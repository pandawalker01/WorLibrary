export type WorldBookAccessMode = 'catalog_only' | 'public_domain' | 'licensed_full_text' | 'preview' | 'borrow' | 'purchase' | 'external'

export type WorldBookAccess = {
  mode: WorldBookAccessMode
  url: string
  license?: string
  rightsNotice?: string
}

export type WorldBook = {
  id: string
  sourceId: string
  sourceRecordId: string
  title: string
  author: string
  year?: number
  languages: string[]
  editionCount?: number
  coverUrl?: string
  sourceUrl: string
  sourceName: string
  access: WorldBookAccess
}

export type WorldLibrarySearchOptions = { language?: string; multiLanguageOnly?: boolean }

export type WorldCatalogSource = {
  id: string
  name: string
  search: (query: string, options: WorldLibrarySearchOptions, signal?: AbortSignal) => Promise<WorldBook[]>
}

const SAVED_WORLD_BOOKS_KEY = 'worlibrary.saved-world-books'
// A browser request can remain pending during DNS, captive-portal or upstream
// outages. Catalog search must return control to the reader instead of leaving
// the UI in an indefinite loading state.
export const WORLD_CATALOG_REQUEST_TIMEOUT_MS = 8_000

// Open Library indexes ISO 639-3 language codes. This intentionally stays
// global rather than being a short, product-defined language whitelist.
export const WORLD_LANGUAGE_CODES = [
  'aar', 'abk', 'ace', 'afr', 'aka', 'amh', 'ara', 'arg', 'asm', 'ava', 'aym', 'aze', 'bak', 'bam', 'bel', 'ben', 'bis', 'bos', 'bre', 'bul', 'cat', 'ceb', 'ces', 'cha', 'che', 'chi', 'chu', 'chv', 'cor', 'cos', 'cre', 'cym', 'dan', 'deu', 'div', 'dzo', 'ell', 'eng', 'epo', 'est', 'eus', 'ewe', 'fao', 'fas', 'fij', 'fin', 'fon', 'fra', 'fry', 'ful', 'gla', 'gle', 'glg', 'grc', 'guj', 'hat', 'hau', 'heb', 'her', 'hin', 'hmo', 'hrv', 'hun', 'hye', 'ibo', 'ido', 'iii', 'iku', 'ile', 'ina', 'ind', 'ipk', 'isl', 'ita', 'jav', 'jpn', 'kal', 'kan', 'kas', 'kat', 'kau', 'kaz', 'khm', 'kik', 'kin', 'kir', 'kom', 'kon', 'kor', 'kua', 'kur', 'lao', 'lat', 'lav', 'lim', 'lin', 'lit', 'ltz', 'lug', 'mah', 'mal', 'mar', 'mkd', 'mlg', 'mlt', 'mon', 'mri', 'msa', 'mya', 'nau', 'nav', 'nbl', 'nde', 'ndo', 'nep', 'nld', 'nno', 'nob', 'nor', 'nya', 'oci', 'oji', 'ori', 'orm', 'oss', 'pan', 'pli', 'pol', 'por', 'pus', 'que', 'roh', 'ron', 'run', 'rus', 'sag', 'san', 'sin', 'slk', 'slv', 'sme', 'smo', 'sna', 'snd', 'som', 'sot', 'spa', 'sqi', 'srd', 'srp', 'ssw', 'sun', 'swa', 'swe', 'tah', 'tam', 'tat', 'tel', 'tgk', 'tgl', 'tha', 'tir', 'ton', 'tsn', 'tso', 'tuk', 'tur', 'twi', 'uig', 'ukr', 'urd', 'uzb', 'ven', 'vie', 'vol', 'wln', 'wol', 'xho', 'yid', 'yor', 'zha', 'zul',
] as const

export function worldLanguageName(code: string, locale: string): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code } catch { return code }
}

type OpenLibraryDoc = { key?: string; title?: string; author_name?: string[]; first_publish_year?: number; language?: string[]; edition_count?: number; cover_i?: number }

function sourceRequestSignal(parent?: AbortSignal) {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parent?.reason)
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener('abort', abortFromParent, { once: true })
  const timeout = globalThis.setTimeout(() => controller.abort(new DOMException('Catalog request timed out', 'TimeoutError')), WORLD_CATALOG_REQUEST_TIMEOUT_MS)
  return {
    signal: controller.signal,
    dispose: () => { globalThis.clearTimeout(timeout); parent?.removeEventListener('abort', abortFromParent) },
  }
}

function normalizeOpenLibraryBook(doc: OpenLibraryDoc): WorldBook | undefined {
  if (!doc.key || !doc.title) return undefined
  const sourceRecordId = doc.key.replace(/^\/works\//, '')
  const sourceUrl = `https://openlibrary.org${doc.key}`
  return {
    id: `open-library:${sourceRecordId}`, sourceId: 'open-library', sourceRecordId, title: doc.title,
    author: doc.author_name?.[0] ?? '', year: doc.first_publish_year, languages: [...new Set(doc.language ?? [])],
    editionCount: doc.edition_count, coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : undefined,
    sourceUrl, sourceName: 'Open Library',
    // A catalog record, or a public-domain query term, never grants WorLibrary
    // a right to deliver this work's full text.
    access: { mode: 'catalog_only', url: sourceUrl },
  }
}

const openLibrarySource: WorldCatalogSource = {
  id: 'open-library', name: 'Open Library',
  async search(query, options, signal) {
    const languageQuery = options.language ? `&language=${encodeURIComponent(options.language)}` : ''
    const request = sourceRequestSignal(signal)
    try {
      const response = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}${languageQuery}&limit=24&fields=key,title,author_name,first_publish_year,language,edition_count,cover_i`, { signal: request.signal })
      if (!response.ok) throw new Error('WORLD_LIBRARY_UNAVAILABLE')
      const payload = await response.json() as { docs?: OpenLibraryDoc[] }
      return (payload.docs ?? []).map(normalizeOpenLibraryBook).filter((book): book is WorldBook => Boolean(book)).filter((book) => !options.multiLanguageOnly || book.languages.length > 1)
    } finally { request.dispose() }
  },
}

// Register a source here only after its terms, rate limits, provenance and
// access mode have been reviewed. There are no hidden or user-specific sources.
export const WORLD_CATALOG_SOURCES: readonly WorldCatalogSource[] = [openLibrarySource]

export async function searchWorldLibrary(query: string, options: WorldLibrarySearchOptions = {}, signal?: AbortSignal): Promise<WorldBook[]> {
  const term = query.trim()
  if (!term) return []
  const results = await Promise.allSettled(WORLD_CATALOG_SOURCES.map((source) => source.search(term, options, signal)))
  const books = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  if (books.length === 0 && results.some((result) => result.status === 'rejected')) throw new Error('WORLD_LIBRARY_UNAVAILABLE')
  return [...new Map(books.map((book) => [worldBookIdentity(book), book])).values()]
}

export function worldBookIdentity(book: Pick<WorldBook, 'sourceId' | 'sourceRecordId' | 'id'>): string {
  return book.sourceId && book.sourceRecordId ? `${book.sourceId}:${book.sourceRecordId}` : book.id
}

function normalizeSavedWorldBook(book: Partial<WorldBook>): WorldBook | undefined {
  if (typeof book?.id !== 'string' || typeof book?.title !== 'string' || typeof book?.sourceUrl !== 'string') return undefined
  const sourceId = typeof book.sourceId === 'string' ? book.sourceId : 'open-library'
  const sourceRecordId = typeof book.sourceRecordId === 'string' ? book.sourceRecordId : book.id
  const sourceUrl = book.sourceUrl
  return {
    id: book.id || `${sourceId}:${sourceRecordId}`, sourceId, sourceRecordId, title: book.title,
    author: typeof book.author === 'string' ? book.author : '', year: typeof book.year === 'number' ? book.year : undefined,
    languages: Array.isArray(book.languages) ? book.languages.filter((language): language is string => typeof language === 'string') : [],
    editionCount: typeof book.editionCount === 'number' ? book.editionCount : undefined, coverUrl: typeof book.coverUrl === 'string' ? book.coverUrl : undefined,
    sourceUrl, sourceName: typeof book.sourceName === 'string' ? book.sourceName : 'Open Library',
    access: book.access?.mode && typeof book.access.url === 'string' ? book.access : { mode: 'catalog_only', url: sourceUrl },
  }
}

export function loadSavedWorldBooks(): WorldBook[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SAVED_WORLD_BOOKS_KEY) ?? '[]')
    return Array.isArray(value) ? value.map(normalizeSavedWorldBook).filter((book): book is WorldBook => Boolean(book)) : []
  } catch { return [] }
}

export function saveWorldBook(book: WorldBook): WorldBook[] {
  const saved = loadSavedWorldBooks()
  const next = saved.some((item) => worldBookIdentity(item) === worldBookIdentity(book)) ? saved : [book, ...saved]
  try { window.localStorage.setItem(SAVED_WORLD_BOOKS_KEY, JSON.stringify(next)) } catch { /* Saving a bookmark must not block browsing. */ }
  return next
}
