import { expect, test } from '@playwright/test'
import type { AuthSession } from '../src/lib/auth'
import { enqueueLocalHighlightMetadataSyncIntent } from '../src/lib/metadata-sync-highlight-intent'
import {
  SYNC_CLIENT_INSTANCE_STORAGE_KEY,
  type ClientInstanceStorage,
} from '../src/lib/device-registration-session'
import type { CreateMetadataSyncOutboxEntry, Highlight, MetadataSyncOutboxEntry } from '../src/lib/storage'

const session: AuthSession = {
  accessToken: 'session-token', refreshToken: 'refresh-token', user: { id: 'stable-user', isAnonymous: false },
}
const clientInstanceId = 'a1d8eb2c-6996-4b5a-928f-2c429c083e69'
const editionId = 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7'
const highlightId = 'a005f008-79a8-49f0-bdaa-0c9c468add46'

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: highlightId,
    bookId: 'browser-only-local-book-id',
    text: 'A private sentence selected by this reader.',
    location: 'epubcfi(/6/2[chapter]!/4/1:12)',
    note: 'A private reading note.',
    color: 'rose',
    isHighlighted: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function storage(initial: string | null = clientInstanceId): ClientInstanceStorage & { reads: number } {
  let value = initial
  const result: ClientInstanceStorage & { reads: number } = {
    reads: 0,
    getItem: (key) => {
      expect(key).toBe(SYNC_CLIENT_INSTANCE_STORAGE_KEY)
      result.reads += 1
      return value
    },
    setItem: (_key, next) => { value = next },
  }
  return result
}

function capture(entries: CreateMetadataSyncOutboxEntry[]) {
  return async (input: CreateMetadataSyncOutboxEntry): Promise<MetadataSyncOutboxEntry> => {
    entries.push(input)
    return { ...input, operationId: input.operationId ?? highlightId, status: 'pending', createdAt: 3 }
  }
}

test('a stable account queues only the user-authorised private highlight fields', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const result = await enqueueLocalHighlightMetadataSyncIntent({
    session,
    highlight: highlight(),
    editionId,
    deviceStorage: storage(),
    enqueue: capture(entries),
  })

  expect(result.status).toBe('queued')
  expect(entries).toEqual([{
    userId: 'stable-user', deviceClientId: clientInstanceId,
    entityType: 'highlight', entityId: highlightId, operation: 'upsert', baseRevision: 0,
    payload: {
      edition_id: editionId,
      text: 'A private sentence selected by this reader.',
      location: 'epubcfi(/6/2[chapter]!/4/1:12)',
      note: 'A private reading note.', color: 'rose', is_highlighted: true,
    },
  }])
})

test('highlight intent excludes browser-local book ids, file data, URLs, covers and visibility even if injected into a local record', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const local = Object.assign(highlight(), {
    bookId: 'browser-only-local-book-id',
    fileName: 'private.epub',
    coverImage: 'data:image/png;base64,private-cover-bytes',
    objectKey: 'private/user/book.epub',
    url: 'https://private.example/book.epub',
    visibility: 'public',
  })
  const result = await enqueueLocalHighlightMetadataSyncIntent({
    session, highlight: local, editionId, deviceStorage: storage(), enqueue: capture(entries),
  })

  expect(result.status).toBe('queued')
  const serialized = JSON.stringify(entries[0])
  for (const forbidden of [
    'browser-only-local-book-id', 'private.epub', 'private-cover-bytes', 'private/user/book.epub',
    'https://private.example', 'public', 'bookId', 'fileName', 'coverImage', 'objectKey', 'visibility',
  ]) expect(serialized).not.toContain(forbidden)
})

test('a stable local delete queues an empty private tombstone payload', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const result = await enqueueLocalHighlightMetadataSyncIntent({
    session, highlight: highlight(), editionId, operation: 'delete', baseRevision: 7,
    deviceStorage: storage(), enqueue: capture(entries),
  })

  expect(result.status).toBe('queued')
  expect(entries[0]).toMatchObject({
    entityType: 'highlight', entityId: highlightId, operation: 'delete', baseRevision: 7, payload: {},
  })
})

test('anonymous trials do not inspect highlights, storage or the outbox', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const deviceStorage = storage()
  const result = await enqueueLocalHighlightMetadataSyncIntent({
    session: { ...session, user: { id: 'anonymous-user', isAnonymous: true } },
    highlight: highlight({ id: 'not-a-uuid', text: 'https://not-inspected.example' }),
    editionId: 'not-a-uuid', deviceStorage, enqueue: capture(entries),
  })

  expect(result).toEqual({ status: 'no-stable-account' })
  expect(deviceStorage.reads).toBe(0)
  expect(entries).toEqual([])
})

test('unsafe text, locators, identities and colours are rejected before the outbox', async () => {
  for (const input of [
    { highlight: highlight({ text: 'data:text/plain,never' }), editionId },
    { highlight: highlight({ location: 'https://private.example/locator' }), editionId },
    { highlight: highlight({ id: 'not-a-uuid' }), editionId },
    { highlight: highlight({ color: 'green' as Highlight['color'] }), editionId },
    { highlight: highlight(), editionId: 'not-a-uuid' },
  ]) {
    const entries: CreateMetadataSyncOutboxEntry[] = []
    const result = await enqueueLocalHighlightMetadataSyncIntent({
      session, ...input, deviceStorage: storage(), enqueue: capture(entries),
    })
    expect(result.status).toBe('invalid-highlight')
    expect(entries).toEqual([])
  }
})
