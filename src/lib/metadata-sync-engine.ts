import type { AuthSession } from './auth'
import type { RemoteClient, RemoteRequestError } from './remote'
import type { MetadataSyncOutboxEntry } from './storage'

/**
 * Minimal boundary the flush engine needs from IndexedDB.  Keeping this
 * injectable lets callers use the real outbox while tests never need an
 * IndexedDB implementation.
 */
export type MetadataSyncOutboxStore = {
  list(userId: string): Promise<MetadataSyncOutboxEntry[]>
  confirm(userId: string, operationId: string): Promise<boolean>
}

export type MetadataSyncRpcClient = Pick<RemoteClient, 'rpc'>

export type MetadataSyncFlushInput = {
  session: AuthSession | null
  /**
   * The active owned server device returned by register_sync_device.  Device
   * registration belongs to the session orchestration layer, not this loop.
   */
  serverDeviceId: string | null
  remote: MetadataSyncRpcClient
  outbox: MetadataSyncOutboxStore
}

export type MetadataSyncFlushStopReason =
  | 'completed'
  | 'no-stable-account'
  | 'missing-device'
  | 'retryable-failure'
  | 'conflict'
  | 'permanent-failure'

export type MetadataSyncFlushResult = {
  reason: MetadataSyncFlushStopReason
  attempted: number
  confirmed: number
  failedOperationId?: string
  error?: unknown
}

function isStableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function isRetryableSyncError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'retryable' in error
    && (error as RemoteRequestError).retryable === true
}

function isConflictError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status = 'status' in error ? (error as RemoteRequestError).status : undefined
  if (status === 409) return true
  return error instanceof Error && /stale base revision|conflict/i.test(error.message)
}

function isValidDeviceId(value: string | null): value is string {
  return Boolean(value?.trim())
}

/**
 * Flush metadata intents strictly in creation order.  A successful RPC (also
 * an idempotent `applied: false` replay) is the only condition that removes an
 * outbox entry.  Any failure leaves the failed entry and every later entry in
 * place so another device's change cannot be skipped or silently overwritten.
 * This module intentionally has no file/blob input or storage API.
 */
export async function flushMetadataSyncOutbox(input: MetadataSyncFlushInput): Promise<MetadataSyncFlushResult> {
  if (!isStableSession(input.session)) {
    return { reason: 'no-stable-account', attempted: 0, confirmed: 0 }
  }
  if (!isValidDeviceId(input.serverDeviceId)) {
    return { reason: 'missing-device', attempted: 0, confirmed: 0 }
  }

  const entries = await input.outbox.list(input.session.user.id)
  let attempted = 0
  let confirmed = 0

  for (const entry of entries) {
    // A defensive account check makes an injected/misbehaving storage adapter
    // unable to send another account's intent through this session.
    if (entry.userId !== input.session.user.id) continue
    attempted += 1
    try {
      const response = await input.remote.rpc('apply_metadata_sync_change', {
        p_device_id: input.serverDeviceId,
        p_operation_id: entry.operationId,
        p_entity_type: entry.entityType,
        p_entity_id: entry.entityId,
        p_operation: entry.operation,
        p_base_revision: entry.baseRevision,
        p_payload: entry.payload,
      })
      if (!Array.isArray(response) || response.length !== 1) {
        throw new Error('同步服务返回了无效的 mutation 回执')
      }
      const acknowledged = await input.outbox.confirm(input.session.user.id, entry.operationId)
      if (!acknowledged) {
        throw new Error('同步操作确认失败；本地队列未删除')
      }
      confirmed += 1
    } catch (error) {
      const reason: MetadataSyncFlushStopReason = isRetryableSyncError(error)
        ? 'retryable-failure'
        : isConflictError(error)
          ? 'conflict'
          : 'permanent-failure'
      return { reason, attempted, confirmed, failedOperationId: entry.operationId, error }
    }
  }

  return { reason: 'completed', attempted, confirmed }
}
