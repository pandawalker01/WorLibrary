import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiGateway } from './ai-gateway.mjs'

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
