import type { AuthSession } from './auth'
import type { RegisteredSyncDevice, RemoteClient, SyncDevicePlatform } from './remote'

/** A local browser-installation marker, never an account identifier or a file identifier. */
export const SYNC_CLIENT_INSTANCE_STORAGE_KEY = 'wor-library.sync.client-instance-id'

export type ClientInstanceStorage = Pick<Storage, 'getItem' | 'setItem'>
export type DeviceRegistrationRemote = Pick<RemoteClient, 'rpc'>

export type DeviceRegistrationSessionInput = {
  session: AuthSession | null
  /** Omit this until Supabase configuration has been validated by the caller. */
  remote?: DeviceRegistrationRemote
  storage?: ClientInstanceStorage | null
  platform?: SyncDevicePlatform
  appVersion?: string
  /** Injected by tests; production uses cryptographically secure random UUIDs. */
  createClientInstanceId?: () => string
}

export type DeviceRegistrationSessionResult = {
  status: 'registered' | 'no-stable-account' | 'unconfigured' | 'storage-unavailable' | 'failed'
  clientInstanceId?: string
  device?: RegisteredSyncDevice
  error?: unknown
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function stableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function defaultStorage(): ClientInstanceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function browserClientInstanceId(): string {
  const id = globalThis.crypto?.randomUUID?.()
  if (!id || !uuidPattern.test(id)) throw new Error('浏览器无法生成安全的设备实例 ID')
  return id
}

/**
 * Register the current browser installation for an already-stable account.
 * The persisted value is a random UUID shared by browser profiles only; it
 * contains no account id, email, book id, filename, or reading payload. The
 * server binds it to the authenticated account from the JWT.
 */
export async function registerBrowserSyncDevice(input: DeviceRegistrationSessionInput): Promise<DeviceRegistrationSessionResult> {
  // Check these before resolving localStorage, generating an ID, or invoking
  // the remote client. Anonymous trials and missing configuration are inert.
  if (!stableSession(input.session)) return { status: 'no-stable-account' }
  if (!input.remote) return { status: 'unconfigured' }

  const storage = input.storage === undefined ? defaultStorage() : input.storage
  if (!storage) return { status: 'storage-unavailable' }

  let clientInstanceId: string
  try {
    const existing = storage.getItem(SYNC_CLIENT_INSTANCE_STORAGE_KEY)
    clientInstanceId = existing && uuidPattern.test(existing) ? existing : (input.createClientInstanceId ?? browserClientInstanceId)()
    if (!uuidPattern.test(clientInstanceId)) throw new Error('设备实例 ID 必须是 UUID')
    if (clientInstanceId !== existing) storage.setItem(SYNC_CLIENT_INSTANCE_STORAGE_KEY, clientInstanceId)
  } catch (error) {
    return { status: 'storage-unavailable', error }
  }

  try {
    const device = await input.remote.rpc('register_sync_device', {
      p_client_instance_id: clientInstanceId,
      p_platform: input.platform ?? 'web',
      ...(input.appVersion ? { p_app_version: input.appVersion } : {}),
    })
    return { status: 'registered', clientInstanceId, device }
  } catch (error) {
    return { status: 'failed', clientInstanceId, error }
  }
}
