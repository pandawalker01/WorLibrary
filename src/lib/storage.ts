export type CoverTone = 'ink' | 'sun' | 'red'

export type StoredBook = {
  id: string
  title: string
  author: string
  language: string
  progress: number
  cover: CoverTone
  /** A small, locally stored data URL extracted from the EPUB package. Never synced. */
  coverImage?: string
  /** Distinguishes an EPUB-supplied cover from an image the reader uploaded. */
  coverSource?: 'embedded' | 'custom'
  fileName: string
  fileType: string
  fileSize: number
  storage: 'opfs' | 'indexeddb'
  createdAt: number
  /** Most recent local reader activity; used only for the on-device reading history. */
  lastReadAt?: number
  location?: string
  workId?: string
  editionId?: string
}

export type Highlight = {
  id: string
  bookId: string
  text: string
  location: string
  note?: string
  color: 'gold' | 'rose' | 'blue'
  /** `false` keeps an excerpt without painting an EPUB annotation. Old records render by default. */
  isHighlighted?: boolean
  createdAt: number
  /** Local edit time used only for metadata conflict resolution during sync. */
  updatedAt?: number
}

/**
 * A durable, account-scoped intent to call the controlled metadata-sync RPC.
 * This store is deliberately separate from the local book and book-blob
 * stores: it may describe a local book, but it never owns its file bytes.
 */
export type MetadataSyncOutboxEntry = {
  operationId: string
  userId: string
  deviceClientId: string
  entityType: 'work' | 'edition' | 'reading_progress' | 'highlight' | 'library_item' | 'setting'
  entityId: string
  operation: 'upsert' | 'delete'
  baseRevision: number
  payload: Record<string, unknown>
  /**
   * `in-flight` is a short, local-only lease while one flush owns this exact
   * operation id.  A newer edition edit must create a fresh pending intent
   * instead of rewriting the bytes already handed to the RPC client.
   */
  status: 'pending' | 'in-flight'
  /** Never leaves this browser's metadata outbox or crosses the RPC boundary. */
  claimId?: string
  /** A crashed tab can be reclaimed after this timestamp and replayed safely. */
  claimExpiresAt?: number
  createdAt: number
}

export type CreateMetadataSyncOutboxEntry = Omit<MetadataSyncOutboxEntry, 'operationId' | 'status' | 'createdAt'> & {
  operationId?: string
}

/**
 * A remote edition's safe metadata shown on a second device before its owner
 * re-imports the original EPUB/PDF. This is intentionally not a StoredBook:
 * it has no local storage location, cover image, bytes, or reader entitlement.
 */
export type RemoteBookMetadataShadow = {
  key: string
  userId: string
  editionId: string
  revision: number
  sequence: number
  title: string
  author: string
  language: string
  progress: number
  location?: string
  fileName: string
  fileType: string
  fileSize: number
  cover: CoverTone
  needsReimport: true
}

export type UpsertRemoteBookMetadataShadow = Omit<RemoteBookMetadataShadow, 'key' | 'needsReimport'>

export type LibraryBackup = { version: 2; exportedAt: string; books: StoredBook[]; highlights: Highlight[]; files: Record<string, string>; works?: Work[]; editions?: Edition[]; alignments?: Alignment[] }

import type { Alignment, Edition, Work } from './edition'

const DB_NAME = 'wor-library'
const DB_VERSION = 8
const BOOKS_STORE = 'books'
const BLOBS_STORE = 'book-blobs'
const HIGHLIGHTS_STORE = 'highlights'
const WORKS_STORE = 'works'
const EDITIONS_STORE = 'editions'
const ALIGNMENTS_STORE = 'alignments'
const TEXT_INDEX_STORE = 'text-index'
const METADATA_SYNC_OUTBOX_STORE = 'metadata-sync-outbox'
const METADATA_SYNC_OUTBOX_BY_USER = 'by-user-id'
const REMOTE_BOOK_METADATA_SHADOWS_STORE = 'remote-book-metadata-shadows'
const REMOTE_BOOK_METADATA_SHADOWS_BY_USER = 'by-user-id'
const METADATA_SYNC_CURSORS_STORE = 'metadata-sync-cursors'
const METADATA_SYNC_ENTITY_REVISIONS_STORE = 'metadata-sync-entity-revisions'
const METADATA_SYNC_OUTBOX_CLAIM_LEASE_MS = 60_000

/**
 * The last server sequence safely applied for one stable account.  This is
 * intentionally a tiny, metadata-only record: it has no device identifier,
 * payload, URL, or any reference to original book files.
 */
export type MetadataSyncCursor = {
  userId: string
  sequence: number
  updatedAt: number
}

/**
 * The latest server revision seen for exactly one account-owned sync entity.
 * This contains routing metadata only: it deliberately has no entity payload,
 * book bytes, object reference, URL, text body, or reader location.
 */
export type MetadataSyncEntityRevision = {
  key: string
  userId: string
  entityType: MetadataSyncOutboxEntry['entityType']
  entityId: string
  revision: number
  lastSequence?: number
  updatedAt: number
}

const metadataSyncEntityTypes = new Set<MetadataSyncOutboxEntry['entityType']>([
  'work', 'edition', 'reading_progress', 'highlight', 'library_item', 'setting',
])

const forbiddenMetadataKeys = new Set([
  'blob', 'bookblob', 'filebytes', 'objectkey', 'contenturl', 'signedurl', 'rawcontent', 'body',
])

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('本地书库正在被旧页面占用，请关闭其他 WorLibrary 页面后刷新重试'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BOOKS_STORE)) db.createObjectStore(BOOKS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE)
      if (!db.objectStoreNames.contains(HIGHLIGHTS_STORE)) db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(WORKS_STORE)) db.createObjectStore(WORKS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(EDITIONS_STORE)) db.createObjectStore(EDITIONS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ALIGNMENTS_STORE)) db.createObjectStore(ALIGNMENTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(TEXT_INDEX_STORE)) db.createObjectStore(TEXT_INDEX_STORE, { keyPath: 'bookId' })
      if (!db.objectStoreNames.contains(METADATA_SYNC_OUTBOX_STORE)) {
        const outbox = db.createObjectStore(METADATA_SYNC_OUTBOX_STORE, { keyPath: 'operationId' })
        outbox.createIndex(METADATA_SYNC_OUTBOX_BY_USER, 'userId', { unique: false })
      } else {
        const outbox = request.transaction?.objectStore(METADATA_SYNC_OUTBOX_STORE)
        if (outbox && !outbox.indexNames.contains(METADATA_SYNC_OUTBOX_BY_USER)) {
          outbox.createIndex(METADATA_SYNC_OUTBOX_BY_USER, 'userId', { unique: false })
        }
      }
      if (!db.objectStoreNames.contains(REMOTE_BOOK_METADATA_SHADOWS_STORE)) {
        const shadows = db.createObjectStore(REMOTE_BOOK_METADATA_SHADOWS_STORE, { keyPath: 'key' })
        shadows.createIndex(REMOTE_BOOK_METADATA_SHADOWS_BY_USER, 'userId', { unique: false })
      } else {
        const shadows = request.transaction?.objectStore(REMOTE_BOOK_METADATA_SHADOWS_STORE)
        if (shadows && !shadows.indexNames.contains(REMOTE_BOOK_METADATA_SHADOWS_BY_USER)) {
          shadows.createIndex(REMOTE_BOOK_METADATA_SHADOWS_BY_USER, 'userId', { unique: false })
        }
      }
      if (!db.objectStoreNames.contains(METADATA_SYNC_CURSORS_STORE)) {
        db.createObjectStore(METADATA_SYNC_CURSORS_STORE, { keyPath: 'userId' })
      }
      if (!db.objectStoreNames.contains(METADATA_SYNC_ENTITY_REVISIONS_STORE)) {
        db.createObjectStore(METADATA_SYNC_ENTITY_REVISIONS_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // An older tab must release its connection when a newer schema is ready.
      // Otherwise a future import can wait forever on a blocked upgrade.
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

function transaction<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = operation(tx.objectStore(storeName))
    let value: T
    request.onerror = () => { db.close(); reject(request.error) }
    request.onsuccess = () => { value = request.result }
    tx.oncomplete = () => { db.close(); resolve(value) }
    tx.onabort = () => { db.close(); reject(tx.error ?? request.error) }
    tx.onerror = () => { db.close(); reject(tx.error ?? request.error) }
  }))
}

function assertNonEmptyMetadataSyncId(value: string, label: string, maximum = 256) {
  if (!value.trim() || value.length > maximum) throw new Error(`Invalid metadata sync ${label}`)
}

function isBlobLike(value: unknown): boolean {
  return (typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
    || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))
}

/**
 * Reject data which must never leave the device through metadata sync.  This
 * deliberately validates recursively because flexible `metadata` maps are a
 * common route for accidentally reintroducing a file/object locator.
 */
export function assertSafeMetadataSyncPayload(value: unknown): asserts value is Record<string, unknown> {
  const visited = new WeakSet<object>()
  const visit = (candidate: unknown, path: string): void => {
    if (candidate === null || typeof candidate === 'boolean') return
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error(`Metadata sync payload contains a non-finite number at ${path}`)
      return
    }
    if (typeof candidate === 'string') {
      if (/^\s*data:/i.test(candidate)) throw new Error(`Metadata sync payload cannot contain a data URL at ${path}`)
      return
    }
    if (isBlobLike(candidate)) throw new Error(`Metadata sync payload cannot contain binary data at ${path}`)
    if (Array.isArray(candidate)) {
      if (visited.has(candidate)) throw new Error(`Metadata sync payload cannot contain circular values at ${path}`)
      visited.add(candidate)
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (!candidate || typeof candidate !== 'object') throw new Error(`Metadata sync payload contains an unsupported value at ${path}`)
    const prototype = Object.getPrototypeOf(candidate)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Metadata sync payload must contain plain objects at ${path}`)
    }
    if (visited.has(candidate)) throw new Error(`Metadata sync payload cannot contain circular values at ${path}`)
    visited.add(candidate)
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[\s_-]/g, '')
      if (forbiddenMetadataKeys.has(normalizedKey)) {
        throw new Error(`Metadata sync payload cannot contain ${key}`)
      }
      visit(nested, `${path}.${key}`)
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value) || isBlobLike(value)) {
    throw new Error('Metadata sync payload must be a plain object')
  }
  visit(value, 'payload')
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('Metadata sync payload must be JSON serializable')
  }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 65_536) {
    throw new Error('Metadata sync payload exceeds the 64 KiB metadata limit')
  }
}

function outboxTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(METADATA_SYNC_OUTBOX_STORE, mode)
    let settled = false
    const finish = (value: T) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const fail = (reason: unknown) => {
      if (!settled) {
        settled = true
        reject(reason)
      }
    }
    tx.oncomplete = () => db.close()
    tx.onabort = () => { db.close(); fail(tx.error ?? new Error('Metadata sync outbox transaction aborted')) }
    tx.onerror = () => { db.close(); fail(tx.error ?? new Error('Metadata sync outbox transaction failed')) }
    try {
      action(tx.objectStore(METADATA_SYNC_OUTBOX_STORE), finish, fail)
    } catch (error) {
      tx.abort()
      fail(error)
    }
  }))
}

/**
 * Replace a pending edition upsert with a newer local snapshot without
 * creating a second optimistic mutation against the same server revision.
 *
 * The first operation id and base revision are deliberately retained. The
 * operation id remains idempotent at the RPC boundary, while the base
 * revision continues to describe the remote version from which this pending
 * local edit began. Only account-local, pending edition upserts can be
 * combined; deletes and every other entity keep their independent ordering.
 */
export function coalescePendingEditionMetadataSyncEntry(
  existing: MetadataSyncOutboxEntry,
  replacement: MetadataSyncOutboxEntry,
): MetadataSyncOutboxEntry | null {
  if (
    existing.userId !== replacement.userId
    || existing.entityType !== 'edition'
    || replacement.entityType !== 'edition'
    || existing.entityId !== replacement.entityId
    || existing.operation !== 'upsert'
    || replacement.operation !== 'upsert'
    || existing.status !== 'pending'
    || replacement.status !== 'pending'
  ) {
    return null
  }

  return {
    ...existing,
    // A replacement may follow a browser device re-registration. It must use
    // the current stable client id, but it never changes account ownership.
    deviceClientId: replacement.deviceClientId,
    payload: replacement.payload,
  }
}

/** Queue only sanitized metadata for one stable account and one local device. */
export async function createMetadataSyncOutboxEntry(input: CreateMetadataSyncOutboxEntry): Promise<MetadataSyncOutboxEntry> {
  assertNonEmptyMetadataSyncId(input.userId, 'user id')
  assertNonEmptyMetadataSyncId(input.deviceClientId, 'device client id')
  assertNonEmptyMetadataSyncId(input.entityId, 'entity id')
  if (!metadataSyncEntityTypes.has(input.entityType)) throw new Error('Invalid metadata sync entity type')
  if (input.operation !== 'upsert' && input.operation !== 'delete') throw new Error('Invalid metadata sync operation')
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new Error('Invalid metadata sync base revision')
  assertSafeMetadataSyncPayload(input.payload)
  if (input.operation === 'delete' && Object.keys(input.payload).length > 0) {
    throw new Error('Metadata sync delete operations cannot contain a payload')
  }

  const operationId = input.operationId ?? crypto.randomUUID()
  assertNonEmptyMetadataSyncId(operationId, 'operation id')
  const entry: MetadataSyncOutboxEntry = {
    operationId,
    userId: input.userId,
    deviceClientId: input.deviceClientId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    baseRevision: input.baseRevision,
    payload: input.payload,
    status: 'pending',
    createdAt: Date.now(),
  }

  return outboxTransaction('readwrite', (store, resolve, reject) => {
    const existingRequest = store.get(operationId)
    existingRequest.onerror = () => reject(existingRequest.error)
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as MetadataSyncOutboxEntry | undefined
      if (existing) {
        if (existing.userId !== entry.userId) {
          reject(new Error('Metadata sync operation id belongs to another account'))
          return
        }
        if (JSON.stringify(existing) !== JSON.stringify(entry)) {
          reject(new Error('Metadata sync operation id was already used for another mutation'))
          return
        }
        resolve(existing)
        return
      }

      // A local reader can write progress several times before the first
      // network flush. Keep one pending edition mutation per account/edition
      // so all of those snapshots apply against one base revision instead of
      // racing as multiple baseRevision=0 requests.
      const pendingRequest = store.index(METADATA_SYNC_OUTBOX_BY_USER).getAll(entry.userId)
      pendingRequest.onerror = () => reject(pendingRequest.error)
      pendingRequest.onsuccess = () => {
        const pendingEditionUpserts = (pendingRequest.result as MetadataSyncOutboxEntry[])
          .filter((candidate) => coalescePendingEditionMetadataSyncEntry(candidate, entry) !== null)
          .sort((left, right) => left.createdAt - right.createdAt)

        if (pendingEditionUpserts.length === 0) {
          const putRequest = store.put(entry)
          putRequest.onerror = () => reject(putRequest.error)
          putRequest.onsuccess = () => resolve(entry)
          return
        }

        const canonical = coalescePendingEditionMetadataSyncEntry(pendingEditionUpserts[0], entry)
        if (!canonical) {
          reject(new Error('Metadata sync edition coalescing failed'))
          return
        }

        // Heal any older duplicate pending intents in the same transaction.
        // Only their safe metadata is replaced; no book bytes or locators are
        // consulted or written here.
        const duplicateIds = pendingEditionUpserts.slice(1).map((candidate) => candidate.operationId)
        const putRequest = store.put(canonical)
        putRequest.onerror = () => reject(putRequest.error)
        putRequest.onsuccess = () => {
          if (duplicateIds.length === 0) {
            resolve(canonical)
            return
          }
          let removed = 0
          for (const duplicateId of duplicateIds) {
            const removeRequest = store.delete(duplicateId)
            removeRequest.onerror = () => reject(removeRequest.error)
            removeRequest.onsuccess = () => {
              removed += 1
              if (removed === duplicateIds.length) resolve(canonical)
            }
          }
        }
      }
    }
  })
}

/** List pending metadata intents for this account only. */
export async function listMetadataSyncOutbox(userId: string): Promise<MetadataSyncOutboxEntry[]> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  const now = Date.now()
  return outboxTransaction('readonly', (store, resolve, reject) => {
    const request = store.index(METADATA_SYNC_OUTBOX_BY_USER).getAll(userId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const entries = (request.result as MetadataSyncOutboxEntry[])
        // An expired lease is intentionally visible for a safe idempotent
        // replay after a tab/browser crash. A live lease remains hidden from
        // a concurrent local flush, which prevents a duplicate in-flight RPC.
        .filter((entry) => entry.userId === userId && (
          entry.status === 'pending'
          || (entry.status === 'in-flight'
            && typeof entry.claimExpiresAt === 'number'
            && Number.isSafeInteger(entry.claimExpiresAt)
            && entry.claimExpiresAt <= now)
        ))
        .sort((left, right) => left.createdAt - right.createdAt)
      resolve(entries)
    }
  })
}

/**
 * Atomically lease one queued operation before it is handed to the RPC
 * client. A claim token makes a late acknowledgement unable to delete work
 * that another local flush has safely reclaimed after a crash.
 */
export async function claimMetadataSyncOutboxEntry(
  userId: string,
  operationId: string,
  claimId: string,
): Promise<MetadataSyncOutboxEntry | null> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertNonEmptyMetadataSyncId(operationId, 'operation id')
  assertNonEmptyMetadataSyncId(claimId, 'claim id')
  const now = Date.now()
  return outboxTransaction('readwrite', (store, resolve, reject) => {
    const request = store.get(operationId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const entry = request.result as MetadataSyncOutboxEntry | undefined
      if (!entry || entry.userId !== userId) {
        resolve(null)
        return
      }
      const canClaim = entry.status === 'pending'
        || (entry.status === 'in-flight'
          && typeof entry.claimExpiresAt === 'number'
          && Number.isSafeInteger(entry.claimExpiresAt)
          && entry.claimExpiresAt <= now)
      if (!canClaim) {
        resolve(null)
        return
      }
      const claimed: MetadataSyncOutboxEntry = {
        ...entry,
        status: 'in-flight',
        claimId,
        claimExpiresAt: now + METADATA_SYNC_OUTBOX_CLAIM_LEASE_MS,
      }
      const put = store.put(claimed)
      put.onerror = () => reject(put.error)
      put.onsuccess = () => resolve(claimed)
    }
  })
}

/** Return a matching failed lease to pending status so it can be retried. */
export async function releaseMetadataSyncOutboxClaim(userId: string, operationId: string, claimId: string): Promise<boolean> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertNonEmptyMetadataSyncId(operationId, 'operation id')
  assertNonEmptyMetadataSyncId(claimId, 'claim id')
  return outboxTransaction('readwrite', (store, resolve, reject) => {
    const request = store.get(operationId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const entry = request.result as MetadataSyncOutboxEntry | undefined
      if (!entry || entry.userId !== userId || entry.status !== 'in-flight' || entry.claimId !== claimId) {
        resolve(false)
        return
      }
      const released: MetadataSyncOutboxEntry = { ...entry, status: 'pending' }
      delete released.claimId
      delete released.claimExpiresAt
      const put = store.put(released)
      put.onerror = () => reject(put.error)
      put.onsuccess = () => resolve(true)
    }
  })
}

/**
 * Acknowledge exactly the lease that was sent to the server. Besides deleting
 * that operation, atomically rebase later local intents for the same entity
 * to the returned server revision. This is what preserves a new edit made
 * while the older operation was in flight.
 */
export async function acknowledgeMetadataSyncOutboxEntry(
  userId: string,
  operationId: string,
  claimId: string,
  entityRevision: number,
): Promise<boolean> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertNonEmptyMetadataSyncId(operationId, 'operation id')
  assertNonEmptyMetadataSyncId(claimId, 'claim id')
  if (!Number.isSafeInteger(entityRevision) || entityRevision < 1) throw new Error('Invalid metadata sync entity revision')
  return outboxTransaction('readwrite', (store, resolve, reject) => {
    const request = store.get(operationId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const entry = request.result as MetadataSyncOutboxEntry | undefined
      if (!entry || entry.userId !== userId || entry.status !== 'in-flight' || entry.claimId !== claimId) {
        resolve(false)
        return
      }
      const allRequest = store.index(METADATA_SYNC_OUTBOX_BY_USER).getAll(userId)
      allRequest.onerror = () => reject(allRequest.error)
      allRequest.onsuccess = () => {
        const followUps = (allRequest.result as MetadataSyncOutboxEntry[])
          .filter((candidate) => candidate.operationId !== operationId
            && candidate.status === 'pending'
            && candidate.entityType === entry.entityType
            && candidate.entityId === entry.entityId)
          .map((candidate) => ({ ...candidate, baseRevision: entityRevision }))
        const writes: IDBRequest[] = [store.delete(operationId)]
        for (const followUp of followUps) writes.push(store.put(followUp))
        let completed = 0
        for (const write of writes) {
          write.onerror = () => reject(write.error)
          write.onsuccess = () => {
            completed += 1
            if (completed === writes.length) resolve(true)
          }
        }
      }
    }
  })
}

/** @deprecated Use claim + acknowledge so in-flight edits cannot be lost. */
export async function confirmMetadataSyncOutboxEntry(userId: string, operationId: string): Promise<boolean> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertNonEmptyMetadataSyncId(operationId, 'operation id')
  return outboxTransaction('readwrite', (store, resolve, reject) => {
    const request = store.get(operationId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const entry = request.result as MetadataSyncOutboxEntry | undefined
      if (!entry || entry.userId !== userId || entry.status !== 'pending') {
        resolve(false)
        return
      }
      const remove = store.delete(operationId)
      remove.onerror = () => reject(remove.error)
      remove.onsuccess = () => resolve(true)
    }
  })
}

/** Remove every pending metadata intent for exactly one account, never another. */
export async function clearMetadataSyncOutbox(userId: string): Promise<number> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  return outboxTransaction('readwrite', (store, resolve, reject) => {
    let removed = 0
    const request = store.index(METADATA_SYNC_OUTBOX_BY_USER).openCursor(IDBKeyRange.only(userId))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(removed)
        return
      }
      const entry = cursor.value as MetadataSyncOutboxEntry
      if (entry.userId !== userId) {
        cursor.continue()
        return
      }
      const remove = cursor.delete()
      remove.onerror = () => reject(remove.error)
      remove.onsuccess = () => {
        removed += 1
        cursor.continue()
      }
    }
  })
}

function remoteBookMetadataShadowKey(userId: string, editionId: string) {
  return `${userId}:${editionId}`
}

function assertMetadataSyncCursorSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Invalid metadata sync cursor sequence')
  }
}

function assertMetadataSyncEntityType(entityType: string): asserts entityType is MetadataSyncOutboxEntry['entityType'] {
  if (!metadataSyncEntityTypes.has(entityType as MetadataSyncOutboxEntry['entityType'])) {
    throw new Error('Invalid metadata sync entity type')
  }
}

function metadataSyncEntityRevisionKey(
  userId: string,
  entityType: MetadataSyncOutboxEntry['entityType'],
  entityId: string,
): string {
  // Length-prefix each component so an entity id containing a delimiter cannot
  // collide with another account/entity tuple.
  return `${userId.length}:${userId}${entityType.length}:${entityType}${entityId.length}:${entityId}`
}

function assertMetadataSyncEntityRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Invalid metadata sync entity revision')
  }
}

function metadataSyncCursorTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(METADATA_SYNC_CURSORS_STORE, mode)
    let settled = false
    let completed = false
    let result: T | undefined
    const finish = (nextValue: T) => {
      if (!settled) {
        completed = true
        result = nextValue
      }
    }
    const fail = (reason: unknown) => {
      if (!settled) {
        settled = true
        reject(reason)
      }
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && completed) {
        settled = true
        resolve(result as T)
      }
    }
    tx.onabort = () => { db.close(); fail(tx.error ?? new Error('Metadata sync cursor transaction aborted')) }
    tx.onerror = () => { db.close(); fail(tx.error ?? new Error('Metadata sync cursor transaction failed')) }
    try {
      action(tx.objectStore(METADATA_SYNC_CURSORS_STORE), finish, fail)
    } catch (error) {
      tx.abort()
      fail(error)
    }
  }))
}

/** Read only this stable account's durable feed cursor; missing starts at zero. */
export async function readMetadataSyncCursor(userId: string): Promise<number> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  return metadataSyncCursorTransaction('readonly', (store, resolve, reject) => {
    const request = store.get(userId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result as MetadataSyncCursor | undefined
      if (!cursor) {
        resolve(0)
        return
      }
      if (cursor.userId !== userId) {
        reject(new Error('Metadata sync cursor belongs to another account'))
        return
      }
      try {
        assertMetadataSyncCursorSequence(cursor.sequence)
        resolve(cursor.sequence)
      } catch (error) {
        reject(error)
      }
    }
  })
}

/**
 * Persist an account-scoped cursor without permitting an older browser tab to
 * move it backwards and replay an already accepted remote history.
 */
export async function writeMetadataSyncCursor(userId: string, sequence: number): Promise<void> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertMetadataSyncCursorSequence(sequence)
  return metadataSyncCursorTransaction('readwrite', (store, resolve, reject) => {
    const existingRequest = store.get(userId)
    existingRequest.onerror = () => reject(existingRequest.error)
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as MetadataSyncCursor | undefined
      if (existing && existing.userId !== userId) {
        reject(new Error('Metadata sync cursor belongs to another account'))
        return
      }
      try {
        if (existing) assertMetadataSyncCursorSequence(existing.sequence)
      } catch (error) {
        reject(error)
        return
      }
      const cursor: MetadataSyncCursor = {
        userId,
        sequence: Math.max(sequence, existing?.sequence ?? 0),
        updatedAt: Date.now(),
      }
      const putRequest = store.put(cursor)
      putRequest.onerror = () => reject(putRequest.error)
      putRequest.onsuccess = () => resolve()
    }
  })
}

function metadataSyncEntityRevisionTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(METADATA_SYNC_ENTITY_REVISIONS_STORE, mode)
    let settled = false
    let completed = false
    let result: T | undefined
    const finish = (nextValue: T) => {
      if (!settled) {
        completed = true
        result = nextValue
      }
    }
    const fail = (reason: unknown) => {
      if (!settled) {
        settled = true
        reject(reason)
      }
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && completed) {
        settled = true
        resolve(result as T)
      }
    }
    tx.onabort = () => { db.close(); fail(tx.error ?? new Error('Metadata sync entity revision transaction aborted')) }
    tx.onerror = () => { db.close(); fail(tx.error ?? new Error('Metadata sync entity revision transaction failed')) }
    try {
      action(tx.objectStore(METADATA_SYNC_ENTITY_REVISIONS_STORE), finish, fail)
    } catch (error) {
      tx.abort()
      fail(error)
    }
  }))
}

/** Read one account/entity's server revision. Missing entities have no revision. */
export async function readMetadataSyncEntityRevision(
  userId: string,
  entityType: MetadataSyncOutboxEntry['entityType'],
  entityId: string,
): Promise<MetadataSyncEntityRevision | null> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertMetadataSyncEntityType(entityType)
  assertNonEmptyMetadataSyncId(entityId, 'entity id')
  const key = metadataSyncEntityRevisionKey(userId, entityType, entityId)

  return metadataSyncEntityRevisionTransaction('readonly', (store, resolve, reject) => {
    const request = store.get(key)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const entry = request.result as MetadataSyncEntityRevision | undefined
      if (!entry) {
        resolve(null)
        return
      }
      if (entry.key !== key || entry.userId !== userId || entry.entityType !== entityType || entry.entityId !== entityId) {
        reject(new Error('Metadata sync entity revision belongs to another entity'))
        return
      }
      try {
        assertMetadataSyncEntityRevision(entry.revision)
        if (entry.lastSequence !== undefined) assertMetadataSyncCursorSequence(entry.lastSequence)
        resolve(entry)
      } catch (error) {
        reject(error)
      }
    }
  })
}

/**
 * Remember only a newer server revision/sequence for this account entity.
 * Independent monotonic maxima protect against an older tab moving either
 * marker backwards; there is never a content payload in this store.
 */
export async function writeMetadataSyncEntityRevision(input: {
  userId: string
  entityType: MetadataSyncOutboxEntry['entityType']
  entityId: string
  revision: number
  lastSequence?: number
}): Promise<MetadataSyncEntityRevision> {
  assertNonEmptyMetadataSyncId(input.userId, 'user id')
  assertMetadataSyncEntityType(input.entityType)
  assertNonEmptyMetadataSyncId(input.entityId, 'entity id')
  assertMetadataSyncEntityRevision(input.revision)
  if (input.lastSequence !== undefined) assertMetadataSyncCursorSequence(input.lastSequence)
  const key = metadataSyncEntityRevisionKey(input.userId, input.entityType, input.entityId)

  return metadataSyncEntityRevisionTransaction('readwrite', (store, resolve, reject) => {
    const existingRequest = store.get(key)
    existingRequest.onerror = () => reject(existingRequest.error)
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as MetadataSyncEntityRevision | undefined
      if (
        existing
        && (existing.key !== key || existing.userId !== input.userId || existing.entityType !== input.entityType || existing.entityId !== input.entityId)
      ) {
        reject(new Error('Metadata sync entity revision belongs to another entity'))
        return
      }
      try {
        if (existing) {
          assertMetadataSyncEntityRevision(existing.revision)
          if (existing.lastSequence !== undefined) assertMetadataSyncCursorSequence(existing.lastSequence)
        }
      } catch (error) {
        reject(error)
        return
      }

      const entry: MetadataSyncEntityRevision = {
        key,
        userId: input.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        revision: Math.max(input.revision, existing?.revision ?? 0),
        ...(input.lastSequence === undefined && existing?.lastSequence === undefined
          ? {}
          : { lastSequence: Math.max(input.lastSequence ?? 0, existing?.lastSequence ?? 0) }),
        updatedAt: Date.now(),
      }
      const putRequest = store.put(entry)
      putRequest.onerror = () => reject(putRequest.error)
      putRequest.onsuccess = () => resolve(entry)
    }
  })
}

function assertSafeRemoteBookMetadataString(value: string | undefined, label: string, maximum = 4_096, optional = false): asserts value is string | undefined {
  if (value === undefined && optional) return
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /^\s*data:/i.test(value)) {
    throw new Error(`Invalid remote book metadata ${label}`)
  }
}

function assertSafeRemoteBookMetadataNumber(value: number, label: string, maximum: number) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`Invalid remote book metadata ${label}`)
}

function remoteBookMetadataShadowTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(REMOTE_BOOK_METADATA_SHADOWS_STORE, mode)
    let settled = false
    const finish = (value: T) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const fail = (reason: unknown) => {
      if (!settled) {
        settled = true
        reject(reason)
      }
    }
    tx.oncomplete = () => db.close()
    tx.onabort = () => { db.close(); fail(tx.error ?? new Error('Remote book metadata shadow transaction aborted')) }
    tx.onerror = () => { db.close(); fail(tx.error ?? new Error('Remote book metadata shadow transaction failed')) }
    try {
      action(tx.objectStore(REMOTE_BOOK_METADATA_SHADOWS_STORE), finish, fail)
    } catch (error) {
      tx.abort()
      fail(error)
    }
  }))
}

/**
 * Persist a safe remote edition description for a specific account. The
 * caller must use the controlled sync feed's server revision and sequence;
 * this API never creates a StoredBook or a readable-file placeholder.
 */
export async function upsertRemoteBookMetadataShadow(input: UpsertRemoteBookMetadataShadow): Promise<RemoteBookMetadataShadow> {
  assertNonEmptyMetadataSyncId(input.userId, 'user id')
  assertNonEmptyMetadataSyncId(input.editionId, 'edition id')
  assertSafeRemoteBookMetadataString(input.title, 'title')
  assertSafeRemoteBookMetadataString(input.author, 'author')
  assertSafeRemoteBookMetadataString(input.language, 'language')
  assertSafeRemoteBookMetadataString(input.fileName, 'file name')
  assertSafeRemoteBookMetadataString(input.fileType, 'file type')
  assertSafeRemoteBookMetadataString(input.location, 'location', 4_096, true)
  assertSafeRemoteBookMetadataNumber(input.progress, 'progress', 100)
  assertSafeRemoteBookMetadataNumber(input.fileSize, 'file size', Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid remote book metadata revision')
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error('Invalid remote book metadata sequence')
  if (input.cover !== 'ink' && input.cover !== 'sun' && input.cover !== 'red') throw new Error('Invalid remote book metadata cover')

  const shadow: RemoteBookMetadataShadow = {
    key: remoteBookMetadataShadowKey(input.userId, input.editionId),
    userId: input.userId,
    editionId: input.editionId,
    revision: input.revision,
    sequence: input.sequence,
    title: input.title,
    author: input.author,
    language: input.language,
    progress: input.progress,
    location: input.location,
    fileName: input.fileName,
    fileType: input.fileType,
    fileSize: input.fileSize,
    cover: input.cover,
    needsReimport: true,
  }
  return remoteBookMetadataShadowTransaction('readwrite', (store, resolve, reject) => {
    const request = store.put(shadow)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(shadow)
  })
}

/** Read remote metadata shadows for exactly one account; never local books. */
export async function listRemoteBookMetadataShadows(userId: string): Promise<RemoteBookMetadataShadow[]> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  return remoteBookMetadataShadowTransaction('readonly', (store, resolve, reject) => {
    const request = store.index(REMOTE_BOOK_METADATA_SHADOWS_BY_USER).getAll(userId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve((request.result as RemoteBookMetadataShadow[])
      .filter((shadow) => shadow.userId === userId && shadow.needsReimport === true)
      .sort((left, right) => right.sequence - left.sequence))
  })
}

/** Delete a remote metadata shadow only when it belongs to the requesting account. */
export async function deleteRemoteBookMetadataShadow(userId: string, editionId: string): Promise<boolean> {
  assertNonEmptyMetadataSyncId(userId, 'user id')
  assertNonEmptyMetadataSyncId(editionId, 'edition id')
  const key = remoteBookMetadataShadowKey(userId, editionId)
  return remoteBookMetadataShadowTransaction('readwrite', (store, resolve, reject) => {
    const request = store.get(key)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const shadow = request.result as RemoteBookMetadataShadow | undefined
      if (!shadow || shadow.userId !== userId || shadow.editionId !== editionId) {
        resolve(false)
        return
      }
      const remove = store.delete(key)
      remove.onerror = () => reject(remove.error)
      remove.onsuccess = () => resolve(true)
    }
  })
}

function titleFromFile(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim() || '未命名书籍'
}

function extensionOf(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

type ImportedMetadata = { title?: string; author?: string; coverImage?: string }

const MAX_COVER_BYTES = 2 * 1024 * 1024

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('封面读取失败'))
    reader.readAsDataURL(blob)
  })
}

type EpubManifestItem = { id?: string; href?: string; properties?: string | string[]; type?: string; mediaType?: string; 'media-type'?: string }
type EpubPublication = {
  coverUrl?: () => Promise<string | undefined>
  packaging?: { manifest?: Record<string, EpubManifestItem>; metadata?: { cover?: string }; coverPath?: string }
  resolve?: (href: string) => string
  archive?: { getBlob?: (path: string) => Promise<Blob> | undefined }
}

async function imageDataUrl(blob: Blob | undefined, declaredType?: string): Promise<string | undefined> {
  if (!blob || blob.size > MAX_COVER_BYTES) return undefined
  // A few EPUB producers omit a MIME type in the ZIP entry. The OPF manifest
  // is authoritative in that case, and wrapping the bytes ensures FileReader
  // emits an image data URL that the shelf can render after a page reload.
  const mimeType = blob.type.startsWith('image/') ? blob.type : declaredType
  if (!mimeType?.startsWith('image/')) return undefined
  return blobToDataUrl(blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }))
}

async function archiveImage(publication: EpubPublication, href: string, declaredType?: string): Promise<string | undefined> {
  const getBlob = publication.archive?.getBlob?.bind(publication.archive)
  if (!getBlob) return undefined
  const resolved = publication.resolve?.(href)
  // epub.js archives expect a leading slash. Keep the original href as a
  // fallback for EPUBs whose manifest root differs from the package root.
  const candidates = [resolved, href.startsWith('/') ? href : `/${href}`, href]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
  for (const path of candidates) {
    try {
      const image = await imageDataUrl(await getBlob(path), declaredType)
      if (image) return image
    } catch {
      // Try another normalized package path before giving up on this image.
    }
  }
  return undefined
}

/**
 * Some EPUBs use an ordinary image in the manifest without declaring it as
 * `cover-image`. Prefer a cover-named image, then the first usable image.
 */
async function findManifestCover(publication: EpubPublication): Promise<string | undefined> {
  const manifest = publication.packaging?.manifest
  if (!manifest) return undefined
  const metadataCoverId = publication.packaging?.metadata?.cover
  const coverPath = publication.packaging?.coverPath
  const mediaType = (item: EpubManifestItem) => item.type ?? item.mediaType ?? item['media-type']
  const properties = (item: EpubManifestItem) => Array.isArray(item.properties) ? item.properties.join(' ') : item.properties ?? ''
  // epub.js normalizes OPF's `media-type` into `type`, whereas JSON manifests
  // commonly retain mediaType. Accept all three forms before ranking candidates.
  const images = Object.values(manifest).filter((item) => mediaType(item)?.startsWith('image/') && item.href)
  images.sort((left, right) => {
    const score = (item: EpubManifestItem) => {
      if (item.id && item.id === metadataCoverId) return 0
      if (item.href && item.href === coverPath) return 0
      if (/cover-image|cover/i.test(properties(item))) return 1
      if (/cover|title|front/i.test(item.href ?? '')) return 2
      return 3
    }
    return score(left) - score(right)
  })
  for (const image of images) {
    try {
      const cover = await archiveImage(publication, image.href!, mediaType(image))
      if (cover) return cover
    } catch {
      // Continue through the manifest: one corrupt image should not hide a later cover.
    }
  }
  return undefined
}

async function readImportedMetadata(file: File, extension: string): Promise<ImportedMetadata> {
  if (extension !== 'epub') return {}
  try {
    const { default: ePub } = await import('epubjs')
    const publication = ePub(await file.arrayBuffer())
    await publication.ready
    const metadata = await (publication.loaded as unknown as { metadata: Promise<{ title?: string; creator?: string }> }).metadata
    let coverImage: string | undefined
    const epub = publication as unknown as EpubPublication
    try {
      const coverUrl = await epub.coverUrl?.()
      if (coverUrl) {
        const response = await fetch(coverUrl)
        coverImage = await imageDataUrl(await response.blob())
      }
    } catch {
      // Blob URLs from a few archive implementations cannot be fetched. Fall
      // through to the OPF manifest rather than abandoning cover extraction.
    }
    try {
      coverImage ??= await findManifestCover(epub)
    } catch {
      // Cover art is optional; a readable EPUB should never fail to import because of it.
    }
    publication.destroy()
    return {
      title: metadata.title?.trim() || undefined,
      author: metadata.creator?.trim() || undefined,
      coverImage,
    }
  } catch {
    // A malformed book can still be stored and retried in the reader later.
    return {}
  }
}

async function ensureEditionForBook(book: StoredBook): Promise<StoredBook> {
  if (book.workId && book.editionId) return book
  const workId = crypto.randomUUID()
  const editionId = crypto.randomUUID()
  const migratedBook = { ...book, workId, editionId }
  const work: Work = { id: workId, title: book.title, author: book.author, editionIds: [editionId] }
  const extension = extensionOf(book.fileName)
  const edition: Edition = { id: editionId, workId, label: book.title, language: book.language, format: (['epub', 'pdf', 'mobi', 'cbz'].includes(extension) ? extension : 'epub') as Edition['format'], bookId: book.id, progress: book.progress, location: book.location }
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.put(migratedBook))
  await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put(edition))
  return migratedBook
}

async function writeToOpfs(id: string, file: File) {
  const storageManager = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>
  }
  if (!storageManager.getDirectory) return false
  const root = await storageManager.getDirectory()
  const handle = await root.getFileHandle(`${id}-${file.name}`, { create: true })
  const writable = await handle.createWritable()
  await writable.write(file)
  await writable.close()
  return true
}

export async function listBooks(): Promise<StoredBook[]> {
  const books = await transaction<StoredBook[]>('books', 'readonly', (store) => store.getAll())
  const migrated = await Promise.all(books.map(ensureEditionForBook))
  return migrated.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBook(file: File, index: number): Promise<StoredBook> {
  const extension = extensionOf(file.name)
  if (!['epub', 'pdf'].includes(extension)) throw new Error(`暂不支持 .${extension || 'unknown'} 文件，目前仅支持 EPUB 和 PDF`)
  if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} 超过 100 MB 限制`)
  const existing = await listBooks()
  if (existing.some((book) => book.fileName === file.name && book.fileSize === file.size)) {
    throw new Error(`${file.name} 已在书库中，无需重复导入`)
  }

  const metadata = await readImportedMetadata(file, extension)
  const id = crypto.randomUUID()
  let storage: StoredBook['storage'] = 'indexeddb'
  try {
    storage = await writeToOpfs(id, file) ? 'opfs' : 'indexeddb'
  } catch {
    storage = 'indexeddb'
  }
  if (storage === 'indexeddb') await transaction('book-blobs', 'readwrite', (store) => store.put(file, id))

  const book: StoredBook = {
    id,
    title: metadata.title ?? titleFromFile(file.name),
    author: metadata.author ?? '本地导入',
    language: `本地 · ${extension.toUpperCase()}`,
    progress: 0,
    cover: (['ink', 'sun', 'red'] as CoverTone[])[index % 3],
    coverImage: metadata.coverImage,
    coverSource: metadata.coverImage ? 'embedded' : undefined,
    fileName: file.name,
    fileType: file.type || `application/${extension}`,
    fileSize: file.size,
    storage,
    createdAt: Date.now(),
  }
  const workId = crypto.randomUUID()
  const editionId = crypto.randomUUID()
  book.workId = workId
  book.editionId = editionId
  await transaction('books', 'readwrite', (store) => store.put(book))
  const work: Work = { id: workId, title: book.title, author: book.author, editionIds: [editionId] }
  const edition: Edition = { id: editionId, workId, label: book.title, language: book.language, format: extension as Edition['format'], bookId: book.id, progress: 0 }
  await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put(edition))
  return book
}

/** Correct shelf metadata locally without touching the imported source file. */
export async function updateBookMetadata(bookId: string, input: Pick<StoredBook, 'title' | 'author'>): Promise<StoredBook> {
  const current = await transaction<StoredBook | undefined>(BOOKS_STORE, 'readonly', (store) => store.get(bookId))
  if (!current) throw new Error('找不到这本本地书籍，请刷新后重试')
  const title = input.title.trim()
  const author = input.author.trim()
  if (!title) throw new Error('请填写书名')
  if (!author) throw new Error('请填写作者；未知作者可填写“未知作者”')

  const updated = { ...current, title, author }
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.put(updated))
  const workId = updated.workId
  const editionId = updated.editionId
  if (workId) {
    const work = await transaction<Work | undefined>(WORKS_STORE, 'readonly', (store) => store.get(workId))
    if (work) await transaction(WORKS_STORE, 'readwrite', (store) => store.put({ ...work, title, author }))
  }
  if (editionId) {
    const edition = await transaction<Edition | undefined>(EDITIONS_STORE, 'readonly', (store) => store.get(editionId))
    if (edition) await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put({ ...edition, label: title }))
  }
  return updated
}

/** Re-read only the embedded EPUB cover for books imported before cover support existed. */
export async function refreshBookCover(bookId: string, options: { replaceLegacyCover?: boolean } = {}): Promise<StoredBook> {
  const current = await transaction<StoredBook | undefined>(BOOKS_STORE, 'readonly', (store) => store.get(bookId))
  if (!current) throw new Error('找不到这本本地书籍，请刷新后重试')
  if (extensionOf(current.fileName) !== 'epub') throw new Error('目前只能从 EPUB 中重新读取封面')
  if (current.coverSource === 'custom') throw new Error('已保留你上传的本地封面，不会被 EPUB 封面覆盖')
  // Older releases did not record the source. Do not overwrite a legacy image
  // without a visible confirmation from the settings UI.
  if (current.coverImage && !current.coverSource && !options.replaceLegacyCover) {
    throw new Error('这本书已有较早导入的封面，请确认后再用 EPUB 原书封面替换')
  }
  const file = await getBookFile(current)
  const { coverImage } = await readImportedMetadata(file, 'epub')
  if (!coverImage) throw new Error('这本 EPUB 未提供可用封面，将继续使用书架色块')
  const updated = { ...current, coverImage, coverSource: 'embedded' as const }
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.put(updated))
  return updated
}

/** Store a user-selected shelf cover locally when an EPUB does not expose one. */
export async function updateBookCover(bookId: string, file: File): Promise<StoredBook> {
  const current = await transaction<StoredBook | undefined>(BOOKS_STORE, 'readonly', (store) => store.get(bookId))
  if (!current) throw new Error('找不到这本本地书籍，请刷新后重试')
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件作为封面')
  if (file.size > MAX_COVER_BYTES) throw new Error('封面图片不能超过 2 MB')
  const updated = { ...current, coverImage: await blobToDataUrl(file), coverSource: 'custom' as const }
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.put(updated))
  return updated
}

export async function listWorks(): Promise<Work[]> {
  return transaction<Work[]>(WORKS_STORE, 'readonly', (store) => store.getAll())
}

export async function listEditions(workId?: string): Promise<Edition[]> {
  const editions = await transaction<Edition[]>(EDITIONS_STORE, 'readonly', (store) => store.getAll())
  return editions.filter((edition) => !workId || edition.workId === workId)
}

export async function listAlignments(workId?: string): Promise<Alignment[]> {
  const alignments = await transaction<Alignment[]>(ALIGNMENTS_STORE, 'readonly', (store) => store.getAll())
  return alignments.filter((alignment) => !workId || alignment.workId === workId)
}

export async function linkBookEditions(leftBookId: string, rightBookId: string): Promise<{ work: Work; alignment: Alignment }> {
  const books = await listBooks()
  const left = books.find((book) => book.id === leftBookId)
  const right = books.find((book) => book.id === rightBookId)
  if (!left || !right || leftBookId === rightBookId) throw new Error('请选择两本不同的本地书籍')
  const editions = await listEditions()
  const leftEdition = editions.find((edition) => edition.bookId === leftBookId)
  const rightEdition = editions.find((edition) => edition.bookId === rightBookId)
  if (!leftEdition || !rightEdition) throw new Error('找不到版本元数据，请重新导入书籍')
  const work: Work = { id: leftEdition.workId, title: left.title, author: left.author, editionIds: [leftEdition.id, rightEdition.id] }
  const alignment: Alignment = { id: crypto.randomUUID(), workId: work.id, leftEditionId: leftEdition.id, rightEditionId: rightEdition.id, confidence: 0 }
  await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put({ ...rightEdition, workId: work.id }))
  await transaction('books', 'readwrite', (store) => {
    store.put({ ...left, workId: work.id, editionId: leftEdition.id })
    return store.put({ ...right, workId: work.id, editionId: rightEdition.id })
  })
  await transaction(ALIGNMENTS_STORE, 'readwrite', (store) => store.put(alignment))
  return { work, alignment }
}

export async function saveEditionProgress(editionId: string, location: string, progress: number): Promise<void> {
  const current = await transaction<Edition | undefined>(EDITIONS_STORE, 'readonly', (store) => store.get(editionId))
  if (!current) return
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put({ ...current, location, progress: Math.max(0, Math.min(100, progress)) }))
}

export async function getBookFile(book: StoredBook): Promise<File> {
  if (book.storage === 'opfs') {
    const storageManager = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>
    }
    if (storageManager.getDirectory) {
      const root = await storageManager.getDirectory()
      const handle = await root.getFileHandle(`${book.id}-${book.fileName}`)
      return handle.getFile()
    }
  }
  const blob = await transaction<Blob | undefined>('book-blobs', 'readonly', (store) => store.get(book.id))
  if (!blob) throw new Error('找不到本地书籍文件，请重新导入')
  return new File([blob], book.fileName, { type: book.fileType })
}

export type BookTextIndex = { bookId: string; text: string; updatedAt: number }

/** Store extracted text locally for search. This store is intentionally excluded from sync snapshots. */
export async function saveBookTextIndex(bookId: string, text: string): Promise<void> {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return
  await transaction(TEXT_INDEX_STORE, 'readwrite', (store) => store.put({ bookId, text: normalized.slice(0, 2_000_000), updatedAt: Date.now() } satisfies BookTextIndex))
}

export async function searchBookTextIndex(query: string): Promise<Array<{ bookId: string; snippet: string }>> {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return []
  const indexes = await transaction<BookTextIndex[]>(TEXT_INDEX_STORE, 'readonly', (store) => store.getAll())
  return indexes.filter((index) => index.text.toLocaleLowerCase().includes(normalized)).map((index) => {
    const source = index.text
    const at = source.toLocaleLowerCase().indexOf(normalized)
    const start = Math.max(0, at - 55)
    const end = Math.min(source.length, at + normalized.length + 95)
    return { bookId: index.bookId, snippet: `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}` }
  })
}

export async function saveReadingProgress(bookId: string, location: string, progress: number): Promise<void> {
  const current = await transaction<StoredBook | undefined>('books', 'readonly', (store) => store.get(bookId))
  if (!current) return
  await transaction('books', 'readwrite', (store) => store.put({
    ...current,
    location,
    progress: Math.max(0, Math.min(100, progress)),
    lastReadAt: Date.now(),
  }))
}

export async function saveHighlight(input: Omit<Highlight, 'id' | 'createdAt'>): Promise<Highlight> {
  const now = Date.now()
  const highlight: Highlight = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put(highlight))
  return highlight
}

export async function listHighlights(bookId?: string): Promise<Highlight[]> {
  const highlights = await transaction<Highlight[]>(HIGHLIGHTS_STORE, 'readonly', (store) => store.getAll())
  return highlights.filter((highlight) => !bookId || highlight.bookId === bookId).sort((a, b) => b.createdAt - a.createdAt)
}

export async function updateHighlightNote(id: string, note: string): Promise<void> {
  const current = await transaction<Highlight | undefined>(HIGHLIGHTS_STORE, 'readonly', (store) => store.get(id))
  if (!current) return
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put({ ...current, note, updatedAt: Date.now() }))
}

export async function updateHighlightColor(id: string, color: Highlight['color']): Promise<void> {
  const current = await transaction<Highlight | undefined>(HIGHLIGHTS_STORE, 'readonly', (store) => store.get(id))
  if (!current) return
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put({ ...current, color, updatedAt: Date.now() }))
}

export async function deleteHighlight(id: string): Promise<void> {
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.delete(id))
}

export async function deleteBook(book: StoredBook): Promise<void> {
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.delete(book.id))
  await transaction(BLOBS_STORE, 'readwrite', (store) => store.delete(book.id))
  await transaction(TEXT_INDEX_STORE, 'readwrite', (store) => store.delete(book.id))
  const storageManager = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  if (book.storage === 'opfs' && storageManager.getDirectory) {
    try {
      const root = await storageManager.getDirectory()
      await root.removeEntry(`${book.id}-${book.fileName}`)
    } catch {
      // The metadata is already gone; a missing OPFS entry is safe to ignore.
    }
  }
  const highlights = await listHighlights(book.id)
  await Promise.all(highlights.map((highlight) => deleteHighlight(highlight.id)))
}

function encodeBytes(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  return btoa(binary)
}

function decodeBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function exportLibraryData(): Promise<LibraryBackup> {
  const books = await listBooks()
  const files: Record<string, string> = {}
  for (const book of books) {
    const buffer = await (await getBookFile(book)).arrayBuffer()
    files[book.id] = encodeBytes(new Uint8Array(buffer as ArrayBuffer))
  }
  return { version: 2, exportedAt: new Date().toISOString(), books, highlights: await listHighlights(), files, works: await listWorks(), editions: await listEditions(), alignments: await listAlignments() }
}

export async function importLibraryData(backup: LibraryBackup): Promise<{ books: number; highlights: number }> {
  if (backup.version !== 2 || !Array.isArray(backup.books) || !Array.isArray(backup.highlights) || !backup.files) throw new Error('备份版本过旧，请重新导出')
  // Validate and decode every source file before writing anything. Previously a
  // backup missing one `files[book.id]` entry created a visible shelf record
  // backed by an empty Blob, which could only fail later when the reader opened.
  // A rejected backup must leave the existing local shelf untouched.
  const importedFiles = backup.books.map((book) => {
    const encoded = backup.files[book.id]
    if (typeof encoded !== 'string' || encoded.length === 0) throw new Error(`备份缺少《${book.title || book.fileName}》的原始文件，已取消导入`)
    try {
      return { book, bytes: decodeBytes(encoded) }
    } catch {
      throw new Error(`备份中的《${book.title || book.fileName}》文件已损坏，已取消导入`)
    }
  })
  for (const { book, bytes } of importedFiles) {
    await transaction(BLOBS_STORE, 'readwrite', (store) => store.put(new Blob([bytes], { type: book.fileType }), book.id))
    await transaction(BOOKS_STORE, 'readwrite', (store) => store.put({ ...book, storage: 'indexeddb' }))
  }
  for (const highlight of backup.highlights) await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put(highlight))
  for (const work of backup.works ?? []) await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  for (const edition of backup.editions ?? []) await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put(edition))
  for (const alignment of backup.alignments ?? []) await transaction(ALIGNMENTS_STORE, 'readwrite', (store) => store.put(alignment))
  return { books: backup.books.length, highlights: backup.highlights.length }
}
