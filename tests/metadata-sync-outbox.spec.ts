import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import {
  assertSafeMetadataSyncPayload,
  coalescePendingEditionMetadataSyncEntry,
  type MetadataSyncOutboxEntry,
} from '../src/lib/storage'

function editionEntry(overrides: Partial<MetadataSyncOutboxEntry> = {}): MetadataSyncOutboxEntry {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    userId: 'account-a',
    deviceClientId: 'device-a',
    entityType: 'edition',
    entityId: '22222222-2222-4222-8222-222222222222',
    operation: 'upsert',
    baseRevision: 0,
    payload: { title: 'Earlier title', progress: 12 },
    status: 'pending',
    createdAt: 100,
    ...overrides,
  }
}

test('metadata sync outbox is an account-scoped metadata-only IndexedDB store', async () => {
  const source = await readFile('src/lib/storage.ts', 'utf8')

  expect(source).toContain("const DB_VERSION = 8")
  expect(source).toContain("const METADATA_SYNC_OUTBOX_STORE = 'metadata-sync-outbox'")
  expect(source).toContain("outbox.createIndex(METADATA_SYNC_OUTBOX_BY_USER, 'userId'")
  expect(source).toContain('createMetadataSyncOutboxEntry')
  expect(source).toContain('listMetadataSyncOutbox')
  expect(source).toContain('confirmMetadataSyncOutboxEntry')
  expect(source).toContain('clearMetadataSyncOutbox')
  expect(source).toContain("existing.userId !== entry.userId")
  expect(source).toContain("entry.userId !== userId")
  expect(source).toContain("status: 'pending'")
  expect(source).toContain('baseRevision: input.baseRevision')
  expect(source).toContain('coalescePendingEditionMetadataSyncEntry')
  expect(source).toContain('store.index(METADATA_SYNC_OUTBOX_BY_USER).getAll(entry.userId)')
})

test('pending local edition upserts coalesce by account and edition while retaining idempotency and base revision', () => {
  const earlier = editionEntry()
  const latest = editionEntry({
    operationId: '33333333-3333-4333-8333-333333333333',
    deviceClientId: 'device-current',
    baseRevision: 7,
    payload: { title: 'Latest title', progress: 48 },
    createdAt: 200,
  })

  expect(coalescePendingEditionMetadataSyncEntry(earlier, latest)).toEqual({
    ...earlier,
    deviceClientId: 'device-current',
    payload: { title: 'Latest title', progress: 48 },
  })
})

test('edition outbox coalescing never crosses accounts or changes delete/non-edition ordering', () => {
  const earlier = editionEntry()
  const latest = editionEntry({ operationId: '33333333-3333-4333-8333-333333333333' })

  expect(coalescePendingEditionMetadataSyncEntry(earlier, { ...latest, userId: 'account-b' })).toBeNull()
  expect(coalescePendingEditionMetadataSyncEntry(earlier, { ...latest, entityId: 'other-edition' })).toBeNull()
  expect(coalescePendingEditionMetadataSyncEntry(earlier, { ...latest, operation: 'delete', payload: {} })).toBeNull()
  expect(coalescePendingEditionMetadataSyncEntry(earlier, { ...latest, entityType: 'highlight' })).toBeNull()
})

test('metadata sync cursors are durable, account-scoped, monotonic, and metadata-only', async () => {
  const source = await readFile('src/lib/storage.ts', 'utf8')

  expect(source).toContain("const METADATA_SYNC_CURSORS_STORE = 'metadata-sync-cursors'")
  expect(source).toContain("db.createObjectStore(METADATA_SYNC_CURSORS_STORE, { keyPath: 'userId' })")
  expect(source).toContain('readMetadataSyncCursor')
  expect(source).toContain('writeMetadataSyncCursor')
  expect(source).toContain("resolve(0)")
  expect(source).toContain("cursor.userId !== userId")
  expect(source).toContain('Math.max(sequence, existing?.sequence ?? 0)')
  const cursorType = source.slice(source.indexOf('export type MetadataSyncCursor'), source.indexOf('/**\n * The latest server revision'))
  expect(cursorType).toContain('userId: string')
  expect(cursorType).toContain('sequence: number')
  expect(cursorType).not.toContain('payload')
  expect(cursorType).not.toContain('url')
  expect(cursorType).not.toContain('blob')
})

test('metadata sync entity revisions are keyed by account and entity, and exclude all content fields', async () => {
  const source = await readFile('src/lib/storage.ts', 'utf8')
  expect(source).toContain("const METADATA_SYNC_ENTITY_REVISIONS_STORE = 'metadata-sync-entity-revisions'")
  expect(source).toContain('export type MetadataSyncEntityRevision')
  expect(source).toContain('readMetadataSyncEntityRevision')
  expect(source).toContain('writeMetadataSyncEntityRevision')
  expect(source).toContain('metadataSyncEntityRevisionKey')

  const entityType = source.slice(source.indexOf('export type MetadataSyncEntityRevision'), source.indexOf('const metadataSyncEntityTypes'))
  expect(entityType).toContain('userId: string')
  expect(entityType).toContain('entityType: MetadataSyncOutboxEntry')
  expect(entityType).toContain('entityId: string')
  expect(entityType).toContain('revision: number')
  expect(entityType).toContain('lastSequence?: number')
  expect(entityType).not.toMatch(/payload|url|blob|body|content|file/i)
})

test('remote metadata shadows are account-scoped, require re-import, and never become local books', async () => {
  const source = await readFile('src/lib/storage.ts', 'utf8')

  expect(source).toContain("const REMOTE_BOOK_METADATA_SHADOWS_STORE = 'remote-book-metadata-shadows'")
  expect(source).toContain("shadows.createIndex(REMOTE_BOOK_METADATA_SHADOWS_BY_USER, 'userId'")
  expect(source).toContain('upsertRemoteBookMetadataShadow')
  expect(source).toContain('listRemoteBookMetadataShadows')
  expect(source).toContain('deleteRemoteBookMetadataShadow')
  expect(source).toContain('needsReimport: true')
  expect(source).toContain('remoteBookMetadataShadowKey(input.userId, input.editionId)')
  const shadowType = source.slice(source.indexOf('export type RemoteBookMetadataShadow'), source.indexOf('export type UpsertRemoteBookMetadataShadow'))
  expect(shadowType).not.toContain('coverImage')
  expect(shadowType).not.toContain('storage:')
  expect(shadowType).not.toContain('objectKey')
  expect(shadowType).not.toContain('contentUrl')
})

test('metadata sync payload guard accepts bounded metadata and rejects file-bearing values', () => {
  expect(() => assertSafeMetadataSyncPayload({ title: 'A book', nested: { count: 2 }, tags: ['reading'] })).not.toThrow()

  for (const payload of [
    { blob: 'not allowed' },
    { nested: { object_key: 'private/book.epub' } },
    { contentUrl: 'https://content.example/book.epub' },
    { body: 'full text' },
    { preview: 'data:text/plain;base64,SGVsbG8=' },
    { bytes: new ArrayBuffer(8) },
  ]) {
    expect(() => assertSafeMetadataSyncPayload(payload)).toThrow(/Metadata sync payload/i)
  }
})
