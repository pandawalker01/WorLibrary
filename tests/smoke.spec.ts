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
  await expect(page.getByRole('button', { name: '导入书籍' })).toBeVisible()
})

test('library search includes imported file names and stays usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await importFixture(page)
  const search = page.getByRole('textbox', { name: '搜索书库' })
  await expect(search).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入书籍' })).toBeVisible()
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
})

test('library filter controls expose reading and edition views', async ({ page }) => {
  await page.goto('/')
  await importFixture(page)
  await page.getByRole('button', { name: /正在读/ }).click()
  await expect(page.getByText('没有找到匹配的书籍或筛选结果')).toBeVisible()
  await page.getByRole('button', { name: /多译本/ }).click()
  await expect(page.getByText('没有找到匹配的书籍或筛选结果')).toBeVisible()
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
  await expect(page.getByText('本地书籍')).toBeVisible()
  await expect(page.getByRole('button', { name: /Reader Fixture/ })).toBeVisible()
  await page.getByRole('button', { name: '书库 →' }).click()
  await expect(page.getByRole('heading', { name: '把世界的书，' })).toBeVisible()
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
  await expect(page.getByRole('status')).toContainText('本地优先')
  await expect(page.getByText('原始 EPUB/PDF 文件和封面始终留在本机。')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出阅读数据' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入阅读数据' })).toBeVisible()
})

test('top account avatar leads to account settings', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '个人账户: 登录' }).click()
  await expect(page.getByRole('heading', { name: '阅读与界面语言' })).toBeVisible()
  await expect(page.getByRole('region', { name: '账号与同步' })).toBeVisible()
})
