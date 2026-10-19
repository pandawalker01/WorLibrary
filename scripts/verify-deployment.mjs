#!/usr/bin/env node

const REQUIRED_SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'",
  'strict-transport-security': undefined,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

function header(response, name) {
  return response.headers.get(name) || ''
}

function failure(message) {
  return { ok: false, message }
}

export async function verifyDeployment(origin, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let baseUrl
  try {
    baseUrl = new URL(origin)
  } catch {
    return failure('Deployment URL must be an absolute HTTPS URL')
  }
  if (baseUrl.protocol !== 'https:') return failure('Deployment URL must use HTTPS')
  baseUrl.pathname = '/'
  baseUrl.search = ''
  baseUrl.hash = ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestId = `deploy-probe-${Date.now()}`
  try {
    const healthUrl = new URL('/api/health', baseUrl)
    const health = await fetchImpl(healthUrl, {
      headers: { 'x-request-id': requestId },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!health.ok) return failure(`Health probe returned HTTP ${health.status}`)
    if (header(health, 'cache-control') !== 'no-store') return failure('Health probe must return cache-control: no-store')
    if (header(health, 'x-request-id') !== requestId) return failure('Health probe did not return its x-request-id')

    let payload
    try {
      payload = await health.json()
    } catch {
      return failure('Health probe did not return JSON')
    }
    const isWorkerHealth = payload?.status === 'ok' && payload?.runtime === 'cloudflare-worker' && payload?.catalog === 'configured'
    const isLegacyGatewayHealth = payload?.status === 'ok' && payload?.service === 'worlibrary-ai-gateway'
    if (!isWorkerHealth && !isLegacyGatewayHealth) {
      return failure('Health probe returned an unexpected status payload')
    }

    const page = await fetchImpl(baseUrl, { redirect: 'error', signal: controller.signal })
    if (!page.ok) return failure(`Application page returned HTTP ${page.status}`)
    for (const [name, expected] of Object.entries(REQUIRED_SECURITY_HEADERS)) {
      const value = header(page, name)
      if (!value) return failure(`Application page is missing ${name}`)
      if (expected && !value.includes(expected)) return failure(`Application page has an invalid ${name}`)
    }

    const catalogRequestId = `${requestId}-catalog`
    const catalogUrl = new URL('/api/catalog?q=world%20classics&language=eng', baseUrl)
    const catalog = await fetchImpl(catalogUrl, {
      headers: { 'x-request-id': catalogRequestId },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!catalog.ok) return failure(`Catalog probe returned HTTP ${catalog.status}`)
    if (!header(catalog, 'cache-control').startsWith('public,')) return failure('Catalog probe must return a short-lived public cache policy')
    if (header(catalog, 'x-request-id') !== catalogRequestId) return failure('Catalog probe did not return its x-request-id')
    let catalogPayload
    try {
      catalogPayload = await catalog.json()
    } catch {
      return failure('Catalog probe did not return JSON')
    }
    if (!Array.isArray(catalogPayload?.books) || !Array.isArray(catalogPayload?.sources) || !catalogPayload.sources.includes('open-library')) {
      return failure('Catalog probe returned an unexpected payload')
    }
    return { ok: true, origin: baseUrl.origin, requestId, catalogCount: catalogPayload.books.length }
  } catch (error) {
    if (error?.name === 'AbortError') return failure(`Deployment probe timed out after ${timeoutMs}ms`)
    return failure(`Deployment probe failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const origin = process.argv[2] || process.env.DEPLOYMENT_URL
  if (!origin) {
    console.error('Usage: node scripts/verify-deployment.mjs https://deployment.example.com')
    process.exit(2)
  }
  const result = await verifyDeployment(origin)
  if (!result.ok) {
    console.error(`Deployment verification failed: ${result.message}`)
    process.exit(1)
  }
  console.log(`Deployment verification passed for ${result.origin} (${result.requestId})`)
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await main()
