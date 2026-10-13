import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

test('interface locale persists independently from the AI reading language', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()

  const languageSections = page.locator('.language-section')
  const interfaceLanguagePicker = languageSections.nth(0).locator('.interface-language-picker')
  await interfaceLanguagePicker.getByRole('button', { name: /选择界面语言.*中文/ }).click()
  await expect(interfaceLanguagePicker.getByRole('option', { name: /日本語/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(interfaceLanguagePicker.getByText('即将支持', { exact: true }).first()).toBeVisible()
  await interfaceLanguagePicker.getByRole('option', { name: /English/ }).click()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await expect(page.locator('.nav-item', { hasText: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading & interface languages' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading language' })).toBeVisible()

  const readingLanguagePicker = languageSections.nth(1).locator('.reading-language-picker')
  await readingLanguagePicker.getByRole('button', { name: /Choose a global reading language/ }).click()
  await readingLanguagePicker.getByPlaceholder('Type a language name, such as Arabic').fill('French')
  await readingLanguagePicker.getByRole('option', { name: /French/ }).click()
  await expect(readingLanguagePicker.getByRole('button', { name: /Choose a global reading language.*French/ })).toBeVisible()

  await page.reload()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Choose a global reading language.*French/ })).toBeVisible()

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

test('interface language picker exposes the global roadmap without enabling incomplete packs', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()

  const picker = page.locator('.interface-language-picker')
  await picker.getByRole('button', { name: /选择界面语言/ }).click()
  await expect(picker.getByRole('option', { name: /中文（中国）/ })).toBeVisible()
  await expect(picker.getByRole('option', { name: /日本語/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(picker.getByRole('button', { name: /日本語/ })).toHaveCount(0)

  await picker.getByPlaceholder('输入语言名称，例如 西班牙语').fill('English')
  await picker.getByRole('option', { name: /English/ }).click()
  await expect(page.getByRole('heading', { name: 'Reading & interface languages' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Reading & interface languages' })).toBeVisible()
})
