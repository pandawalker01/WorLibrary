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
 * Durable cursor storage is injected because the current IndexedDB schema has
 * no cursor record yet.  A future App integration must persist this per stable
 * account and only write it after a fully accepted remote page.
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
  /** Inject the registration session to keep browser localStorage outside this coordinator. */
  registerDevice: () => Promise<DeviceRegistrationSessionResult>
  pageSize?: number
  maxPages?: number
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

  const registration = await input.registerDevice()
  if (!usableRegistration(registration)) {
    return { status: 'device-registration-failed', registration, error: registration.error }
  }

  const flush = await flushMetadataSyncOutbox({
    session: input.session,
    serverDeviceId: registration.device.id,
    remote: input.remote,
    outbox: input.outbox,
  })
  if (flush.reason !== 'completed') return { status: 'outbox-blocked', registration, flush, error: flush.error }

  let afterSequence: number
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
    },
  })
  if (!cursorCanAdvance(pull)) return { status: 'pull-failed', registration, flush, pull, error: pull.error }

  try {
    await input.cursors.write(input.session.user.id, pull.nextSequence)
  } catch (error) {
    return { status: 'cursor-failure', registration, flush, pull, error }
  }
  return { status: 'completed', registration, flush, pull }
}
