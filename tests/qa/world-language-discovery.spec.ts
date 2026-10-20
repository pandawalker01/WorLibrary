import { expect, test } from '@playwright/test'

function protectedPdfFixture(pageTexts = ['PLATFORM_PDF_PAGE_ONE', 'PLATFORM_PDF_PAGE_TWO']) {
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

test('P1: legacy Open Library saves remain usable as catalog-only records', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worlibrary.saved-world-books', JSON.stringify([{
    id: 'OLlegacy', title: 'Legacy catalog item', author: 'Catalog author', languages: ['eng'], sourceUrl: 'https://openlibrary.org/works/OLlegacy', sourceName: 'Open Library',
  }])))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Legacy catalog item' })).toBeVisible()
  await expect(page.getByText('来源： Open Library · 仅书目记录')).toBeVisible()
  await expect(page.getByRole('button', { name: '查看来源' })).toBeVisible()
})

test('P0: personal library makes platform access states explicit and never offers a fabricated download', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worlibrary.saved-world-books', JSON.stringify([
    { id: 'catalog', sourceId: 'open-library', sourceRecordId: 'catalog', title: 'Catalog only', author: 'A', languages: ['eng'], sourceUrl: 'https://example.test/catalog', sourceName: 'Open Library', access: { mode: 'catalog_only', url: 'https://example.test/catalog' } },
    { id: 'preview', sourceId: 'google-books', sourceRecordId: 'preview', title: 'Preview only', author: 'B', languages: ['eng'], sourceUrl: 'https://example.test/preview', sourceName: 'Google Books', access: { mode: 'preview', url: 'https://example.test/preview' } },
    { id: 'licensed', sourceId: 'licensed', sourceRecordId: 'licensed', title: 'Licensed online', author: 'C', languages: ['eng'], sourceUrl: 'https://example.test/licensed', sourceName: 'Licensed source', access: { mode: 'licensed_full_text', url: 'https://example.test/licensed' } },
    { id: 'external', sourceId: 'external', sourceRecordId: 'external', title: 'Source reading', author: 'D', languages: ['eng'], sourceUrl: 'https://example.test/source', sourceName: 'External source', access: { mode: 'external', url: 'https://example.test/source' } },
  ])))

  await page.goto('/')
  const shelf = page.locator('.saved-world-shelf')
  await expect(shelf.getByText('仅书目记录')).toBeVisible()
  await expect(shelf.getByRole('button', { name: '查看来源' })).toBeVisible()
  await expect(shelf.getByText('限量预览')).toBeVisible()
  await expect(shelf.getByRole('button', { name: '前往预览' })).toBeVisible()
  await expect(shelf.getByText('可在线阅读')).toBeVisible()
  await expect(shelf.getByRole('button', { name: '前往在线阅读' })).toBeVisible()
  await expect(shelf.getByText('来源阅读', { exact: true })).toBeVisible()
  await expect(shelf.getByRole('button', { name: '前往来源阅读' })).toBeVisible()
  await expect(page.getByRole('button', { name: /下载/ })).toHaveCount(0)
  await expect(page.getByText('收藏保存的是书目信息与来源链接，不等于下载或获得应用内正文。未授权正文不会下载、存储或分发。')).toHaveCount(0)
})

test('P0: platform online title opens the in-app reader and fails closed before content delivery exists', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worlibrary.saved-world-books', JSON.stringify([{
    id: 'platform-fixture', sourceId: 'platform', sourceRecordId: 'platform-fixture', platformEditionId: 'platform-fixture', title: 'Platform fixture', author: 'Rights holder', languages: ['eng'], sourceUrl: 'https://example.test/platform-fixture', sourceName: 'WorLibrary platform', access: { mode: 'licensed_full_text', url: 'https://example.test/platform-fixture' },
  }])))
  let accessRequests = 0
  await page.route('**/api/reader/access?editionId=platform-fixture', async (route) => {
    accessRequests += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ editionId: 'platform-fixture', access_mode: 'stream', delivery: { available: false, reason: 'content_delivery_not_implemented' } }) })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '在 WorLibrary 中阅读' }).click()
  await expect(page.getByRole('heading', { name: 'Platform fixture' })).toBeVisible()
  await expect(page.getByText('平台内容尚未配置，不能打开')).toBeVisible()
  await expect(page).toHaveURL(/view=reader/)
  await expect(page).toHaveURL(/platformEdition=platform-fixture/)
  expect(accessRequests).toBe(1)
  await expect(page.locator('.epub-reader-frame, .pdf-reader-frame')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /下载/ })).toHaveCount(0)
})

test('P1: visible platform reader time is kept as local metadata and appears in recent reading', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worlibrary.saved-world-books', JSON.stringify([{
    id: 'platform-time-fixture', sourceId: 'platform', sourceRecordId: 'platform-time-fixture', platformEditionId: 'platform-time-fixture', title: 'Platform time fixture', author: 'Rights holder', languages: ['eng'], sourceUrl: 'https://example.test/platform-time-fixture', sourceName: 'WorLibrary platform', access: { mode: 'licensed_full_text', url: 'https://example.test/platform-time-fixture' },
  }])))
  await page.route('**/api/reader/access?editionId=platform-time-fixture', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ editionId: 'platform-time-fixture', access_mode: 'stream', delivery: { available: false, reason: 'content_delivery_not_implemented' } }) })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '在 WorLibrary 中阅读' }).click()
  await expect(page.getByText('Platform time fixture', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('worlibrary.reading-by-book') ?? '{}')['platform:platform-time-fixture'])).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('worlibrary.platform-reading-metadata') ?? '{}')['platform:platform-time-fixture'])).toEqual(expect.objectContaining({ editionId: 'platform-time-fixture', title: 'Platform time fixture', author: 'Rights holder' }))
  await page.getByRole('button', { name: '← 返回书库' }).click()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click()
  await expect(page.getByText('Platform time fixture', { exact: true })).toBeVisible()
})

test('P0: protected platform PDF stays in-app, is responsive, and paginates without a download action', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worlibrary.saved-world-books', JSON.stringify([{
    id: 'platform-pdf', sourceId: 'platform', sourceRecordId: 'platform-pdf', platformEditionId: 'platform-pdf', title: 'Protected PDF fixture', author: 'Rights holder', languages: ['eng'], sourceUrl: 'https://example.test/platform-pdf', sourceName: 'WorLibrary platform', access: { mode: 'licensed_full_text', url: 'https://example.test/platform-pdf' },
  }])))
  await page.route('**/api/reader/access?editionId=platform-pdf', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ editionId: 'platform-pdf', access_mode: 'stream', delivery: { available: true, mode: 'in_app_stream', content_type: 'application/pdf' } }) })
  })
  let protectedContentRequests = 0
  await page.route('**/api/reader/content?editionId=platform-pdf', async (route) => {
    protectedContentRequests += 1
    await route.fulfill({ contentType: 'application/pdf', body: protectedPdfFixture() })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '在 WorLibrary 中阅读' }).click()
  const protectedReader = page.locator('.platform-pdf-reader')
  await expect(protectedReader).toBeVisible()
  await expect(protectedReader.getByText('受保护 PDF · 第 1 / 2 页')).toBeVisible({ timeout: 15_000 })
  await expect(protectedReader.locator('canvas')).toBeVisible()
  await expect(protectedReader.getByRole('button', { name: '上一页' })).toBeDisabled()
  await protectedReader.getByRole('button', { name: '下一页' }).click()
  await expect(protectedReader.getByText('第 2 / 2 页', { exact: true })).toBeVisible()
  await expect(protectedReader.getByRole('button', { name: '下一页' })).toBeDisabled()
  expect(protectedContentRequests).toBe(1)
  await expect(page.getByRole('button', { name: /下载/ })).toHaveCount(0)
  await expect(page.locator('.epub-reader-frame, .pdf-reader-frame')).toHaveCount(0)
})

test('P1: a stalled catalog request leaves loading state and can be retried', async ({ page }) => {
  await page.route('https://openlibrary.org/search.json**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 9_000))
    await route.fulfill({ json: { docs: [] } }).catch(() => undefined)
  })
  await page.route('https://www.googleapis.com/books/v1/volumes**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 9_000))
    await route.fulfill({ json: { items: [] } }).catch(() => undefined)
  })

  await page.goto('/')
  await page.getByRole('tab', { name: '世界书库' }).click()
  await page.getByRole('textbox', { name: '搜索世界书库' }).fill('stalled fixture')
  await page.getByRole('button', { name: '搜索世界书库' }).click()
  await expect(page.getByRole('alert')).toHaveText('暂时无法连接任何书目来源，请检查网络后重试。', { timeout: 10_000 })
  await expect(page.getByRole('status', { name: '正在检索书目来源…' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '搜索世界书库' })).toBeEnabled()
})

test('P1: world catalog presents a global, readable language picker and carries its selection into search', async ({ page }) => {
  let requestedUrl = ''
  await page.route('https://openlibrary.org/search.json**', async (route) => {
    requestedUrl = route.request().url()
    await route.fulfill({ json: { docs: [{ key: '/works/OLzulFixture', title: 'Zulu fixture', author_name: ['Catalog author'], language: ['zul', 'eng'], edition_count: 2 }] } })
  })
  await page.route('https://www.googleapis.com/books/v1/volumes**', async (route) => route.fulfill({ json: { items: [] } }))

  await page.goto('/')
  await page.getByRole('tab', { name: '世界书库' }).click()

  const picker = page.locator('.world-language-picker')
  await picker.getByRole('button', { name: /书目语言/ }).click()
  const options = picker.getByRole('option')
  expect(await options.count()).toBeGreaterThan(120)
  // `bi`, `ce`, and `ch` were browser-normalized code aliases seen in the
  // native picker. Short real language names (for example Ewe) remain valid.
  await expect(picker.getByRole('option', { name: 'bi', exact: true })).toHaveCount(0)
  await expect(picker.getByRole('option', { name: 'ce', exact: true })).toHaveCount(0)
  await expect(picker.getByRole('option', { name: 'ch', exact: true })).toHaveCount(0)

  const catalogLanguageSearch = picker.getByRole('searchbox', { name: '搜索全球语言' })
  await catalogLanguageSearch.fill('祖鲁')
  await expect(picker.getByRole('option', { name: '祖鲁语', exact: true })).toBeVisible()
  await picker.getByRole('option', { name: '祖鲁语', exact: true }).click()
  await expect(picker.getByRole('button', { name: /书目语言.*祖鲁语/ })).toBeVisible()

  await page.getByRole('textbox', { name: '搜索世界书库' }).fill('fixture')
  await page.getByRole('button', { name: '搜索世界书库' }).click()
  await expect(page.getByRole('heading', { name: 'Zulu fixture' })).toBeVisible()
  const result = page.locator('[data-source-id="open-library"]')
  await expect(result.getByText('来源： Open Library')).toBeVisible()
  await expect(result.getByText('仅书目记录')).toBeVisible()
  await expect(result.getByRole('button', { name: '查看来源' })).toBeVisible()
  await result.getByRole('button', { name: '加入我的书库' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('worlibrary.saved-world-books') ?? '[]'))).toEqual([expect.objectContaining({
    sourceId: 'open-library', sourceRecordId: 'OLzulFixture', sourceName: 'Open Library', access: { mode: 'catalog_only', url: 'https://openlibrary.org/works/OLzulFixture' },
  })])
  expect(requestedUrl).toContain('language=zul')
})

test('P1: Google Books supplies catalog results when Open Library returns none', async ({ page }) => {
  let googleUrl = ''
  await page.route('https://openlibrary.org/search.json**', async (route) => route.fulfill({ json: { docs: [] } }))
  await page.route('https://www.googleapis.com/books/v1/volumes**', async (route) => {
    googleUrl = route.request().url()
    await route.fulfill({ json: { items: [{ id: 'googleFixture', volumeInfo: { title: 'Google fixture', authors: ['Catalog author'], language: 'ja', infoLink: 'https://books.google.com/books?id=googleFixture' }, accessInfo: { viewability: 'PARTIAL', webReaderLink: 'https://books.google.com/books?id=googleFixture&jscmd=SearchWithinVolume2' } }] } })
  })

  await page.goto('/')
  await page.getByRole('tab', { name: '世界书库' }).click()
  const picker = page.locator('.world-language-picker')
  await picker.getByRole('button', { name: /书目语言/ }).click()
  await picker.getByRole('searchbox', { name: '搜索全球语言' }).fill('日语')
  await picker.getByRole('option', { name: '日语', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索世界书库' }).fill('fixture')
  await page.getByRole('button', { name: '搜索世界书库' }).click()
  const result = page.locator('[data-source-id="google-books"]')
  await expect(result.getByRole('heading', { name: 'Google fixture' })).toBeVisible()
  await expect(result.getByText('来源： Google Books')).toBeVisible()
  await expect(result.getByText('限量预览')).toBeVisible()
  await expect(result.getByRole('button', { name: '前往预览' })).toBeVisible()
  expect(googleUrl).toContain('langRestrict=ja')
})
