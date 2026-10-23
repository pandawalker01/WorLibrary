import JSZip from 'jszip'
import { expect, test } from '@playwright/test'

const coverPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Jc8AAAAAASUVORK5CYII='

async function createTwoPageEpub() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-e2e-fixture</dc:identifier><dc:title>Reader E2E Fixture</dc:title><dc:creator>QA Author</dc:creator><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`)
  zip.file('OEBPS/cover.png', Buffer.from(coverPng, 'base64'))
  zip.file('OEBPS/one.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>READER_E2E_FIRST_PAGE</p></body></html>')
  zip.file('OEBPS/two.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>READER_E2E_SECOND_PAGE</p></body></html>')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

test('P0: a fresh reader can import, read, translate, save, restore, and switch the interface locale', async ({ page }) => {
  let translationTarget: string | undefined
  await page.route('**/api/translate', async (route) => {
    translationTarget = JSON.parse(route.request().postData() || '{}').targetLanguage
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translation: '端到端测试译文', provider: 'qa', cached: false }) })
  })

  // Each Playwright test begins with a new browser context. No seeded book,
  // localStorage setting, or IndexedDB record may be required for this flow.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Reader E2E Fixture' })).toHaveCount(0)
  await page.locator('input[type=file][accept*=".epub"]').first().setInputFiles({
    name: 'reader-e2e-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: await createTwoPageEpub(),
  })
  await expect(page.getByRole('img', { name: 'Reader E2E Fixture 封面' })).toBeVisible()

  await page.getByRole('button', { name: /Reader E2E Fixture/i }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  await expect(reader.getByText('READER_E2E_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '下一页' }).click()
  const selectedText = reader.getByText('READER_E2E_SECOND_PAGE')
  await expect(selectedText).toBeVisible({ timeout: 10_000 })
  await selectedText.evaluate((node) => {
    const selection = node.ownerDocument?.defaultView?.getSelection()
    const range = node.ownerDocument?.createRange()
    if (!selection || !range) return
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    node.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })
  await expect(page.getByTestId('translation-popover')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('translation-popover')).toHaveAttribute('style', /--selection-popover-left:/)
  await expect(page.getByTestId('translation-popover')).toHaveAttribute('style', /--selection-popover-top:/)
  await expect(page.getByRole('button', { name: '金色' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.epub-reader-frame [ref="worlibrary-highlight"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.epub-reader-frame iframe')
    const popover = document.querySelector<HTMLElement>('[data-testid="translation-popover"]')
    const range = iframe?.contentWindow?.getSelection()?.getRangeAt(0)
    if (!iframe || !popover || !range) return false
    return popover.getBoundingClientRect().top >= iframe.getBoundingClientRect().top + range.getBoundingClientRect().bottom
  })).toBe(true)
  await expect.poll(() => translationTarget).toBe('中文')
  await expect(page.getByTestId('translation-result')).toContainText('端到端测试译文')
  await page.getByRole('button', { name: '玫红' }).click()
  await expect(page.getByRole('button', { name: '玫红' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.locator('.epub-reader-frame [ref="worlibrary-highlight"]').count()).toBeGreaterThan(0)
  await expect(page.locator('.epub-reader-frame [ref="worlibrary-highlight"]').first()).toHaveAttribute('fill', '#bf6d76')
  await expect(page.locator('.epub-reader-frame [ref="worlibrary-highlight"]').first()).toHaveAttribute('fill-opacity', '0.55')
  await page.getByRole('button', { name: '保存摘录' }).click()
  await expect(page.locator('.toast')).toContainText('摘录已保存到本地')

  await page.waitForTimeout(500)
  await page.reload()
  await expect(page.frameLocator('.epub-reader-frame iframe').getByText('READER_E2E_SECOND_PAGE')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => page.locator('.epub-reader-frame [ref="worlibrary-highlight"]').count()).toBeGreaterThan(0)
  await page.getByRole('button', { name: '摘录' }).click()
  await expect(page.getByText('READER_E2E_SECOND_PAGE')).toBeVisible()

  await page.getByRole('button', { name: '设置' }).click()
  const languageSections = page.locator('.language-section')
  const interfaceLanguagePicker = languageSections.nth(0).locator('.interface-language-picker')
  await interfaceLanguagePicker.getByRole('button', { name: /选择界面语言.*中文/ }).click()
  await interfaceLanguagePicker.getByRole('option', { name: /English/ }).click()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await interfaceLanguagePicker.getByRole('button', { name: /Choose an interface language.*English/ }).click()
  await interfaceLanguagePicker.getByRole('option', { name: /中文（中国）/ }).click()
  await expect(page.locator('.nav-item', { hasText: '书库' })).toBeVisible()
  await expect(page.locator('.topbar .header-reading-language-picker').getByRole('button', { name: /理解语言：中文/ })).toBeVisible()
})
