const CATALOG_TIMEOUT_MS = 8_000
const MAX_QUERY_LENGTH = 180
// Catalog metadata is public, but search terms are still short-lived cache
// entries. Health and user/AI routes keep the stricter no-store policy.
const CATALOG_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=60'
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

function requestId(request) {
  return request.headers.get('x-request-id') || crypto.randomUUID()
}

function json(value, status, id) {
  return new Response(JSON.stringify(value), { status, headers: { ...API_HEADERS, 'x-request-id': id } })
}

function catalogCacheKey(query, language, multiLanguageOnly) {
  const url = new URL('https://catalog-cache.invalid/api/catalog')
  // Normalize only the cache key. The original normalized query is still sent
  // upstream so the source remains responsible for its search semantics.
  url.searchParams.set('q', query.replace(/\s+/g, ' ').toLowerCase())
  if (language) url.searchParams.set('language', language)
  url.searchParams.set('multiLanguageOnly', multiLanguageOnly ? '1' : '0')
  return new Request(url.toString())
}

function catalogSuccess(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'Cache-Control': CATALOG_CACHE_CONTROL,
      'Content-Type': 'application/json; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function withRequestId(response, id) {
  const headers = new Headers(response.headers)
  // Request IDs are trace metadata, never a shared cache value.
  headers.set('x-request-id', id)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function methodNotAllowed(id) {
  return json({ error: 'METHOD_NOT_ALLOWED' }, 405, id)
}

function normalizeOpenLibrary(doc) {
  if (!doc?.key || !doc.title) return undefined
  const sourceRecordId = doc.key.replace(/^\/works\//, '')
  const sourceUrl = `https://openlibrary.org${doc.key}`
  return {
    id: `open-library:${sourceRecordId}`,
    sourceId: 'open-library',
    sourceRecordId,
    title: doc.title,
    author: doc.author_name?.[0] || '',
    year: doc.first_publish_year,
    languages: [...new Set(doc.language || [])],
    editionCount: doc.edition_count,
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : undefined,
    sourceUrl,
    sourceName: 'Open Library',
    access: { mode: 'catalog_only', url: sourceUrl },
  }
}

const googleLanguageByIso3 = {
  eng: 'en', chi: 'zh', jpn: 'ja', kor: 'ko', fra: 'fr', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', ara: 'ar', hin: 'hi',
  nld: 'nl', pol: 'pl', tur: 'tr', ukr: 'uk', vie: 'vi', ind: 'id', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', ces: 'cs', ell: 'el',
  heb: 'he', tha: 'th',
}

function googleAccess(item, sourceUrl) {
  const viewability = item.accessInfo?.viewability
  if (viewability === 'FULL_PUBLIC_DOMAIN') return { mode: 'public_domain', url: item.accessInfo?.webReaderLink || sourceUrl, rightsNotice: 'Google Books reports this volume as public domain.' }
  if (viewability === 'ALL_PAGES' || viewability === 'PARTIAL') return { mode: 'preview', url: item.accessInfo?.webReaderLink || sourceUrl }
  return { mode: 'catalog_only', url: sourceUrl }
}

function normalizeGoogle(item) {
  const sourceRecordId = item?.id
  const title = item?.volumeInfo?.title
  if (!sourceRecordId || !title) return undefined
  const sourceUrl = item.volumeInfo.infoLink || `https://books.google.com/books?id=${encodeURIComponent(sourceRecordId)}`
  const published = item.volumeInfo.publishedDate
  return {
    id: `google-books:${sourceRecordId}`,
    sourceId: 'google-books',
    sourceRecordId,
    title,
    author: item.volumeInfo.authors?.[0] || '',
    year: /^\d{4}/.test(published || '') ? Number(published.slice(0, 4)) : undefined,
    languages: item.volumeInfo.language ? [item.volumeInfo.language] : [],
    coverUrl: item.volumeInfo.imageLinks?.thumbnail?.replace(/^http:/, 'https:'),
    sourceUrl,
    sourceName: 'Google Books',
    access: googleAccess(item, sourceUrl),
  }
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`UPSTREAM_${response.status}`)
  return response.json()
}

async function searchCatalog(query, language, multiLanguageOnly) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('catalog timeout'), CATALOG_TIMEOUT_MS)
  const openLibraryParams = new URLSearchParams({ q: query, limit: '24', fields: 'key,title,author_name,first_publish_year,language,edition_count,cover_i' })
  if (language) openLibraryParams.set('language', language)
  const googleParams = new URLSearchParams({ q: query, maxResults: '20', printType: 'books' })
  const googleLanguage = language ? googleLanguageByIso3[language] : undefined
  if (googleLanguage) googleParams.set('langRestrict', googleLanguage)
  const requests = [
    fetchJson(`https://openlibrary.org/search.json?${openLibraryParams}`, controller.signal)
      .then((payload) => (payload.docs || []).map(normalizeOpenLibrary).filter(Boolean)),
    language && !googleLanguage
      ? Promise.resolve([])
      : fetchJson(`https://www.googleapis.com/books/v1/volumes?${googleParams}`, controller.signal)
        .then((payload) => (payload.items || []).map(normalizeGoogle).filter(Boolean)),
  ]
  try {
    const settled = await Promise.allSettled(requests)
    const books = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((book) => !multiLanguageOnly || book.languages.length > 1)
    if (books.length === 0 && settled.every((result) => result.status === 'rejected')) throw new Error('CATALOG_UNAVAILABLE')
    return [...new Map(books.map((book) => [`${book.sourceId}:${book.sourceRecordId}`, book])).values()]
  } finally {
    clearTimeout(timeout)
  }
}

async function catalog(request, id) {
  if (request.method !== 'GET') return methodNotAllowed(id)
  const url = new URL(request.url)
  const query = (url.searchParams.get('q') || '').trim()
  const language = url.searchParams.get('language') || undefined
  const multiLanguageOnly = url.searchParams.get('multiLanguageOnly') === 'true'
  if (!query || query.length > MAX_QUERY_LENGTH) return json({ error: 'INVALID_QUERY' }, 400, id)
  if (language && !/^[a-z]{3}$/.test(language)) return json({ error: 'INVALID_LANGUAGE' }, 400, id)
  const cache = globalThis.caches?.default
  const cacheKey = catalogCacheKey(query, language, multiLanguageOnly)
  const cached = cache ? await cache.match(cacheKey) : undefined
  if (cached) return withRequestId(cached, id)
  try {
    const books = await searchCatalog(query, language, multiLanguageOnly)
    const response = catalogSuccess({ books, sources: ['open-library', 'google-books'] })
    // Errors are returned below and are intentionally never written to cache.
    if (cache) await cache.put(cacheKey, response.clone())
    return withRequestId(response, id)
  } catch {
    return json({ error: 'WORLD_LIBRARY_UNAVAILABLE' }, 503, id)
  }
}

function health(request, id) {
  if (request.method !== 'GET') return methodNotAllowed(id)
  return json({ status: 'ok', runtime: 'cloudflare-worker', catalog: 'configured' }, 200, id)
}

function htmlNavigation(request) {
  return request.method === 'GET' && request.headers.get('accept')?.includes('text/html')
}

async function staticAsset(request, env) {
  const asset = await env.ASSETS.fetch(request)
  if (asset.status !== 404 || !htmlNavigation(request)) return asset
  return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request))
}

function withPageSecurity(response) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const id = requestId(request)
    if (url.pathname === '/api/health' || url.pathname === '/health') return health(request, id)
    if (url.pathname === '/api/catalog') return catalog(request, id)
    if (url.pathname.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404, id)
    return withPageSecurity(await staticAsset(request, env))
  },
}
