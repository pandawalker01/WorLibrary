import type { AuthSession } from './auth'
import type { AppliedMetadataSyncChange, ApplyPrivateHighlightSyncChangeInput, PulledMetadataSyncChange, RemoteClient, RemoteRequestError } from './remote'
import type { MetadataSyncOutboxEntry } from './storage'

/**
 * Minimal boundary the flush engine needs from IndexedDB.  Keeping this
 * injectable lets callers use the real outbox while tests never need an
 * IndexedDB implementation.
 */
export type MetadataSyncOutboxStore = {
  list(userId: string): Promise<MetadataSyncOutboxEntry[]>
  /** Atomically reserve one local operation before its RPC is sent. */
  claim(userId: string, operationId: string, claimId: string): Promise<MetadataSyncOutboxEntry | null>
  /** Delete only the matching reservation and rebase later local work. */
  acknowledge(userId: string, operationId: string, claimId: string, entityRevision: number): Promise<boolean>
  /** Return a failed reservation to the retryable pending queue. */
  release(userId: string, operationId: string, claimId: string): Promise<boolean>
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
  /**
   * Lets the session owner invalidate an in-flight run after sign-out or an
   * account switch.  This is deliberately a synchronous predicate so the
   * engine can stop before every new storage or network step.
   */
  shouldContinue?: () => boolean
}

export type MetadataSyncFlushStopReason =
  | 'completed'
  | 'no-stable-account'
  | 'missing-device'
  | 'invalidated'
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
  /** See `MetadataSyncFlushInput.shouldContinue`. */
  shouldContinue?: () => boolean
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
  | 'invalidated'
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

function acknowledgedMutation(
  response: AppliedMetadataSyncChange[],
  operation: MetadataSyncOutboxEntry['operation'],
): AppliedMetadataSyncChange {
  const receipt = response[0]
  if (
    !Array.isArray(response)
    || response.length !== 1
    || !receipt
    || receipt.operation !== operation
    || typeof receipt.applied !== 'boolean'
    || !Number.isSafeInteger(receipt.sequence)
    || receipt.sequence < 1
    || !Number.isSafeInteger(receipt.entity_revision)
    || receipt.entity_revision < 1
  ) {
    throw new Error('同步服务返回了无效的 mutation 回执')
  }
  return receipt
}

async function releaseClaimAfterFailure(
  outbox: MetadataSyncOutboxStore,
  userId: string,
  operationId: string,
  claimId: string,
): Promise<void> {
  // A false result means another holder legitimately reclaimed or completed
  // the lease. Either way this flush must stop instead of deleting anything.
  await outbox.release(userId, operationId, claimId)
}

function privateHighlightRequest(entry: MetadataSyncOutboxEntry, serverDeviceId: string): ApplyPrivateHighlightSyncChangeInput {
  const payload = entry.payload
  const allowed = new Set(['edition_id', 'text', 'location', 'note', 'color', 'is_highlighted'])
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw new Error('私有摘录同步包含未允许字段')
  const base = {
    p_device_id: serverDeviceId,
    p_operation_id: entry.operationId,
    p_highlight_id: entry.entityId,
    p_operation: entry.operation,
    p_base_revision: entry.baseRevision,
  } as const
  if (entry.operation === 'delete') {
    if (Object.keys(payload).length > 0) throw new Error('删除摘录不能携带内容')
    return base
  }
  const editionId = payload.edition_id
  const text = payload.text
  const location = payload.location
  const note = payload.note
  const color = payload.color
  const isHighlighted = payload.is_highlighted
  if (typeof editionId !== 'string' || typeof text !== 'string' || typeof location !== 'string' || typeof isHighlighted !== 'boolean') {
    throw new Error('私有摘录同步字段无效')
  }
  if (note !== undefined && typeof note !== 'string') throw new Error('私有摘录笔记无效')
  if (color !== undefined && color !== 'gold' && color !== 'rose' && color !== 'blue') throw new Error('私有摘录颜色无效')
  return { ...base, p_edition_id: editionId, p_text: text, p_location: location, ...(note !== undefined ? { p_note: note } : {}), ...(color !== undefined ? { p_color: color } : {}), p_is_highlighted: isHighlighted }
}

async function applyOutboxEntry(remote: MetadataSyncRpcClient, entry: MetadataSyncOutboxEntry, serverDeviceId: string): Promise<AppliedMetadataSyncChange[]> {
  if (entry.entityType === 'highlight') {
    return remote.rpc('apply_private_highlight_sync_change', privateHighlightRequest(entry, serverDeviceId))
  }
  return remote.rpc('apply_metadata_sync_change', {
    p_device_id: serverDeviceId,
    p_operation_id: entry.operationId,
    p_entity_type: entry.entityType,
    p_entity_id: entry.entityId,
    p_operation: entry.operation,
    p_base_revision: entry.baseRevision,
    p_payload: entry.payload,
  })
}

/**
 * Flush metadata intents strictly in creation order. Each operation is
 * atomically claimed before its RPC leaves the browser. A newer edit made
 * during that request therefore becomes a separate pending intent; the exact
 * claim acknowledgement deletes only the sent operation and rebases the new
 * one to the returned server revision. Any failure releases only its matching
 * claim for idempotent retry. This module intentionally has no file/blob input
 * or storage API.
 */
export async function flushMetadataSyncOutbox(input: MetadataSyncFlushInput): Promise<MetadataSyncFlushResult> {
  if (!isStableSession(input.session)) {
    return { reason: 'no-stable-account', attempted: 0, confirmed: 0 }
  }
  if (!isValidDeviceId(input.serverDeviceId)) {
    return { reason: 'missing-device', attempted: 0, confirmed: 0 }
  }
  if (input.shouldContinue?.() === false) {
    return { reason: 'invalidated', attempted: 0, confirmed: 0 }
  }

  const entries = await input.outbox.list(input.session.user.id)
  let attempted = 0
  let confirmed = 0

  for (const listedEntry of entries) {
    if (input.shouldContinue?.() === false) {
      return { reason: 'invalidated', attempted, confirmed }
    }
    // A defensive account check makes an injected/misbehaving storage adapter
    // unable to send another account's intent through this session.
    if (listedEntry.userId !== input.session.user.id) continue
    const claimId = crypto.randomUUID()
    const entry = await input.outbox.claim(input.session.user.id, listedEntry.operationId, claimId)
    // A second local flush may have an active lease. Do not send or confirm an
    // unclaimed snapshot: it might have been superseded by a newer edit.
    if (!entry) continue
    if (input.shouldContinue?.() === false) {
      await releaseClaimAfterFailure(input.outbox, input.session.user.id, entry.operationId, claimId)
      return { reason: 'invalidated', attempted, confirmed }
    }
    attempted += 1
    try {
      const response = await applyOutboxEntry(input.remote, entry, input.serverDeviceId)
      const receipt = acknowledgedMutation(response, entry.operation)
      if (input.shouldContinue?.() === false) {
        await releaseClaimAfterFailure(input.outbox, input.session.user.id, entry.operationId, claimId)
        return { reason: 'invalidated', attempted, confirmed }
      }
      const acknowledged = await input.outbox.acknowledge(
        input.session.user.id,
        entry.operationId,
        claimId,
        receipt.entity_revision,
      )
      if (!acknowledged) {
        throw new Error('同步操作确认失败；本地队列未删除')
      }
      confirmed += 1
    } catch (error) {
      try {
        await releaseClaimAfterFailure(input.outbox, input.session.user.id, entry.operationId, claimId)
      } catch (releaseError) {
        return {
          reason: 'permanent-failure',
          attempted,
          confirmed,
          failedOperationId: entry.operationId,
          error: releaseError,
        }
      }
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
  if (input.shouldContinue?.() === false) {
    return { reason: 'invalidated', nextSequence, pages: 0, received: 0, applied: 0 }
  }

  const pageSize = boundedPositiveInteger(input.pageSize, 100, 200)
  const maxPages = boundedPositiveInteger(input.maxPages, 20, 1_000)
  let cursor = nextSequence
  let pages = 0
  let received = 0
  let applied = 0

  while (pages < maxPages) {
    if (input.shouldContinue?.() === false) {
      return { reason: 'invalidated', nextSequence: cursor, pages, received, applied }
    }
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
    if (input.shouldContinue?.() === false) {
      return { reason: 'invalidated', nextSequence: cursor, pages, received, applied }
    }
    if (!Array.isArray(page) || !pageHasStrictlyIncreasingSequences(page, cursor)) {
      return { reason: 'invalid-feed', nextSequence: cursor, pages, received, applied }
    }
    if (page.length === 0) {
      return { reason: 'completed', nextSequence: cursor, pages, received, applied }
    }

    received += page.length
    try {
      for (const change of page) {
        if (input.shouldContinue?.() === false) {
          return { reason: 'invalidated', nextSequence: cursor, pages, received, applied }
        }
        await input.onChange(change)
      }
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
