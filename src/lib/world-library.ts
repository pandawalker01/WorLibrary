export type WorldBook = {
  id: string
  title: string
  author: string
  year?: number
  languages: string[]
  editionCount?: number
  coverUrl?: string
  sourceUrl: string
  sourceName: 'Open Library'
}

const SAVED_WORLD_BOOKS_KEY = 'worlibrary.saved-world-books'

// Open Library indexes ISO 639-3 language codes. This intentionally stays
// global rather than being a short, product-defined language whitelist.
export const WORLD_LANGUAGE_CODES = [
  'aar', 'abk', 'ace', 'afr', 'aka', 'amh', 'ara', 'arg', 'asm', 'ava', 'aym', 'aze', 'bak', 'bam', 'bel', 'ben', 'bis', 'bos', 'bre', 'bul', 'cat', 'ceb', 'ces', 'cha', 'che', 'chi', 'chu', 'chv', 'cor', 'cos', 'cre', 'cym', 'dan', 'deu', 'div', 'dzo', 'ell', 'eng', 'epo', 'est', 'eus', 'ewe', 'fao', 'fas', 'fij', 'fin', 'fon', 'fra', 'fry', 'ful', 'gla', 'gle', 'glg', 'grc', 'guj', 'hat', 'hau', 'heb', 'her', 'hin', 'hmo', 'hrv', 'hun', 'hye', 'ibo', 'ido', 'iii', 'iku', 'ile', 'ina', 'ind', 'ipk', 'isl', 'ita', 'jav', 'jpn', 'kal', 'kan', 'kas', 'kat', 'kau', 'kaz', 'khm', 'kik', 'kin', 'kir', 'kom', 'kon', 'kor', 'kua', 'kur', 'lao', 'lat', 'lav', 'lim', 'lin', 'lit', 'ltz', 'lug', 'mah', 'mal', 'mar', 'mkd', 'mlg', 'mlt', 'mon', 'mri', 'msa', 'mya', 'nau', 'nav', 'nbl', 'nde', 'ndo', 'nep', 'nld', 'nno', 'nob', 'nor', 'nya', 'oci', 'oji', 'ori', 'orm', 'oss', 'pan', 'pli', 'pol', 'por', 'pus', 'que', 'roh', 'ron', 'run', 'rus', 'sag', 'san', 'sin', 'slk', 'slv', 'sme', 'smo', 'sna', 'snd', 'som', 'sot', 'spa', 'sqi', 'srd', 'srp', 'ssw', 'sun', 'swa', 'swe', 'tah', 'tam', 'tat', 'tel', 'tgk', 'tgl', 'tha', 'tir', 'ton', 'tsn', 'tso', 'tuk', 'tur', 'twi', 'uig', 'ukr', 'urd', 'uzb', 'ven', 'vie', 'vol', 'wln', 'wol', 'xho', 'yid', 'yor', 'zha', 'zul',
] as const

export function worldLanguageName(code: string, locale: string): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code } catch { return code }
}

type OpenLibraryDoc = { key?: string; title?: string; author_name?: string[]; first_publish_year?: number; language?: string[]; edition_count?: number; cover_i?: number }

export type WorldLibrarySearchOptions = {
  language?: string
  multiLanguageOnly?: boolean
}

function normalizeWorldBook(doc: OpenLibraryDoc): WorldBook | undefined {
  if (!doc.key || !doc.title) return undefined
  const id = doc.key.replace(/^\/works\//, '')
  return { id, title: doc.title, author: doc.author_name?.[0] ?? '', year: doc.first_publish_year, languages: [...new Set(doc.language ?? [])], editionCount: doc.edition_count, coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : undefined, sourceUrl: `https://openlibrary.org${doc.key}`, sourceName: 'Open Library' }
}

export async function searchWorldLibrary(query: string, options: WorldLibrarySearchOptions = {}, signal?: AbortSignal): Promise<WorldBook[]> {
  const term = query.trim()
  if (!term) return []
  const languageQuery = options.language ? `&language=${encodeURIComponent(options.language)}` : ''
  const response = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(term)}${languageQuery}&limit=24&fields=key,title,author_name,first_publish_year,language,edition_count,cover_i`, { signal })
  if (!response.ok) throw new Error('WORLD_LIBRARY_UNAVAILABLE')
  const payload = await response.json() as { docs?: OpenLibraryDoc[] }
  return (payload.docs ?? []).map(normalizeWorldBook).filter((book): book is WorldBook => Boolean(book)).filter((book) => !options.multiLanguageOnly || book.languages.length > 1)
}

export function loadSavedWorldBooks(): WorldBook[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SAVED_WORLD_BOOKS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((book): book is WorldBook => typeof book?.id === 'string' && typeof book?.title === 'string' && typeof book?.sourceUrl === 'string').map((book) => ({ ...book, languages: Array.isArray(book.languages) ? book.languages : [] })) : []
  } catch { return [] }
}

export function saveWorldBook(book: WorldBook): WorldBook[] {
  const saved = loadSavedWorldBooks()
  const next = saved.some((item) => item.id === book.id) ? saved : [book, ...saved]
  try { window.localStorage.setItem(SAVED_WORLD_BOOKS_KEY, JSON.stringify(next)) } catch { /* Saving a bookmark must not block browsing. */ }
  return next
}
