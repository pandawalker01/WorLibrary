import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeGateway } from '../api/gateway.mjs'
import health from '../api/health.mjs'
import { createAiGateway } from './ai-gateway.mjs'
import { createOcrGateway } from './ocr-gateway.mjs'

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

async function signedToken(claims, secret = 'test-secret') {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify(claims))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`
}

function request(path, body, headers = {}) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anonymous-id': 'test-user', ...headers },
    body: JSON.stringify(body),
  })
}

test('translate succeeds and repeated content is served from cache', async () => {
  let calls = 0
  const gateway = createAiGateway({ provider: async () => { calls += 1; return { translation: '译文', provider: 'test', model: 'test-1' } }, logger: () => {} })
  const body = { text: 'hello', targetLanguage: 'zh-CN', requestId: 'success-1' }
  assert.equal((await gateway(request('/api/translate', body))).status, 200)
  const cached = await gateway(request('/api/translate', { ...body, requestId: 'success-2' }))
  assert.equal(cached.status, 200)
  assert.equal((await cached.json()).cached, true)
  assert.equal(calls, 1)
})

test('health probe is safe, cache-free, and carries a trace id', async () => {
  const gateway = createAiGateway({ env: { AI_PROVIDER: 'openai', AI_API_KEY: 'server-only', AI_MODEL: 'model', AI_BASE_URL: 'https://provider.test/v1' }, logger: () => {} })
  const response = await gateway(new Request('https://example.test/api/health', { headers: { 'x-request-id': 'probe-123' } }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-request-id'), 'probe-123')
  const payload = await response.json()
  assert.deepEqual(Object.keys(payload).sort(), ['provider', 'providerConfigured', 'service', 'status', 'timestamp'])
  assert.equal(payload.status, 'ok')
  assert.equal(payload.providerConfigured, true)
  assert.equal(JSON.stringify(payload).includes('server-only'), false)
})

test('AI responses and errors are never cacheable by a shared HTTP cache', async () => {
  const gateway = createAiGateway({
    provider: async () => ({ translation: '译文', provider: 'test', model: 'test-1' }),
    logger: () => {},
  })
  const successful = await gateway(request('/api/translate', { text: 'private selection', requestId: 'no-store-success' }))
  assert.equal(successful.headers.get('cache-control'), 'no-store')

  const failed = await gateway(new Request('https://example.test/api/translate', { method: 'POST' }))
  assert.equal(failed.status, 400)
  assert.equal(failed.headers.get('cache-control'), 'no-store')
  assert.equal(failed.headers.get('x-request-id')?.length > 0, true)
})

test('serverless API runtime passes deployment environment to the shared gateway', async () => {
  const runtimeGateway = createRuntimeGateway({
    AI_PROVIDER: 'openai',
    AI_API_KEY: 'deployment-only-secret',
    AI_MODEL: 'deployment-model',
    AI_BASE_URL: 'https://provider.example.test/v1',
  })
  const response = await runtimeGateway(new Request('https://app.example.test/api/health', {
    headers: { 'x-request-id': 'runtime-health-probe' },
  }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-request-id'), 'runtime-health-probe')
  const payload = await response.json()
  assert.equal(payload.providerConfigured, true)
  assert.equal(JSON.stringify(payload).includes('deployment-only-secret'), false)
})

test('Vercel health route preserves probe response guarantees', async () => {
  const response = await health(new Request('https://app.example.test/api/health', {
    headers: { 'x-request-id': 'api-route-probe' },
  }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-request-id'), 'api-route-probe')
  assert.equal((await response.json()).status, 'ok')
})

test('quota exhaustion returns a stable error code', async () => {
  const gateway = createAiGateway({ env: { AI_DAILY_QUOTA: '1' }, provider: async () => ({ translation: '译文', provider: 'test' }), logger: () => {} })
  assert.equal((await gateway(request('/api/translate', { text: 'one', requestId: 'quota-1' }))).status, 200)
  const response = await gateway(request('/api/translate', { text: 'two', requestId: 'quota-2' }))
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.code, 'quota_exceeded')
})

test('provider failures map to a user-safe error', async () => {
  const gateway = createAiGateway({ provider: async () => { throw Object.assign(new Error('upstream down'), { code: 'provider_error' }) }, logger: () => {} })
  const response = await gateway(request('/api/explain', { text: 'hello', requestId: 'failure-1' }))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'provider_error')
})

test('provider configuration stays server-side and upstream status maps cleanly', async () => {
  const missingKey = createAiGateway({ env: { AI_BASE_URL: 'https://provider.invalid/v1' }, logger: () => {} })
  const unavailable = await missingKey(request('/api/translate', { text: 'hello', requestId: 'missing-key' }))
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).error.code, 'provider_unavailable')
  let receivedUrl = ''
  const rateLimited = createAiGateway({ env: { AI_API_KEY: 'server-only', AI_BASE_URL: 'https://provider.test/v1' }, fetchImpl: async (url) => { receivedUrl = url; return new Response('{}', { status: 429 }) }, logger: () => {} })
  const response = await rateLimited(request('/api/translate', { text: 'hello', requestId: 'upstream-rate' }))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'provider_rate_limited')
  assert.equal(receivedUrl, 'https://provider.test/v1/chat/completions')
})

test('mock provider is development-only and never requires a browser key', async () => {
  const development = createAiGateway({ env: { AI_PROVIDER: 'mock', AI_ENV: 'development' }, logger: () => {} })
  const response = await development(request('/api/translate', { text: 'hello', targetLanguage: 'zh-CN', requestId: 'mock-1' }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.provider, 'mock')
  assert.equal(payload.translation, '[zh-CN] hello')

  const production = createAiGateway({ env: { AI_PROVIDER: 'mock', AI_ENV: 'production' }, logger: () => {} })
  const blocked = await production(request('/api/translate', { text: 'hello', requestId: 'mock-production' }))
  assert.equal(blocked.status, 401)
  assert.equal((await blocked.json()).error.code, 'unauthorized')
})

test('gateway retries only transient provider failures and validates bounded config', async () => {
  let calls = 0
  const gateway = createAiGateway({
    env: { AI_RETRY_ATTEMPTS: '2', AI_RETRY_DELAY_MS: '0', AI_TIMEOUT_MS: 'not-a-number' },
    provider: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'provider_error' })
      return { translation: 'recovered', provider: 'test' }
    },
    logger: () => {},
  })
  const response = await gateway(request('/api/translate', { text: 'retry', requestId: 'retry-1' }))
  assert.equal(response.status, 200)
  assert.equal(calls, 2)

  calls = 0
  const authFailure = createAiGateway({ provider: async () => { calls += 1; throw Object.assign(new Error('bad credentials'), { code: 'provider_unavailable' }) }, logger: () => {} })
  assert.equal((await authFailure(request('/api/translate', { text: 'no-retry', requestId: 'no-retry-1' }))).status, 503)
  assert.equal(calls, 1)
})

test('provider status and timeout errors use stable gateway codes', async () => {
  for (const [providerStatus, expectedStatus, expectedCode] of [[401, 503, 'provider_unavailable'], [403, 503, 'provider_unavailable'], [500, 502, 'provider_error']]) {
    const gateway = createAiGateway({ env: { AI_API_KEY: 'server-only' }, fetchImpl: async () => new Response('{}', { status: providerStatus }), logger: () => {} })
    const response = await gateway(request('/api/translate', { text: `status-${providerStatus}`, requestId: `status-${providerStatus}` }))
    assert.equal(response.status, expectedStatus)
    assert.equal((await response.json()).error.code, expectedCode)
  }
  const timeout = createAiGateway({ env: { AI_TIMEOUT_MS: '1' }, provider: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), logger: () => {} })
  const response = await timeout(request('/api/translate', { text: 'timeout', requestId: 'timeout-1' }))
  assert.equal(response.status, 504)
  assert.equal((await response.json()).error.code, 'provider_timeout')
})

test('auth, user rate limiting, and request idempotency are supported by adapters', async () => {
  const records = new Map()
  const store = {
    async getIdempotency(key) { return records.get(`id:${key}`) },
    async setIdempotency(key, value) { records.set(`id:${key}`, value) },
  }
  let calls = 0
  const gateway = createAiGateway({ env: { AI_REQUIRE_AUTH: 'true', AI_RATE_LIMIT: '2' }, store, authVerifier: async (token) => token === 'valid' ? { id: 'user-1' } : null, provider: async () => { calls += 1; return { translation: '译文', provider: 'test' } }, logger: () => {} })
  assert.equal((await gateway(request('/api/translate', { text: 'missing' }))).status, 401)
  const headers = { authorization: 'Bearer valid' }
  const first = await gateway(request('/api/translate', { text: 'hello', requestId: 'same' }, headers))
  assert.equal(first.status, 200)
  const second = await gateway(request('/api/translate', { text: 'hello', requestId: 'same' }, headers))
  assert.equal(second.status, 200)
  assert.equal(calls, 1)
  assert.equal((await gateway(request('/api/translate', { text: 'other', requestId: 'limited' }, headers))).status, 429)
})

test('production requires a verifiable Supabase JWT and rejects arbitrary Bearer text', async () => {
  const now = 1_750_000_000_000
  let calls = 0
  const env = { AI_ENV: 'production', SUPABASE_JWT_SECRET: 'test-secret', SUPABASE_JWT_ISSUER: 'https://project.supabase.co/auth/v1', SUPABASE_JWT_AUDIENCE: 'authenticated' }
  const quotaStore = { async consume() { return { allowed: true, charged: true, used: 1 } }, async release() { return true } }
  const gateway = createAiGateway({ env, now: () => now, store: quotaStore, provider: async () => { calls += 1; return { translation: 'ok', provider: 'test' } }, logger: () => {} })
  assert.equal((await gateway(request('/api/translate', { text: 'missing' }))).status, 401)
  assert.equal((await gateway(request('/api/translate', { text: 'fake' }, { authorization: 'Bearer arbitrary-text' }))).status, 401)
  const token = await signedToken({ sub: 'user-123', exp: now / 1000 + 60, iss: env.SUPABASE_JWT_ISSUER, aud: 'authenticated' })
  assert.equal((await gateway(request('/api/translate', { text: 'verified' }, { authorization: `Bearer ${token}` }))).status, 200)
  assert.equal(calls, 1)
})

test('durable quota adapter charges before provider and releases failed provider calls', async () => {
  const calls = []
  const store = {
    async consume(input) { calls.push(['consume', input]); return { allowed: true, charged: true, used: 1 } },
    async release(input) { calls.push(['release', input]); return true },
  }
  const gateway = createAiGateway({
    env: { AI_ENV: 'production' },
    store,
    authVerifier: async () => ({ id: 'user-1' }),
    provider: async () => { throw Object.assign(new Error('down'), { code: 'provider_error' }) },
    logger: () => {},
  })
  const response = await gateway(request('/api/translate', { text: 'private source text', requestId: 'release-1' }, { authorization: 'Bearer verified-token' }))
  assert.equal(response.status, 502)
  assert.deepEqual(calls.map(([name]) => name), ['consume', 'release'])
  assert.equal(calls[0][1].accessToken, 'verified-token')
  assert.equal(JSON.stringify(calls).includes('private source text'), false)
})

test('expired or wrong-audience Supabase JWT never reaches AI or OCR providers', async () => {
  const now = 1_750_000_000_000
  const env = { AI_ENV: 'production', OCR_ENV: 'production', SUPABASE_JWT_SECRET: 'test-secret', SUPABASE_JWT_ISSUER: 'https://project.supabase.co/auth/v1', SUPABASE_JWT_AUDIENCE: 'authenticated' }
  const expired = await signedToken({ sub: 'user-123', exp: now / 1000 - 1, iss: env.SUPABASE_JWT_ISSUER, aud: 'authenticated' })
  const wrongAudience = await signedToken({ sub: 'user-123', exp: now / 1000 + 60, iss: env.SUPABASE_JWT_ISSUER, aud: 'anon' })
  let aiCalls = 0
  const gateway = createAiGateway({ env, now: () => now, provider: async () => { aiCalls += 1; return { translation: 'nope' } }, logger: () => {} })
  assert.equal((await gateway(request('/api/translate', { text: 'expired' }, { authorization: `Bearer ${expired}` }))).status, 401)
  assert.equal((await gateway(request('/api/translate', { text: 'wrong audience' }, { authorization: `Bearer ${wrongAudience}` }))).status, 401)
  assert.equal(aiCalls, 0)
  let ocrCalls = 0
  const ocr = createOcrGateway({ env, now: () => now, provider: async () => { ocrCalls += 1; return { text: 'nope', provider: 'test' } }, logger: () => {} })
  const image = 'data:image/png;base64,aGVsbG8='
  const ocrRequest = new Request('https://example.test/api/ocr/page', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${expired}` }, body: JSON.stringify({ image }) })
  assert.equal((await ocr(ocrRequest)).status, 401)
  assert.equal(ocrCalls, 0)
})
