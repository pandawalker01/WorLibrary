import { expect, test } from '@playwright/test'
import { explicitWorldWorkIdentity, groupWorldBooksByWork, parseWorldCatalogResponse, parseWorldBook, type WorldBook } from '../src/lib/world-library'

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

test('catalog response parser drops malicious records and fails closed for forged access', () => {
  const books = parseWorldCatalogResponse({ books: [
    { id: 'unsafe', sourceId: 'evil\u0000source', sourceRecordId: 'x', title: 'Bad', sourceUrl: 'https://catalog.example.test/x', access: { mode: 'preview', url: 'https://catalog.example.test/x' } },
    { id: 'unsafe-url', sourceId: 'catalog', sourceRecordId: 'y', title: 'Bad URL', sourceUrl: 'javascript:alert(1)', access: { mode: 'preview', url: 'https://catalog.example.test/y' } },
    { id: 'safe', sourceId: ' catalog ', sourceRecordId: ' record ', title: '  Safe   title ', author: '  A   Author ', languages: [' ENG ', 'eng'], sourceUrl: 'https://catalog.example.test/record', coverUrl: 'data:image/png;base64,abc', access: { mode: 'licensed_full_text', url: 'javascript:alert(1)' }, platformEditionId: 'forged-platform', originalTitle: '  Claimed original  ' },
  ] })

  expect(books).toEqual([expect.objectContaining({
    id: 'catalog:record', title: 'Safe title', author: 'A Author', languages: ['eng'], sourceUrl: 'https://catalog.example.test/record',
    access: { mode: 'catalog_only', url: 'https://catalog.example.test/record' }, originalTitle: 'Claimed original',
  })])
  expect(books?.[0].coverUrl).toBeUndefined()
  expect(books?.[0].platformEditionId).toBeUndefined()
})

test('saved legacy records stay usable but unsafe saved access is downgraded to their HTTPS source', () => {
  const legacy = parseWorldBook({ id: 'OLlegacy', title: ' Legacy ', sourceUrl: 'https://openlibrary.org/works/OLlegacy', access: { mode: 'not-a-mode', url: 'https://attacker.example.test/' } }, { allowLegacyIdentity: true })
  expect(legacy).toMatchObject({ id: 'open-library:OLlegacy', sourceId: 'open-library', sourceRecordId: 'OLlegacy', title: 'Legacy', access: { mode: 'catalog_only', url: 'https://openlibrary.org/works/OLlegacy' } })
})
