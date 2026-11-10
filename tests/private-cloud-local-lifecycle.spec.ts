import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { expect, test, type Page } from '@playwright/test'
test.use({ serviceWorkers: 'block' })

async function loadStorage(page: Page) {
  const source = await readFile('src/lib/storage.ts', 'utf8')
  const body = stripTypeScriptTypes(source)
  await page.route('**/__storage-test.js', (route) => route.fulfill({ contentType: 'text/javascript', body }))
  const commit = await readFile('src/lib/private-file-local-commit.ts', 'utf8')
  const commitBody = stripTypeScriptTypes(commit)
  await page.route('**/private-file-local-commit', (route) => route.fulfill({ contentType: 'text/javascript', body: commitBody }))
  await page.goto('/')
  await expect(page.getByRole('tab', { name: '我的书库' })).toBeVisible()
}

test('account invalidation inside recovery transaction rolls back file, book, work and edition together', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await loadStorage(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/__storage-test.js')
    const controller = new AbortController()
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args)
      if (this.name === 'books') request.addEventListener('success', () => controller.abort(), { once: true })
      return request
    }
    let error = ''
    try {
      await storage.reimportRemoteBookMetadataShadow({
        file: new File(['test'], 'original.pdf', { type: 'application/pdf' }), signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
        shadow: { needsReimport: true, editionId: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', title: 'Original', author: 'Fixture', language: 'English', progress: 0, fileName: 'original.pdf', fileType: 'application/pdf', fileSize: 4, cover: 'ink' },
      })
    } catch (caught) { error = (caught as Error).message }
    finally { IDBObjectStore.prototype.put = originalPut }
    const counts = await new Promise<Record<string, number>>((resolve, reject) => {
      const open = indexedDB.open('wor-library')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result; const names = ['books', 'book-blobs', 'works', 'editions']
        const tx = db.transaction(names); const values: Record<string, number> = {}
        for (const name of names) { const request = tx.objectStore(name).count(); request.onsuccess = () => { values[name] = request.result } }
        tx.oncomplete = () => { db.close(); resolve(values) }
      }
    })
    return { error, counts }
  })
  expect(result.error).toBe('RECOVERY_SESSION_INVALIDATED')
  expect(Object.values(result.counts)).toEqual([0, 0, 0, 0])
  expect(pageErrors).toEqual([])
})

test('successful recovery is readable and failed OPFS cleanup preserves the local book for retry', async ({ page }) => {
  await loadStorage(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/__storage-test.js')
    const book = await storage.reimportRemoteBookMetadataShadow({
      file: new File(['test'], 'original.pdf', { type: 'application/pdf' }), isCurrent: () => true,
      shadow: { needsReimport: true, editionId: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', title: 'Original', author: 'Fixture', language: 'English', progress: 0, fileName: 'original.pdf', fileType: 'application/pdf', fileSize: 4, cover: 'ink' },
    })
    const bytes = await (await storage.getBookFile(book)).text()
    const original = navigator.storage.getDirectory
    Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: async () => { throw new DOMException('Busy', 'NoModificationAllowedError') } })
    let failed = false
    try { await storage.deleteBook({ ...book, storage: 'opfs' }) } catch { failed = true }
    finally { Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: original }) }
    const retained = (await storage.listBooks()).some((item: { id: string }) => item.id === book.id)
    await storage.deleteBook(book)
    const remaining = (await storage.listBooks()).length
    return { bytes, failed, retained, remaining }
  })
  expect(result).toEqual({ bytes: 'test', failed: true, retained: true, remaining: 0 })
})

test('concurrent recovery cannot commit two local books for one remote edition', async ({ page }) => {
  await loadStorage(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/__storage-test.js')
    const input = {
      file: new File(['test'], 'original.pdf', { type: 'application/pdf' }), isCurrent: () => true,
      shadow: { needsReimport: true, editionId: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', title: 'Original', author: 'Fixture', language: 'English', progress: 0, fileName: 'original.pdf', fileType: 'application/pdf', fileSize: 4, cover: 'ink' },
    }
    const outcomes = await Promise.allSettled([storage.reimportRemoteBookMetadataShadow(input), storage.reimportRemoteBookMetadataShadow(input)])
    return { success: outcomes.filter((item) => item.status === 'fulfilled').length, books: (await storage.listBooks()).length }
  })
  expect(result).toEqual({ success: 1, books: 1 })
})
