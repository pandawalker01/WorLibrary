import { expect, test } from '@playwright/test'
import type { AuthSession } from '../src/lib/auth'
import {
  registerBrowserSyncDevice,
  SYNC_CLIENT_INSTANCE_STORAGE_KEY,
  type ClientInstanceStorage,
  type DeviceRegistrationRemote,
} from '../src/lib/device-registration-session'

const stableSession: AuthSession = {
  accessToken: 'session-jwt',
  refreshToken: 'refresh-token',
  user: { id: 'stable-user', isAnonymous: false },
}
const anonymousSession: AuthSession = {
  ...stableSession,
  user: { id: 'anonymous-user', isAnonymous: true },
}
const clientId = 'a1d8eb2c-6996-4b5a-928f-2c429c083e69'

function memoryStorage(initial?: string): ClientInstanceStorage & { reads: number; writes: string[] } {
  let value = initial ?? null
  const storage: ClientInstanceStorage & { reads: number; writes: string[] } = {
    reads: 0,
    writes: [],
    getItem: () => {
      storage.reads += 1
      return value
    },
    setItem: (_key, next) => {
      storage.writes.push(next)
      value = next
    },
  }
  return storage
}

function registeredRemote(calls: Array<{ name: string; input: unknown }>): DeviceRegistrationRemote {
  return {
    rpc: (async (name: string, input: unknown) => {
      calls.push({ name, input })
      return {
        id: 'server-device-id', clientInstanceId: clientId, platform: 'web',
        lastSeenAt: '2026-10-21T00:00:00.000Z', revokedAt: null,
      }
    }) as DeviceRegistrationRemote['rpc'],
  }
}

test('anonymous trials and unconfigured stable accounts do not read device storage or call the network', async () => {
  const storage = memoryStorage()
  const calls: Array<{ name: string; input: unknown }> = []
  const remote = registeredRemote(calls)

  await expect(registerBrowserSyncDevice({ session: anonymousSession, remote, storage })).resolves.toEqual({ status: 'no-stable-account' })
  await expect(registerBrowserSyncDevice({ session: stableSession, storage })).resolves.toEqual({ status: 'unconfigured' })

  expect(storage.reads).toBe(0)
  expect(storage.writes).toEqual([])
  expect(calls).toEqual([])
})

test('stable account creates one opaque client UUID and registers only the minimum browser device input', async () => {
  const storage = memoryStorage()
  const calls: Array<{ name: string; input: unknown }> = []

  const result = await registerBrowserSyncDevice({
    session: stableSession,
    remote: registeredRemote(calls),
    storage,
    appVersion: '0.1.0',
    createClientInstanceId: () => clientId,
  })

  expect(result).toEqual({
    status: 'registered', clientInstanceId: clientId,
    device: { id: 'server-device-id', clientInstanceId: clientId, platform: 'web', lastSeenAt: '2026-10-21T00:00:00.000Z', revokedAt: null },
  })
  expect(storage.reads).toBe(1)
  expect(storage.writes).toEqual([clientId])
  expect(calls).toEqual([{
    name: 'register_sync_device',
    input: { p_client_instance_id: clientId, p_platform: 'web', p_app_version: '0.1.0' },
  }])
  expect(JSON.stringify(calls)).not.toContain(stableSession.user.id)
  expect(JSON.stringify(calls)).not.toContain('book')
})

test('stable account reuses only a valid opaque UUID and replaces unsafe legacy storage before it can reach the RPC', async () => {
  const storage = memoryStorage('stable-user')
  const calls: Array<{ name: string; input: unknown }> = []

  const result = await registerBrowserSyncDevice({
    session: stableSession,
    remote: registeredRemote(calls),
    storage,
    createClientInstanceId: () => clientId,
  })

  expect(result.status).toBe('registered')
  expect(storage.writes).toEqual([clientId])
  expect(calls[0].input).toEqual({ p_client_instance_id: clientId, p_platform: 'web' })
  expect(JSON.stringify(calls)).not.toContain('stable-user')
})

test('device registration returns a failure without retaining server device data when the RPC is unavailable', async () => {
  const storage = memoryStorage()
  const remote: DeviceRegistrationRemote = {
    rpc: (async () => { throw new Error('offline') }) as DeviceRegistrationRemote['rpc'],
  }

  const result = await registerBrowserSyncDevice({
    session: stableSession, remote, storage, createClientInstanceId: () => clientId,
  })

  expect(result.status).toBe('failed')
  expect(result.clientInstanceId).toBe(clientId)
  expect(result.device).toBeUndefined()
  expect(storage.writes).toEqual([clientId])
  expect(storage.getItem(SYNC_CLIENT_INSTANCE_STORAGE_KEY)).toBe(clientId)
})
