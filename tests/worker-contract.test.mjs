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
