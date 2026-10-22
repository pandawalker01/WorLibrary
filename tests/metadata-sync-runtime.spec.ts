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
  const revisionWrites: Array<{ entityId: string; revision: number; lastSequence: number }> = []
  return {
    calls,
    revisionWrites,
    outbox: {
      list: async (userId: string) => { calls.push(`list:${userId}`); return [] },
      claim: async () => null,
      acknowledge: async () => true,
      release: async () => true,
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
    revisions: {
      write: async ({ entityId, revision, lastSequence }: { entityId: string; revision: number; lastSequence: number }) => {
        calls.push(`revision-write:${entityId}:${revision}:${lastSequence}`)
        revisionWrites.push({ entityId, revision, lastSequence })
      },
    },
  }
}

function safeEdition(sequence = 1) {
  return {
    sequence,
    device_id: registration.device.id,
    operation_id: `31e5ed3a-7258-4f7f-a53d-${String(sequence).padStart(12, '0')}`,
    entity_type: 'edition' as const,
    entity_id: 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7',
    operation: 'upsert' as const,
    entity_revision: 1,
    payload: {
      title: 'A local EPUB', author: 'Reader', language: 'en', progress: 22,
      location: 'epubcfi(/6/2)', file_name: 'reader.epub', file_type: 'epub', file_size: 2048, cover: 'ink',
    },
    occurred_at: '2026-10-22T00:00:00.000Z',
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
    revisions: data.revisions,
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
    revisions: data.revisions,
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
    revisions: data.revisions,
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

test('runtime invalidation prevents an obsolete session from pulling or writing cursor state after registration', async () => {
  const data = dependencies()
  let releaseRegistration: (() => void) | undefined
  const waitForRegistration = new Promise<void>((resolve) => { releaseRegistration = resolve })
  let pullCalls = 0
  const runtime = createMetadataSyncRuntime({
    remote: { rpc: async () => { pullCalls += 1; return [] } },
    outbox: data.outbox,
    shadows: data.shadows,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => { await waitForRegistration; return registration },
  })

  const obsolete = runtime.run(session)
  runtime.invalidate(session.user.id)
  releaseRegistration?.()

  await expect(obsolete).resolves.toMatchObject({ status: 'invalidated' })
  expect(pullCalls).toBe(0)
  expect(data.calls).toEqual([])
})

test('runtime invalidation during a pending pull blocks projection, revision, and cursor writes', async () => {
  const data = dependencies()
  let releasePull: (() => void) | undefined
  const waitForPull = new Promise<void>((resolve) => { releasePull = resolve })
  let pullCalls = 0
  const runtime = createMetadataSyncRuntime({
    remote: {
      rpc: async (name) => {
        if (name === 'pull_metadata_sync_changes') {
          pullCalls += 1
          await waitForPull
          return [safeEdition()]
        }
        return []
      },
    },
    outbox: data.outbox,
    shadows: data.shadows,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
  })

  const obsolete = runtime.run(session)
  await expect.poll(() => pullCalls).toBe(1)
  runtime.invalidate(session.user.id)
  releasePull?.()

  await expect(obsolete).resolves.toMatchObject({ status: 'invalidated' })
  expect(data.revisionWrites).toEqual([])
  expect(data.calls).toEqual(['list:stable-user', 'cursor-read:stable-user'])
})

test('account switching invalidates an old projection after its shadow write and never advances its revision or cursor', async () => {
  const data = dependencies()
  let releaseShadow: (() => void) | undefined
  const waitForShadow = new Promise<void>((resolve) => { releaseShadow = resolve })
  let shadowStarted = false
  const oldSession = session
  const nextSession = {
    ...session,
    user: { id: 'next-stable-user', isAnonymous: false },
  }
  let oldPulls = 0
  const runtime = createMetadataSyncRuntime({
    remote: {
      rpc: async (name, input) => {
        if (name !== 'pull_metadata_sync_changes') return []
        if (input.p_after_sequence === 0 && oldPulls === 0) {
          oldPulls += 1
          return [safeEdition()]
        }
        return []
      },
    },
    outbox: data.outbox,
    shadows: {
      ...data.shadows,
      upsert: async (input) => {
        shadowStarted = true
        await waitForShadow
        return {
          key: `${input.userId}:${input.editionId}`,
          ...input,
          needsReimport: true,
        }
      },
    },
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
  })

  const obsolete = runtime.run(oldSession)
  await expect.poll(() => shadowStarted).toBe(true)
  runtime.invalidate(oldSession.user.id)
  const next = runtime.run(nextSession)
  releaseShadow?.()

  await expect(obsolete).resolves.toMatchObject({ status: 'invalidated' })
  await expect(next).resolves.toMatchObject({ status: 'completed' })
  expect(data.revisionWrites).toEqual([])
  expect(data.calls).toEqual([
    'list:stable-user',
    'cursor-read:stable-user',
    'list:next-stable-user',
    'cursor-read:next-stable-user',
    'cursor-write:0',
  ])
})

test('runtime forwards each accepted edition revision to its injectable durable store before advancing the cursor', async () => {
  const data = dependencies()
  const pages = [[safeEdition()], []]
  const runtime = createMetadataSyncRuntime({
    remote: { rpc: async () => pages.shift() ?? [] },
    outbox: data.outbox,
    shadows: data.shadows,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
  })

  await expect(runtime.run(session)).resolves.toMatchObject({ status: 'completed' })
  expect(data.revisionWrites).toEqual([{
    entityId: 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7', revision: 1, lastSequence: 1,
  }])
  expect(data.calls).toEqual([
    'list:stable-user', 'cursor-read:stable-user',
    'revision-write:f2cbf73d-5716-433f-8e93-7f03a3e9d3e7:1:1', 'cursor-write:1',
  ])
})

test('runtime default cursor adapter delegates to the IndexedDB cursor helpers, never localStorage', async () => {
  const source = await readFile(new URL('../src/lib/metadata-sync-runtime.ts', import.meta.url), 'utf8')

  expect(source).toContain('readMetadataSyncCursor')
  expect(source).toContain('writeMetadataSyncCursor')
  expect(source).toContain('writeMetadataSyncEntityRevision')
  expect(source).toContain('read: readMetadataSyncCursor')
  expect(source).toContain('write: writeMetadataSyncCursor')
  expect(source).toContain('write: writeMetadataSyncEntityRevision')
  expect(source).not.toContain('localStorage')
  expect(source).not.toContain('cursorStorage')
})
