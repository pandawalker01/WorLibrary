import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

test('interface locale persists independently from the AI reading language', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()

  const languageSections = page.locator('.language-section')
  await languageSections.nth(0).getByRole('button', { name: /^English/ }).click()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await expect(page.locator('.nav-item', { hasText: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading & interface languages' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading language' })).toBeVisible()

  await languageSections.nth(1).getByRole('button', { name: /^Français/ }).click()
  await expect(page.getByRole('button', { name: /Reading language：Français/ })).toBeVisible()

  await page.reload()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Reading language：Français/ })).toBeVisible()

  await page.locator('.nav-item', { hasText: 'Library' }).click()
  const encoded = await readFile(fixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  await expect(page.getByRole('button', { name: '← Library' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Paper' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next page' })).toBeVisible()

  await page.locator('.back-button').click()
  await page.locator('.nav-item', { hasText: 'Highlights' }).click()
  await expect(page.getByRole('heading', { name: 'Your excerpts' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search highlights' })).toBeVisible()

  await page.locator('.nav-item', { hasText: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Account & sync' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export reading data' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import reading data' })).toBeVisible()
})
