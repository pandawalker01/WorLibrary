import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

async function openFixtureWithSelection(page: Page) {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.goto('/')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await page.getByRole('button', { name: /reader fixture/i }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  const text = reader.getByText('ORCHARD_FIXTURE_FIRST_PAGE')
  await expect(text).toBeVisible({ timeout: 10_000 })
  await text.evaluate((node) => {
    const selection = node.ownerDocument?.defaultView?.getSelection()
    const range = node.ownerDocument?.createRange()
    if (!selection || !range) return
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    node.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })
  await expect(page.getByTestId('translation-popover')).toBeVisible({ timeout: 5_000 })
}

test.describe('AI request feedback', () => {
  for (const scenario of [
    { code: 'provider_unavailable', title: 'AI 服务暂不可用', detail: '请稍后重试；若持续出现，请检查部署配置。' },
    { code: 'provider_timeout', title: 'AI 响应超时', detail: '服务响应较慢。请稍后重试，或缩短选中的文字。' },
    { code: 'rate_limited', title: 'AI 服务繁忙', detail: '请求过于频繁或供应商繁忙，请稍后重试。' },
  ]) {
    test(`P1: ${scenario.code} gives actionable feedback and retries the same selection`, async ({ page }) => {
      let calls = 0
      await page.route('**/api/translate', async (route) => {
        calls += 1
        if (calls === 1) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: scenario.code, message: 'gateway error', retryable: true } }),
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ translation: '重试后的译文', provider: 'qa', cached: false }),
        })
      })

      await openFixtureWithSelection(page)
      const feedback = page.locator('.ai-request-feedback')
      await expect(feedback).toContainText(scenario.title)
      await expect(feedback).toContainText(scenario.detail)
      await page.getByRole('button', { name: '重试翻译' }).click()
      await expect(page.getByTestId('translation-result')).toContainText('重试后的译文')
      await expect(feedback).toHaveCount(0)
      expect(calls).toBe(2)
    })
  }

  test('P1: exhausted quota explains the limit without exposing a retry action', async ({ page }) => {
    await page.route('**/api/translate', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'quota_exceeded', message: 'gateway error', retryable: false } }),
      })
    })

    await openFixtureWithSelection(page)
    const feedback = page.locator('.ai-request-feedback')
    await expect(feedback).toContainText('今日额度已用完')
    await expect(feedback).toContainText('请明天再试，或联系管理员调整试用额度。')
    await expect(feedback.getByRole('button', { name: '重试翻译' })).toHaveCount(0)
  })
})
