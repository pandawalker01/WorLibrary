import { expect, test } from '@playwright/test'
import { projectRemoteHighlightChangeToShadow } from '../src/lib/metadata-sync-highlight-shadow'
import type { PulledMetadataSyncChange } from '../src/lib/remote'
import type { RemoteHighlightMetadataShadow, UpsertRemoteHighlightMetadataShadow } from '../src/lib/storage'

const userId = 'stable-reader'
const highlightId = '4f7c8ac9-25a9-473e-9e9c-a06345613418'
const editionId = 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7'

function highlightChange(overrides: Partial<PulledMetadataSyncChange> = {}): PulledMetadataSyncChange {
  return {
    sequence: 9,
    device_id: '35008161-324f-4f6c-b2b8-cf8ca503581d',
    operation_id: '31e5ed3a-7258-4f7f-a53d-5d43a02f4aec',
    entity_type: 'highlight',
    entity_id: highlightId,
    operation: 'upsert',
    entity_revision: 3,
    payload: {
      edition_id: editionId,
      text: 'It was a fine day.',
      location: 'epubcfi(/6/8!/4/2/10)',
      note: 'Return to this later.',
      color: 'gold',
      is_highlighted: true,
    },
    occurred_at: '2026-10-22T00:00:00.000Z',
    ...overrides,
  }
}

function shadows() {
  const upserts: UpsertRemoteHighlightMetadataShadow[] = []
  const deletes: Array<{ userId: string; highlightId: string }> = []
  return {
    upserts,
    deletes,
    store: {
      upsert: async (input: UpsertRemoteHighlightMetadataShadow): Promise<RemoteHighlightMetadataShadow> => {
        upserts.push(input)
        return { key: `${input.userId}:${input.highlightId}`, ...input }
      },
      delete: async (requestedUserId: string, requestedHighlightId: string) => {
        deletes.push({ userId: requestedUserId, highlightId: requestedHighlightId })
        return true
      },
    },
  }
}

test('highlight upsert projects only the account-scoped private excerpt fields', async () => {
  const fixture = shadows()
  const result = await projectRemoteHighlightChangeToShadow({ userId, change: highlightChange(), highlights: fixture.store })

  expect(result.outcome).toBe('projected')
  expect(fixture.upserts).toEqual([{
    userId, highlightId, editionId, revision: 3, sequence: 9,
    text: 'It was a fine day.', location: 'epubcfi(/6/8!/4/2/10)', note: 'Return to this later.',
    color: 'gold', isHighlighted: true,
  }])
})

test('highlight delete addresses only the current account shadow', async () => {
  const fixture = shadows()
  const result = await projectRemoteHighlightChangeToShadow({
    userId,
    change: highlightChange({ operation: 'delete', payload: {} }),
    highlights: fixture.store,
  })

  expect(result).toEqual({ outcome: 'deleted', deleted: true })
  expect(fixture.deletes).toEqual([{ userId, highlightId }])
})

test('highlight projection rejects local file identity, object addresses, URLs, binary fields and unknown payload keys', async () => {
  for (const payload of [
    { ...highlightChange().payload, book_id: 'local-browser-book-id' },
    { ...highlightChange().payload, file_name: 'reader.epub' },
    { ...highlightChange().payload, object_key: 'private/books/reader.epub' },
    { ...highlightChange().payload, signed_url: 'https://objects.example/reader.epub?signature=secret' },
    { ...highlightChange().payload, text: 'data:text/plain;base64,SGVsbG8=' },
    { ...highlightChange().payload, location: 'blob:https://reader.example/opaque' },
  ]) {
    const fixture = shadows()
    const result = await projectRemoteHighlightChangeToShadow({
      userId,
      change: highlightChange({ payload }),
      highlights: fixture.store,
    })
    expect(result.outcome).toBe('rejected')
    expect(fixture.upserts).toEqual([])
    expect(fixture.deletes).toEqual([])
  }
})

test('edition and other entity changes are not written into highlight shadow storage', async () => {
  const fixture = shadows()
  const result = await projectRemoteHighlightChangeToShadow({
    userId,
    change: highlightChange({ entity_type: 'edition' }),
    highlights: fixture.store,
  })
  expect(result).toEqual({ outcome: 'ignored' })
  expect(fixture.upserts).toEqual([])
  expect(fixture.deletes).toEqual([])
})
