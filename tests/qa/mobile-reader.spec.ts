import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

function twoPagePdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 51 >>\nstream\nBT /F1 18 Tf 40 180 Td (MOBILE_PDF_PAGE_ONE) Tj ET\nendstream',
    '<< /Length 51 >>\nstream\nBT /F1 18 Tf 40 180 Td (MOBILE_PDF_PAGE_TWO) Tj ET\nendstream',
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(output.length)
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = output.length
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(output)
}

async function expectNoHorizontalOverflow(page: Parameters<typeof test>[0] extends never ? never : import('@playwright/test').Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test.use({ viewport: { width: 390, height: 844 } })

test('P1 mobile: imported EPUB reader keeps pagination and reading controls usable at 390px', async ({ page }) => {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.goto('/')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'mobile-reader-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'reader fixture' })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('button', { name: /reader fixture/i }).click()
  const next = page.getByRole('button', { name: '下一页' })
  const previous = page.getByRole('button', { name: '上一页' })
  await expect(next).toBeVisible()
  await expect(next).toBeEnabled()
  await expect(previous).toBeVisible()
  await expect(page.getByRole('button', { name: '增大字号' })).toBeVisible()
  await expect(page.getByRole('button', { name: '纸张' })).toBeVisible()
  await expect(page.frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await next.click()
  await expect(page.frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_SECOND_PAGE')).toBeVisible({ timeout: 10_000 })
  await expectNoHorizontalOverflow(page)
})

test('P1 mobile: imported PDF reader keeps toolbar and page controls usable at 390px', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({
    name: 'mobile-pdf-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: twoPagePdfFixture(),
  })
  await expect(page.getByRole('heading', { name: 'mobile pdf fixture' })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('button', { name: /mobile pdf fixture/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
  const next = page.getByRole('button', { name: '下一页' })
  const previous = page.getByRole('button', { name: '上一页' })
  await expect(next).toBeVisible()
  await expect(next).toBeEnabled()
  await expect(previous).toBeVisible()
  await expect(page.getByRole('button', { name: '放大页面' })).toBeVisible()
  await expect(page.getByRole('button', { name: '识别当前页' })).toBeVisible()
  const pageNavigation = page.getByRole('navigation', { name: 'PDF 翻页' })
  await expect(pageNavigation).toBeVisible()
  await expect(pageNavigation.locator('button')).toHaveCount(2)
  await expect(pageNavigation).toHaveCSS('position', 'sticky')
  await expect(pageNavigation.getByRole('button', { name: '上一页' })).toBeDisabled()
  await expect(pageNavigation.getByRole('button', { name: '下一页' })).toHaveCSS('min-height', '44px')
  await next.click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
  await expectNoHorizontalOverflow(page)
})
