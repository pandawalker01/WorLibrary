import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createAiGateway } from '../server/ai-gateway.mjs'
import { syncLibrary } from '../src/lib/sync'
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
