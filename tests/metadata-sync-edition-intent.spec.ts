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
const workId = 'c292d267-dc68-49e9-9eb5-8afdfd6371f4'

function book(overrides: Partial<StoredBook> = {}): StoredBook {
  return {
    id: 'local-book-id', title: 'A local EPUB', author: 'Reader', language: 'en', progress: 22,
    cover: 'ink', coverImage: 'data:image/png;base64,not-synced', fileName: 'reader.epub',
    fileType: 'application/epub+zip', fileSize: 2048, storage: 'indexeddb', createdAt: 1,
    location: 'epubcfi(/6/2)', workId, editionId,
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
      cover: 'ink', work_id: workId,
    },
  }])
  expect(JSON.stringify(entries)).not.toContain('coverImage')
  expect(JSON.stringify(entries)).not.toContain('data:image')
  expect(JSON.stringify(entries)).not.toContain('local-book-id')
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
