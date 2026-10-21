import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

async function importFixture(page: import('@playwright/test').Page) {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles({
    name: 'reader-fixture.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
}

test('library opens to an empty local shelf and guides the first import', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '把世界的书，' })).toBeVisible()
  await expect(page.getByText('你的书架还是空的。导入 EPUB 或 PDF 后，书籍会只保存在这台设备上。')).toBeVisible()
  await expect(page.getByRole('button', { name: /导入我的书/ })).toBeVisible()
})

test('primary pages omit decorative micro-labels and serial numbers', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.eyebrow')).toHaveCount(0)

  await page.getByRole('tab', { name: '世界书库' }).click()
  await expect(page.locator('.eyebrow')).toHaveCount(0)

  await page.getByRole('button', { name: '摘录' }).click()
  await expect(page.locator('.eyebrow')).toHaveCount(0)

  await page.getByRole('button', { name: '我的', exact: true }).click()
  await expect(page.locator('.eyebrow')).toHaveCount(0)

  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.eyebrow')).toHaveCount(0)
})

test('world library saves a source-labelled catalog book to my library', async ({ page }) => {
  await page.route('https://openlibrary.org/search.json**', async (route) => {
    await route.fulfill({ json: { docs: [{ key: '/works/OLfixtureW', title: 'World Fixture', author_name: ['Catalog Author'], first_publish_year: 2024, language: ['eng'] }] } })
  })
  await page.goto('/')
  await page.getByRole('tab', { name: '世界书库' }).click()
  await page.getByRole('textbox', { name: '搜索世界书库' }).fill('fixture')
  await page.getByRole('button', { name: '搜索世界书库' }).click()
  await expect(page.getByRole('heading', { name: 'World Fixture' })).toBeVisible()
  await page.getByRole('button', { name: '加入我的书库' }).click()
  await page.getByRole('tab', { name: '我的书库' }).click()
  await expect(page.getByRole('heading', { name: 'World Fixture' })).toBeVisible()
  await expect(page.getByText('联网收藏')).toBeVisible()
})

test('world library filters catalog search by language and multilingual availability', async ({ page }) => {
  let requestedUrl = ''
  await page.route('https://openlibrary.org/search.json**', async (route) => {
    requestedUrl = route.request().url()
    await route.fulfill({ json: { docs: [{ key: '/works/OLlanguageW', title: 'Multilingual Fixture', author_name: ['Catalog Author'], language: ['eng', 'chi'], edition_count: 7 }] } })
  })
  await page.goto('/')
  await page.getByRole('tab', { name: '世界书库' }).click()
  await page.getByRole('button', { name: '书目语言 全部语言' }).click()
  const languageSearch = page.getByRole('searchbox', { name: '搜索全球语言' })
  await languageSearch.fill('英语')
  await page.getByRole('option', { name: '英语' }).click()
  await page.getByRole('checkbox', { name: '优先多语种版本' }).check()
  await page.getByRole('textbox', { name: '搜索世界书库' }).fill('fixture')
  await page.getByRole('button', { name: '搜索世界书库' }).click()
  await expect(page.getByRole('heading', { name: 'Multilingual Fixture' })).toBeVisible()
  await expect(page.getByText('2 种语言 · 7 个版本')).toBeVisible()
  expect(requestedUrl).toContain('language=eng')
})

test('library search includes imported file names and stays usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await importFixture(page)
  const search = page.getByRole('textbox', { name: '搜索书库' })
  await expect(search).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('button', { name: /导入我的书/ })).toBeVisible()
  await search.fill('Reader Fixture')
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
})

test('reader controls remain visible on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  await expect(page.getByRole('button', { name: '← 书库' })).toBeVisible()
  await expect(page.getByRole('button', { name: '⇄ 对照阅读' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aa' })).toBeVisible()
  await page.getByRole('button', { name: 'Aa' }).click()
  const layoutPanel = page.getByRole('dialog', { name: '阅读排版' })
  await expect(layoutPanel).toBeVisible()
  await layoutPanel.getByRole('button', { name: '夜间' }).click()
  await expect(layoutPanel.getByRole('button', { name: '夜间' })).toHaveAttribute('aria-pressed', 'true')
})

test('library filter controls expose reading and edition views', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /正在读/ }).click()
  await expect(page.getByText('没有找到匹配的书籍或筛选结果')).toBeVisible()
  await page.getByRole('button', { name: /多译本/ }).click()
  await expect(page.getByText('没有找到匹配的书籍或筛选结果')).toBeVisible()
})

test('local book actions are available from the library card context menu', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click({ button: 'right' })
  await expect(page.getByRole('menu', { name: '本地书籍管理' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '编辑信息' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible()
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '本地书籍管理' })).toHaveCount(0)
})

test('highlights view provides text and book filters', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '摘录' }).click()
  await expect(page.getByRole('textbox', { name: '搜索摘录' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '筛选书籍' })).toBeVisible()
})

test('profile shows local reading stats and routes back to the library', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  await page.getByRole('button', { name: '下一页' }).click()
  await page.getByRole('button', { name: '← 书库' }).click()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的阅读' })).toBeVisible()
  await expect(page.getByText('累计阅读')).toBeVisible()
  await expect(page.getByRole('heading', { name: '阅读轨迹' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '最近阅读' })).toBeVisible()
  await expect(page.getByText('本地书籍')).toBeVisible()
  await page.getByRole('button', { name: '书库 →' }).click()
  await expect(page.getByRole('heading', { name: '把世界的书，' })).toBeVisible()
})

test('reading time does not advance while the reader tab is hidden', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  await page.evaluate(() => {
    localStorage.removeItem('worlibrary.reading-seconds')
    localStorage.removeItem('worlibrary.reading-history')
    localStorage.removeItem('worlibrary.reading-by-book')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  })
  await page.waitForTimeout(1200)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('worlibrary.reading-seconds'))).toBeNull()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('worlibrary.reading-history'))).toBeNull()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('worlibrary.reading-by-book'))).toBeNull()
})

test('reader, comparison and explanation flow are available', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  await expect(page.locator('.reader-header').getByRole('button', { name: /导入书籍|Import book/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '⇄ 对照阅读' })).toBeVisible()
  await page.getByRole('button', { name: '⇄ 对照阅读' }).click()
  await expect(page.getByRole('status')).toContainText('请先导入并关联另一个译本')
})

test('settings and backup controls are reachable', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('#reading-language-title')).toHaveText(/^(理解语言|Reading language)$/)
  await expect(page.getByRole('heading', { name: '阅读与界面语言' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '账号与同步' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(/本地优先|当前仅保存在本机/)
  await expect(page.getByText('原始 EPUB/PDF 文件和封面始终留在本机。')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出阅读数据' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入阅读数据' })).toBeVisible()
})

test('signed-out top account avatar opens the email account dialog', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('wor-library.auth.session'))
  await page.goto('/')
  await page.getByRole('button', { name: '个人账户: 登录' }).click()
  const dialog = page.getByRole('dialog', { name: '账号与同步' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('region', { name: '账号与同步' })).toBeVisible()
})

test('refresh and browser history restore the current application route', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page).toHaveURL(/view=settings/)
  await page.reload()
  await expect(page.getByRole('heading', { name: '阅读与界面语言' })).toBeVisible()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '书库', exact: true }).click()
  await page.getByRole('tab', { name: '世界书库' }).click()
  await expect(page).toHaveURL(/view=library.*scope=world/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: '把世界的书，' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: '阅读与界面语言' })).toBeVisible()
})

test('refresh restores an imported reader route', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  await expect(page).toHaveURL(/view=reader.*book=/)
  await page.reload()
  await expect(page.getByRole('button', { name: '← 书库' })).toBeVisible()
})
