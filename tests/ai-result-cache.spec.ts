import { expect, test } from '@playwright/test'
import { aiFeedbackFor } from '../src/lib/ai-feedback'
import { AiGatewayError, clearExplanationResultCache, explainSelection } from '../src/lib/explanation'
import { clearTranslationResultCache, translateSelection } from '../src/lib/translation'

test.afterEach(() => {
  clearTranslationResultCache()
  clearExplanationResultCache()
})

test('reuses an identical translation in this browser session without another gateway request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return Response.json({ translation: '你好', provider: 'test' })
  }) as typeof fetch

  const first = await translateSelection('Hello', '中文', { sourceLanguage: 'English', context: 'A greeting' })
  const second = await translateSelection('Hello', '中文', { sourceLanguage: 'English', context: 'A greeting' })

  expect(calls).toBe(1)
  expect(first.cached).toBe(false)
  expect(second).toMatchObject({ translation: '你好', cached: true })
  globalThis.fetch = originalFetch
})

test('keeps explanation entries separate from translation entries and request context', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    calls += 1
    const url = String(input)
    return Response.json(url.endsWith('/api/explain')
      ? { translation: '你好', explanation: '问候语', provider: 'test' }
      : { translation: '你好', provider: 'test' })
  }) as typeof fetch

  await translateSelection('Hello', '中文', { context: 'Greeting' })
  await explainSelection('Hello', '中文', { context: 'Greeting' })
  await translateSelection('Hello', '中文', { context: 'Different context' })

  expect(calls).toBe(3)
  globalThis.fetch = originalFetch
})

test('preserves a server-provided retry-after value without inventing quota data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'rate_limited', message: 'retry later', retryable: true },
  }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '45' },
  })) as typeof fetch

  try {
    await translateSelection('Hello', '中文')
    throw new Error('Expected translation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AiGatewayError)
    expect((error as AiGatewayError).code).toBe('rate_limited')
    expect((error as AiGatewayError).retryAfterSeconds).toBe(45)
    expect(aiFeedbackFor(error).detail).toContain('约 45 秒后再试')
  } finally {
    globalThis.fetch = originalFetch
  }
})
