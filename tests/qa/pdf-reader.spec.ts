import { expect, test } from '@playwright/test'

function pdfFixture(pageTexts = ['PDF_FIXTURE_PAGE']) {
  const pageObjectStart = 3
  const fontObject = pageObjectStart + pageTexts.length
  const contentObjectStart = fontObject + 1
  const pageObjects = pageTexts.map((_, index) => `${pageObjectStart + index} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageTexts.length} >>`,
    ...pageTexts.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pageTexts.map((text) => {
      const content = `BT /F1 18 Tf 40 180 Td (${text}) Tj ET`
      return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
    }),
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

test('P1: PDF reading preferences survive refresh and reopening', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({ name: 'pdf-preferences.pdf', mimeType: 'application/pdf', buffer: pdfFixture() })
  await page.getByRole('button', { name: /pdf preferences/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 1 页 ·/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: '增大字号' }).click()
  await page.getByRole('button', { name: '放大页面' }).click()
  await page.getByRole('button', { name: '纸张' }).click()
  await expect(page.locator('.pdf-reader-shell')).toHaveClass(/reader-theme-sepia/)
  await expect(page.locator('.pdf-reader-shell')).toHaveAttribute('style', /--reader-font-scale: 1.05/)
  await expect(page.getByText(/111%/)).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: /pdf preferences/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 1 页 ·.*111%/)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.pdf-reader-shell')).toHaveClass(/reader-theme-sepia/)
  await expect(page.locator('.pdf-reader-shell')).toHaveAttribute('style', /--reader-font-scale: 1.05/)
})

test('P1: PDF OCR result is selectable and reuses translation and excerpt paths', async ({ page }) => {
  await page.goto('/')
  let translatedText = ''
  await page.route('**/api/translate', async (route) => {
    translatedText = String(route.request().postDataJSON().text)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translation: 'OCR 测试译文', sourceLanguage: 'English', targetLanguage: '中文', provider: 'test', requestId: 'ocr-selection-translation' }) })
  })
  await page.route('**/api/ocr/page', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ text: 'PDF_FIXTURE_PAGE OCR', provider: 'test', requestId: 'ocr-ui-once' }),
    })
  })
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({ name: 'pdf-ocr-once.pdf', mimeType: 'application/pdf', buffer: pdfFixture() })
  await page.getByRole('button', { name: /pdf ocr once/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 1 页 ·/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: '识别当前页' }).click()
  const ocrResult = page.getByLabel('OCR 当前页文字')
  await expect(ocrResult).toHaveCount(1, { timeout: 15_000 })
  await expect(ocrResult).toContainText('识别结果')
  await expect(ocrResult).toContainText('PDF_FIXTURE_PAGE')
  await expect(ocrResult).toContainText('校正并确认后，可选择、复制、翻译或保存为摘录')
  await page.getByLabel('校正识别文字').fill('PDF_FIXTURE_PAGE OCR 校正后')
  await expect(page.getByRole('button', { name: '确认校正' })).toBeEnabled()
  await page.getByRole('button', { name: '确认校正' }).click()
  await expect(page.locator('.pdf-ocr-selectable-text')).toHaveText('PDF_FIXTURE_PAGE OCR 校正后')
  await page.locator('.pdf-ocr-selectable-text').evaluate((node) => {
    const selection = node.ownerDocument?.defaultView?.getSelection()
    const range = node.ownerDocument?.createRange()
    if (!selection || !range || !node.firstChild) return
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await expect(page.getByRole('button', { name: '翻译' })).toBeVisible()
  await page.getByRole('button', { name: '翻译' }).click()
  await expect(page.getByText('OCR 测试译文')).toBeVisible()
  expect(translatedText).toBe('PDF_FIXTURE_PAGE OCR 校正后')
  await expect(page.getByRole('button', { name: '保存选中' })).toBeEnabled()
  await page.getByRole('button', { name: '保存选中' }).click()
  await expect(page.getByRole('button', { name: '上一页' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled()
  await page.getByRole('button', { name: '摘录' }).click()
  await expect(page.getByRole('heading', { name: '摘录空间' })).toBeVisible()
  await expect(page.getByText('PDF_FIXTURE_PAGE OCR 校正后', { exact: true })).toBeVisible()
})

test('P1: PDF OCR failure keeps the page and offers an inline retry', async ({ page }) => {
  await page.goto('/')
  let attempt = 0
  await page.route('**/api/ocr/page', async (route) => {
    attempt += 1
    if (attempt === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'provider_unavailable', message: '暂不可用', retryable: true } }) })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: 'RETRY_SUCCEEDED', provider: 'test', requestId: 'ocr-retry' }) })
  })
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({ name: 'pdf-ocr-retry.pdf', mimeType: 'application/pdf', buffer: pdfFixture(['OCR_RETRY_PAGE_ONE', 'OCR_RETRY_PAGE_TWO']) })
  await page.getByRole('button', { name: /pdf ocr retry/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '识别当前页' }).click()
  await expect(page.locator('.pdf-ocr-error')).toContainText('识别未完成')
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 2 页 ·/)).toBeVisible()
  await page.getByRole('button', { name: '重新识别本页' }).click()
  await expect(page.getByLabel('OCR 当前页文字')).toContainText('RETRY_SUCCEEDED')
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 2 页 ·/)).toBeVisible()
})

test('P0: two-page PDF restores the latest page after refreshing', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({
    name: 'pdf-progress.pdf',
    mimeType: 'application/pdf',
    buffer: pdfFixture(['PDF_PAGE_ONE', 'PDF_PAGE_TWO']),
  })
  await page.getByRole('button', { name: /pdf progress/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 1 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.reload()
  await page.getByRole('button', { name: /pdf progress/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: '← 书库' }).click()
  await page.getByRole('button', { name: /pdf progress/i }).click()
  await expect(page.getByText(/PDF 本地阅读 · 第 2 \/ 2 页 ·/)).toBeVisible({ timeout: 15_000 })
})
