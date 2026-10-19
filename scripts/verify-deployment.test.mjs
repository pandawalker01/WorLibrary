import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { verifyDeployment } from './verify-deployment.mjs'

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}

function healthyFetch({ omitHeader, translationStatus, translationHeaders } = {}) {
  return async (url, init = {}) => {
    if (new URL(url).pathname === '/api/health') {
      return response({ status: 'ok', runtime: 'cloudflare-worker', catalog: 'configured' }, {
        headers: { 'cache-control': 'no-store', 'x-request-id': init.headers['x-request-id'] },
      })
    }
    if (new URL(url).pathname === '/api/translation-status') {
      return response(translationStatus || {
        status: 'ok', service: 'worlibrary-translation', configured: true, authRequired: true, rateLimit: 'configured',
      }, {
        headers: { 'cache-control': 'no-store', 'x-request-id': init.headers['x-request-id'], ...translationHeaders },
      })
    }
    if (new URL(url).pathname === '/api/catalog') {
      return response({ books: [{ id: 'open-library:fixture' }], sources: ['open-library', 'google-books'] }, {
        headers: { 'cache-control': 'public, max-age=60, s-maxage=300', 'x-request-id': init.headers['x-request-id'] },
      })
    }
    const headers = {
      'content-security-policy': "default-src 'self'; object-src 'none'",
      'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
    }
    delete headers[omitHeader]
    return response({}, { headers })
  }
}

test('deployment verifier accepts a safe health endpoint and app security headers', async () => {
  const result = await verifyDeployment('https://app.example.test/path', { fetchImpl: healthyFetch() })
  assert.equal(result.ok, true)
  assert.equal(result.origin, 'https://app.example.test')
  assert.match(result.requestId, /^deploy-probe-/)
  assert.equal(result.catalogCount, 1)
  assert.equal(result.translationConfigured, true)
})

test('deployment verifier permits an intentionally unconfigured translation provider without consuming an AI request', async () => {
  const result = await verifyDeployment('https://app.example.test', {
    fetchImpl: healthyFetch({ translationStatus: { status: 'ok', service: 'worlibrary-translation', configured: false, authRequired: true, rateLimit: 'configured' } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.translationConfigured, false)
})

test('deployment verifier rejects a translation status payload that could reveal a secret', async () => {
  const result = await verifyDeployment('https://app.example.test', {
    fetchImpl: healthyFetch({ translationStatus: { status: 'ok', service: 'worlibrary-translation', configured: true, authRequired: true, apiKey: 'must-not-leak' } }),
  })
  assert.deepEqual(result, { ok: false, message: 'Translation status probe returned an unsafe or unexpected payload' })
})

test('deployment verifier requires the translation status response to be private', async () => {
  const result = await verifyDeployment('https://app.example.test', {
    fetchImpl: healthyFetch({ translationHeaders: { 'cache-control': 'public, max-age=60' } }),
  })
  assert.deepEqual(result, { ok: false, message: 'Translation status probe must return cache-control: no-store' })
})

test('deployment verifier rejects non-HTTPS targets before making a request', async () => {
  const result = await verifyDeployment('http://app.example.test', {
    fetchImpl: () => { throw new Error('must not fetch') },
  })
  assert.deepEqual(result, { ok: false, message: 'Deployment URL must use HTTPS' })
})

test('deployment verifier reports a missing production security header', async () => {
  const result = await verifyDeployment('https://app.example.test', {
    fetchImpl: healthyFetch({ omitHeader: 'strict-transport-security' }),
  })
  assert.deepEqual(result, { ok: false, message: 'Application page is missing strict-transport-security' })
})

test('Vercel applies the security headers that the deployment verifier requires', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'))
  const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key.toLowerCase(), value]))
  assert.match(headers['content-security-policy'], /default-src 'self'/)
  assert.match(headers['strict-transport-security'], /max-age=/)
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin')
})

test('static-host header rules include HSTS as well', async () => {
  const rules = await readFile(new URL('../public/_headers', import.meta.url), 'utf8')
  assert.match(rules, /Strict-Transport-Security: max-age=/)
})
