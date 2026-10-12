import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiGateway } from './ai-gateway.mjs'

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

async function signedToken(claims, secret = 'quality-test-secret') {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify(claims))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`
}

function productionRequest(body, token) {
  return new Request('https://app.example.test/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

const now = 1_750_000_000_000
const env = {
  AI_ENV: 'production',
  AI_API_KEY: 'provider-secret-must-not-leak',
  SUPABASE_JWT_SECRET: 'quality-test-secret',
  SUPABASE_JWT_ISSUER: 'https://project.supabase.co/auth/v1',
  SUPABASE_JWT_AUDIENCE: 'authenticated',
}

async function validToken() {
  return signedToken({
    sub: 'quality-user',
    exp: now / 1000 + 60,
    iss: env.SUPABASE_JWT_ISSUER,
    aud: env.SUPABASE_JWT_AUDIENCE,
  })
}

test('production refuses a verified request when no durable quota adapter is available', async () => {
  let providerCalls = 0
  const gateway = createAiGateway({
    env,
    now: () => now,
    provider: async () => { providerCalls += 1; return { translation: 'should not run', provider: 'test' } },
    logger: () => {},
  })
  const response = await gateway(productionRequest({ text: 'private selected sentence', requestId: 'missing-ledger' }, await validToken()))
  const payload = await response.json()

  assert.equal(response.status, 503)
  assert.equal(payload.error.code, 'provider_unavailable')
  assert.equal(providerCalls, 0)
  assert.equal(JSON.stringify(payload).includes('private selected sentence'), false)
  assert.equal(JSON.stringify(payload).includes(env.AI_API_KEY), false)
})

test('durable quota adapter preserves idempotency, rejects exhaustion, and never receives source text', async () => {
  const calls = []
  const logs = []
  let providerCalls = 0
  const store = {
    async consume(input) {
      calls.push(input)
      if (input.requestId === 'quota-exhausted') return { allowed: false, charged: false, used: 1 }
      return { allowed: true, charged: true, used: 1 }
    },
    async release() { throw new Error('release must not run after a successful provider response') },
  }
  const gateway = createAiGateway({
    env: { ...env, AI_DAILY_QUOTA: '1' },
    now: () => now,
    store,
    provider: async () => { providerCalls += 1; return { translation: '安全译文', provider: 'test' } },
    logger: (event) => logs.push(event),
  })
  const token = await validToken()
  const first = await gateway(productionRequest({ text: 'never write this sentence to the ledger', requestId: 'same-request' }, token))
  const retry = await gateway(productionRequest({ text: 'never write this sentence to the ledger', requestId: 'same-request' }, token))
  const exhausted = await gateway(productionRequest({ text: 'another private sentence', requestId: 'quota-exhausted' }, token))

  assert.equal(first.status, 200)
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).cached, true)
  assert.equal(providerCalls, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['accessToken', 'dailyLimit', 'kind', 'requestId'])
  assert.equal(calls[0].kind, 'translate')
  assert.equal(calls[0].requestId, 'same-request')
  assert.equal(calls.some((call) => JSON.stringify(call).includes('never write this sentence to the ledger')), false)

  assert.equal(exhausted.status, 429)
  const payload = await exhausted.json()
  assert.equal(payload.error.code, 'quota_exceeded')
  assert.equal(providerCalls, 1)
  const observable = JSON.stringify({ payload, logs })
  assert.equal(observable.includes('another private sentence'), false)
  assert.equal(observable.includes(env.AI_API_KEY), false)
  assert.equal(observable.includes(token), false)
})
