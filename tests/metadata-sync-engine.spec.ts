import { expect, test } from '@playwright/test'
import type { AuthSession } from '../src/lib/auth'
import { flushMetadataSyncOutbox } from '../src/lib/metadata-sync-engine'
import { RemoteRequestError } from '../src/lib/remote'
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
  return {
    calls,
    confirmations,
    outbox: {
      list: async (userId: string) => {
        calls.push(`list:${userId}`)
        return entries
      },
      confirm: async (userId: string, operationId: string) => {
        confirmations.push(`${userId}:${operationId}`)
        return true
      },
    },
  }
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
