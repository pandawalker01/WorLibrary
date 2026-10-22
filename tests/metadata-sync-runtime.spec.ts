import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createMetadataSyncRuntime } from '../src/lib/metadata-sync-runtime'
import type { RemoteBookMetadataShadow, UpsertRemoteBookMetadataShadow } from '../src/lib/storage'

const session = {
  accessToken: 'jwt',
  refreshToken: 'refresh',
  user: { id: 'stable-user', isAnonymous: false },
}

const registration = {
  status: 'registered' as const,
  clientInstanceId: '35008161-324f-4f6c-b2b8-cf8ca503581d',
  device: {
    id: '9c025db3-12bc-4c7b-8be7-b6d0bd658fba',
    clientInstanceId: '35008161-324f-4f6c-b2b8-cf8ca503581d',
    platform: 'web' as const,
    lastSeenAt: null,
    revokedAt: null,
  },
}

function dependencies() {
  const calls: string[] = []
  return {
    calls,
    outbox: {
      list: async (userId: string) => { calls.push(`list:${userId}`); return [] },
      confirm: async () => true,
    },
    shadows: {
      upsert: async (input: UpsertRemoteBookMetadataShadow): Promise<RemoteBookMetadataShadow> => ({
        key: `${input.userId}:${input.editionId}`, ...input, needsReimport: true,
      }),
      delete: async () => true,
    },
    cursors: {
      read: async (userId: string) => { calls.push(`cursor-read:${userId}`); return 0 },
      write: async (_userId: string, sequence: number) => { calls.push(`cursor-write:${sequence}`) },
    },
  }
}

test('runtime is inert before it reads local stores for anonymous and unconfigured sessions', async () => {
  const data = dependencies()
  let remoteCreated = 0
  let registered = 0
  const runtime = createMetadataSyncRuntime({
    isConfigured: () => false,
    createRemote: () => { remoteCreated += 1; throw new Error('must remain inert') },
    outbox: data.outbox,
    shadows: data.shadows,
    cursors: data.cursors,
    registerDevice: async () => { registered += 1; return registration },
  })

  await expect(runtime.run({ ...session, user: { ...session.user, isAnonymous: true } }))
    .resolves.toEqual({ status: 'no-stable-account' })
  await expect(runtime.run(session)).resolves.toEqual({ status: 'unconfigured' })

  expect(remoteCreated).toBe(0)
  expect(registered).toBe(0)
  expect(data.calls).toEqual([])
})

test('runtime adapts the configured client, browser device registration, outbox, shadows, and durable cursor store', async () => {
  const values = new Map<string, string>()
  const data = dependencies()
  let clientCreated = 0
  const rpcCalls: string[] = []
  const runtime = createMetadataSyncRuntime({
    isConfigured: () => true,
    createRemote: () => {
      clientCreated += 1
      return {
        rpc: async (name) => {
          rpcCalls.push(name)
          if (name === 'register_sync_device') return registration.device
          return []
        },
      }
    },
    deviceStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
    },
    outbox: data.outbox,
    shadows: data.shadows,
    cursors: data.cursors,
  })

  const result = await runtime.run(session)

  expect(result.status).toBe('completed')
  expect(clientCreated).toBe(1)
  expect(rpcCalls).toEqual(['register_sync_device', 'pull_metadata_sync_changes'])
  expect(data.calls).toEqual(['list:stable-user', 'cursor-read:stable-user', 'cursor-write:0'])
})

test('runtime coalesces concurrent runs for the same account into one device and feed operation', async () => {
  const data = dependencies()
  let registerCalls = 0
  let pullCalls = 0
  let releasePull: (() => void) | undefined
  const waitForPull = new Promise<void>((resolve) => { releasePull = resolve })
  const runtime = createMetadataSyncRuntime({
    remote: {
      rpc: async (name) => {
        if (name === 'pull_metadata_sync_changes') {
          pullCalls += 1
          await waitForPull
          return []
        }
        return []
      },
    },
    outbox: data.outbox,
    shadows: data.shadows,
    cursors: data.cursors,
    registerDevice: async () => { registerCalls += 1; return registration },
  })

  const first = runtime.run(session)
  const second = runtime.run(session)
  await expect.poll(() => registerCalls).toBe(1)
  releasePull?.()
  const [left, right] = await Promise.all([first, second])

  expect(left.status).toBe('completed')
  expect(right.status).toBe('completed')
  expect(registerCalls).toBe(1)
  expect(pullCalls).toBe(1)
  expect(data.calls).toEqual(['list:stable-user', 'cursor-read:stable-user', 'cursor-write:0'])
})

test('runtime default cursor adapter delegates to the IndexedDB cursor helpers, never localStorage', async () => {
  const source = await readFile(new URL('../src/lib/metadata-sync-runtime.ts', import.meta.url), 'utf8')

  expect(source).toContain('readMetadataSyncCursor')
  expect(source).toContain('writeMetadataSyncCursor')
  expect(source).toContain('read: readMetadataSyncCursor')
  expect(source).toContain('write: writeMetadataSyncCursor')
  expect(source).not.toContain('localStorage')
  expect(source).not.toContain('cursorStorage')
})
