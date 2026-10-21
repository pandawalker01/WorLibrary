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

test('Cloudflare catalog exposes only reviewed platform directory records with a matching policy', async () => {
  const assets = createAssets()
  const policy = JSON.stringify([
    { editionId: 'reviewed-open-edition', accessMode: 'stream', requiresAuthorization: false, rightsNotice: 'Open licence verified by WorLibrary.' },
  ])
  const directory = JSON.stringify([
    {
      editionId: 'reviewed-open-edition',
      title: 'Reviewed Open Edition',
      author: 'A verified rights holder',
      languages: ['eng', 'fra'],
      subjects: ['world literature'],
      sourceUrl: 'https://provenance.example.test/reviewed-open-edition',
    },
    {
      editionId: 'unreviewed-edition',
      title: 'Unreviewed Free Label',
      languages: ['eng'],
      sourceUrl: 'https://unreviewed.example.test/item',
    },
  ])

  await withFetchStub(async () => { throw new Error('upstreams unavailable') }, async () => {
    const response = await worker.fetch(new Request('https://app.example.test/api/catalog?q=world&language=eng&multiLanguageOnly=true'), {
      ASSETS: assets,
      PLATFORM_CONTENT_ACCESS_JSON: policy,
      PLATFORM_CATALOG_JSON: directory,
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.books, [{
      id: 'platform:reviewed-open-edition',
      sourceId: 'platform',
      sourceRecordId: 'reviewed-open-edition',
      platformEditionId: 'reviewed-open-edition',
      title: 'Reviewed Open Edition',
      author: 'A verified rights holder',
      languages: ['eng', 'fra'],
      sourceUrl: 'https://provenance.example.test/reviewed-open-edition',
      sourceName: 'WorLibrary',
      access: {
        mode: 'licensed_full_text',
        url: 'https://provenance.example.test/reviewed-open-edition',
        rightsNotice: 'Open licence verified by WorLibrary.',
      },
    }])
    assert.doesNotMatch(JSON.stringify(payload), /r2ObjectKey|objectKey|signed/i)
  })
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

test('Cloudflare reader access returns only a policy decision after an entitlement check', async () => {
  const assets = createAssets()
  const policy = JSON.stringify([
    { editionId: 'public-download', accessMode: 'download', requiresAuthorization: false, rightsNotice: 'Public domain edition.' },
    { editionId: 'licensed-stream', accessMode: 'stream', rightsNotice: 'Licensed for account streaming only.' },
    { editionId: 'source-reader', accessMode: 'external_reader', requiresAuthorization: false, externalReaderUrl: 'https://reader.example.test/book/source-reader' },
  ])

  const unconfigured = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=licensed-stream'), { ASSETS: assets })
  assert.equal(unconfigured.status, 503)
  assert.equal((await unconfigured.json()).error.code, 'PLATFORM_ACCESS_UNCONFIGURED')

  const noSession = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=licensed-stream'), { ASSETS: assets, PLATFORM_CONTENT_ACCESS_JSON: policy, READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access' })
  assert.equal(noSession.status, 401)
  assert.equal((await noSession.json()).error.code, 'AUTH_REQUIRED')

  const calls = []
  await withFetchStub(async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json({ allowed: true, userId: 'must-not-be-returned' })
  }, async () => {
    const allowed = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=licensed-stream', {
      headers: { authorization: 'Bearer reader-session-token', 'x-request-id': 'reader-access-contract' },
    }), { ASSETS: assets, PLATFORM_CONTENT_ACCESS_JSON: policy, READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access' })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('cache-control'), 'no-store')
    assert.equal(allowed.headers.get('x-request-id'), 'reader-access-contract')
    const payload = await allowed.json()
    assert.deepEqual(payload, {
      editionId: 'licensed-stream',
      access_mode: 'stream',
      rights_notice: 'Licensed for account streaming only.',
      delivery: { available: false, reason: 'content_delivery_unavailable' },
    })
    assert.doesNotMatch(JSON.stringify(payload), /reader-session-token|userId/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://auth.example.test/reader-access')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer reader-session-token')
    assert.deepEqual(JSON.parse(calls[0].init.body), { editionId: 'licensed-stream', accessMode: 'stream' })
  })

  const download = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=public-download'), { ASSETS: assets, PLATFORM_CONTENT_ACCESS_JSON: policy })
  assert.equal(download.status, 200)
  assert.equal((await download.json()).access_mode, 'download')
  const external = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=source-reader'), { ASSETS: assets, PLATFORM_CONTENT_ACCESS_JSON: policy })
  assert.equal(external.status, 200)
  assert.equal((await external.json()).external_reader_url, 'https://reader.example.test/book/source-reader')
})

test('Cloudflare reader access fails closed for unknown editions, invalid policies, and denied entitlements', async () => {
  const assets = createAssets()
  const invalidPolicy = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=bad'), {
    ASSETS: assets,
    PLATFORM_CONTENT_ACCESS_JSON: JSON.stringify([{ editionId: 'bad', accessMode: 'unrestricted' }]),
  })
  assert.equal(invalidPolicy.status, 503)
  assert.equal((await invalidPolicy.json()).error.code, 'ACCESS_POLICY_INVALID')

  const unknownEdition = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=absent'), {
    ASSETS: assets,
    PLATFORM_CONTENT_ACCESS_JSON: JSON.stringify([{ editionId: 'present', accessMode: 'preview', requiresAuthorization: false }]),
  })
  assert.equal(unknownEdition.status, 404)
  assert.equal((await unknownEdition.json()).error.code, 'EDITION_NOT_FOUND')

  await withFetchStub(async () => new Response(null, { status: 403 }), async () => {
    const denied = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=restricted', {
      headers: { authorization: 'Bearer reader-session-token' },
    }), {
      ASSETS: assets,
      PLATFORM_CONTENT_ACCESS_JSON: JSON.stringify([{ editionId: 'restricted', accessMode: 'stream' }]),
      READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access',
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'ACCESS_DENIED')
  })
})

test('Cloudflare reader content rechecks entitlement and serves private R2 bytes without exposing object metadata', async () => {
  const assets = createAssets()
  const bytes = new TextEncoder().encode('private epub fixture bytes')
  const calls = []
  const content = {
    async head(key) {
      calls.push({ method: 'head', key })
      return key === 'licensed/edition.epub' ? { size: bytes.byteLength } : null
    },
    async get(key, options) {
      calls.push({ method: 'get', key, options })
      if (key !== 'licensed/edition.epub') return null
      const range = options?.range
      const selected = range ? bytes.slice(range.offset, range.offset + range.length) : bytes
      return { body: new Response(selected).body }
    },
  }
  const policy = JSON.stringify([{
    editionId: 'licensed-stream',
    accessMode: 'stream',
    r2ObjectKey: 'licensed/edition.epub',
    contentType: 'application/epub+zip',
  }])

  const missingSession = await worker.fetch(new Request('https://app.example.test/api/reader/content?editionId=licensed-stream'), {
    ASSETS: assets,
    PLATFORM_CONTENT_ACCESS_JSON: policy,
    PLATFORM_CONTENT: content,
    READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access',
  })
  assert.equal(missingSession.status, 401)
  assert.equal((await missingSession.json()).error.code, 'AUTH_REQUIRED')
  assert.equal(calls.length, 0)

  let authorizationCalls = 0
  await withFetchStub(async () => {
    authorizationCalls += 1
    return Response.json({ allowed: true, userId: 'never return this' })
  }, async () => {
    const access = await worker.fetch(new Request('https://app.example.test/api/reader/access?editionId=licensed-stream', {
      headers: { authorization: 'Bearer reader-session-token' },
    }), {
      ASSETS: assets,
      PLATFORM_CONTENT_ACCESS_JSON: policy,
      PLATFORM_CONTENT: content,
      READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access',
    })
    assert.equal(access.status, 200)
    assert.deepEqual((await access.json()).delivery, { available: true, mode: 'in_app_stream', content_type: 'application/epub+zip' })

    const response = await worker.fetch(new Request('https://app.example.test/api/reader/content?editionId=licensed-stream', {
      headers: { authorization: 'Bearer reader-session-token', range: 'bytes=8-11', 'x-request-id': 'content-contract' },
    }), {
      ASSETS: assets,
      PLATFORM_CONTENT_ACCESS_JSON: policy,
      PLATFORM_CONTENT: content,
      READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access',
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'application/epub+zip')
    assert.equal(response.headers.get('content-range'), `bytes 8-11/${bytes.byteLength}`)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-request-id'), 'content-contract')
    assert.equal(await response.text(), 'epub')
    assert.equal(authorizationCalls, 2)
    assert.deepEqual(calls, [
      { method: 'head', key: 'licensed/edition.epub' },
      { method: 'get', key: 'licensed/edition.epub', options: { range: { offset: 8, length: 4 } } },
    ])
  })

  await withFetchStub(async () => Response.json({ allowed: true }), async () => {
    const invalidRange = await worker.fetch(new Request('https://app.example.test/api/reader/content?editionId=licensed-stream', {
      headers: { authorization: 'Bearer reader-session-token', range: 'bytes=999-' },
    }), {
      ASSETS: assets,
      PLATFORM_CONTENT_ACCESS_JSON: policy,
      PLATFORM_CONTENT: content,
      READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access',
    })
    assert.equal(invalidRange.status, 416)
    assert.equal(invalidRange.headers.get('content-range'), `bytes */${bytes.byteLength}`)
    assert.equal((await invalidRange.json()).error.code, 'RANGE_NOT_SATISFIABLE')

    const unavailable = await worker.fetch(new Request('https://app.example.test/api/reader/content?editionId=licensed-stream', {
      headers: { authorization: 'Bearer reader-session-token' },
    }), {
      ASSETS: assets,
      PLATFORM_CONTENT_ACCESS_JSON: policy,
      READER_AUTHORIZATION_URL: 'https://auth.example.test/reader-access',
    })
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json()).error.code, 'CONTENT_DELIVERY_UNAVAILABLE')
  })
})
