import { expect, test } from '@playwright/test'

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
  expect(requestedUrl).toContain('language=zul')
})
