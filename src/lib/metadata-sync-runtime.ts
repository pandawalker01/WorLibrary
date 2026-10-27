import type { AuthSession } from './auth'
import {
  registerBrowserSyncDevice,
  type ClientInstanceStorage,
  type DeviceRegistrationSessionResult,
} from './device-registration-session'
import {
  coordinateMetadataSync,
  type MetadataSyncCoordinatorResult,
  type MetadataSyncCursorStore,
  type MetadataSyncEntityRevisionStore,
} from './metadata-sync-coordinator'
import type { RemoteBookMetadataShadowStore } from './metadata-sync-edition-shadow'
import type { RemoteHighlightMetadataShadowStore } from './metadata-sync-highlight-shadow'
import type { RemoteReaderPreferenceStore } from './metadata-sync-preference-shadow'
import type { MetadataSyncOutboxStore, MetadataSyncRpcClient } from './metadata-sync-engine'
import { createRemoteClient } from './remote'
import { isRetryableMetadataSyncError, metadataSyncRetryDelayMs, shouldRetryMetadataSync } from './metadata-sync-retry'
import {
  acknowledgeMetadataSyncOutboxEntry,
  claimMetadataSyncOutboxEntry,
  deleteRemoteBookMetadataShadow,
  deleteRemoteHighlightMetadataShadow,
  listMetadataSyncOutbox,
  readMetadataSyncCursor,
  releaseMetadataSyncOutboxClaim,
  upsertRemoteBookMetadataShadow,
  upsertRemoteHighlightMetadataShadow,
  writeMetadataSyncEntityRevision,
  writeMetadataSyncCursor,
} from './storage'

const runtimeEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

export type MetadataSyncRuntimeDependencies = {
  /**
   * A preconfigured controlled-RPC client. Supplying this is useful for an
   * embedding host or tests; the runtime otherwise creates the browser
   * Supabase client only after configuration has been verified.
   */
  remote?: MetadataSyncRpcClient
  createRemote?: (session: AuthSession) => MetadataSyncRpcClient
  isConfigured?: () => boolean
  outbox?: MetadataSyncOutboxStore
  shadows?: RemoteBookMetadataShadowStore
  highlights?: RemoteHighlightMetadataShadowStore
  /** The app owns account-scoped durable preference storage and UI updates. */
  preferences?: RemoteReaderPreferenceStore
  cursors?: MetadataSyncCursorStore
  revisions?: MetadataSyncEntityRevisionStore
  deviceStorage?: ClientInstanceStorage | null
  registerDevice?: (input: {
    session: AuthSession
    remote: MetadataSyncRpcClient
  }) => Promise<DeviceRegistrationSessionResult>
  pageSize?: number
  maxPages?: number
}

export type MetadataSyncRuntime = {
  /**
   * Run the bounded edition-metadata protocol once. Concurrent calls for one
   * account share a single flight; no EPUB/PDF bytes, covers, URLs, or text
   * bodies are accepted by this runtime.
   */
  run(session: AuthSession | null): Promise<MetadataSyncCoordinatorResult>
  /**
   * Marks a current run obsolete after sign-out or account switching.  It
   * cannot retract an RPC already at the server, but prevents the obsolete
   * browser session from continuing with another flush, pull, or durable
   * cursor/revision write.  Omit `userId` to invalidate every known account.
   */
  invalidate(userId?: string): void
}

function stableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function defaultIsConfigured(): boolean {
  return Boolean(runtimeEnv.VITE_SUPABASE_URL && runtimeEnv.VITE_SUPABASE_ANON_KEY)
}

/**
 * The opaque feed cursor is durable IndexedDB metadata, scoped by stable
 * account. It has no device ID, email, file path, URL, cover bytes, or body.
 * Keeping this here makes the runtime's default explicit while preserving an
 * injectable adapter for focused tests and embedding hosts.
 */
function defaultCursorStore(): MetadataSyncCursorStore {
  return {
    read: readMetadataSyncCursor,
    write: writeMetadataSyncCursor,
  }
}

function defaultEntityRevisionStore(): MetadataSyncEntityRevisionStore {
  return { write: writeMetadataSyncEntityRevision }
}

function defaultOutboxStore(): MetadataSyncOutboxStore {
  return {
    list: listMetadataSyncOutbox,
    claim: claimMetadataSyncOutboxEntry,
    acknowledge: acknowledgeMetadataSyncOutboxEntry,
    release: releaseMetadataSyncOutboxClaim,
  }
}

function defaultShadowStore(): RemoteBookMetadataShadowStore {
  return {
    upsert: upsertRemoteBookMetadataShadow,
    delete: deleteRemoteBookMetadataShadow,
  }
}

function defaultHighlightShadowStore(): RemoteHighlightMetadataShadowStore {
  return {
    upsert: upsertRemoteHighlightMetadataShadow,
    delete: deleteRemoteHighlightMetadataShadow,
  }
}

/**
 * Compose the controlled metadata primitives into one narrow application
 * service. The application may call `run` after a stable session becomes
 * available and after local metadata changes; it remains deliberately inert
 * for anonymous sessions and missing Supabase configuration.
 */
export function createMetadataSyncRuntime(
  dependencies: MetadataSyncRuntimeDependencies = {},
): MetadataSyncRuntime {
  const flights = new Map<string, Promise<MetadataSyncCoordinatorResult>>()
  const generations = new Map<string, number>()
  const retryAttempts = new Map<string, number>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const clearRetry = (userId: string): void => {
    const timer = retryTimers.get(userId)
    if (timer !== undefined) globalThis.clearTimeout(timer)
    retryTimers.delete(userId)
  }

  const invalidate = (userId?: string): void => {
    const users = userId ? [userId] : [...new Set([...generations.keys(), ...retryTimers.keys()])]
    for (const id of users) {
      generations.set(id, (generations.get(id) ?? 0) + 1)
      clearRetry(id)
      retryAttempts.delete(id)
      // A future stable session must not be held behind the obsolete flight.
      flights.delete(id)
    }
  }

  const run = (session: AuthSession | null): Promise<MetadataSyncCoordinatorResult> => {
    // These guards intentionally precede browser storage, default-store, ID
    // generation, device registration, and network-client construction.
    if (!stableSession(session)) return Promise.resolve({ status: 'no-stable-account' })

    clearRetry(session.user.id)
    const existing = flights.get(session.user.id)
    if (existing) return existing

    let remote = dependencies.remote
    if (!remote) {
      if (!(dependencies.isConfigured ?? defaultIsConfigured)()) {
        return Promise.resolve({ status: 'unconfigured' })
      }
      remote = (dependencies.createRemote ?? createRemoteClient)(session)
    }

    const outbox = dependencies.outbox ?? defaultOutboxStore()
    const shadows = dependencies.shadows ?? defaultShadowStore()
    const highlights = dependencies.highlights ?? defaultHighlightShadowStore()
    const cursors = dependencies.cursors ?? defaultCursorStore()
    const revisions = dependencies.revisions ?? defaultEntityRevisionStore()
    const registerDevice = dependencies.registerDevice
      ? () => dependencies.registerDevice!({ session, remote })
      : () => registerBrowserSyncDevice({ session, remote, storage: dependencies.deviceStorage })
    const generation = generations.get(session.user.id) ?? 0
    generations.set(session.user.id, generation)
    const shouldContinue = () => generations.get(session.user.id) === generation

    const task = coordinateMetadataSync({
      session,
      remote,
      outbox,
      shadows,
      highlights,
      preferences: dependencies.preferences,
      cursors,
      revisions,
      registerDevice,
      pageSize: dependencies.pageSize,
      maxPages: dependencies.maxPages,
      shouldContinue,
    }).then((result) => {
      if (generations.get(session.user.id) !== generation) return result
      if (result.status === 'completed') {
        retryAttempts.delete(session.user.id)
      } else if (shouldRetryMetadataSync(result)) {
        scheduleRetry(session, generation)
      }
      return result
    }, (error: unknown) => {
      if (generations.get(session.user.id) === generation && isRetryableMetadataSyncError(error)) {
        scheduleRetry(session, generation)
      }
      throw error
    })
    flights.set(session.user.id, task)
    // Do not use `finally` without consuming the promise it returns: a
    // rejected injected adapter must still release the single-flight slot.
    void task.then(
      () => { if (flights.get(session.user.id) === task) flights.delete(session.user.id) },
      () => { if (flights.get(session.user.id) === task) flights.delete(session.user.id) },
    )
    return task
  }

  function scheduleRetry(session: AuthSession, generation: number): void {
    const userId = session.user.id
    if (retryTimers.has(userId) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
    const attempt = retryAttempts.get(userId) ?? 0
    const delay = metadataSyncRetryDelayMs(attempt)
    if (delay === null) return
    retryAttempts.set(userId, attempt + 1)
    const timer = globalThis.setTimeout(() => {
      retryTimers.delete(userId)
      if (generations.get(userId) === generation) void run(session)
    }, delay)
    retryTimers.set(userId, timer)
  }

  return { run, invalidate }
}
