import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const node = process.execPath
const script = new URL('./validate-env.mjs', import.meta.url)

function validate(env, args = ['--production', '--json']) {
  const result = spawnSync(node, [script.pathname, ...args], {
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
  SUPABASE_JWT_SECRET: 'jwt-signing-secret-for-test',
  OCR_PROVIDER: 'example-ocr',
  OCR_API_KEY: 'ocr-key-for-test',
  OCR_BASE_URL: 'https://ocr.example.test/v1',
  OCR_ENV: 'production',
  OCR_REQUIRE_AUTH: 'true',
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

test('staging contract can deliberately run the local-first reader without cloud credentials', () => {
  const result = validate({}, ['--staging', '--json'])
  assert.equal(result.status, 0)
  assert.equal(result.payload.status, 'passed')
  assert.equal(result.payload.profile, 'staging')
  assert.deepEqual(result.payload.capabilities, {
    supabase: 'disabled',
    ai: 'disabled',
    ocr: 'disabled',
    vercel: 'not_checked',
  })
  assert.match(result.payload.warnings.join('\n'), /authentication and cloud sync stay disabled/)
})

test('staging contract rejects a half-configured AI gateway and exposes each missing safety dependency', () => {
  const result = validate({
    AI_PROVIDER: 'openai',
    AI_MODEL: 'test-model',
    AI_API_KEY: 'server-key-for-test',
    AI_BASE_URL: 'https://provider.example.test/v1',
  }, ['--staging', '--json'])
  assert.equal(result.status, 1)
  assert.equal(result.payload.capabilities.ai, 'enabled')
  assert.match(result.payload.missing.join('\n'), /AI_ENV/)
  assert.match(result.payload.missing.join('\n'), /SUPABASE_JWT_SECRET/)
  assert.match(result.payload.missing.join('\n'), /ALLOWED_ORIGIN/)
})

test('deployment mode reports missing Vercel credentials separately from application capability warnings', () => {
  const result = validate({}, ['--staging', '--deployment', '--json'])
  assert.equal(result.status, 1)
  assert.deepEqual(result.payload.missing, ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'])
  assert.equal(result.payload.capabilities.vercel, 'enabled')
  assert.match(result.payload.warnings.join('\n'), /AI gateway is not configured/)
})

test('staging gateway configuration requires an HTTPS browser origin', () => {
  const result = validate({ ...configured, ALLOWED_ORIGIN: 'http://staging.example.test' }, ['--staging', '--json'])
  assert.equal(result.status, 1)
  assert.match(result.payload.invalid.join('\n'), /ALLOWED_ORIGIN must use https in staging/)
})
