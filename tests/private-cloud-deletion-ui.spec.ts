import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
const owner = '11111111-1111-4111-8111-111111111111'
const other = '44444444-4444-4444-8444-444444444444'
const manifestId = '22222222-2222-4222-8222-222222222222'
const editionId = '33333333-3333-4333-8333-333333333333'
const remoteJob = { manifestId, editionId, fileName: 'original.pdf' }
const configured = Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY)
test.skip(!configured, 'Build and test with public CI VITE Supabase fixtures; all remote requests are mocked')
async function account(page: Page) {
  await page.addInitScript(owner => localStorage.setItem('wor-library.auth.session', JSON.stringify({ accessToken: 'synthetic-owner', refreshToken: 'synthetic-refresh', user: { id: owner, isAnonymous: false } })), owner)
  await page.route('**/rest/v1/user_file_manifests?**', route => route.fulfill({ json: [] }))
}
async function seedJobs(page: Page) {
  await page.evaluate(async ({ owner, other, manifestId, editionId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('worlibrary-private-deletions', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('jobs')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('jobs', 'readwrite')
      for (const [userId, label] of [[owner, 'My pending file'], [other, 'Other account private file']]) {
        tx.objectStore('jobs').put({ userId, manifestId, editionId, label, state: 'failed' }, `${userId}:${manifestId}`)
      }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, { owner, other, manifestId, editionId })
}

test('new-device pending cleanup is retryable without a local book and survives refresh until confirmed', async ({ page }) => {
  await account(page)
  let remote = [remoteJob]; let deletes = 0; let used = 4 * 1048576
  await page.route('**/rest/v1/rpc/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)
    if (name === 'list_private_file_cleanup_jobs') return route.fulfill({ json: remote })
    if (name === 'get_private_file_library_state') return route.fulfill({ json: { enabled: false, consented: true, quotaBytes: 1073741824, usedBytes: used, reservedBytes: 0 } })
    return route.fulfill({ status: 400, json: {} })
  })
  await page.route(`**/api/user-files/${manifestId}`, route => {
    expect(route.request().method()).toBe('DELETE')
    deletes++; if (deletes > 1) { remote = []; used = 0 }
    return route.fulfill({ status: 202, json: { status: deletes === 1 ? 'deleting' : 'deleted' } })
  })
  await page.goto('/?view=settings')
  const section = page.getByTestId('private-cloud-deletions')
  await section.getByRole('button', { name: '重试删除 original.pdf' }).click()
  await expect(section.getByRole('button', { name: '重试删除 original.pdf' })).toBeEnabled()
  remote = []
  await page.reload()
  await section.getByRole('button', { name: '重试删除 original.pdf' }).click()
  await expect(section.getByTestId(`private-delete-${manifestId}`)).toHaveCount(0)
  await expect(section.getByText('删除请求已处理。')).toBeVisible()
  await expect(page.getByTestId('private-cloud-preferences')).toContainText('正文用量: 0 MB')
  expect(deletes).toBe(2)
})

test('local failed jobs remain when status is malformed; IndexedDB and UI stay account scoped', async ({ page }) => {
  await account(page)
  await page.route('**/rest/v1/rpc/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)
    if (name === 'list_private_file_cleanup_jobs') return route.fulfill({ json: [{ ...remoteJob, object_key: 'never-render-private-locator' }] })
    if (name === 'get_private_file_library_state') return route.fulfill({ json: { enabled: false, consented: false, quotaBytes: 1073741824, usedBytes: 0, reservedBytes: 0 } })
    return route.fulfill({ status: 400, json: {} })
  })
  await page.route(`**/api/user-files/${manifestId}`, route => route.fulfill({ status: 500, json: { error: { message: 'never-render-private-locator' } } }))
  await page.goto('/?view=settings'); await seedJobs(page)
  const section = page.getByTestId('private-cloud-deletions')
  await section.getByRole('button', { name: '重新读取删除任务' }).click()
  await expect(section).toContainText('My pending file'); await expect(section).not.toContainText('Other account private file')
  await section.getByRole('button', { name: '重试删除 My pending file' }).click()
  await expect(section.getByRole('button', { name: '重试删除 My pending file' })).toBeEnabled()
  await expect(section).not.toContainText('never-render-private-locator')
  await page.reload(); await expect(section).toContainText('My pending file')
  await page.evaluate(other => {
    localStorage.setItem('wor-library.auth.session', JSON.stringify({ accessToken: 'synthetic-other', refreshToken: 'synthetic-refresh', user: { id: other, isAnonymous: false } }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'wor-library.auth.session' }))
  }, other)
  await expect(section).toContainText('Other account private file'); await expect(section).not.toContainText('My pending file')
})

test('failed local deletion journal prevents an untracked remote DELETE', async ({ page }) => {
  await account(page)
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = (name: string, version?: number) => {
      if (name === 'worlibrary-private-deletions') throw new Error('synthetic storage failure')
      return version === undefined ? open(name) : open(name, version)
    }
  })
  let deletes = 0
  await page.route('**/rest/v1/rpc/**', route => route.fulfill({ json: route.request().url().endsWith('/list_private_file_cleanup_jobs') ? [remoteJob] : { enabled: false, consented: true, quotaBytes: 1073741824, usedBytes: 0, reservedBytes: 0 } }))
  await page.route(`**/api/user-files/${manifestId}`, route => { deletes++; return route.fulfill({ status: 202, json: { status: 'deleted' } }) })
  await page.goto('/?view=settings')
  const section = page.getByTestId('private-cloud-deletions')
  await section.getByRole('button', { name: '重试删除 original.pdf' }).click()
  await expect(section.getByRole('button', { name: '重试删除 original.pdf' })).toBeEnabled()
  await expect(section).toContainText('删除尚未确认，请重试。'); expect(deletes).toBe(0)
})

test('book-menu cloud deletion persists its retry entry and retains the local original', async ({ page }) => {
  await account(page)
  const encoded = await readFile('tests/fixtures/reader-fixture.epub.b64', 'utf8')
  const bytes = Buffer.from(encoded.trim(), 'base64')
  let cloudEdition = ''; let remote: typeof remoteJob[] = []
  await page.route('**/rest/v1/user_file_manifests?**', route => route.fulfill({ json: cloudEdition ? [{ id: manifestId, edition_id: cloudEdition, file_name: 'reader-fixture.epub', media_type: 'application/epub+zip', plaintext_size: bytes.length, plaintext_hash: 'a'.repeat(64), upload_state: 'active', deleted_at: null }] : [] }))
  await page.route('**/rest/v1/rpc/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)
    if (name === 'list_private_file_cleanup_jobs') return route.fulfill({ json: remote })
    if (name === 'get_private_file_library_state') return route.fulfill({ json: { enabled: false, consented: false, quotaBytes: 1073741824, usedBytes: bytes.length, reservedBytes: 0 } })
    return route.fulfill({ status: 400, json: {} })
  })
  await page.route(`**/api/user-files/${manifestId}`, route => {
    remote = [{ manifestId, editionId: cloudEdition, fileName: 'reader-fixture.epub' }]
    return route.fulfill({ status: 202, json: { status: 'deleting' } })
  })
  await page.goto('/')
  await page.getByTestId('library-import').setInputFiles({ name: 'reader-fixture.epub', mimeType: 'application/epub+zip', buffer: bytes })
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
  cloudEdition = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('wor-library'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const books = await new Promise<Array<{ editionId: string }>>((resolve, reject) => { const request = db.transaction('books').objectStore('books').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    db.close(); return books[0].editionId
  })
  await page.reload()
  await page.getByRole('heading', { name: 'Reader Fixture' }).click({ button: 'right' })
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('menuitem', { name: '从云端删除', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click()
  const section = page.getByTestId('private-cloud-deletions')
  await expect(section.getByRole('button', { name: '重试删除 Reader Fixture' })).toBeVisible()
  await page.reload()
  await expect(section.getByRole('button', { name: '重试删除 Reader Fixture' })).toBeVisible()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '书库', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reader Fixture' })).toBeVisible()
})
