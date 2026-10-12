import JSZip from 'jszip'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const coverPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Jc8AAAAAASUVORK5CYII='

async function embeddedCoverEpub() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">embedded-cover-fixture</dc:identifier>
        <dc:title>Embedded Cover Fixture</dc:title>
        <dc:creator>QA Author</dc:creator>
        <meta name="cover" content="cover-image"/>
      </metadata>
      <manifest>
        <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="chapter"/></spine>
    </package>`)
  zip.file('OEBPS/cover.png', Buffer.from(coverPng, 'base64'))
  zip.file('OEBPS/chapter.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover QA</title></head>
    <body><p>EMBEDDED_COVER_FIXTURE_TEXT</p></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function importEmbeddedCoverFixture(page: Page) {
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'embedded-cover-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: await embeddedCoverEpub(),
  })
  await expect(page.getByRole('heading', { name: 'Embedded Cover Fixture' })).toBeVisible()
}

async function importReaderFixture(page: Page) {
  const fixture = await import('node:fs/promises').then(({ readFile }) => readFile('tests/fixtures/reader-fixture.epub.b64', 'utf8'))
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.trim(), 'base64'),
  })
  await page.getByRole('button', { name: /reader fixture/i }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  const text = reader.getByText('ORCHARD_FIXTURE_FIRST_PAGE')
  await expect(text).toBeVisible({ timeout: 10_000 })
  await text.evaluate((node) => {
    const selection = node.ownerDocument?.defaultView?.getSelection()
    const range = node.ownerDocument?.createRange()
    if (!selection || !range) return
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    node.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })
}

test('P0: imported EPUB uses its embedded cover and keeps it after refresh', async ({ page }) => {
  await page.goto('/')
  await importEmbeddedCoverFixture(page)
  const cover = page.getByRole('img', { name: 'Embedded Cover Fixture 封面' })
  await expect(cover).toBeVisible()
  await expect(cover).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(page.locator('.book-card .cover.ink > img')).toHaveCount(1)

  await page.reload()
  const restoredCover = page.getByRole('img', { name: 'Embedded Cover Fixture 封面' })
  await expect(restoredCover).toBeVisible()
  await expect(restoredCover).toHaveAttribute('src', /^data:image\/png;base64,/)
})

test('P0: interface locale survives refresh without changing the AI understanding language', async ({ page }) => {
  let targetLanguage: string | undefined
  await page.route('**/api/translate', async (route) => {
    targetLanguage = JSON.parse(route.request().postData() || '{}').targetLanguage
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translation: 'fixture translation', provider: 'qa' }) })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '界面语言', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '界面语言：English' }).click()
  await expect(page.getByRole('heading', { name: 'Your reading language' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Understanding language: 中文' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your reading language' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Understanding language: 中文' })).toBeVisible()
  await page.getByRole('button', { name: 'Library' }).click()
  await importReaderFixture(page)
  await expect(page.getByRole('button', { name: 'Translate' })).toBeVisible({ timeout: 5_000 })
  await page.getByRole('button', { name: 'Translate' }).click()
  await expect.poll(() => targetLanguage).toBe('中文')
})
