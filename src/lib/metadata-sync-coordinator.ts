import type { AuthSession } from './auth'
import type { DeviceRegistrationSessionResult } from './device-registration-session'
import { projectRemoteEditionChangeToShadow, type RemoteBookMetadataShadowStore } from './metadata-sync-edition-shadow'
import {
  flushMetadataSyncOutbox,
  pullMetadataSyncChangeFeed,
  type MetadataSyncFlushResult,
  type MetadataSyncOutboxStore,
  type MetadataSyncRpcClient,
  type PullMetadataSyncChangeFeedResult,
} from './metadata-sync-engine'

/**
 * Keeps the server-authoritative revision for a single accepted entity. This
 * intentionally stores only routing/version metadata, never its payload.
 */
export type MetadataSyncEntityRevisionStore = {
  write(input: {
    userId: string
    entityType: 'edition'
    entityId: string
    revision: number
    lastSequence: number
  }): Promise<unknown>
}

/**
 * Durable cursor storage remains injected to keep the coordinator independent
 * of IndexedDB. The browser runtime supplies the account-scoped cursor store;
 * callers must write only after a fully accepted remote page.
 */
export type MetadataSyncCursorStore = {
  read(userId: string): Promise<number>
  write(userId: string, sequence: number): Promise<void>
}

export type MetadataSyncCoordinatorInput = {
  session: AuthSession | null
  /** Omit until the caller has verified Supabase configuration. */
  remote?: MetadataSyncRpcClient
  outbox: MetadataSyncOutboxStore
  shadows: RemoteBookMetadataShadowStore
  cursors: MetadataSyncCursorStore
  revisions: MetadataSyncEntityRevisionStore
  /** Inject the registration session to keep browser localStorage outside this coordinator. */
  registerDevice: () => Promise<DeviceRegistrationSessionResult>
  pageSize?: number
  maxPages?: number
  /** Stops an obsolete runtime session before it enters another sync stage. */
  shouldContinue?: () => boolean
}

export type MetadataSyncCoordinatorResult = {
  status:
    | 'completed'
    | 'no-stable-account'
    | 'unconfigured'
    | 'device-registration-failed'
    | 'outbox-blocked'
    | 'cursor-failure'
    | 'pull-failed'
    | 'invalidated'
  registration?: DeviceRegistrationSessionResult
  flush?: MetadataSyncFlushResult
  pull?: PullMetadataSyncChangeFeedResult
  error?: unknown
}

function isStableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function usableRegistration(result: DeviceRegistrationSessionResult): result is DeviceRegistrationSessionResult & {
  status: 'registered'
  device: { id: string; revokedAt: string | null }
} {
  return result.status === 'registered' && Boolean(result.device?.id.trim()) && result.device?.revokedAt === null
}

function cursorCanAdvance(result: PullMetadataSyncChangeFeedResult): boolean {
  return result.reason === 'completed' || result.reason === 'page-limit'
}

function sessionIsCurrent(input: MetadataSyncCoordinatorInput): boolean {
  return input.shouldContinue?.() !== false
}

/**
 * Bounded MVP assembly of the safe sync primitives.  It deliberately does
 * not know about `StoredBook`, book bytes, object URLs, or App state.  It is
 * inert for anonymous trials, then registers the device, flushes existing
 * metadata intents, projects only safe remote edition metadata into shadows,
 * and persists an opaque cursor after accepted pages.
 */
export async function coordinateMetadataSync(input: MetadataSyncCoordinatorInput): Promise<MetadataSyncCoordinatorResult> {
  if (!isStableSession(input.session)) return { status: 'no-stable-account' }
  if (!input.remote) return { status: 'unconfigured' }
  if (!sessionIsCurrent(input)) return { status: 'invalidated' }

  const registration = await input.registerDevice()
  if (!sessionIsCurrent(input)) return { status: 'invalidated', registration }
  if (!usableRegistration(registration)) {
    return { status: 'device-registration-failed', registration, error: registration.error }
  }

  const flush = await flushMetadataSyncOutbox({
    session: input.session,
    serverDeviceId: registration.device.id,
    remote: input.remote,
    outbox: input.outbox,
    shouldContinue: input.shouldContinue,
  })
  if (flush.reason === 'invalidated' || !sessionIsCurrent(input)) {
    return { status: 'invalidated', registration, flush }
  }
  if (flush.reason !== 'completed') return { status: 'outbox-blocked', registration, flush, error: flush.error }

  let afterSequence: number
  if (!sessionIsCurrent(input)) return { status: 'invalidated', registration, flush }
  try {
    afterSequence = await input.cursors.read(input.session.user.id)
  } catch (error) {
    return { status: 'cursor-failure', registration, flush, error }
  }

  const pull = await pullMetadataSyncChangeFeed({
    session: input.session,
    remote: input.remote,
    afterSequence,
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    onChange: async (change) => {
      if (!sessionIsCurrent(input)) throw new Error('sync session invalidated')
      const projection = await projectRemoteEditionChangeToShadow({
        userId: input.session!.user.id,
        change,
        shadows: input.shadows,
      })
      // The caller should not advance a cursor through data it cannot safely
      // interpret.  This makes the limited MVP support explicit instead of
      // silently losing highlights, settings, or future entity types.
      if (projection.outcome === 'ignored') throw new Error(`unsupported sync entity: ${change.entity_type}`)
      if (projection.outcome === 'rejected') throw projection.error
      if (!sessionIsCurrent(input)) throw new Error('sync session invalidated')
      // The cursor may advance only after both the safe shadow projection and
      // its corresponding server revision are durable.  If this write fails,
      // the pull engine aborts the page and leaves its cursor unchanged.
      await input.revisions.write({
        userId: input.session!.user.id,
        entityType: 'edition',
        entityId: change.entity_id,
        revision: change.entity_revision,
        lastSequence: change.sequence,
      })
    },
    shouldContinue: input.shouldContinue,
  })
  if (pull.reason === 'invalidated' || !sessionIsCurrent(input)) {
    return { status: 'invalidated', registration, flush, pull }
  }
  if (!cursorCanAdvance(pull)) return { status: 'pull-failed', registration, flush, pull, error: pull.error }

  try {
    if (!sessionIsCurrent(input)) return { status: 'invalidated', registration, flush, pull }
    await input.cursors.write(input.session.user.id, pull.nextSequence)
  } catch (error) {
    return { status: 'cursor-failure', registration, flush, pull, error }
  }
  return { status: 'completed', registration, flush, pull }
}
