import { test, expect } from '@playwright/test'

test('library opens and filters books', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '把世界的书，' })).toBeVisible()
  const search = page.getByRole('textbox', { name: '搜索书库' })
  await search.fill('Kafka')
  await expect(page.getByRole('heading', { name: '变形记' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'The Invisible Life of Addie LaRue' })).not.toBeVisible()
  await expect(page.getByRole('status')).toContainText('找到 1 本匹配书籍')
})

test('library search includes imported file names and stays usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const search = page.getByRole('textbox', { name: '搜索书库' })
  await expect(search).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入书籍' })).toBeVisible()
  await search.fill('English')
  await expect(page.getByRole('heading', { name: 'The Invisible Life of Addie LaRue' })).toBeVisible()
})

test('reader controls remain visible on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /The Invisible Life of Addie LaRue/ }).click()
  await expect(page.getByRole('button', { name: '← 书库' })).toBeVisible()
  await expect(page.getByRole('button', { name: '⇄ 对照阅读' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aa' })).toBeVisible()
})

test('library filter controls expose reading and edition views', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /正在读/ }).click()
  await expect(page.getByRole('heading', { name: 'The Invisible Life of Addie LaRue' })).toBeVisible()
  await page.getByRole('button', { name: /多译本/ }).click()
  await expect(page.getByText('没有找到匹配的书籍或筛选结果')).toBeVisible()
})

test('highlights view provides text and book filters', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '摘录' }).click()
  await expect(page.getByRole('textbox', { name: '搜索摘录' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '筛选书籍' })).toBeVisible()
})

test('reader, comparison and explanation flow are available', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /The Invisible Life of Addie LaRue/ }).click()
  await expect(page.getByRole('button', { name: '⇄ 对照阅读' })).toBeVisible()
  await page.getByRole('button', { name: '⇄ 对照阅读' }).click()
  await expect(page.getByRole('status')).toContainText('请先导入并关联另一个译本')
})

test('settings and backup controls are reachable', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '你的阅读语言' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出阅读数据' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入阅读数据' })).toBeVisible()
})
