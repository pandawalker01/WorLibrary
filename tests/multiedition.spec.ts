import { expect, test } from '@playwright/test'

test('opens the two-column edition comparison reader', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const fixture = Buffer.from(await (await import('node:fs/promises')).readFile('tests/fixtures/reader-fixture.epub.b64'), 'utf8').toString().trim()
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles([
    { name: 'reader-fixture-english.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(fixture, 'base64') },
    { name: 'reader-fixture-chinese.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(fixture, 'base64') },
  ])
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toHaveCount(2)
  await page.getByRole('button', { name: /Reader Fixture/i }).first().click()
  page.once('dialog', (dialog) => dialog.accept('1'))
  await page.getByRole('button', { name: '＋ 关联译本' }).click()
  await expect(page.getByRole('status')).toContainText('已关联')
  await page.getByRole('button', { name: '⇄ 对照阅读' }).click()
  await expect(page.getByRole('region', { name: '双译本对照阅读' })).toBeVisible()
  await expect(page.locator('.edition-comparison-panes > article')).toHaveCount(2)
  await expect(page.getByText('独立滚动', { exact: true })).toBeVisible()
})

test('P0: comparison renders two imported sources and never falls back to the showcase passage', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const fixture = Buffer.from(await (await import('node:fs/promises')).readFile('tests/fixtures/reader-fixture.epub.b64'), 'utf8').toString().trim()
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles([
    { name: 'original-edition.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(fixture, 'base64') },
    { name: 'translated-edition.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(fixture, 'base64') },
  ])
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toHaveCount(2)
  await page.getByRole('button', { name: /Reader Fixture/i }).first().click()
  page.once('dialog', (dialog) => dialog.accept('1'))
  await page.getByRole('button', { name: '＋ 关联译本' }).click()
  await expect(page.locator('.toast')).toContainText('已关联')
  await page.getByRole('button', { name: '⇄ 对照阅读' }).click()

  const panes = page.locator('.edition-comparison-panes > article')
  await expect(panes).toHaveCount(2)
  await expect(panes.nth(0).locator('.epub-reader-frame iframe')).toHaveCount(1)
  await expect(panes.nth(1).locator('.epub-reader-frame iframe')).toHaveCount(1)
  await expect(panes.nth(0).frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await expect(panes.nth(1).frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('A LIFE, UNLIVED', { exact: false })).toHaveCount(0)
  await expect(page.locator('.reader-source-unavailable')).toHaveCount(0)
})
