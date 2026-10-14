import { expect, test } from '@playwright/test'

test('P1: legacy Open Library saves remain usable as catalog-only records', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worlibrary.saved-world-books', JSON.stringify([{
    id: 'OLlegacy', title: 'Legacy catalog item', author: 'Catalog author', languages: ['eng'], sourceUrl: 'https://openlibrary.org/works/OLlegacy', sourceName: 'Open Library',
  }])))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Legacy catalog item' })).toBeVisible()
  await expect(page.getByText('来源： Open Library · 仅书目记录')).toBeVisible()
  await expect(page.getByRole('button', { name: '前往来源阅读' })).toBeVisible()
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
  await expect(result.getByRole('button', { name: '前往来源阅读' })).toBeVisible()
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
  await expect(result.getByText('来源提供预览')).toBeVisible()
  expect(googleUrl).toContain('langRestrict=ja')
})
