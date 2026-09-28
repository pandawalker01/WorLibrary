import { test, expect } from '@playwright/test'

test('library opens and filters books', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '把世界的书，' })).toBeVisible()
  const search = page.getByRole('textbox', { name: '搜索书库' })
  await search.fill('Kafka')
  await expect(page.getByRole('heading', { name: '变形记' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'The Invisible Life of Addie LaRue' })).not.toBeVisible()
})

test('reader, comparison and explanation flow are available', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /The Invisible Life of Addie LaRue/ }).click()
  await expect(page.getByRole('button', { name: '⇄ 对照阅读' })).toBeVisible()
  await page.getByRole('button', { name: '⇄ 对照阅读' }).click()
  await expect(page.locator('.translation-page')).toBeVisible()
  await page.getByRole('button', { name: /用 AI 解释/ }).click()
  await expect(page.locator('.ai-panel')).toContainText('通俗解释')
})

test('settings and backup controls are reachable', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '你的阅读语言' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出阅读数据' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入阅读数据' })).toBeVisible()
})
