import { expect, test } from '@playwright/test'
import { projectRemoteEditionChangeToShadow } from '../src/lib/metadata-sync-edition-shadow'
import type { PulledMetadataSyncChange } from '../src/lib/remote'
import type { RemoteBookMetadataShadow, UpsertRemoteBookMetadataShadow } from '../src/lib/storage'

const userId = 'stable-user'
const editionId = 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7'

function editionChange(overrides: Partial<PulledMetadataSyncChange> = {}): PulledMetadataSyncChange {
  return {
    sequence: 8,
    device_id: '35008161-324f-4f6c-b2b8-cf8ca503581d',
    operation_id: '31e5ed3a-7258-4f7f-a53d-5d43a02f4aec',
    entity_type: 'edition',
    entity_id: editionId,
    operation: 'upsert',
    entity_revision: 2,
    payload: {
      title: 'A local EPUB',
      author: 'Reader',
      language: 'en',
      progress: 22,
      location: 'epubcfi(/6/2)',
      file_name: 'reader.epub',
      file_type: 'epub',
      file_size: 2048,
      cover: 'ink',
    },
    occurred_at: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function shadows() {
  const upserts: UpsertRemoteBookMetadataShadow[] = []
  const deletes: Array<{ userId: string; editionId: string }> = []
  return {
    upserts,
    deletes,
    store: {
      upsert: async (input: UpsertRemoteBookMetadataShadow): Promise<RemoteBookMetadataShadow> => {
        upserts.push(input)
        return { key: `${input.userId}:${input.editionId}`, ...input, needsReimport: true }
      },
      delete: async (requestedUserId: string, requestedEditionId: string) => {
        deletes.push({ userId: requestedUserId, editionId: requestedEditionId })
        return true
      },
    },
  }
}

test('edition upsert projects only safe local-import metadata into a re-import shadow', async () => {
  const fixture = shadows()
  const result = await projectRemoteEditionChangeToShadow({ userId, change: editionChange(), shadows: fixture.store })

  expect(result.outcome).toBe('projected')
  expect(fixture.upserts).toEqual([{
    userId, editionId, revision: 2, sequence: 8,
    title: 'A local EPUB', author: 'Reader', language: 'en', progress: 22,
    location: 'epubcfi(/6/2)', fileName: 'reader.epub', fileType: 'epub', fileSize: 2048, cover: 'ink',
  }])
  if (result.outcome === 'projected') expect(result.shadow.needsReimport).toBe(true)
})

test('edition shadow normalizes an empty optional location before durable storage', async () => {
  const fixture = shadows()
  const result = await projectRemoteEditionChangeToShadow({
    userId,
    change: editionChange({ payload: { ...editionChange().payload, location: '' } }),
    shadows: fixture.store,
  })

  expect(result.outcome).toBe('projected')
  expect(fixture.upserts).toHaveLength(1)
  expect(fixture.upserts[0].location).toBeUndefined()
})

test('edition delete deletes its account-scoped shadow without treating it as a book', async () => {
  const fixture = shadows()
  const result = await projectRemoteEditionChangeToShadow({
    userId,
    change: editionChange({ operation: 'delete', payload: {} }),
    shadows: fixture.store,
  })

  expect(result).toEqual({ outcome: 'deleted', deleted: true })
  expect(fixture.upserts).toEqual([])
  expect(fixture.deletes).toEqual([{ userId, editionId }])
})

test('unknown feed entities are ignored without touching shadow storage so the caller controls cursor advancement', async () => {
  const fixture = shadows()
  const result = await projectRemoteEditionChangeToShadow({
    userId,
    change: editionChange({ entity_type: 'highlight' }),
    shadows: fixture.store,
  })

  expect(result).toEqual({ outcome: 'ignored' })
  expect(fixture.upserts).toEqual([])
  expect(fixture.deletes).toEqual([])
})

test('edition shadow projection rejects image, locator, URL and body fields before storage', async () => {
  for (const payload of [
    { ...editionChange().payload, coverImage: 'data:image/png;base64,AA==' },
    { ...editionChange().payload, object_key: 'private/book.epub' },
    { ...editionChange().payload, body: 'full book text' },
    { ...editionChange().payload, title: 'https://source.example/book.epub' },
  ]) {
    const fixture = shadows()
    const result = await projectRemoteEditionChangeToShadow({
      userId,
      change: editionChange({ payload }),
      shadows: fixture.store,
    })
    expect(result.outcome).toBe('rejected')
    expect(fixture.upserts).toEqual([])
    expect(fixture.deletes).toEqual([])
  }
})
