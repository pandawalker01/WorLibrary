import type { AuthSession } from './auth'
import type { PulledMetadataSyncChange, RemoteClient, RemoteRequestError } from './remote'
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

export type MetadataSyncChangeFeedHandler = (change: PulledMetadataSyncChange) => void | Promise<void>

export type PullMetadataSyncChangeFeedInput = {
  session: AuthSession | null
  remote: MetadataSyncRpcClient
  /** The opaque durable cursor last confirmed by the caller. */
  afterSequence?: number
  /** The server permits 1–200 rows per page; the default is deliberately small. */
  pageSize?: number
  /** Bounded polling prevents an accidental full-history loop in one UI tick. */
  maxPages?: number
  /**
   * The application validates and applies each sanitized server change.  This
   * engine deliberately does not interpret entity payloads: new entity types
   * or unsafe/unhandled payloads must be rejected by this caller-owned hook.
   */
  onChange: MetadataSyncChangeFeedHandler
}

export type PullMetadataSyncChangeFeedStopReason =
  | 'completed'
  | 'no-stable-account'
  | 'page-limit'
  | 'invalid-feed'
  | 'handler-failure'
  | 'remote-failure'

export type PullMetadataSyncChangeFeedResult = {
  reason: PullMetadataSyncChangeFeedStopReason
  /** Only advances after the entire corresponding page was accepted. */
  nextSequence: number
  pages: number
  received: number
  applied: number
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

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value!)))
}

function validCursor(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('同步游标必须是非负安全整数')
  return value
}

function pageHasStrictlyIncreasingSequences(page: PulledMetadataSyncChange[], afterSequence: number): boolean {
  let previous = afterSequence
  return page.every((change) => {
    if (!Number.isSafeInteger(change.sequence) || change.sequence <= previous) return false
    previous = change.sequence
    return true
  })
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

/**
 * Pull the server-authoritative, account-scoped metadata change feed.  The
 * function owns pagination only; it neither writes IndexedDB nor interprets
 * content.  In particular, callers must validate each entity/payload and
 * persist their cursor only after this result's `nextSequence` is durable.
 */
export async function pullMetadataSyncChangeFeed(input: PullMetadataSyncChangeFeedInput): Promise<PullMetadataSyncChangeFeedResult> {
  const nextSequence = validCursor(input.afterSequence)
  if (!isStableSession(input.session)) {
    return { reason: 'no-stable-account', nextSequence, pages: 0, received: 0, applied: 0 }
  }

  const pageSize = boundedPositiveInteger(input.pageSize, 100, 200)
  const maxPages = boundedPositiveInteger(input.maxPages, 20, 1_000)
  let cursor = nextSequence
  let pages = 0
  let received = 0
  let applied = 0

  while (pages < maxPages) {
    let page: PulledMetadataSyncChange[]
    try {
      page = await input.remote.rpc('pull_metadata_sync_changes', {
        p_after_sequence: cursor,
        p_limit: pageSize,
      })
    } catch (error) {
      return { reason: 'remote-failure', nextSequence: cursor, pages, received, applied, error }
    }
    pages += 1
    if (!Array.isArray(page) || !pageHasStrictlyIncreasingSequences(page, cursor)) {
      return { reason: 'invalid-feed', nextSequence: cursor, pages, received, applied }
    }
    if (page.length === 0) {
      return { reason: 'completed', nextSequence: cursor, pages, received, applied }
    }

    received += page.length
    try {
      for (const change of page) await input.onChange(change)
    } catch (error) {
      // Do not advance the durable cursor past a partially handled page.  The
      // caller's handler must therefore be idempotent by operation id.
      return { reason: 'handler-failure', nextSequence: cursor, pages, received, applied, error }
    }
    applied += page.length
    cursor = page[page.length - 1].sequence
  }

  return { reason: 'page-limit', nextSequence: cursor, pages, received, applied }
}
