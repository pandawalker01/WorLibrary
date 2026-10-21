import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { assertSafeMetadataSyncPayload } from '../src/lib/storage'

test('metadata sync outbox is an account-scoped metadata-only IndexedDB store', async () => {
  const source = await readFile('src/lib/storage.ts', 'utf8')

  expect(source).toContain("const DB_VERSION = 6")
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
