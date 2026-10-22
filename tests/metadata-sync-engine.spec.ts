import { expect, test } from '@playwright/test'
import type { AuthSession } from '../src/lib/auth'
import { flushMetadataSyncOutbox, pullMetadataSyncChangeFeed } from '../src/lib/metadata-sync-engine'
import { RemoteRequestError } from '../src/lib/remote'
import type { PulledMetadataSyncChange } from '../src/lib/remote'
import type { MetadataSyncOutboxEntry } from '../src/lib/storage'

const session: AuthSession = {
  accessToken: 'jwt',
  refreshToken: 'refresh',
  user: { id: 'stable-user', isAnonymous: false },
}

function entry(operationId: string, createdAt: number): MetadataSyncOutboxEntry {
  return {
    operationId,
    userId: session.user.id,
    deviceClientId: 'browser-device',
    entityType: 'setting',
    entityId: `reader.setting.${operationId}`,
    operation: 'upsert',
    baseRevision: 0,
    payload: { value: 'paper' },
    status: 'pending',
    createdAt,
  }
}

function fixture(entries: MetadataSyncOutboxEntry[]) {
  const calls: string[] = []
  const confirmations: string[] = []
  const claims = new Map<string, string>()
  return {
    calls,
    confirmations,
    outbox: {
      list: async (userId: string) => {
        calls.push(`list:${userId}`)
        // IndexedDB returns a snapshot array; acknowledgements must not mutate
        // the iteration list that this test flush is already walking.
        return entries.map((candidate) => ({ ...candidate }))
      },
      claim: async (userId: string, operationId: string, claimId: string) => {
        const candidate = entries.find((entry) => entry.operationId === operationId && entry.userId === userId)
        if (!candidate || candidate.status !== 'pending') return null
        candidate.status = 'in-flight'
        candidate.claimId = claimId
        claims.set(operationId, claimId)
        return { ...candidate }
      },
      acknowledge: async (userId: string, operationId: string, claimId: string) => {
        confirmations.push(`${userId}:${operationId}`)
        const index = entries.findIndex((entry) => entry.operationId === operationId && entry.userId === userId && claims.get(operationId) === claimId)
        if (index < 0) return false
        entries.splice(index, 1)
        return true
      },
      release: async (userId: string, operationId: string, claimId: string) => {
        const candidate = entries.find((entry) => entry.operationId === operationId && entry.userId === userId && candidateClaim(entry) === claimId)
        if (!candidate) return false
        candidate.status = 'pending'
        delete candidate.claimId
        return true
      },
    },
  }
}

function candidateClaim(entry: MetadataSyncOutboxEntry): string | undefined {
  return entry.claimId
}

test('metadata outbox flush is disabled for anonymous sessions before any storage or RPC work', async () => {
  const data = fixture([entry('one', 1)])
  let rpcCalls = 0

  const result = await flushMetadataSyncOutbox({
    session: { ...session, user: { ...session.user, isAnonymous: true } },
    serverDeviceId: 'server-device',
    outbox: data.outbox,
    remote: { rpc: async () => { rpcCalls += 1; return [] } },
  })

  expect(result).toEqual({ reason: 'no-stable-account', attempted: 0, confirmed: 0 })
  expect(data.calls).toEqual([])
  expect(rpcCalls).toBe(0)
})

test('metadata outbox flush applies and confirms stable-account operations sequentially', async () => {
  const data = fixture([entry('first', 1), entry('second', 2)])
  const rpcOperations: string[] = []

  const result = await flushMetadataSyncOutbox({
    session,
    serverDeviceId: 'server-device',
    outbox: data.outbox,
    remote: {
      rpc: async (_name, request) => {
        rpcOperations.push(request.p_operation_id)
        expect(request.p_device_id).toBe('server-device')
        return [{ sequence: rpcOperations.length, entity_revision: 1, operation: 'upsert', applied: true }]
      },
    },
  })

  expect(result).toEqual({ reason: 'completed', attempted: 2, confirmed: 2 })
  expect(rpcOperations).toEqual(['first', 'second'])
  expect(data.confirmations).toEqual(['stable-user:first', 'stable-user:second'])
})

test('metadata outbox flush stops at a conflict without confirming the failed or later entries', async () => {
  const data = fixture([entry('first', 1), entry('conflict', 2), entry('later', 3)])
  const rpcOperations: string[] = []

  const result = await flushMetadataSyncOutbox({
    session,
    serverDeviceId: 'server-device',
    outbox: data.outbox,
    remote: {
      rpc: async (_name, request) => {
        rpcOperations.push(request.p_operation_id)
        if (request.p_operation_id === 'conflict') throw new Error('stale base revision')
        return [{ sequence: 1, entity_revision: 1, operation: 'upsert', applied: true }]
      },
    },
  })

  expect(result.reason).toBe('conflict')
  expect(result.attempted).toBe(2)
  expect(result.confirmed).toBe(1)
  expect(result.failedOperationId).toBe('conflict')
  expect(rpcOperations).toEqual(['first', 'conflict'])
  expect(data.confirmations).toEqual(['stable-user:first'])
})

test('metadata outbox flush keeps retryable failures and later operations queued', async () => {
  const data = fixture([entry('retry', 1), entry('later', 2)])
  const rpcOperations: string[] = []

  const result = await flushMetadataSyncOutbox({
    session,
    serverDeviceId: 'server-device',
    outbox: data.outbox,
    remote: {
      rpc: async (_name, request) => {
        rpcOperations.push(request.p_operation_id)
        throw new RemoteRequestError('temporary outage', { status: 503, retryable: true })
      },
    },
  })

  expect(result.reason).toBe('retryable-failure')
  expect(result.attempted).toBe(1)
  expect(result.confirmed).toBe(0)
  expect(result.failedOperationId).toBe('retry')
  expect(rpcOperations).toEqual(['retry'])
  expect(data.confirmations).toEqual([])
})

test('an acknowledgement never deletes a newer edition edit created while its older operation is in flight', async () => {
  const older: MetadataSyncOutboxEntry = {
    ...entry('older-edition', 1),
    entityType: 'edition',
    entityId: 'edition-1',
    payload: { title: 'Earlier title', progress: 12 },
  }
  const entries: MetadataSyncOutboxEntry[] = [older]
  let activeClaim: string | undefined
  const outbox = {
    list: async () => entries.filter((candidate) => candidate.status === 'pending').map((candidate) => ({ ...candidate })),
    claim: async (_userId: string, operationId: string, claimId: string) => {
      const candidate = entries.find((item) => item.operationId === operationId && item.status === 'pending')
      if (!candidate) return null
      candidate.status = 'in-flight'
      candidate.claimId = claimId
      activeClaim = claimId
      return { ...candidate }
    },
    acknowledge: async (_userId: string, operationId: string, claimId: string, entityRevision: number) => {
      const index = entries.findIndex((item) => item.operationId === operationId && item.status === 'in-flight' && item.claimId === claimId)
      if (index < 0) return false
      const confirmed = entries[index]
      entries.splice(index, 1)
      for (const candidate of entries) {
        if (candidate.status === 'pending' && candidate.entityType === confirmed.entityType && candidate.entityId === confirmed.entityId) {
          candidate.baseRevision = entityRevision
        }
      }
      return true
    },
    release: async () => false,
  }

  const result = await flushMetadataSyncOutbox({
    session,
    serverDeviceId: 'server-device',
    outbox,
    remote: {
      rpc: async () => {
        // This represents a local reader progress update that arrives after
        // the old payload was captured for network transmission.
        entries.push({
          ...older,
          operationId: 'newer-edition',
          payload: { title: 'Newest title', progress: 48 },
          baseRevision: 0,
          status: 'pending',
          createdAt: 2,
        })
        return [{ sequence: 4, entity_revision: 3, operation: 'upsert' as const, applied: true }]
      },
    },
  })

  expect(result).toEqual({ reason: 'completed', attempted: 1, confirmed: 1 })
  expect(activeClaim).toBeTruthy()
  expect(entries).toEqual([expect.objectContaining({
    operationId: 'newer-edition', status: 'pending', baseRevision: 3, payload: { title: 'Newest title', progress: 48 },
  })])
})

function pulledChange(sequence: number): PulledMetadataSyncChange {
  return {
    sequence,
    device_id: '9c025db3-12bc-4c7b-8be7-b6d0bd658fba',
    operation_id: `edc7ece7-86fc-4a68-95c9-${String(sequence).padStart(12, '0')}`,
    entity_type: 'setting',
    entity_id: `reader.setting.${sequence}`,
    operation: 'upsert',
    entity_revision: 1,
    payload: { value: 'paper' },
    occurred_at: '2026-10-21T00:00:00.000Z',
  }
}

test('controlled change-feed pull paginates to an empty page and delegates every payload to its handler', async () => {
  const requests: Array<{ after: number | undefined; limit: number | undefined }> = []
  const applied: number[] = []
  const pages = [[pulledChange(3), pulledChange(4)], [pulledChange(5)], []]

  const result = await pullMetadataSyncChangeFeed({
    session,
    afterSequence: 2,
    pageSize: 2,
    remote: {
      rpc: async (_name, input) => {
        requests.push({ after: input.p_after_sequence, limit: input.p_limit })
        return pages.shift() ?? []
      },
    },
    onChange: async (change) => { applied.push(change.sequence) },
  })

  expect(result).toEqual({ reason: 'completed', nextSequence: 5, pages: 3, received: 3, applied: 3 })
  expect(requests).toEqual([
    { after: 2, limit: 2 },
    { after: 4, limit: 2 },
    { after: 5, limit: 2 },
  ])
  expect(applied).toEqual([3, 4, 5])
})

test('controlled change-feed pull does not make any request for an anonymous session', async () => {
  let rpcCalls = 0
  const result = await pullMetadataSyncChangeFeed({
    session: { ...session, user: { ...session.user, isAnonymous: true } },
    afterSequence: 7,
    remote: { rpc: async () => { rpcCalls += 1; return [] } },
    onChange: () => undefined,
  })

  expect(result).toEqual({ reason: 'no-stable-account', nextSequence: 7, pages: 0, received: 0, applied: 0 })
  expect(rpcCalls).toBe(0)
})

test('controlled change-feed pull leaves cursor at the previous page when caller rejects an unsafe or unknown payload', async () => {
  const rejected = {
    ...pulledChange(8),
    entity_type: 'future_entity' as PulledMetadataSyncChange['entity_type'],
    payload: { object_key: 'must-be-rejected-by-caller' },
  }
  let rpcCalls = 0

  const result = await pullMetadataSyncChangeFeed({
    session,
    afterSequence: 7,
    remote: {
      rpc: async () => {
        rpcCalls += 1
        return [rejected]
      },
    },
    onChange: (change) => {
      if (change.entity_type !== 'setting' || 'object_key' in change.payload) {
        throw new Error('caller rejected unsupported feed payload')
      }
    },
  })

  expect(result.reason).toBe('handler-failure')
  expect(result.nextSequence).toBe(7)
  expect(result.pages).toBe(1)
  expect(result.received).toBe(1)
  expect(result.applied).toBe(0)
  expect(rpcCalls).toBe(1)
})

test('controlled change-feed pull returns the cursor after its configured page limit', async () => {
  const result = await pullMetadataSyncChangeFeed({
    session,
    afterSequence: 0,
    maxPages: 2,
    remote: { rpc: async (_name, input) => [pulledChange((input.p_after_sequence ?? 0) + 1)] },
    onChange: () => undefined,
  })

  expect(result).toEqual({ reason: 'page-limit', nextSequence: 2, pages: 2, received: 2, applied: 2 })
})
