import { expect, test } from '@playwright/test'

test('interface locale persists independently from the AI reading language', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()

  const languageSections = page.locator('.language-section')
  await languageSections.nth(0).getByRole('button', { name: /^English/ }).click()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await expect(page.locator('.nav-item', { hasText: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading & interface languages' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading language' })).toBeVisible()

  await languageSections.nth(1).getByRole('button', { name: /^Français/ }).click()
  await expect(page.getByRole('button', { name: /Reading language：Français/ })).toBeVisible()

  await page.reload()
  await expect(page.locator('.nav-item', { hasText: 'Library' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Reading language：Français/ })).toBeVisible()
})
