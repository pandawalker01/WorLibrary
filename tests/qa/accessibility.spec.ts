import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

async function importFixture(page: import('@playwright/test').Page) {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
}

test('P1: navigation, language controls, contents, and metadata dialog expose keyboard state', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nav-item', { hasText: '书库' })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('button', { name: '设置' }).click()
  const interfaceLanguages = page.locator('.language-grid-compact')
  await expect(interfaceLanguages.getByRole('button', { name: /^简体中文/ })).toHaveAttribute('aria-pressed', 'true')
  await interfaceLanguages.getByRole('button', { name: /^English/ }).click()
  await expect(page.locator('.nav-item', { hasText: 'Settings' })).toHaveAttribute('aria-current', 'page')
  await expect(interfaceLanguages.getByRole('button', { name: /^English/ })).toHaveAttribute('aria-pressed', 'true')
  await interfaceLanguages.getByRole('button', { name: /^简体中文/ }).click()

  await page.locator('.nav-item', { hasText: '书库' }).click()
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  const contents = page.locator('button[aria-controls="epub-contents"]')
  await expect(contents).toHaveAttribute('aria-expanded', 'false')
  await contents.click()
  await expect(contents).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(contents).toHaveAttribute('aria-expanded', 'false')

  // Reader pagination shortcuts belong to the reading surface, not focused
  // controls. Without this boundary, pressing an arrow key while operating the
  // contents control would unexpectedly turn a page.
  const progress = page.getByTestId('epub-progress')
  await expect(progress).not.toContainText('准备阅读')
  const positionBeforeControlShortcut = await progress.textContent()
  await contents.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  await expect(progress).toHaveText(positionBeforeControlShortcut ?? '')

  await page.getByRole('button', { name: '← 书库' }).click()
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: '编辑信息' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
