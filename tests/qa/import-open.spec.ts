import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')
const noNavigationFixturePath = resolve('tests/fixtures/no-navigation-fixture.epub.b64')
const coverFixturePath = resolve('tests/fixtures/cover-fixture.epub.b64')

async function importFixture(page: Page) {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'reader fixture' })).toBeVisible()
}

async function importNoNavigationFixture(page: Page) {
  const encoded = await readFile(noNavigationFixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'no-navigation-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'no nav fixture' })).toBeVisible()
}

async function importCoverFixture(page: Page) {
  const encoded = await readFile(coverFixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'cover-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'Cover Fixture' })).toBeVisible()
}

test('P0: imported EPUB renders fixture content instead of demo content', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /reader fixture/i }).click()
  await expect(page.getByText('Chapter 4', { exact: true })).not.toBeVisible()
  await expect(page.getByText('进度已保存到本机', { exact: true })).toBeVisible()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  await expect(reader.getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
})

test('P0: imported EPUB metadata can be corrected without re-importing the file', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('button', { name: '重新读取封面' })).toBeVisible()
  await page.getByRole('button', { name: '上传本地封面' }).click()
  await page.locator('input[accept="image/*"]').setInputFiles({
    name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Jc8AAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(page.locator('.toast')).toContainText('已设置本地书籍封面')
  await page.getByRole('button', { name: '01 书库' }).click()
  await expect(page.getByRole('img', { name: 'Reader Fixture 封面' })).toBeVisible()
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: '编辑信息' }).click()
  await page.getByRole('textbox', { name: '书名' }).fill('校正后的书名')
  await page.getByRole('textbox', { name: '作者' }).fill('校正后的作者')
  await page.getByRole('button', { name: '保存信息' }).click()
  await expect(page.locator('.toast')).toContainText('书籍信息已在本地更新')
  await page.getByRole('button', { name: '01 书库' }).click()
  await expect(page.getByRole('heading', { name: '校正后的书名' })).toBeVisible()
  await page.getByRole('button', { name: /校正后的书名/ }).click()
  await expect(page.frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
})

test('P0: standard EPUB cover survives import, refresh and reopening the library', async ({ page }) => {
  await page.goto('/')
  await importCoverFixture(page)
  const shelfCover = page.getByRole('img', { name: 'Cover Fixture 封面' })
  await expect(shelfCover).toBeVisible()
  await expect(shelfCover).toHaveAttribute('src', /^data:image\/png;base64,/)

  await page.reload()
  await expect(shelfCover).toBeVisible()
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: '重新读取封面' }).click()
  await expect(page.locator('.toast')).toContainText('已从 EPUB 重新读取原书封面')
  await page.getByRole('button', { name: '01 书库' }).click()
  await expect(shelfCover).toBeVisible()
  await expect(shelfCover).toHaveAttribute('src', /^data:image\/png;base64,/)
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

test('P1: imported EPUB always exposes a usable contents affordance', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /reader fixture/i }).click()
  // The fixture has an NCX/navigation document. The reader normalizes nested
  // entries and, for books without one, derives this list from the spine.
  await expect(page.getByRole('button', { name: /目录 · \d+/ })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /目录 · \d+/ }).click()
  await expect(page.getByRole('navigation', { name: '章节目录' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '章节目录' }).getByRole('button').first()).toBeVisible()
})

test('P1: EPUB without a navigation document falls back to spine chapters', async ({ page }) => {
  await page.goto('/')
  await importNoNavigationFixture(page)
  await page.getByRole('button', { name: /no nav fixture/i }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  await expect(reader.getByText('NO_NAV_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: /目录 · 2/ })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /目录 · 2/ }).click()
  const contents = page.getByRole('navigation', { name: '章节目录' })
  await expect(contents.getByRole('button', { name: '第 2 节' })).toBeVisible()
  await contents.getByRole('button', { name: '第 2 节' }).click()
  await expect(reader.getByText('NO_NAV_FIXTURE_SECOND_PAGE')).toBeVisible({ timeout: 10_000 })
})

test('P1: EPUB font size and theme survive a refresh and reopening the book', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /reader fixture/i }).click()
  await expect(page.frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '增大字号' }).click()
  await page.getByRole('button', { name: '纸张' }).click()
  await expect(page.locator('.epub-reader-shell')).toHaveClass(/reader-theme-sepia/)
  await expect(page.locator('.epub-reader-shell')).toHaveAttribute('style', /--reader-font-scale: 1.05/)
  await page.reload()
  await page.getByRole('button', { name: /reader fixture/i }).click()
  await expect(page.frameLocator('.epub-reader-frame iframe').getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.epub-reader-shell')).toHaveClass(/reader-theme-sepia/)
  await expect(page.locator('.epub-reader-shell')).toHaveAttribute('style', /--reader-font-scale: 1.05/)
})

test('P2: local full-text search finds imported EPUB text without uploading the file', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /reader fixture/i }).click()
  const reader = page.frameLocator('.epub-reader-frame iframe')
  await expect(reader.getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '← 书库' }).click()
  const search = page.getByRole('textbox', { name: '搜索书库' })
  await search.fill('ORCHARD_FIXTURE_SECOND_PAGE')
  await expect(page.getByRole('heading', { name: 'reader fixture' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/正文命中：.*ORCHARD_FIXTURE_SECOND_PAGE/)).toBeVisible()
})

test('P1: selecting EPUB text exposes translation, explanation and local highlight actions', async ({ page }) => {
  await page.route('**/api/translate', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ translation: '果园里的第一句话', provider: 'qa', cached: false }) })
  })
  await page.route('**/api/explain', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ translation: '果园里的第一句话', explanation: '这是用于验证划词解释的测试文本。', provider: 'qa', cached: false }) })
  })
  await page.goto('/')
  await importFixture(page)
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
  await expect(page.getByRole('button', { name: '翻译' })).toBeVisible({ timeout: 5_000 })
  await page.getByRole('button', { name: '翻译' }).click()
  await expect(page.getByTestId('translation-result')).toContainText('果园里的第一句话')
  await page.getByRole('button', { name: '解释' }).click()
  await expect(page.getByTestId('translation-result')).toContainText('这是用于验证划词解释的测试文本。')
  await page.getByRole('button', { name: '玫红' }).click()
  await page.getByRole('button', { name: '保存摘录' }).click()
  await expect(page.getByRole('status')).toContainText('摘录已保存到本地')
  await page.getByRole('button', { name: '摘录' }).click()
  await expect(page.getByRole('heading', { name: '摘录空间' })).toBeVisible()
  await expect(page.getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible()

  // Notes are metadata only: the source EPUB remains in local OPFS/IndexedDB.
  await page.getByRole('button', { name: '添加备注' }).click()
  await page.getByPlaceholder('写下你的理解…').fill('仅保存在这台设备上的阅读笔记')
  await page.getByRole('button', { name: '保存备注' }).click()
  await expect(page.getByText('仅保存在这台设备上的阅读笔记')).toBeVisible()
  await page.getByRole('button', { name: '编辑备注' }).click()
  await page.getByPlaceholder('写下你的理解…').fill('编辑后的本地笔记')
  await page.getByRole('button', { name: '保存备注' }).click()
  await expect(page.getByText('编辑后的本地笔记')).toBeVisible()
  await page.getByRole('combobox', { name: '筛选书籍' }).selectOption({ label: 'Reader Fixture' })
  await expect(page.getByText('ORCHARD_FIXTURE_FIRST_PAGE')).toBeVisible()
  await page.getByRole('button', { name: '删除' }).click()
  await expect(page.getByText('还没有摘录')).toBeVisible()
})
