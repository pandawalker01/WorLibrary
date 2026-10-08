const DEFAULT_TIMEOUT_MS = 20_000
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

const errors = {
  invalid_request: ['图片无效，请重新选择当前页后再试。', false, 400],
  request_too_large: ['图片过大，请缩小页面后重试。', false, 413],
  provider_unavailable: ['文字识别服务尚未配置，请稍后再试。', true, 503],
  provider_timeout: ['文字识别超时，请稍后重试。', true, 504],
  provider_error: ['文字识别服务暂时出错，请稍后重试。', true, 502],
}

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

function fail(code, headers) {
  const [message, retryable, status] = errors[code] ?? errors.provider_error
  return response({ error: { code, message, retryable } }, status, headers)
}

function numberOption(value, fallback, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

function normaliseInput(body) {
  if (!body || typeof body !== 'object' || typeof body.image !== 'string') return { error: 'invalid_request' }
  const image = body.image.trim()
  const match = image.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i)
  if (!match) return { error: 'invalid_request' }
  const bytes = Math.floor(match[2].length * 0.75)
  if (bytes > MAX_IMAGE_BYTES) return { error: 'request_too_large' }
  return {
    image,
    mimeType: match[1].toLowerCase(),
    language: typeof body.language === 'string' && body.language.trim() ? body.language.trim().slice(0, 32) : 'auto',
    requestId: typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim().slice(0, 128) : crypto.randomUUID(),
  }
}

function makeProvider(env, fetchImpl) {
  const environment = env.OCR_ENV || env.NODE_ENV || 'development'
  const providerName = env.OCR_PROVIDER || 'mock'
  if (providerName === 'mock') {
    if (environment === 'production') return async () => { throw Object.assign(new Error('mock provider is disabled in production'), { code: 'provider_unavailable' }) }
    return async ({ language }) => ({ text: `开发环境 OCR 模拟文本（语言：${language}）。`, provider: 'mock', confidence: 0.99 })
  }
  const apiKey = typeof env.OCR_API_KEY === 'string' ? env.OCR_API_KEY.trim() : ''
  const baseUrl = typeof env.OCR_BASE_URL === 'string' ? env.OCR_BASE_URL.replace(/\/$/, '') : ''
  return async ({ image, mimeType, language, signal }) => {
    if (!apiKey || !/^https?:\/\//i.test(baseUrl)) throw Object.assign(new Error('OCR provider is not configured'), { code: 'provider_unavailable' })
    const upstream = await fetchImpl(`${baseUrl}/ocr`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ image, mimeType, language }),
    })
    if (!upstream.ok) throw Object.assign(new Error(`provider status ${upstream.status}`), { code: upstream.status === 401 || upstream.status === 403 ? 'provider_unavailable' : 'provider_error' })
    const payload = await upstream.json()
    if (typeof payload?.text !== 'string' || !payload.text.trim()) throw Object.assign(new Error('invalid OCR response'), { code: 'provider_error' })
    return { text: payload.text.trim(), provider: providerName, confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined }
  }
}

export function createOcrGateway({ env = {}, fetchImpl = fetch, logger = console.warn, provider } = {}) {
  const timeoutMs = numberOption(env.OCR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 120_000)
  const callProvider = provider || makeProvider(env, fetchImpl)
  return async function handle(request) {
    const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'POST, OPTIONS' }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/ocr/page')) return new Response('Not found', { status: 404, headers: cors })
    let input
    try { input = normaliseInput(await request.json()) } catch { return fail('invalid_request', cors) }
    if (input.error) return fail(input.error, cors)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const result = await callProvider({ ...input, signal: controller.signal })
      logger?.({ event: 'ocr_succeeded', requestId: input.requestId, provider: result.provider })
      return response({ ...result, requestId: input.requestId }, 200, cors)
    } catch (error) {
      const code = error?.name === 'AbortError' || error?.code === 'provider_timeout' ? 'provider_timeout' : error?.code === 'provider_unavailable' ? 'provider_unavailable' : 'provider_error'
      logger?.({ event: 'ocr_failed', requestId: input.requestId, code })
      return fail(code, cors)
    } finally { clearTimeout(timer) }
  }
}

export default { fetch: (request, env) => createOcrGateway({ env })(request) }
