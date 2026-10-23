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
  /**
   * A source-provided work identifier which explicitly relates several source
   * records to one literary work. It is deliberately optional: title/author
   * similarity is not enough to merge records from a global catalog.
   */
  sourceWorkId?: string
  title: string
  author: string
  year?: number
  languages: string[]
  editionCount?: number
  coverUrl?: string
  sourceUrl: string
  sourceName: string
  access: WorldBookAccess
  /** Source-confirmed original-work metadata. Never inferred from a title. */
  originalTitle?: string
  originalLanguage?: string
  isOriginal?: boolean
  /** Platform-only edition identity. This is a policy lookup key, never a file key or URL. */
  platformEditionId?: string
}

export type WorldWorkEdition = WorldBook

/**
 * A read-only view model for Work-first search. `editions` are source records,
 * not a claim that WorLibrary may deliver any of their text.
 */
export type WorldWork = {
  id: string
  sourceId: string
  sourceWorkId?: string
  title: string
  author: string
  originalTitle?: string
  originalLanguage?: string
  originalEdition?: WorldWorkEdition
  editions: WorldWorkEdition[]
}

export type WorkFirstSearchOptions = {
  /** ISO 639-3 edition language filter. */
  language?: string
  /** Only retain a work's explicitly source-confirmed original editions. */
  originalsOnly?: boolean
  /** Current interface locale, used only for deterministic edition ordering. */
  interfaceLocale?: string
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
const WORLD_CATALOG_API_PATH = '/api/catalog'

// Open Library indexes ISO 639-3 language codes. This intentionally stays
// global rather than being a short, product-defined language whitelist.
export const WORLD_LANGUAGE_CODES = [
  'aar', 'abk', 'ace', 'afr', 'aka', 'amh', 'ara', 'arg', 'asm', 'ava', 'aym', 'aze', 'bak', 'bam', 'bel', 'ben', 'bis', 'bos', 'bre', 'bul', 'cat', 'ceb', 'ces', 'cha', 'che', 'chi', 'chu', 'chv', 'cor', 'cos', 'cre', 'cym', 'dan', 'deu', 'div', 'dzo', 'ell', 'eng', 'epo', 'est', 'eus', 'ewe', 'fao', 'fas', 'fij', 'fin', 'fon', 'fra', 'fry', 'ful', 'gla', 'gle', 'glg', 'grc', 'guj', 'hat', 'hau', 'heb', 'her', 'hin', 'hmo', 'hrv', 'hun', 'hye', 'ibo', 'ido', 'iii', 'iku', 'ile', 'ina', 'ind', 'ipk', 'isl', 'ita', 'jav', 'jpn', 'kal', 'kan', 'kas', 'kat', 'kau', 'kaz', 'khm', 'kik', 'kin', 'kir', 'kom', 'kon', 'kor', 'kua', 'kur', 'lao', 'lat', 'lav', 'lim', 'lin', 'lit', 'ltz', 'lug', 'mah', 'mal', 'mar', 'mkd', 'mlg', 'mlt', 'mon', 'mri', 'msa', 'mya', 'nau', 'nav', 'nbl', 'nde', 'ndo', 'nep', 'nld', 'nno', 'nob', 'nor', 'nya', 'oci', 'oji', 'ori', 'orm', 'oss', 'pan', 'pli', 'pol', 'por', 'pus', 'que', 'roh', 'ron', 'run', 'rus', 'sag', 'san', 'sin', 'slk', 'slv', 'sme', 'smo', 'sna', 'snd', 'som', 'sot', 'spa', 'sqi', 'srd', 'srp', 'ssw', 'sun', 'swa', 'swe', 'tah', 'tam', 'tat', 'tel', 'tgk', 'tgl', 'tha', 'tir', 'ton', 'tsn', 'tso', 'tuk', 'tur', 'twi', 'uig', 'ukr', 'urd', 'uzb', 'ven', 'vie', 'vol', 'wln', 'wol', 'xho', 'yid', 'yor', 'zha', 'zul',
] as const

export function worldLanguageName(code: string, locale: string): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code } catch { return code }
}

type OpenLibraryDoc = { key?: string; title?: string; author_name?: string[]; first_publish_year?: number; language?: string[]; edition_count?: number; cover_i?: number }
type GoogleBooksDoc = {
  id?: string
  volumeInfo?: { title?: string; authors?: string[]; publishedDate?: string; language?: string; imageLinks?: { thumbnail?: string }; infoLink?: string }
  accessInfo?: { viewability?: string; webReaderLink?: string }
}

const GOOGLE_LANGUAGE_TO_ISO_639_3: Record<string, string> = { en: 'eng', zh: 'chi', ja: 'jpn', ko: 'kor', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', ru: 'rus', ar: 'ara', hi: 'hin', nl: 'nld', pl: 'pol', tr: 'tur', uk: 'ukr', vi: 'vie', id: 'ind', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', cs: 'ces', el: 'ell', he: 'heb', th: 'tha' }
const ISO_639_3_TO_GOOGLE_LANGUAGE = Object.fromEntries(Object.entries(GOOGLE_LANGUAGE_TO_ISO_639_3).map(([twoLetter, threeLetter]) => [threeLetter, twoLetter])) as Record<string, string>

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
    sourceWorkId: sourceRecordId,
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

function googleBookAccess(doc: GoogleBooksDoc, sourceUrl: string): WorldBookAccess {
  const viewability = doc.accessInfo?.viewability
  if (viewability === 'FULL_PUBLIC_DOMAIN') return { mode: 'public_domain', url: doc.accessInfo?.webReaderLink ?? sourceUrl, rightsNotice: 'Google Books reports this volume as public domain.' }
  if (viewability === 'ALL_PAGES' || viewability === 'PARTIAL') return { mode: 'preview', url: doc.accessInfo?.webReaderLink ?? sourceUrl }
  return { mode: 'catalog_only', url: sourceUrl }
}

function normalizeGoogleBook(doc: GoogleBooksDoc): WorldBook | undefined {
  const sourceRecordId = doc.id
  const title = doc.volumeInfo?.title
  if (!sourceRecordId || !title) return undefined
  const sourceUrl = doc.volumeInfo?.infoLink ?? `https://books.google.com/books?id=${encodeURIComponent(sourceRecordId)}`
  const published = doc.volumeInfo?.publishedDate
  const year = published && /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : undefined
  return {
    id: `google-books:${sourceRecordId}`, sourceId: 'google-books', sourceRecordId, title,
    author: doc.volumeInfo?.authors?.[0] ?? '', year, languages: doc.volumeInfo?.language ? [doc.volumeInfo.language] : [],
    coverUrl: doc.volumeInfo?.imageLinks?.thumbnail?.replace(/^http:/, 'https:'), sourceUrl, sourceName: 'Google Books',
    access: googleBookAccess(doc, sourceUrl),
  }
}

const googleBooksSource: WorldCatalogSource = {
  id: 'google-books', name: 'Google Books',
  async search(query, options, signal) {
    // Google Books uses BCP 47 / ISO 639-1 here. Avoid silently ignoring an
    // unsupported language filter: Open Library remains the global fallback.
    const googleLanguage = options.language ? ISO_639_3_TO_GOOGLE_LANGUAGE[options.language] : undefined
    if (options.language && !googleLanguage) return []
    const languageQuery = googleLanguage ? `&langRestrict=${encodeURIComponent(googleLanguage)}` : ''
    const request = sourceRequestSignal(signal)
    try {
      const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}${languageQuery}&maxResults=20&printType=books`, { signal: request.signal })
      if (!response.ok) throw new Error('WORLD_LIBRARY_UNAVAILABLE')
      const payload = await response.json() as { items?: GoogleBooksDoc[] }
      return (payload.items ?? []).map(normalizeGoogleBook).filter((book): book is WorldBook => Boolean(book)).filter((book) => !options.multiLanguageOnly || book.languages.length > 1)
    } finally { request.dispose() }
  },
}

// Register a source here only after its terms, rate limits, provenance and
// access mode have been reviewed. There are no hidden or user-specific sources.
// Both sources are catalog metadata only; opening a result always leaves the app.
export const WORLD_CATALOG_SOURCES: readonly WorldCatalogSource[] = [openLibrarySource, googleBooksSource]

function isCatalogApiResponse(payload: unknown): payload is { books: WorldBook[] } {
  return Boolean(payload) && typeof payload === 'object' && Array.isArray((payload as { books?: unknown }).books)
}

async function searchCatalogApi(query: string, options: WorldLibrarySearchOptions, signal?: AbortSignal): Promise<WorldBook[] | undefined> {
  const request = sourceRequestSignal(signal)
  try {
    const params = new URLSearchParams({ q: query })
    if (options.language) params.set('language', options.language)
    if (options.multiLanguageOnly) params.set('multiLanguageOnly', 'true')
    const response = await fetch(`${WORLD_CATALOG_API_PATH}?${params}`, { signal: request.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    return isCatalogApiResponse(payload) ? payload.books : undefined
  } catch {
    // Local Vite development and legacy deployments may not expose the Worker
    // route yet. Fall back to reviewed direct catalog adapters in that case.
    return undefined
  } finally { request.dispose() }
}

export async function searchWorldLibrary(query: string, options: WorldLibrarySearchOptions = {}, signal?: AbortSignal): Promise<WorldBook[]> {
  const term = query.trim()
  if (!term) return []
  // Cloudflare production serves this same-origin endpoint from the Worker,
  // so readers do not depend on direct browser access to third-party catalogs.
  // The explicit fallback keeps local development and existing deployments
  // usable until their Worker route has been enabled.
  const proxiedResults = await searchCatalogApi(term, options, signal)
  if (proxiedResults) return proxiedResults
  const results = await Promise.allSettled(WORLD_CATALOG_SOURCES.map((source) => source.search(term, options, signal)))
  const books = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  if (books.length === 0 && results.some((result) => result.status === 'rejected')) throw new Error('WORLD_LIBRARY_UNAVAILABLE')
  return [...new Map(books.map((book) => [worldBookIdentity(book), book])).values()]
}

export function worldBookIdentity(book: Pick<WorldBook, 'sourceId' | 'sourceRecordId' | 'id'>): string {
  return book.sourceId && book.sourceRecordId ? `${book.sourceId}:${book.sourceRecordId}` : book.id
}

function normalizedCatalogLanguage(language: string | undefined): string | undefined {
  const value = language?.trim().toLowerCase()
  return value || undefined
}

/**
 * Returns an identity only when the catalog explicitly supplied one. In
 * particular, a title/author match between independent sources never reaches
 * this function and therefore can never cause an accidental work merge.
 */
export function explicitWorldWorkIdentity(book: Pick<WorldBook, 'sourceId' | 'sourceWorkId'>): string | undefined {
  const sourceId = book.sourceId.trim()
  const sourceWorkId = book.sourceWorkId?.trim()
  return sourceId && sourceWorkId ? `${sourceId}:${sourceWorkId}` : undefined
}

function editionLanguage(book: WorldBook): string | undefined {
  return normalizedCatalogLanguage(book.languages[0])
}

function interfaceCatalogLanguage(locale: string | undefined): string | undefined {
  const primary = locale?.trim().toLowerCase().split('-')[0]
  return primary ? GOOGLE_LANGUAGE_TO_ISO_639_3[primary] ?? primary : undefined
}

function compareWorldEditions(left: WorldBook, right: WorldBook, preferredLanguage: string | undefined): number {
  const leftPreferred = editionLanguage(left) === preferredLanguage ? 0 : 1
  const rightPreferred = editionLanguage(right) === preferredLanguage ? 0 : 1
  if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred

  const leftOriginal = left.isOriginal === true ? 0 : 1
  const rightOriginal = right.isOriginal === true ? 0 : 1
  if (leftOriginal !== rightOriginal) return leftOriginal - rightOriginal

  const languageOrder = (editionLanguage(left) ?? '').localeCompare(editionLanguage(right) ?? '')
  if (languageOrder !== 0) return languageOrder
  const titleOrder = left.title.localeCompare(right.title)
  if (titleOrder !== 0) return titleOrder
  return worldBookIdentity(left).localeCompare(worldBookIdentity(right))
}

/**
 * Build a deterministic Work-first catalog view without guessing literary
 * relationships. Records share a work only when their own source supplied the
 * same `sourceWorkId` under the same source namespace. A record without that
 * identity remains a singleton work, even if its title is identical to another
 * record.
 */
export function groupWorldBooksByWork(books: readonly WorldBook[], options: WorkFirstSearchOptions = {}): WorldWork[] {
  const requestedLanguage = normalizedCatalogLanguage(options.language)
  const preferredLanguage = interfaceCatalogLanguage(options.interfaceLocale)
  const grouped = new Map<string, WorldBook[]>()

  for (const book of books) {
    const explicitIdentity = explicitWorldWorkIdentity(book)
    // A missing explicit work ID creates a singleton rather than a fuzzy merge.
    const key = explicitIdentity ?? `record:${worldBookIdentity(book)}`
    const records = grouped.get(key) ?? []
    records.push(book)
    grouped.set(key, records)
  }

  const works: WorldWork[] = []
  for (const [key, records] of grouped.entries()) {
    const orderedAll = [...records].sort((left, right) => compareWorldEditions(left, right, preferredLanguage))
    const originalEdition = orderedAll.find((book) => book.isOriginal === true)
    const filtered = orderedAll.filter((book) => {
      if (options.originalsOnly && book.isOriginal !== true) return false
      return !requestedLanguage || book.languages.some((language) => normalizedCatalogLanguage(language) === requestedLanguage)
    })
    if (filtered.length === 0) continue

    const representative = originalEdition ?? orderedAll[0]
    works.push({
      id: key,
      sourceId: representative.sourceId,
      sourceWorkId: representative.sourceWorkId,
      title: representative.originalTitle ?? originalEdition?.title ?? representative.title,
      author: representative.author,
      originalTitle: representative.originalTitle ?? originalEdition?.title,
      originalLanguage: representative.originalLanguage ?? (originalEdition ? editionLanguage(originalEdition) : undefined),
      originalEdition,
      editions: filtered,
    })
  }
  return works.sort((left, right) => {
    const titleOrder = left.title.localeCompare(right.title)
    return titleOrder !== 0 ? titleOrder : left.id.localeCompare(right.id)
  })
}

function normalizeSavedWorldBook(book: Partial<WorldBook>): WorldBook | undefined {
  if (typeof book?.id !== 'string' || typeof book?.title !== 'string' || typeof book?.sourceUrl !== 'string') return undefined
  const sourceId = typeof book.sourceId === 'string' ? book.sourceId : 'open-library'
  const sourceRecordId = typeof book.sourceRecordId === 'string' ? book.sourceRecordId : book.id
  const sourceUrl = book.sourceUrl
  return {
    id: book.id || `${sourceId}:${sourceRecordId}`, sourceId, sourceRecordId, title: book.title,
    sourceWorkId: typeof book.sourceWorkId === 'string' && book.sourceWorkId.trim() ? book.sourceWorkId.trim() : undefined,
    author: typeof book.author === 'string' ? book.author : '', year: typeof book.year === 'number' ? book.year : undefined,
    languages: Array.isArray(book.languages) ? book.languages.filter((language): language is string => typeof language === 'string') : [],
    editionCount: typeof book.editionCount === 'number' ? book.editionCount : undefined, coverUrl: typeof book.coverUrl === 'string' ? book.coverUrl : undefined,
    sourceUrl, sourceName: typeof book.sourceName === 'string' ? book.sourceName : 'Open Library',
    access: book.access?.mode && typeof book.access.url === 'string' ? book.access : { mode: 'catalog_only', url: sourceUrl },
    originalTitle: typeof book.originalTitle === 'string' && book.originalTitle.trim() ? book.originalTitle.trim() : undefined,
    originalLanguage: typeof book.originalLanguage === 'string' && book.originalLanguage.trim() ? book.originalLanguage.trim() : undefined,
    isOriginal: book.isOriginal === true,
    platformEditionId: typeof book.platformEditionId === 'string' && book.platformEditionId.trim() ? book.platformEditionId.trim() : undefined,
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
