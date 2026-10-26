import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const fixturePath = resolve('tests/fixtures/reader-fixture.epub.b64')

async function importFixture(page: import('@playwright/test').Page) {
  const encoded = await readFile(fixturePath, 'utf8')
  await page.locator('input[data-testid="library-import"]').setInputFiles({
    name: 'reader-fixture.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(encoded.trim(), 'base64'),
  })
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
}

test('P1: navigation, language controls, contents, and metadata dialog expose keyboard state', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nav-item', { hasText: '书库' })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('button', { name: '设置' }).click()
  const interfaceLanguages = page.locator('.interface-language-picker')
  const interfaceTrigger = interfaceLanguages.getByRole('button', { name: /选择界面语言.*中文/ })
  await expect(interfaceTrigger).toHaveAttribute('aria-expanded', 'false')
  await interfaceTrigger.click()
  await expect(interfaceLanguages.getByRole('option', { name: /中文（中国）/ })).toHaveAttribute('aria-selected', 'true')
  await interfaceLanguages.getByRole('option', { name: /English/ }).click()
  await expect(page.locator('.nav-item', { hasText: 'Settings' })).toHaveAttribute('aria-current', 'page')
  await expect(interfaceLanguages.getByRole('button', { name: /Choose an interface language.*English/ })).toHaveAttribute('aria-expanded', 'false')
  await interfaceLanguages.getByRole('button', { name: /Choose an interface language.*English/ }).click()
  await interfaceLanguages.getByRole('option', { name: /Chinese/ }).click()

  await page.locator('.nav-item', { hasText: '书库' }).click()
  await importFixture(page)
  await page.getByRole('button', { name: /Reader Fixture/ }).click()
  const contents = page.locator('button[aria-controls="epub-contents"]')
  await expect(contents).toHaveAttribute('aria-expanded', 'false')
  await contents.click()
  await expect(contents).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(contents).toHaveAttribute('aria-expanded', 'false')

  // Reader pagination shortcuts belong to the reading surface, not focused
  // controls. Without this boundary, pressing an arrow key while operating the
  // contents control would unexpectedly turn a page.
  const progress = page.getByTestId('epub-progress')
  await expect(progress).not.toContainText('准备阅读')
  const positionBeforeControlShortcut = await progress.textContent()
  await contents.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  await expect(progress).toHaveText(positionBeforeControlShortcut ?? '')

  await page.getByRole('button', { name: '← 书库' }).click()
  await page.locator('.book-card', { hasText: 'Reader Fixture' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑信息' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('P1: signed-out account entry opens an accessible email sign-in dialog', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('wor-library.auth.session'))
  await page.goto('/')
  await page.getByRole('button', { name: /个人账户: 登录/ }).click()
  const dialog = page.getByRole('dialog', { name: '账号与同步' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '取消' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
