const CATALOG_TIMEOUT_MS = 8_000
const MAX_QUERY_LENGTH = 180
const AI_TIMEOUT_MS = 12_000
const AI_RATE_WINDOW_MS = 60_000
const DEFAULT_AI_RATE_LIMIT = 10
const MAX_AI_TEXT_LENGTH = 5_000
const MAX_AI_CONTEXT_LENGTH = 1_500
const MAX_AI_LANGUAGE_LENGTH = 64
const MAX_PLATFORM_EDITION_ID_LENGTH = 160
const PLATFORM_ACCESS_MODES = new Set(['download', 'stream', 'external_reader', 'preview', 'catalog_only'])
const PLATFORM_DELIVERY_MODES = new Set(['stream', 'preview'])
const PLATFORM_CONTENT_TYPES = new Set(['application/epub+zip', 'application/pdf'])
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

const aiErrorDefinitions = {
  invalid_request: ['请求内容无效，请检查选中文本和语言设置。', false, 400],
  request_too_large: ['选中文本过长，请缩短后重试。', false, 413],
  rate_limited: ['请求太频繁，请稍后再试。', true, 429],
  provider_unavailable: ['AI 服务暂时不可用，请稍后再试。', true, 503],
  provider_timeout: ['AI 服务响应超时，请稍后再试。', true, 504],
  provider_error: ['AI 服务暂时出错，请稍后再试。', true, 502],
  provider_rate_limited: ['AI 供应商当前繁忙，请稍后再试。', true, 503],
}

// This is intentionally only a small edge-instance guard. Production-wide
// quotas belong in a durable account/usage service; it still prevents a
// single client from accidentally or trivially flooding one Worker isolate.
const aiRequestsByClient = new Map()

function requestId(request) {
  return request.headers.get('x-request-id') || crypto.randomUUID()
}

function json(value, status, id) {
  return new Response(JSON.stringify(value), { status, headers: { ...API_HEADERS, 'x-request-id': id } })
}

function aiError(code, id, extraHeaders = {}) {
  const [message, retryable, status] = aiErrorDefinitions[code] || aiErrorDefinitions.provider_error
  return new Response(JSON.stringify({ error: { code, message, retryable } }), {
    status,
    headers: { ...API_HEADERS, ...extraHeaders, 'x-request-id': id },
  })
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

function boundedPositiveInteger(value, fallback, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

function normalizedLanguage(value, fallback) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, MAX_AI_LANGUAGE_LENGTH)
    : fallback
}

function normalizeAiInput(body, kind) {
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') return undefined
  const text = body.text.trim()
  if (!text) return undefined
  if (text.length > MAX_AI_TEXT_LENGTH) return { error: 'request_too_large' }
  return {
    kind,
    text,
    sourceLanguage: normalizedLanguage(body.sourceLanguage, 'auto'),
    targetLanguage: normalizedLanguage(body.targetLanguage, 'zh-CN'),
    context: typeof body.context === 'string' ? body.context.trim().slice(0, MAX_AI_CONTEXT_LENGTH) : '',
  }
}

function clientKey(request) {
  // CF-Connecting-IP is supplied by Cloudflare, unlike client-controlled
  // identifiers. A fallback keeps local wrangler development usable.
  return request.headers.get('cf-connecting-ip') || 'local-development-client'
}

function rateLimited(request, env) {
  const limit = boundedPositiveInteger(env.AI_RATE_LIMIT, DEFAULT_AI_RATE_LIMIT, 1_000)
  const client = clientKey(request)
  const now = Date.now()
  const recent = (aiRequestsByClient.get(client) || []).filter((time) => time > now - AI_RATE_WINDOW_MS)
  if (recent.length >= limit) {
    aiRequestsByClient.set(client, recent)
    return true
  }
  aiRequestsByClient.set(client, [...recent, now])
  return false
}

function configuredAi(env) {
  const provider = env.AI_PROVIDER || 'openai'
  const apiKey = typeof env.AI_API_KEY === 'string' ? env.AI_API_KEY.trim() : ''
  const model = typeof env.AI_MODEL === 'string' ? env.AI_MODEL.trim() : ''
  const baseUrl = (typeof env.AI_BASE_URL === 'string' && env.AI_BASE_URL.trim()
    ? env.AI_BASE_URL
    : 'https://api.openai.com/v1').replace(/\/$/, '')
  if (provider !== 'openai' || !apiKey || !model || !/^https:\/\//i.test(baseUrl)) return undefined
  return { provider, apiKey, model, baseUrl }
}

function providerPrompt(input) {
  if (input.kind === 'translate') {
    return 'Translate the selected text into the requested target language. Return only the translation, without commentary, labels, or quotation marks.'
  }
  return 'Translate the selected text into the requested target language, then explain its meaning in plain language. Return valid JSON with string keys "translation" and "explanation", and no markdown.'
}

async function requestAiProvider(input, config, env) {
  const timeoutMs = boundedPositiveInteger(env.AI_TIMEOUT_MS, AI_TIMEOUT_MS, 120_000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: input.kind === 'explain' ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: providerPrompt(input) },
          { role: 'user', content: `Source language: ${input.sourceLanguage}\nTarget language: ${input.targetLanguage}\nContext: ${input.context || '(none)'}\nSelected text:\n${input.text}` },
        ],
      }),
    })
    if (!response.ok) {
      if (response.status === 429) return { error: 'provider_rate_limited' }
      return { error: 'provider_error' }
    }
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return { error: 'provider_error' }
    if (input.kind === 'translate') return { translation: content.trim(), provider: config.provider, model: config.model, cached: false }
    try {
      const explanation = JSON.parse(content)
      if (typeof explanation.translation !== 'string' || !explanation.translation.trim() || typeof explanation.explanation !== 'string' || !explanation.explanation.trim()) return { error: 'provider_error' }
      return { translation: explanation.translation.trim(), explanation: explanation.explanation.trim(), provider: config.provider, model: config.model, cached: false }
    } catch {
      return { error: 'provider_error' }
    }
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'provider_timeout' : 'provider_error' }
  } finally {
    clearTimeout(timeout)
  }
}

async function ai(request, env, id, kind) {
  if (request.method !== 'POST') return methodNotAllowed(id)
  let body
  try {
    body = await request.json()
  } catch {
    return aiError('invalid_request', id)
  }
  const input = normalizeAiInput(body, kind)
  if (!input) return aiError('invalid_request', id)
  if (input.error) return aiError(input.error, id)
  const config = configuredAi(env)
  if (!config) return aiError('provider_unavailable', id)
  if (rateLimited(request, env)) return aiError('rate_limited', id, { 'Retry-After': '60' })
  const result = await requestAiProvider(input, config, env)
  return result.error ? aiError(result.error, id) : json(result, 200, id)
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

function health(request, env, id) {
  if (request.method !== 'GET') return methodNotAllowed(id)
  // This reports only readiness, never provider credentials, model names, or
  // provider URLs. It lets deployment checks distinguish an unreachable AI
  // provider from a missing Worker secret.
  return json({ status: 'ok', runtime: 'cloudflare-worker', catalog: 'configured', translation: { configured: Boolean(configuredAi(env)) } }, 200, id)
}

function translationStatus(request, env, id) {
  if (request.method !== 'GET') return methodNotAllowed(id)
  // Keep this narrow so public readiness checks can never become an endpoint
  // for discovering credentials, model choices, or provider topology.
  return json({
    status: 'ok',
    service: 'worlibrary-translation',
    configured: Boolean(configuredAi(env)),
    authRequired: false,
  }, 200, id)
}

function readerAccessError(code, status, id) {
  const messages = {
    INVALID_EDITION_ID: 'The requested edition identifier is invalid.',
    PLATFORM_ACCESS_UNCONFIGURED: 'Platform reader access is not configured.',
    ACCESS_POLICY_INVALID: 'The platform access policy is invalid.',
    EDITION_NOT_FOUND: 'The requested platform edition was not found.',
    AUTH_REQUIRED: 'Sign in is required to read this edition.',
    AUTHORIZATION_UNAVAILABLE: 'Reader authorization is temporarily unavailable.',
    AUTHORIZATION_INVALID: 'Reader authorization returned an invalid decision.',
    ACCESS_DENIED: 'This account is not entitled to read this edition.',
  }
  return json({ error: { code, message: messages[code] || 'Reader access is unavailable.', retryable: status >= 500 } }, status, id)
}

function platformAccessCatalog(env) {
  const raw = typeof env.PLATFORM_CONTENT_ACCESS_JSON === 'string' ? env.PLATFORM_CONTENT_ACCESS_JSON.trim() : ''
  if (!raw) return { error: 'PLATFORM_ACCESS_UNCONFIGURED' }
  try {
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return { error: 'ACCESS_POLICY_INVALID' }
    const records = new Map()
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.editionId !== 'string' || typeof entry.accessMode !== 'string') return { error: 'ACCESS_POLICY_INVALID' }
      const editionId = entry.editionId.trim()
      if (!editionId || editionId.length > MAX_PLATFORM_EDITION_ID_LENGTH || !PLATFORM_ACCESS_MODES.has(entry.accessMode) || records.has(editionId)) return { error: 'ACCESS_POLICY_INVALID' }
      if (entry.accessMode === 'external_reader' && (typeof entry.externalReaderUrl !== 'string' || !/^https:\/\//i.test(entry.externalReaderUrl))) return { error: 'ACCESS_POLICY_INVALID' }
      const r2ObjectKey = typeof entry.r2ObjectKey === 'string' ? entry.r2ObjectKey.trim() : undefined
      const contentType = typeof entry.contentType === 'string' ? entry.contentType.trim().toLowerCase() : undefined
      if (r2ObjectKey && (!PLATFORM_DELIVERY_MODES.has(entry.accessMode) || r2ObjectKey.length > 1_024 || r2ObjectKey.startsWith('/') || r2ObjectKey.includes('..'))) return { error: 'ACCESS_POLICY_INVALID' }
      if (contentType && (!r2ObjectKey || !PLATFORM_CONTENT_TYPES.has(contentType))) return { error: 'ACCESS_POLICY_INVALID' }
      records.set(editionId, {
        editionId,
        accessMode: entry.accessMode,
        requiresAuthorization: entry.requiresAuthorization !== false,
        rightsNotice: typeof entry.rightsNotice === 'string' ? entry.rightsNotice.slice(0, 500) : undefined,
        externalReaderUrl: entry.accessMode === 'external_reader' ? entry.externalReaderUrl : undefined,
        r2ObjectKey,
        contentType,
      })
    }
    return { records }
  } catch {
    return { error: 'ACCESS_POLICY_INVALID' }
  }
}

function configuredAuthorizationUrl(env) {
  const value = typeof env.READER_AUTHORIZATION_URL === 'string' ? env.READER_AUTHORIZATION_URL.trim() : ''
  return /^https:\/\//i.test(value) ? value : undefined
}

async function authorizeReaderAccess(request, authorizationUrl, record, id) {
  const authorization = request.headers.get('authorization')
  if (!authorization) return { error: 'AUTH_REQUIRED', status: 401 }
  if (!authorizationUrl) return { error: 'AUTHORIZATION_UNAVAILABLE', status: 503 }
  try {
    const response = await fetch(authorizationUrl, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'x-request-id': id,
      },
      body: JSON.stringify({ editionId: record.editionId, accessMode: record.accessMode }),
    })
    if (response.status === 401 || response.status === 403) return { error: 'ACCESS_DENIED', status: 403 }
    if (!response.ok) return { error: 'AUTHORIZATION_UNAVAILABLE', status: 503 }
    const decision = await response.json()
    if (typeof decision?.allowed !== 'boolean') return { error: 'AUTHORIZATION_INVALID', status: 502 }
    return decision.allowed ? { allowed: true } : { error: 'ACCESS_DENIED', status: 403 }
  } catch {
    return { error: 'AUTHORIZATION_UNAVAILABLE', status: 503 }
  }
}

async function readerAccess(request, env, id) {
  if (request.method !== 'GET') return methodNotAllowed(id)
  const editionId = (new URL(request.url).searchParams.get('editionId') || '').trim()
  if (!editionId || editionId.length > MAX_PLATFORM_EDITION_ID_LENGTH) return readerAccessError('INVALID_EDITION_ID', 400, id)
  const catalog = platformAccessCatalog(env)
  if (catalog.error) return readerAccessError(catalog.error, 503, id)
  const record = catalog.records.get(editionId)
  if (!record) return readerAccessError('EDITION_NOT_FOUND', 404, id)
  if (record.requiresAuthorization) {
    const authorization = await authorizeReaderAccess(request, configuredAuthorizationUrl(env), record, id)
    if (authorization.error) return readerAccessError(authorization.error, authorization.status, id)
  }
  // This policy endpoint intentionally does not return book bytes, object-store
  // keys, signed download URLs, or reader session tokens. The content route
  // repeats the same entitlement verification before reading an authorized asset.
  const canDeliverInApp = PLATFORM_DELIVERY_MODES.has(record.accessMode)
    && Boolean(record.r2ObjectKey && record.contentType && configuredContentBucket(env))
  return json({
    editionId: record.editionId,
    access_mode: record.accessMode,
    rights_notice: record.rightsNotice,
    delivery: {
      available: canDeliverInApp,
      ...(canDeliverInApp ? { mode: 'in_app_stream', content_type: record.contentType } : { reason: 'content_delivery_unavailable' }),
    },
    ...(record.externalReaderUrl ? { external_reader_url: record.externalReaderUrl } : {}),
  }, 200, id)
}

function readerContentError(code, status, id, extraHeaders = {}) {
  const messages = {
    CONTENT_DELIVERY_UNAVAILABLE: 'This edition is not configured for in-app delivery.',
    CONTENT_NOT_FOUND: 'The requested edition content is unavailable.',
    RANGE_NOT_SATISFIABLE: 'The requested content range is invalid.',
  }
  return new Response(JSON.stringify({ error: { code, message: messages[code] || 'Reader content is unavailable.', retryable: status >= 500 } }), {
    status,
    headers: { ...API_HEADERS, ...extraHeaders, 'x-request-id': id },
  })
}

function parseSingleRange(value, size) {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || size <= 0) return { error: true }
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return { error: true }
  let start
  let end
  if (rawStart) {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  } else {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { error: true }
    start = Math.max(size - suffixLength, 0)
    end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { error: true }
  return { start, end: Math.min(end, size - 1) }
}

function configuredContentBucket(env) {
  return env.PLATFORM_CONTENT && typeof env.PLATFORM_CONTENT.get === 'function' ? env.PLATFORM_CONTENT : undefined
}

async function readerContent(request, env, id) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(id)
  const editionId = (new URL(request.url).searchParams.get('editionId') || '').trim()
  if (!editionId || editionId.length > MAX_PLATFORM_EDITION_ID_LENGTH) return readerAccessError('INVALID_EDITION_ID', 400, id)
  const catalog = platformAccessCatalog(env)
  if (catalog.error) return readerAccessError(catalog.error, 503, id)
  const record = catalog.records.get(editionId)
  if (!record) return readerAccessError('EDITION_NOT_FOUND', 404, id)
  if (!PLATFORM_DELIVERY_MODES.has(record.accessMode) || !record.r2ObjectKey || !record.contentType) return readerContentError('CONTENT_DELIVERY_UNAVAILABLE', 503, id)
  if (record.requiresAuthorization) {
    const authorization = await authorizeReaderAccess(request, configuredAuthorizationUrl(env), record, id)
    if (authorization.error) return readerAccessError(authorization.error, authorization.status, id)
  }
  const bucket = configuredContentBucket(env)
  if (!bucket) return readerContentError('CONTENT_DELIVERY_UNAVAILABLE', 503, id)
  let head
  try {
    head = await bucket.head?.(record.r2ObjectKey)
  } catch {
    return readerContentError('CONTENT_DELIVERY_UNAVAILABLE', 503, id)
  }
  if (!head || !Number.isSafeInteger(head.size) || head.size < 1) return readerContentError('CONTENT_NOT_FOUND', 404, id)
  const range = parseSingleRange(request.headers.get('range'), head.size)
  if (range?.error) return readerContentError('RANGE_NOT_SATISFIABLE', 416, id, { 'Content-Range': `bytes */${head.size}` })
  let object
  try {
    object = request.method === 'HEAD'
      ? head
      : await bucket.get(record.r2ObjectKey, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined)
  } catch {
    return readerContentError('CONTENT_DELIVERY_UNAVAILABLE', 503, id)
  }
  if (!object) return readerContentError('CONTENT_NOT_FOUND', 404, id)
  const responseRange = range || { start: 0, end: head.size - 1 }
  const partial = Boolean(range)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(responseRange.end - responseRange.start + 1),
    'Content-Type': record.contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'x-request-id': id,
  })
  if (partial) headers.set('Content-Range', `bytes ${responseRange.start}-${responseRange.end}/${head.size}`)
  return new Response(request.method === 'HEAD' ? null : object.body, { status: partial ? 206 : 200, headers })
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
    if (url.pathname === '/api/health' || url.pathname === '/health') return health(request, env, id)
    if (url.pathname === '/api/catalog') return catalog(request, id)
    if (url.pathname === '/api/reader/access') return readerAccess(request, env, id)
    if (url.pathname === '/api/reader/content') return readerContent(request, env, id)
    if (url.pathname === '/api/translation-status') return translationStatus(request, env, id)
    if (url.pathname === '/api/translate') return ai(request, env, id, 'translate')
    if (url.pathname === '/api/explain') return ai(request, env, id, 'explain')
    if (url.pathname.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404, id)
    return withPageSecurity(await staticAsset(request, env))
  },
}
