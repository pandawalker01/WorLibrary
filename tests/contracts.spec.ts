import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createAiGateway } from '../server/ai-gateway.mjs'
import { createOcrGateway } from '../server/ocr-gateway.mjs'
import { syncLibrary } from '../src/lib/sync'
import { createRemoteClient, RemoteRequestError } from '../src/lib/remote'
import type { StoredBook } from '../src/lib/storage'

test('login contract exposes anonymous and magic-link paths without provider secrets', async () => {
  const source = await readFile('src/lib/auth.ts', 'utf8')
  expect(source).toContain('signInAnonymously')
  expect(source).toContain('sendMagicLink')
  expect(source).toContain('saveSession')
  expect(source).not.toContain('VITE_AI_API_KEY')
})

test('sync merges remote rows and uploads only metadata', async () => {
  const localBook: StoredBook = { id: 'local', title: 'Local', author: 'Author', language: 'en', progress: 10, fileName: 'local.epub', fileType: 'application/epub+zip', fileSize: 12, storage: 'indexeddb', cover: 'ink', createdAt: Date.now() }
  const remoteBook = { id: 'remote', title: 'Remote', author: 'Author', language: 'zh', progress: 20, file_name: 'remote.epub', file_type: 'application/epub+zip', file_size: 4, cover: 'red', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  let written: { books: StoredBook[] } | undefined
  const result = await syncLibrary({
    select: async (table) => table === 'editions' ? [remoteBook] : [],
    upsert: async (_table, rows) => rows as never,
    remove: async () => undefined,
  }, {
    read: async () => ({ books: [localBook], highlights: [] }),
    write: async (snapshot) => { written = snapshot },
  })
  expect(result.downloaded).toBe(1)
  expect(written?.books.map((book) => book.id)).toEqual(['local', 'remote'])
})

test('sync uploads the merged winner instead of overwriting newer remote data', async () => {
  const localBook: StoredBook = { id: 'same', title: 'Local', author: 'Author', language: 'en', progress: 10, fileName: 'local.epub', fileType: 'application/epub+zip', fileSize: 12, storage: 'indexeddb', cover: 'ink', createdAt: Date.now() - 10_000 }
  const remoteBook = { id: 'same', title: 'Remote', author: 'Author', language: 'zh', progress: 80, file_name: 'remote.epub', file_type: 'application/epub+zip', file_size: 4, cover: 'red', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  let uploadedBooks: unknown[] = []
  await syncLibrary({ select: async () => [remoteBook], upsert: async (table, rows) => { if (table === 'editions') uploadedBooks = Array.isArray(rows) ? rows : [rows]; return rows as never }, remove: async () => undefined }, { read: async () => ({ books: [localBook], highlights: [] }), write: async () => undefined })
  expect((uploadedBooks[0] as { title: string }).title).toBe('Remote')
})

test('remote client retries transient failures but does not retry auth errors', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; if (calls === 1) return new Response('busy', { status: 503 }); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) }) as typeof fetch
  const session = { accessToken: 'token', refreshToken: 'refresh', user: { id: 'user', isAnonymous: true } }
  const client = createRemoteClient(session, { url: 'https://sync.example.com', anonKey: 'test-key' })
  await expect(client.select('editions')).resolves.toEqual([])
  expect(calls).toBe(2)
  calls = 0
  globalThis.fetch = (async () => { calls += 1; return new Response('unauthorized', { status: 401 }) }) as typeof fetch
  await expect(client.select('editions')).rejects.toBeInstanceOf(RemoteRequestError)
  expect(calls).toBe(1)
  globalThis.fetch = originalFetch
})

test('translation gateway returns success, cache hits, provider failures and CORS', async () => {
  let providerCalls = 0
  const gateway = createAiGateway({ env: { ALLOWED_ORIGIN: 'https://staging.example.com' }, provider: async () => { providerCalls += 1; return { translation: '你好', provider: 'test', model: 'test-1' } } })
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-anonymous-id': 'smoke' }, body: JSON.stringify({ text: 'Hello', targetLanguage: 'zh-CN', requestId: 'same-request' }) }
  const first = await gateway(new Request('https://staging.example.com/api/translate', init))
  const second = await gateway(new Request('https://staging.example.com/api/translate', init))
  expect(first.status).toBe(200)
  expect((await second.json()).cached).toBe(true)
  expect(providerCalls).toBe(1)
  expect(first.headers.get('access-control-allow-origin')).toBe('https://staging.example.com')
  const options = await gateway(new Request('https://staging.example.com/api/translate', { method: 'OPTIONS' }))
  expect(options.status).toBe(204)

  const failing = createAiGateway({ provider: async () => { throw Object.assign(new Error('timeout'), { code: 'provider_timeout' }) } })
  const failure = await failing(new Request('https://app.example.com/api/translate', init))
  expect(failure.status).toBe(504)
  expect((await failure.json()).error.code).toBe('provider_timeout')
})

test('translation provider contract keeps keys server-side and blocks the development mock in production', async () => {
  const clientSource = await readFile('src/lib/translation.ts', 'utf8')
  const gatewaySource = await readFile('server/ai-gateway.mjs', 'utf8')
  expect(clientSource).not.toContain('AI_API_KEY')
  expect(clientSource).not.toContain('VITE_AI_API_KEY')
  expect(gatewaySource).toContain("providerName === 'mock'")

  const productionMock = createAiGateway({ env: { AI_PROVIDER: 'mock', AI_ENV: 'production' }, logger: () => {} })
  const response = await productionMock(new Request('https://app.example.com/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anonymous-id': 'contract' },
    body: JSON.stringify({ text: 'Hello', requestId: 'production-mock' }),
  }))
  expect(response.status).toBe(503)
  expect((await response.json()).error.code).toBe('provider_unavailable')
})

test('OCR contract uses a server-side provider, development mock, and stable timeout errors', async () => {
  const clientSource = await readFile('src/lib/ocr.ts', 'utf8')
  const gatewaySource = await readFile('server/ocr-gateway.mjs', 'utf8')
  expect(clientSource).not.toContain('OCR_API_KEY')
  expect(clientSource).not.toContain('VITE_OCR_API_KEY')
  expect(gatewaySource).toContain("providerName === 'mock'")
  const image = 'data:image/png;base64,aGVsbG8='
  const development = createOcrGateway({ env: { OCR_PROVIDER: 'mock', OCR_ENV: 'development' }, logger: () => {} })
  const success = await development(new Request('https://app.example.com/api/ocr/page', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, requestId: 'ocr-dev' }) }))
  expect(success.status).toBe(200)
  expect((await success.json()).provider).toBe('mock')
  const production = createOcrGateway({ env: { OCR_PROVIDER: 'mock', OCR_ENV: 'production' }, logger: () => {} })
  const blocked = await production(new Request('https://app.example.com/api/ocr/page', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, requestId: 'ocr-prod' }) }))
  expect(blocked.status).toBe(503)
  expect((await blocked.json()).error.code).toBe('provider_unavailable')
  const timeout = createOcrGateway({ provider: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), env: { OCR_TIMEOUT_MS: '1' }, logger: () => {} })
  const timedOut = await timeout(new Request('https://app.example.com/api/ocr/page', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, requestId: 'ocr-timeout' }) }))
  expect(timedOut.status).toBe(504)
  expect((await timedOut.json()).error.code).toBe('provider_timeout')
})

test('edition fallback and migration are covered by release checks', async () => {
  const editionSource = await readFile('src/lib/edition.ts', 'utf8')
  const migration = await readFile('supabase/migrations/0001_initial_sync.sql', 'utf8')
  expect(editionSource).toContain('independent')
  expect(editionSource).toContain('confidence')
  expect(migration).toContain('enable row level security')
  expect(migration).toContain('create policy')
})

test('preview serves the required security response headers', async ({ request }) => {
  const response = await request.get('/')
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['x-frame-options']).toBe('DENY')
  expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
})
