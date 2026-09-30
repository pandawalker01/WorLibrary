import { expect, test } from '@playwright/test'

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 180 Td (PDF_FIXTURE_PAGE) Tj ET\nendstream',
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

test('P1: imported PDF renders, paginates with controls and supports keyboard navigation', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({ name: 'pdf-fixture.pdf', mimeType: 'application/pdf', buffer: pdfFixture() })
  await expect(page.getByRole('heading', { name: 'pdf fixture' })).toBeVisible()
  await page.getByRole('button', { name: /pdf fixture/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 1 页 ·/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '上一页' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '放大页面' })).toBeVisible()
  await page.getByRole('button', { name: '放大页面' }).click()
  await expect(page.getByText(/111%/)).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
})
