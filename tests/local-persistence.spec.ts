import { test, expect } from '@playwright/test'

test('imported book metadata and local file survive a reload', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'refresh-proof.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from('local-only-epub-fixture'),
  })
  await expect(page.getByText('已保存 1 本书')).toBeVisible()

  const beforeReload = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wor-library')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const books = await new Promise<Array<{ fileName: string; storage: string; id: string }>>((resolve, reject) => {
      const request = database.transaction('books').objectStore('books').getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const book = books.find((item) => item.fileName === 'refresh-proof.epub')
    if (!book) throw new Error('book metadata was not persisted')
    let blobSize = 0
    if (book.storage === 'indexeddb') {
      blobSize = await new Promise<number>((resolve, reject) => {
        const request = database.transaction('book-blobs').objectStore('book-blobs').get(book.id)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve((request.result as Blob | undefined)?.size ?? 0)
      })
    }
    return { storage: book.storage, blobSize }
  })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'refresh proof' })).toBeVisible()
  expect(['opfs', 'indexeddb']).toContain(beforeReload.storage)
  if (beforeReload.storage === 'indexeddb') expect(beforeReload.blobSize).toBeGreaterThan(0)
})
