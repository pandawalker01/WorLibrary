export type WorldBook = {
  id: string
  title: string
  author: string
  year?: number
  language?: string
  coverUrl?: string
  sourceUrl: string
  sourceName: 'Open Library'
}

const SAVED_WORLD_BOOKS_KEY = 'worlibrary.saved-world-books'

type OpenLibraryDoc = { key?: string; title?: string; author_name?: string[]; first_publish_year?: number; language?: string[]; cover_i?: number }

function normalizeWorldBook(doc: OpenLibraryDoc): WorldBook | undefined {
  if (!doc.key || !doc.title) return undefined
  const id = doc.key.replace(/^\/works\//, '')
  return { id, title: doc.title, author: doc.author_name?.[0] ?? '', year: doc.first_publish_year, language: doc.language?.[0], coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : undefined, sourceUrl: `https://openlibrary.org${doc.key}`, sourceName: 'Open Library' }
}

export async function searchWorldLibrary(query: string, signal?: AbortSignal): Promise<WorldBook[]> {
  const term = query.trim()
  if (!term) return []
  const response = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(term)}&limit=12&fields=key,title,author_name,first_publish_year,language,cover_i`, { signal })
  if (!response.ok) throw new Error('WORLD_LIBRARY_UNAVAILABLE')
  const payload = await response.json() as { docs?: OpenLibraryDoc[] }
  return (payload.docs ?? []).map(normalizeWorldBook).filter((book): book is WorldBook => Boolean(book))
}

export function loadSavedWorldBooks(): WorldBook[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SAVED_WORLD_BOOKS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((book): book is WorldBook => typeof book?.id === 'string' && typeof book?.title === 'string' && typeof book?.sourceUrl === 'string') : []
  } catch { return [] }
}

export function saveWorldBook(book: WorldBook): WorldBook[] {
  const saved = loadSavedWorldBooks()
  const next = saved.some((item) => item.id === book.id) ? saved : [book, ...saved]
  try { window.localStorage.setItem(SAVED_WORLD_BOOKS_KEY, JSON.stringify(next)) } catch { /* Saving a bookmark must not block browsing. */ }
  return next
}
