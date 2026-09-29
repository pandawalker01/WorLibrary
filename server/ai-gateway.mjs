const DEFAULT_LIMIT = 5_000
const DEFAULT_DAILY_QUOTA = 20
const DEFAULT_RATE_LIMIT = 10
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

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
  return { code, message: detail && code === 'provider_error' ? message : message, retryable, status }
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

async function authenticateRequest(request, env, verifier) {
  const authorization = request.headers.get('authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (verifier && token) return verifier(token, request)
  if (env.AI_REQUIRE_AUTH === 'true' && !token) return null
  return { id: token ? `token:${token.slice(0, 16)}` : clientKey(request), anonymous: !token }
}

function safeLog(logger, event, fields = {}) {
  logger?.({ event, ...fields })
}

function makeProvider(env, fetchImpl) {
  const apiKey = env.AI_API_KEY
  const baseUrl = (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = env.AI_MODEL || 'gpt-4o-mini'
  return async ({ kind, text, sourceLanguage, targetLanguage, context, signal }) => {
    if (!apiKey) throw Object.assign(new Error('AI_API_KEY is not configured'), { code: 'provider_unavailable' })
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
  const requests = new Map()
  const dailyQuota = Number(env.AI_DAILY_QUOTA || DEFAULT_DAILY_QUOTA)
  const rateLimit = Number(env.AI_RATE_LIMIT || DEFAULT_RATE_LIMIT)
  const timeoutMs = Number(env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  const cacheTtlMs = Number(env.AI_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS)
  const callProvider = provider || makeProvider(env, fetchImpl)

  return async function handle(request) {
    const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-headers': 'content-type, x-anonymous-id', 'access-control-allow-methods': 'POST, OPTIONS' }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return fail('invalid_request', cors)
    const url = new URL(request.url)
    const kind = url.pathname.endsWith('/explain') ? 'explain' : url.pathname.endsWith('/translate') ? 'translate' : null
    if (!kind) return new Response('Not found', { status: 404, headers: cors })
    let body
    try { body = await request.json() } catch { return fail('invalid_request', cors) }
    const input = normaliseRequest(body, kind)
    if (input.error) return fail(input.error, cors)
    const identityResult = await authenticateRequest(request, env, authVerifier)
    if (!identityResult?.id) return fail('unauthorized', cors)
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
    const previous = store?.getIdempotency ? await store.getIdempotency(idempotencyKey) : null
    if (previous?.expiresAt > nowValue) return json(previous.value, 200, cors)
    const cached = store?.getCache ? await store.getCache(key) : cache.get(key)
    if (cached && cached.expiresAt > nowValue) return json({ ...cached.value, cached: true }, 200, cors)
    const consumed = store?.getUsage ? await store.getUsage(quotaKey) : usage.get(quotaKey) || 0
    if (consumed >= dailyQuota) return fail('quota_exceeded', cors)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let result
    try {
      let lastError
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { result = await callProvider({ ...input, signal: controller.signal }); break } catch (error) {
          lastError = error
          if (error?.name === 'AbortError' || error?.code === 'provider_timeout') throw Object.assign(new Error('provider timeout'), { code: 'provider_timeout' })
          if (attempt === 0) await Promise.resolve()
        }
      }
      if (!result) throw lastError || new Error('provider failed')
    } catch (error) {
      const code = error?.code || (error?.name === 'AbortError' ? 'provider_timeout' : 'provider_error')
      safeLog(logger, 'ai_request_failed', { kind, requestId: input.requestId, code })
      return fail(code, cors)
    } finally { clearTimeout(timeout) }
    if (store?.incrementUsage) await store.incrementUsage(quotaKey)
    else usage.set(quotaKey, consumed + 1)
    const value = { ...result, cached: false }
    const cacheEntry = { value, expiresAt: nowValue + cacheTtlMs }
    if (store?.setCache) await store.setCache(key, cacheEntry)
    else cache.set(key, cacheEntry)
    if (store?.setIdempotency) await store.setIdempotency(idempotencyKey, { value, expiresAt: nowValue + cacheTtlMs })
    safeLog(logger, 'ai_request_succeeded', { kind, requestId: input.requestId, provider: result.provider, cached: false })
    return json(value, 200, cors)
  }
}

export const gateway = createAiGateway()
export default { fetch: (request, env) => (env ? createAiGateway({ env })(request) : gateway(request)) }
