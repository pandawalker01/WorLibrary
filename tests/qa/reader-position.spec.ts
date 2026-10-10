import { expect, test } from '@playwright/test'

function twoPagePdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 53 >>\nstream\nBT /F1 18 Tf 40 180 Td (PDF_POSITION_FIXTURE_ONE) Tj ET\nendstream',
    '<< /Length 53 >>\nstream\nBT /F1 18 Tf 40 180 Td (PDF_POSITION_FIXTURE_TWO) Tj ET\nendstream',
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

test('P0: PDF reading page is restored after refresh and reopening from the library', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({
    name: 'pdf-position-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: twoPagePdfFixture(),
  })
  const book = page.getByRole('button', { name: /pdf position fixture/i })
  await book.click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: /pdf position fixture/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /书库/ }).click()
  await page.getByRole('button', { name: /pdf position fixture/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
})
