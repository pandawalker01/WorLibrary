import { expect, test } from '@playwright/test'
import type { AuthSession } from '../src/lib/auth'
import {
  enqueueLocalEditionMetadataSyncIntent,
} from '../src/lib/metadata-sync-edition-intent'
import {
  SYNC_CLIENT_INSTANCE_STORAGE_KEY,
  type ClientInstanceStorage,
} from '../src/lib/device-registration-session'
import type { CreateMetadataSyncOutboxEntry, MetadataSyncOutboxEntry, StoredBook } from '../src/lib/storage'

const session: AuthSession = {
  accessToken: 'session-token', refreshToken: 'refresh-token', user: { id: 'stable-user', isAnonymous: false },
}
const clientInstanceId = 'a1d8eb2c-6996-4b5a-928f-2c429c083e69'
const editionId = 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7'

function book(overrides: Partial<StoredBook> = {}): StoredBook {
  return {
    id: 'local-book-id', title: 'A local EPUB', author: 'Reader', language: 'en', progress: 22,
    cover: 'ink', coverImage: 'data:image/png;base64,not-synced', fileName: 'reader.epub',
    fileType: 'application/epub+zip', fileSize: 2048, storage: 'indexeddb', createdAt: 1,
    location: 'epubcfi(/6/2)', editionId,
    ...overrides,
  }
}

function storage(initial: string | null = null): ClientInstanceStorage & { reads: number; writes: Array<[string, string]> } {
  let value = initial
  const valueStorage: ClientInstanceStorage & { reads: number; writes: Array<[string, string]> } = {
    reads: 0,
    writes: [],
    getItem: (key) => {
      expect(key).toBe(SYNC_CLIENT_INSTANCE_STORAGE_KEY)
      valueStorage.reads += 1
      return value
    },
    setItem: (key, next) => {
      expect(key).toBe(SYNC_CLIENT_INSTANCE_STORAGE_KEY)
      valueStorage.writes.push([key, next])
      value = next
    },
  }
  return valueStorage
}

function captureEnqueue(entries: CreateMetadataSyncOutboxEntry[]) {
  return async (input: CreateMetadataSyncOutboxEntry): Promise<MetadataSyncOutboxEntry> => {
    entries.push(input)
    return { ...input, operationId: input.operationId ?? 'a005f008-79a8-49f0-bdaa-0c9c468add46', status: 'pending', createdAt: 2 }
  }
}

test('a stable local edition queues only whitelisted metadata with the device registration client UUID', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const deviceStorage = storage(clientInstanceId)

  const result = await enqueueLocalEditionMetadataSyncIntent({
    session, book: book(), deviceStorage, enqueue: captureEnqueue(entries), operationId: 'a005f008-79a8-49f0-bdaa-0c9c468add46',
  })

  expect(result.status).toBe('queued')
  expect(deviceStorage.reads).toBe(1)
  expect(deviceStorage.writes).toEqual([])
  expect(entries).toEqual([{
    operationId: 'a005f008-79a8-49f0-bdaa-0c9c468add46', userId: 'stable-user', deviceClientId: clientInstanceId,
    entityType: 'edition', entityId: editionId, operation: 'upsert', baseRevision: 0,
    payload: {
      title: 'A local EPUB', author: 'Reader', language: 'en', progress: 22,
      location: 'epubcfi(/6/2)', file_name: 'reader.epub', file_type: 'epub', file_size: 2048,
      cover: 'ink',
    },
  }])
  expect(JSON.stringify(entries)).not.toContain('coverImage')
  expect(JSON.stringify(entries)).not.toContain('data:image')
  expect(JSON.stringify(entries)).not.toContain('local-book-id')
  expect(JSON.stringify(entries)).not.toContain('work_id')
})

test('a stable local edition deletion queues an identity-only tombstone without a book payload', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const result = await enqueueLocalEditionMetadataSyncIntent({
    session,
    editionId,
    operation: 'delete',
    baseRevision: 7,
    deviceStorage: storage(clientInstanceId),
    enqueue: captureEnqueue(entries),
    operationId: 'b005f008-79a8-49f0-bdaa-0c9c468add46',
  })

  expect(result.status).toBe('queued')
  expect(entries).toEqual([{
    operationId: 'b005f008-79a8-49f0-bdaa-0c9c468add46', userId: 'stable-user', deviceClientId: clientInstanceId,
    entityType: 'edition', entityId: editionId, operation: 'delete', baseRevision: 7, payload: {},
  }])
  const serialized = JSON.stringify(entries)
  for (const forbidden of ['file_name', 'file_type', 'file_size', 'cover', 'location', 'title', 'author', 'bookId', 'blob']) {
    expect(serialized).not.toContain(forbidden)
  }
})

test('edition deletion rejects an absent or unstable server identity before reaching the outbox', async () => {
  for (const candidate of [undefined, 'not-a-uuid']) {
    const entries: CreateMetadataSyncOutboxEntry[] = []
    const result = await enqueueLocalEditionMetadataSyncIntent({
      session,
      editionId: candidate,
      operation: 'delete',
      deviceStorage: storage(clientInstanceId),
      enqueue: captureEnqueue(entries),
    })
    expect(result.status).toBe('invalid-book')
    expect(entries).toEqual([])
  }
})

test('edition-only intent has a closed payload boundary even when the local record carries unsynced file-related fields', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const localRecord = Object.assign(book({
    coverImage: 'data:image/png;base64,private-cover-bytes',
    workId: 'local-work-relation',
  }), {
    objectKey: 'private-user-files/reader.epub',
    sourceUrl: 'https://private.example/reader.epub',
    textBody: 'never sync an EPUB body',
    fileBytes: 'private-epub-bytes',
  })

  const result = await enqueueLocalEditionMetadataSyncIntent({
    session,
    book: localRecord,
    deviceStorage: storage(clientInstanceId),
    enqueue: captureEnqueue(entries),
  })

  expect(result.status).toBe('queued')
  const payload = entries[0]?.payload ?? {}
  expect(Object.keys(payload).sort()).toEqual([
    'author', 'cover', 'file_name', 'file_size', 'file_type', 'language', 'location', 'progress', 'title',
  ])
  const serialized = JSON.stringify({ entityId: entries[0]?.entityId, payload })
  for (const forbidden of [
    'private-cover-bytes', 'local-work-relation', 'private-user-files',
    'https://private.example', 'never sync an EPUB body', 'private-epub-bytes',
    'work_id', 'objectKey', 'sourceUrl', 'textBody', 'fileBytes',
  ]) {
    expect(serialized).not.toContain(forbidden)
  }
})

test('anonymous sessions never inspect books, storage, or the outbox', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const deviceStorage = storage()
  const result = await enqueueLocalEditionMetadataSyncIntent({
    session: { ...session, user: { id: 'anonymous-user', isAnonymous: true } },
    book: book({ editionId: 'not-a-uuid', title: 'https://not-inspected.example' }),
    deviceStorage,
    enqueue: captureEnqueue(entries),
  })

  expect(result).toEqual({ status: 'no-stable-account' })
  expect(deviceStorage.reads).toBe(0)
  expect(entries).toEqual([])
})

test('unsafe local metadata or an unstable edition identity is rejected before it reaches the outbox', async () => {
  for (const candidate of [
    book({ editionId: 'not-a-uuid' }),
    book({ title: 'https://unsafe.example/book.epub' }),
    book({ fileName: 'data:application/epub;base64,unsafe' }),
    book({ fileName: 'reader.unknown', fileType: 'application/octet-stream' }),
  ]) {
    const entries: CreateMetadataSyncOutboxEntry[] = []
    const result = await enqueueLocalEditionMetadataSyncIntent({
      session, book: candidate, deviceStorage: storage(clientInstanceId), enqueue: captureEnqueue(entries),
    })
    expect(result.status).toBe('invalid-book')
    expect(entries).toEqual([])
  }
})
