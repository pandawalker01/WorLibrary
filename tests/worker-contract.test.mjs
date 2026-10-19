import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../worker/index.mjs'

function createCache() {
  const entries = new Map()
  return {
    async match(request) {
      const cached = entries.get(request.url)
      return cached?.clone()
    },
    async put(request, response) {
      entries.set(request.url, response.clone())
    },
  }
}

function createAssets() {
  const requests = []
  return {
    requests,
    async fetch(request) {
      requests.push(new URL(request.url).pathname)
      if (new URL(request.url).pathname === '/index.html') {
        return new Response('<main id="app">WorLibrary</main>', { headers: { 'content-type': 'text/html' } })
      }
      return new Response('not found', { status: 404 })
    },
  }
}

async function withFetchStub(stub, run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('Cloudflare catalog endpoint normalizes compliant source data, caches it, and preserves request IDs', async () => {
  const originalCaches = globalThis.caches
  const cache = createCache()
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: cache } })
  let upstreamCalls = 0
  const assets = createAssets()

  try {
    await withFetchStub(async (url) => {
      upstreamCalls += 1
      if (String(url).startsWith('https://openlibrary.org/')) {
        return Response.json({ docs: [{ key: '/works/OLworker', title: 'Worker fixture', author_name: ['Catalog author'], language: ['eng', 'fra'], edition_count: 2 }] })
      }
      if (String(url).startsWith('https://www.googleapis.com/books/')) {
        return Response.json({ items: [{ id: 'google-worker', volumeInfo: { title: 'Google worker fixture', language: 'en', infoLink: 'https://books.google.com/books?id=google-worker' }, accessInfo: { viewability: 'PARTIAL' } }] })
      }
      throw new Error(`Unexpected upstream request: ${url}`)
    }, async () => {
      const first = await worker.fetch(new Request('https://app.example.test/api/catalog?q=worker%20fixture&language=eng&multiLanguageOnly=true', { headers: { 'x-request-id': 'worker-first' } }), { ASSETS: assets })
      assert.equal(first.status, 200)
      assert.equal(first.headers.get('cache-control'), 'public, max-age=60, s-maxage=300, stale-while-revalidate=60')
      assert.equal(first.headers.get('x-request-id'), 'worker-first')
      const firstPayload = await first.json()
      assert.deepEqual(firstPayload.books.map((book) => book.sourceId), ['open-library'])
      assert.equal(firstPayload.books[0].access.mode, 'catalog_only')

      const cached = await worker.fetch(new Request('https://app.example.test/api/catalog?q=worker%20fixture&language=eng&multiLanguageOnly=true', { headers: { 'x-request-id': 'worker-second' } }), { ASSETS: assets })
      assert.equal(cached.status, 200)
      assert.equal(cached.headers.get('x-request-id'), 'worker-second')
      assert.equal(upstreamCalls, 2)
      assert.deepEqual((await cached.json()).books, firstPayload.books)
    })
  } finally {
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
  }
})

test('Cloudflare worker rejects invalid catalog requests without contacting upstreams and falls back to the SPA shell', async () => {
  const assets = createAssets()
  await withFetchStub(async () => { throw new Error('upstream should not be contacted') }, async () => {
    const invalid = await worker.fetch(new Request('https://app.example.test/api/catalog?q='), { ASSETS: assets })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), { error: 'INVALID_QUERY' })

    const page = await worker.fetch(new Request('https://app.example.test/settings', { headers: { accept: 'text/html' } }), { ASSETS: assets })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    assert.deepEqual(assets.requests, ['/settings', '/index.html'])
  })
})

test('Cloudflare translation routes call a configured provider without exposing secrets or caching reader text', async () => {
  const assets = createAssets()
  const calls = []
  await withFetchStub(async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json({ choices: [{ message: { content: '你好，世界' } }] })
  }, async () => {
    const response = await worker.fetch(new Request('https://app.example.test/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.18', 'x-request-id': 'translation-contract' },
      body: JSON.stringify({ text: 'Hello, world', sourceLanguage: 'English', targetLanguage: '中文', context: 'Greeting' }),
    }), {
      ASSETS: assets,
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'secret-worker-key',
      AI_MODEL: 'gpt-4o-mini',
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-request-id'), 'translation-contract')
    const responseBody = await response.text()
    assert.deepEqual(JSON.parse(responseBody), { translation: '你好，世界', provider: 'openai', model: 'gpt-4o-mini', cached: false })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-worker-key')
    assert.doesNotMatch(responseBody, /secret-worker-key/)
  })
})

test('Cloudflare translation protects the provider with input validation, configuration checks and a per-client rate guard', async () => {
  const assets = createAssets()
  const unconfiguredHealth = await worker.fetch(new Request('https://app.example.test/api/health'), { ASSETS: assets })
  assert.deepEqual((await unconfiguredHealth.json()).translation, { configured: false })
  const configuredHealth = await worker.fetch(new Request('https://app.example.test/api/health'), { ASSETS: assets, AI_API_KEY: 'key', AI_MODEL: 'model' })
  assert.deepEqual((await configuredHealth.json()).translation, { configured: true })
  const status = await worker.fetch(new Request('https://app.example.test/api/translation-status', { headers: { 'x-request-id': 'translation-status-contract' } }), { ASSETS: assets, AI_API_KEY: 'key', AI_MODEL: 'model' })
  assert.equal(status.status, 200)
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.equal(status.headers.get('x-request-id'), 'translation-status-contract')
  assert.deepEqual(await status.json(), { status: 'ok', service: 'worlibrary-translation', configured: true, authRequired: false })
  const missingConfiguration = await worker.fetch(new Request('https://app.example.test/api/translate', {
    method: 'POST',
    body: JSON.stringify({ text: 'Hello' }),
  }), { ASSETS: assets })
  assert.equal(missingConfiguration.status, 503)
  assert.deepEqual(await missingConfiguration.json(), { error: { code: 'provider_unavailable', message: 'AI 服务暂时不可用，请稍后再试。', retryable: true } })

  let calls = 0
  await withFetchStub(async () => {
    calls += 1
    return Response.json({ choices: [{ message: { content: 'Bonjour' } }] })
  }, async () => {
    const env = { ASSETS: assets, AI_API_KEY: 'key', AI_MODEL: 'model', AI_RATE_LIMIT: '1' }
    const request = (text) => new Request('https://app.example.test/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.19' },
      body: JSON.stringify({ text, targetLanguage: 'Français' }),
    })
    const first = await worker.fetch(request('Hello'), env)
    assert.equal(first.status, 200)
    const limited = await worker.fetch(request('Hello again'), env)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal((await limited.json()).error.code, 'rate_limited')
    assert.equal(calls, 1)
  })
})
