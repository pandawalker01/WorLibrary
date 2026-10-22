import { expect, test } from '@playwright/test'
import { coordinateMetadataSync } from '../src/lib/metadata-sync-coordinator'
import type { RemoteBookMetadataShadow, UpsertRemoteBookMetadataShadow } from '../src/lib/storage'

const session = {
  accessToken: 'jwt',
  refreshToken: 'refresh',
  user: { id: 'stable-user', isAnonymous: false },
}

const editionId = 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7'
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

function safeEdition(sequence = 1) {
  return {
    sequence,
    device_id: registration.device.id,
    operation_id: `31e5ed3a-7258-4f7f-a53d-${String(sequence).padStart(12, '0')}`,
    entity_type: 'edition' as const,
    entity_id: editionId,
    operation: 'upsert' as const,
    entity_revision: 1,
    payload: {
      title: 'A local EPUB', author: 'Reader', language: 'en', progress: 22,
      location: 'epubcfi(/6/2)', file_name: 'reader.epub', file_type: 'epub', file_size: 2048, cover: 'ink',
    },
    occurred_at: '2026-10-22T00:00:00.000Z',
  }
}

function dependencies() {
  const calls: string[] = []
  const shadows: UpsertRemoteBookMetadataShadow[] = []
  const cursorWrites: number[] = []
  const revisionWrites: Array<{ entityId: string; revision: number; lastSequence: number }> = []
  return {
    calls,
    shadows,
    cursorWrites,
    outbox: {
      list: async (userId: string) => { calls.push(`list:${userId}`); return [] },
      confirm: async () => true,
    },
    shadowStore: {
      upsert: async (shadow: UpsertRemoteBookMetadataShadow): Promise<RemoteBookMetadataShadow> => {
        calls.push(`shadow:${shadow.editionId}`)
        shadows.push(shadow)
        return { key: `${shadow.userId}:${shadow.editionId}`, ...shadow, needsReimport: true }
      },
      delete: async () => true,
    },
    cursors: {
      read: async (userId: string) => { calls.push(`cursor-read:${userId}`); return 0 },
      write: async (_userId: string, sequence: number) => { calls.push(`cursor-write:${sequence}`); cursorWrites.push(sequence) },
    },
    revisions: {
      write: async ({ entityId, revision, lastSequence }) => {
        calls.push(`revision-write:${entityId}:${revision}:${lastSequence}`)
        revisionWrites.push({ entityId, revision, lastSequence })
      },
    },
    revisionWrites,
  }
}

test('metadata coordinator is inert for anonymous local-only trials', async () => {
  const data = dependencies()
  let registered = 0
  let rpcCalls = 0

  const result = await coordinateMetadataSync({
    session: { ...session, user: { ...session.user, isAnonymous: true } },
    remote: { rpc: async () => { rpcCalls += 1; return [] } },
    outbox: data.outbox,
    shadows: data.shadowStore,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => { registered += 1; return registration },
  })

  expect(result).toEqual({ status: 'no-stable-account' })
  expect(registered).toBe(0)
  expect(rpcCalls).toBe(0)
  expect(data.calls).toEqual([])
})

test('metadata coordinator flushes, projects a bounded edition feed, then persists its cursor', async () => {
  const data = dependencies()
  const rpcCalls: string[] = []
  const pages = [[safeEdition(1)], []]

  const result = await coordinateMetadataSync({
    session,
    remote: {
      rpc: async (name) => {
        rpcCalls.push(name)
        if (name === 'apply_metadata_sync_change') return []
        return pages.shift() ?? []
      },
    },
    outbox: data.outbox,
    shadows: data.shadowStore,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
    pageSize: 1,
  })

  expect(result.status).toBe('completed')
  expect(rpcCalls).toEqual(['pull_metadata_sync_changes', 'pull_metadata_sync_changes'])
  expect(data.shadows).toHaveLength(1)
  expect(data.cursorWrites).toEqual([1])
  expect(data.revisionWrites).toEqual([{ entityId: editionId, revision: 1, lastSequence: 1 }])
  expect(data.calls).toEqual([
    'list:stable-user', 'cursor-read:stable-user', `shadow:${editionId}`,
    `revision-write:${editionId}:1:1`, 'cursor-write:1',
  ])
})

test('metadata coordinator leaves cursor untouched when the feed contains an unsupported entity', async () => {
  const data = dependencies()
  const result = await coordinateMetadataSync({
    session,
    remote: {
      rpc: async () => [{ ...safeEdition(), entity_type: 'highlight' as const }],
    },
    outbox: data.outbox,
    shadows: data.shadowStore,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
  })

  expect(result.status).toBe('pull-failed')
  expect(result.pull?.reason).toBe('handler-failure')
  expect(data.shadows).toEqual([])
  expect(data.cursorWrites).toEqual([])
  expect(data.revisionWrites).toEqual([])
})

test('metadata coordinator does not pull or advance a cursor when the outbox is blocked', async () => {
  const data = dependencies()
  data.outbox.list = async () => [{
    operationId: '31e5ed3a-7258-4f7f-a53d-5d43a02f4aec', userId: session.user.id, deviceClientId: registration.clientInstanceId,
    entityType: 'setting', entityId: 'reader.theme', operation: 'upsert', baseRevision: 0, payload: { value: 'paper' }, status: 'pending', createdAt: 1,
  }]
  const rpcCalls: string[] = []

  const result = await coordinateMetadataSync({
    session,
    remote: { rpc: async (name) => { rpcCalls.push(name); throw new Error('permission denied') } },
    outbox: data.outbox,
    shadows: data.shadowStore,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
  })

  expect(result.status).toBe('outbox-blocked')
  expect(rpcCalls).toEqual(['apply_metadata_sync_change'])
  expect(data.cursorWrites).toEqual([])
  expect(data.shadows).toEqual([])
})

test('metadata coordinator leaves the whole page cursor behind when persisting an accepted edition revision fails', async () => {
  const data = dependencies()
  data.revisions.write = async () => { throw new Error('revision storage unavailable') }

  const result = await coordinateMetadataSync({
    session,
    remote: { rpc: async () => [safeEdition()] },
    outbox: data.outbox,
    shadows: data.shadowStore,
    cursors: data.cursors,
    revisions: data.revisions,
    registerDevice: async () => registration,
  })

  expect(result.status).toBe('pull-failed')
  expect(result.pull?.reason).toBe('handler-failure')
  expect(data.shadows).toHaveLength(1)
  expect(data.cursorWrites).toEqual([])
})
