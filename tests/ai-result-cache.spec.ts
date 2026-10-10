import { expect, test } from '@playwright/test'
import { clearExplanationResultCache, explainSelection } from '../src/lib/explanation'
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
