import { createSupabaseJwtVerifier } from './supabase-jwt.mjs'
import { createSupabaseQuotaStore } from './supabase-quota-store.mjs'

const DEFAULT_LIMIT = 5_000
const DEFAULT_DAILY_QUOTA = 20
const DEFAULT_RATE_LIMIT = 10
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_RETRY_ATTEMPTS = 2

const errorDefinitions = {
  invalid_request: ['请求内容无效，请检查选中文本和语言设置。', false, 400],
  unauthorized: ['请先登录后再使用 AI 服务。', false, 401],
  request_too_large: ['选中文本过长，请缩短后重试。', false, 413],
  rate_limited: ['请求太频繁，请稍后再试。', true, 429],
  quota_exceeded: ['今日 AI 试用额度已用完，请明天再试。', false, 429],
  provider_unavailable: ['AI 服务暂时不可用，请稍后重试。', true, 503],
  provider_timeout: ['AI 服务响应超时，请稍后重试。', true, 504],
  provider_error: ['AI 服务暂时出错，请稍后重试。', true, 502],
  provider_rate_limited: ['AI 供应商当前繁忙，请稍后重试。', true, 503],
  internal_error: ['服务暂时不可用，请稍后重试。', true, 500],
}

function gatewayError(code, detail) {
  const [message, retryable, status] = errorDefinitions[code] ?? errorDefinitions.internal_error
  return { code, message, retryable, status }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function fail(code, headers = {}) {
  const error = gatewayError(code)
  return json({ error: { code: error.code, message: error.message, retryable: error.retryable } }, error.status, headers)
}

function requestIdFor(request) {
  const supplied = request.headers.get('x-request-id')?.trim()
  return supplied ? supplied.slice(0, 128) : crypto.randomUUID()
}

function healthResponse(env, requestId) {
  const provider = env.AI_PROVIDER || 'openai'
  const configured = provider === 'mock'
    ? (env.NODE_ENV || env.AI_ENV || 'development') !== 'production'
    : Boolean(env.AI_API_KEY && env.AI_MODEL && /^https?:\/\//i.test(env.AI_BASE_URL || 'https://api.openai.com/v1'))
  return json({
    status: 'ok',
    service: 'worlibrary-ai-gateway',
    provider,
    providerConfigured: configured,
    timestamp: new Date().toISOString(),
  }, 200, { 'cache-control': 'no-store', 'x-request-id': requestId })
}

function normaliseLanguage(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : fallback
}

function normaliseRequest(body, kind) {
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') return { error: 'invalid_request' }
  const text = body.text.trim()
  if (!text) return { error: 'invalid_request' }
  if (text.length > DEFAULT_LIMIT) return { error: 'request_too_large' }
  const sourceLanguage = normaliseLanguage(body.sourceLanguage, 'auto')
  const targetLanguage = normaliseLanguage(body.targetLanguage, 'zh-CN')
  const context = typeof body.context === 'string' ? body.context.trim().slice(0, 1_500) : ''
  const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim().slice(0, 128) : crypto.randomUUID()
  return { kind, text, sourceLanguage, targetLanguage, context, requestId }
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

function clientKey(request) {
  return request.headers.get('x-anonymous-id') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'anonymous'
}

function positiveNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? Math.min(parsed, max) : fallback
}

async function authenticateRequest(request, env, verifier, required) {
  const authorization = request.headers.get('authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (token) {
    if (!verifier) return null
    try {
      const identity = await verifier(token, request)
      return identity?.id ? { ...identity, accessToken: token } : null
    } catch { return null }
  }
  if (required) return null
  return { id: token ? `token:${token.slice(0, 16)}` : clientKey(request), anonymous: !token }
}

function safeLog(logger, event, fields = {}) {
  logger?.({ event, ...fields })
}

function makeProvider(env, fetchImpl) {
  const environment = env.AI_ENV || env.NODE_ENV || 'development'
  const providerName = env.AI_PROVIDER || 'openai'
  if (providerName === 'mock') {
    if (environment === 'production') return async () => { throw Object.assign(new Error('mock provider is disabled in production'), { code: 'provider_unavailable' }) }
    return async ({ kind, text, targetLanguage }) => kind === 'translate'
      ? { translation: `[${targetLanguage}] ${text}`, model: 'mock', provider: 'mock' }
      : { translation: `[${targetLanguage}] ${text}`, explanation: '开发环境模拟解释，仅用于本地联调。', model: 'mock', provider: 'mock' }
  }
  const apiKey = typeof env.AI_API_KEY === 'string' ? env.AI_API_KEY.trim() : ''
  const baseUrl = (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = env.AI_MODEL || 'gpt-4o-mini'
  return async ({ kind, text, sourceLanguage, targetLanguage, context, signal }) => {
    if (!apiKey || !/^https?:\/\//i.test(baseUrl) || !model.trim()) throw Object.assign(new Error('AI provider is not configured'), { code: 'provider_unavailable' })
    const task = kind === 'translate'
      ? `Translate the selected text to ${targetLanguage}. Return only the translation.`
      : `Translate the selected text to ${targetLanguage}, then explain its meaning in plain language in ${targetLanguage}. Return valid JSON with keys "translation" and "explanation".`
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, response_format: kind === 'explain' ? { type: 'json_object' } : undefined, messages: [
        { role: 'system', content: task },
        { role: 'user', content: `Source language: ${sourceLanguage}\nContext: ${context || '(none)'}\nText:\n${text}` },
      ] }),
    })
    if (!response.ok) {
      const code = response.status === 429 ? 'provider_rate_limited' : response.status === 401 || response.status === 403 ? 'provider_unavailable' : 'provider_error'
      throw Object.assign(new Error(`provider status ${response.status}`), { code, status: response.status })
    }
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('empty provider response'), { code: 'provider_error' })
    if (kind === 'translate') return { translation: content.trim(), model, provider: env.AI_PROVIDER || 'openai' }
    try {
      const parsed = JSON.parse(content)
      if (typeof parsed.translation !== 'string' || typeof parsed.explanation !== 'string') throw new Error('invalid shape')
      return { translation: parsed.translation.trim(), explanation: parsed.explanation.trim(), model, provider: env.AI_PROVIDER || 'openai' }
    } catch {
      throw Object.assign(new Error('provider returned invalid JSON'), { code: 'provider_error' })
    }
  }
}

export function createAiGateway({ env = {}, fetchImpl = fetch, logger = console.warn, now = () => Date.now(), provider, store, authVerifier } = {}) {
  const cache = new Map()
  const usage = new Map()
  const idempotency = new Map()
  const requests = new Map()
  const dailyQuota = positiveNumber(env.AI_DAILY_QUOTA || DEFAULT_DAILY_QUOTA, DEFAULT_DAILY_QUOTA, { max: 1_000_000 })
  const rateLimit = positiveNumber(env.AI_RATE_LIMIT || DEFAULT_RATE_LIMIT, DEFAULT_RATE_LIMIT, { max: 1_000 })
  const timeoutMs = positiveNumber(env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { max: 120_000 })
  const cacheTtlMs = positiveNumber(env.AI_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, { max: 7 * 24 * 60 * 60 * 1_000 })
  const retryAttempts = Math.round(positiveNumber(env.AI_RETRY_ATTEMPTS || DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS, { max: 3 }))
  const retryDelayMs = positiveNumber(env.AI_RETRY_DELAY_MS || 1, 0, { min: 0, max: 2_000 })
  const callProvider = provider || makeProvider(env, fetchImpl)
  const production = (env.AI_ENV || env.NODE_ENV || 'development') === 'production'
  const requireAuth = production || env.AI_REQUIRE_AUTH === 'true'
  const verifyIdentity = authVerifier || createSupabaseJwtVerifier({
    secret: env.SUPABASE_JWT_SECRET,
    issuer: env.SUPABASE_JWT_ISSUER,
    audience: env.SUPABASE_JWT_AUDIENCE || 'authenticated',
    now,
  })
  const durableQuotaStore = store?.consume ? store : createSupabaseQuotaStore({ env, fetchImpl })

  return async function handle(request) {
    const requestId = requestIdFor(request)
    const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-headers': 'authorization, content-type, x-anonymous-id, x-request-id', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'x-request-id': requestId }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const url = new URL(request.url)
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) return healthResponse(env, requestId)
    if (request.method !== 'POST') return fail('invalid_request', cors)
    const kind = url.pathname.endsWith('/explain') ? 'explain' : url.pathname.endsWith('/translate') ? 'translate' : null
    if (!kind) return new Response('Not found', { status: 404, headers: cors })
    let body
    try { body = await request.json() } catch { return fail('invalid_request', cors) }
    const input = normaliseRequest(body, kind)
    if (input.error) return fail(input.error, cors)
    const identityResult = await authenticateRequest(request, env, verifyIdentity, requireAuth)
    if (!identityResult?.id) return fail('unauthorized', cors)
    // Production must not silently fall back to a process-local quota after a
    // restart or scale-out. Configuration details remain server-side.
    if (production && (!durableQuotaStore?.consume || !durableQuotaStore?.release)) {
      safeLog(logger, 'ai_quota_store_unavailable', { traceId: requestId, reason: 'missing_persistent_adapter' })
      return fail('provider_unavailable', cors)
    }
    const identity = identityResult.id
    const nowValue = now()
    const windowStart = nowValue - 60_000
    const recent = (requests.get(identity) || []).filter((time) => time > windowStart)
    if (recent.length >= rateLimit) return fail('rate_limited', { ...cors, 'retry-after': '60' })
    requests.set(identity, [...recent, nowValue])
    const day = todayKey()
    const quotaKey = `${identity}:${day}`
    const key = await digest(JSON.stringify({ kind, text: input.text, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, context: input.context }))
    const idempotencyKey = `${identity}:${input.requestId}`
    const previous = store?.getIdempotency ? await store.getIdempotency(idempotencyKey) : idempotency.get(idempotencyKey)
    if (previous?.expiresAt > nowValue) return json({ ...previous.value, cached: true }, 200, cors)
    const cached = store?.getCache ? await store.getCache(key) : cache.get(key)
    if (cached && cached.expiresAt > nowValue) return json({ ...cached.value, cached: true }, 200, cors)
    let quotaReservation
    let consumed = 0
    if (durableQuotaStore?.consume) {
      try {
        quotaReservation = await durableQuotaStore.consume({
          accessToken: identityResult.accessToken,
          requestId: input.requestId,
          kind,
          dailyLimit: dailyQuota,
        })
      } catch (error) {
        safeLog(logger, 'ai_quota_store_unavailable', { kind, requestId: input.requestId, traceId: requestId, code: error?.code || 'unknown' })
        return fail('provider_unavailable', cors)
      }
      if (!quotaReservation.allowed) return fail('quota_exceeded', cors)
    } else {
      consumed = store?.getUsage ? await store.getUsage(quotaKey) : usage.get(quotaKey) || 0
      if (consumed >= dailyQuota) return fail('quota_exceeded', cors)
    }
    let result
    try {
      let lastError
      for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        try { result = await callProvider({ ...input, signal: controller.signal }); break } catch (error) {
          lastError = error
          if (error?.name === 'AbortError' || error?.code === 'provider_timeout') throw Object.assign(new Error('provider timeout'), { code: 'provider_timeout' })
          const retryable = error?.code === 'provider_error' || error?.code === 'provider_rate_limited'
          if (!retryable || attempt === retryAttempts - 1) throw error
          if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        } finally { clearTimeout(timeout) }
      }
      if (!result) throw lastError || new Error('provider failed')
    } catch (error) {
      const code = error?.code || (error?.name === 'AbortError' ? 'provider_timeout' : 'provider_error')
      if (quotaReservation?.charged) {
        try {
          await durableQuotaStore.release({ accessToken: identityResult.accessToken, requestId: input.requestId })
        } catch (releaseError) {
          safeLog(logger, 'ai_quota_release_failed', { kind, requestId: input.requestId, traceId: requestId, code: releaseError?.code || 'unknown' })
        }
      }
      safeLog(logger, 'ai_request_failed', { kind, requestId: input.requestId, traceId: requestId, code })
      return fail(code, cors)
    }
    if (!durableQuotaStore?.consume && store?.incrementUsage) await store.incrementUsage(quotaKey)
    else if (!durableQuotaStore?.consume) usage.set(quotaKey, consumed + 1)
    const value = { ...result, cached: false }
    const cacheEntry = { value, expiresAt: nowValue + cacheTtlMs }
    if (store?.setCache) await store.setCache(key, cacheEntry)
    else cache.set(key, cacheEntry)
    if (store?.setIdempotency) await store.setIdempotency(idempotencyKey, { value, expiresAt: nowValue + cacheTtlMs })
    else idempotency.set(idempotencyKey, { value, expiresAt: nowValue + cacheTtlMs })
    safeLog(logger, 'ai_request_succeeded', { kind, requestId: input.requestId, traceId: requestId, provider: result.provider, cached: false })
    return json(value, 200, cors)
  }
}

export const gateway = createAiGateway()
export default { fetch: (request, env) => (env ? createAiGateway({ env })(request) : gateway(request)) }
