import { expect, test } from '@playwright/test'

test('opens the two-column edition comparison reader', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /The Invisible Life of Addie LaRue/ }).click()
  await page.getByRole('button', { name: '⇄ 对照阅读' }).click()
  await expect(page.getByRole('region', { name: '双译本对照阅读' })).toBeVisible()
  await expect(page.locator('.edition-comparison-panes > article')).toHaveCount(2)
  await expect(page.getByText('章节已对齐')).toBeVisible()
})
