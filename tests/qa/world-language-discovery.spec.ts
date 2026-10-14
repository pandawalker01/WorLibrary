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

test('P1: world catalog presents a global, readable language picker and carries its selection into search', async ({ page }) => {
  let requestedUrl = ''
  await page.route('https://openlibrary.org/search.json**', async (route) => {
    requestedUrl = route.request().url()
    await route.fulfill({ json: { docs: [{ key: '/works/OLzulFixture', title: 'Zulu fixture', author_name: ['Catalog author'], language: ['zul', 'eng'], edition_count: 2 }] } })
  })

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
