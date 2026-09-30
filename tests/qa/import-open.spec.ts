import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

async function importFixture(page: Page) {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'reader fixture' })).toBeVisible()
}

test('P0: imported EPUB renders fixture content instead of demo content', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /reader fixture/i }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  await expect(reader.getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
})

test('P0: imported EPUB provides explicit pagination and reaches the next chapter', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /reader fixture/i }).click()
  await expect(page.getByRole('button', { name: '下一页' })).toBeVisible()
  await page.getByRole('button', { name: '下一页' }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  await expect(reader.getByText('ORCHARD_FIXTURE_SECOND_PAGE')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('ArrowLeft')
  await expect(reader.getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('ArrowRight')
  await expect(reader.getByText('ORCHARD_FIXTURE_SECOND_PAGE')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByRole('button', { name: /reader fixture/i }).click()
  const restoredReader = page.frameLocator('.epub-reader-frame iframe')
  await expect(restoredReader.getByText('ORCHARD_FIXTURE_SECOND_PAGE')).toBeVisible({ timeout: 10_000 })
})
