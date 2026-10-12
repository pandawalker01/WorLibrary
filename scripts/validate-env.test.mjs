import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const node = process.execPath
const script = new URL('./validate-env.mjs', import.meta.url)

function validate(env) {
  const result = spawnSync(node, [script.pathname, '--production', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, payload: JSON.parse(result.stdout) }
}

const configured = {
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key-for-test',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-for-server-test',
  AI_PROVIDER: 'openai',
  AI_API_KEY: 'server-key-for-test',
  AI_BASE_URL: 'https://provider.example.test/v1',
  AI_MODEL: 'test-model',
  AI_ENV: 'production',
  AI_REQUIRE_AUTH: 'true',
  OCR_PROVIDER: 'example-ocr',
  OCR_API_KEY: 'ocr-key-for-test',
  OCR_BASE_URL: 'https://ocr.example.test/v1',
  OCR_ENV: 'production',
  ALLOWED_ORIGIN: 'https://app.example.test',
}

test('production environment contract accepts complete server-only configuration', () => {
  const result = validate(configured)
  assert.equal(result.status, 0)
  assert.equal(result.payload.status, 'passed')
})

test('production environment contract rejects mock providers, loose CORS and exposed secrets', () => {
  const result = validate({
    ...configured,
    AI_PROVIDER: 'mock',
    OCR_PROVIDER: 'mock',
    ALLOWED_ORIGIN: '*',
    VITE_AI_API_KEY: 'must-not-be-public',
  })
  assert.equal(result.status, 1)
  assert.equal(result.payload.status, 'blocked')
  assert.match(result.payload.invalid.join('\n'), /AI_PROVIDER must not be mock/)
  assert.match(result.payload.invalid.join('\n'), /ALLOWED_ORIGIN/)
  assert.match(result.payload.invalid.join('\n'), /VITE_AI_API_KEY/)
})

test('production environment contract requires the durable Supabase quota adapter', () => {
  const result = validate({ ...configured, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' })
  assert.equal(result.status, 1)
  assert.match(result.payload.missing.join('\n'), /SUPABASE_URL/)
  assert.match(result.payload.missing.join('\n'), /SUPABASE_ANON_KEY/)
})
