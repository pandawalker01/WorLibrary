import { expect, test } from '@playwright/test'

const accountId = 'shadow-shelf-reader'
const editionId = 'f2cbf73d-5716-433f-8e93-7f03a3e9d3e7'

async function seedShadow(page: import('@playwright/test').Page, userId = accountId) {
  await page.evaluate(async ({ userId, editionId }) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('wor-library')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        const transaction = database.transaction('remote-book-metadata-shadows', 'readwrite')
        transaction.objectStore('remote-book-metadata-shadows').put({
          key: `${userId}:${editionId}`,
          userId,
          editionId,
          revision: 3,
          sequence: 7,
          title: 'Remote edition fixture',
          author: 'A safe author',
          language: 'English',
          progress: 42,
          location: 'epubcfi(/6/2)',
          fileName: 'remote-fixture.epub',
          fileType: 'application/epub+zip',
          fileSize: 2048,
          cover: 'ink',
          needsReimport: true,
        })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => { database.close(); reject(transaction.error) }
      }
    })
  }, { userId, editionId })
}

test('a stable account sees only its remote shadow as a non-reader re-import card', async ({ page }) => {
  await page.addInitScript((userId) => localStorage.setItem('wor-library.auth.session', JSON.stringify({
    accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
    user: { id: userId, email: 'reader@example.com', isAnonymous: false },
  })), accountId)
  await page.goto('/')
  await expect(page.getByRole('tab', { name: '我的书库' })).toBeVisible()
  await seedShadow(page)
  await page.reload()

  const card = page.locator('.remote-book-metadata-shadow')
  await expect(page.getByRole('heading', { name: '云端书架中的书籍' })).toBeVisible()
  await expect(card).toContainText('Remote edition fixture')
  await expect(card).toContainText('需重新导入原书')
  await expect(card).toContainText('阅读进度 42%')
  await expect(card).not.toHaveClass(/book-card/)
  await expect(card).not.toHaveAttribute('role', 'button')
  await card.click({ position: { x: 10, y: 10 } })
  await expect(page).not.toHaveURL(/view=reader/)
})

test('a matching local edition hides its own remote shadow without deleting it', async ({ page }) => {
  await page.addInitScript((userId) => localStorage.setItem('wor-library.auth.session', JSON.stringify({
    accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
    user: { id: userId, email: 'reader@example.com', isAnonymous: false },
  })), accountId)
  await page.goto('/')
  await expect(page.getByRole('tab', { name: '我的书库' })).toBeVisible()
  await seedShadow(page)
  await page.evaluate(async (edition) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('wor-library')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        const transaction = database.transaction('books', 'readwrite')
        transaction.objectStore('books').put({
          id: 'local-shadow-match', title: 'Local original', author: 'Reader', language: 'English', progress: 42,
          cover: 'ink', fileName: 'remote-fixture.epub', fileType: 'application/epub+zip', fileSize: 2048,
          storage: 'indexeddb', createdAt: Date.now(), workId: 'local-shadow-work', editionId: edition,
        })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => { database.close(); reject(transaction.error) }
      }
    })
  }, editionId)
  await page.reload()

  await expect(page.getByRole('heading', { name: 'Local original' })).toBeVisible()
  await expect(page.locator('.remote-book-metadata-shadows')).toHaveCount(0)
})
