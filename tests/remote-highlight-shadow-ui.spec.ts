import { expect, test } from '@playwright/test'

const accountId = 'remote-highlight-reader'

async function seedRemoteHighlight(page: import('@playwright/test').Page) {
  await page.evaluate(async (userId) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('wor-library')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        const transaction = database.transaction('remote-highlight-metadata-shadows', 'readwrite')
        transaction.objectStore('remote-highlight-metadata-shadows').put({
          key: `${userId}:remote-highlight-1`, userId, highlightId: 'remote-highlight-1',
          editionId: 'remote-edition-1', revision: 2, sequence: 5,
          text: 'A private excerpt from another signed-in device.',
          location: 'epubcfi(/6/4)', note: 'A private reading note.', color: 'gold', isHighlighted: true,
        })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => { database.close(); reject(transaction.error) }
      }
    })
  }, accountId)
}

test('a remote excerpt is visible only as a private read-only shadow without a local edition', async ({ page }) => {
  await page.addInitScript((userId) => localStorage.setItem('wor-library.auth.session', JSON.stringify({
    accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
    user: { id: userId, email: 'reader@example.com', isAnonymous: false },
  })), accountId)
  await page.goto('/?view=highlights')
  await expect(page.getByRole('heading', { name: '摘录空间' })).toBeVisible()
  await seedRemoteHighlight(page)
  await page.reload()

  const card = page.locator('.remote-highlight-shadow')
  await expect(card).toContainText('A private excerpt from another signed-in device.')
  await expect(card).toContainText('A private reading note.')
  await expect(card).toContainText('已同步的私密摘录')
  await expect(card).toContainText('原书文件仍不会传到这台设备')
  await expect(card.getByRole('button')).toHaveCount(0)
  await expect(page).not.toHaveURL(/view=reader/)
})
