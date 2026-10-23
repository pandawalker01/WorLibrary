import { expect, test } from '@playwright/test'
import { explicitWorldWorkIdentity, groupWorldBooksByWork, type WorldBook } from '../src/lib/world-library'

function book(overrides: Partial<WorldBook> & Pick<WorldBook, 'id' | 'sourceId' | 'sourceRecordId' | 'title'>): WorldBook {
  return {
    author: 'Author', languages: ['eng'], sourceName: 'Reviewed catalog',
    sourceUrl: 'https://catalog.example.test/record', access: { mode: 'catalog_only', url: 'https://catalog.example.test/record' },
    ...overrides,
  }
}

test('Work-first grouping only merges records with an explicit source work identity', () => {
  const records = [
    book({ id: 'source-a:en', sourceId: 'source-a', sourceRecordId: 'edition-en', sourceWorkId: 'work-1', title: 'The Original', languages: ['eng'], originalTitle: 'The Original', originalLanguage: 'eng', isOriginal: true }),
    book({ id: 'source-a:zh', sourceId: 'source-a', sourceRecordId: 'edition-zh', sourceWorkId: 'work-1', title: '原著的译本', languages: ['chi'] }),
    // Same words, but a different source cannot be joined without a shared,
    // source-defined compatible identity.
    book({ id: 'source-b:lookalike', sourceId: 'source-b', sourceRecordId: 'lookalike', title: 'The Original', languages: ['eng'] }),
    // Nor can two records from one source with no work identifier.
    book({ id: 'source-a:unknown-1', sourceId: 'source-a', sourceRecordId: 'unknown-1', title: 'Untyped', languages: ['eng'] }),
    book({ id: 'source-a:unknown-2', sourceId: 'source-a', sourceRecordId: 'unknown-2', title: 'Untyped', languages: ['eng'] }),
  ]

  const works = groupWorldBooksByWork(records, { interfaceLocale: 'zh-CN' })

  expect(explicitWorldWorkIdentity(records[0])).toBe('source-a:work-1')
  expect(explicitWorldWorkIdentity(records[2])).toBeUndefined()
  expect(works).toHaveLength(4)
  const grouped = works.find((work) => work.id === 'source-a:work-1')
  expect(grouped?.title).toBe('The Original')
  expect(grouped?.originalEdition?.id).toBe('source-a:en')
  // Chinese interface language ranks the Chinese edition before the original.
  expect(grouped?.editions.map((edition) => edition.id)).toEqual(['source-a:zh', 'source-a:en'])
})

test('Work-first language and original filters retain original metadata without leaking other editions', () => {
  const records = [
    book({ id: 'catalog:original', sourceId: 'catalog', sourceRecordId: 'original', sourceWorkId: 'work-2', title: 'Original title', languages: ['eng'], originalTitle: 'Original title', originalLanguage: 'eng', isOriginal: true }),
    book({ id: 'catalog:ja', sourceId: 'catalog', sourceRecordId: 'ja', sourceWorkId: 'work-2', title: '日本語版', languages: ['jpn'] }),
    book({ id: 'catalog:fr', sourceId: 'catalog', sourceRecordId: 'fr', sourceWorkId: 'work-2', title: 'Édition française', languages: ['fra'] }),
  ]

  const japanese = groupWorldBooksByWork(records, { language: 'jpn', interfaceLocale: 'en' })
  expect(japanese).toHaveLength(1)
  expect(japanese[0]).toMatchObject({ title: 'Original title', originalTitle: 'Original title', originalLanguage: 'eng' })
  expect(japanese[0].editions.map((edition) => edition.id)).toEqual(['catalog:ja'])
  expect(japanese[0].originalEdition?.id).toBe('catalog:original')

  const originals = groupWorldBooksByWork(records, { originalsOnly: true, interfaceLocale: 'ja' })
  expect(originals).toHaveLength(1)
  expect(originals[0].editions.map((edition) => edition.id)).toEqual(['catalog:original'])
})
