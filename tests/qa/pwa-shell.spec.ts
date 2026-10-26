import { test, expect } from '@playwright/test'

test('production shell exposes an installable manifest and registers a service worker', async ({ page }) => {
  await page.goto('/')

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest')
    return response.json() as Promise<{ display: string; start_url: string; icons: Array<{ src: string }> }>
  })
  expect(manifest.display).toBe('standalone')
  expect(manifest.start_url).toBe('/')
  expect(manifest.icons).toContainEqual(expect.objectContaining({ src: '/icon.svg' }))

  const worker = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return null
    const registration = await navigator.serviceWorker.ready
    return { scope: registration.scope, active: Boolean(registration.active) }
  })
  expect(worker).toEqual(expect.objectContaining({ active: true }))
  expect(worker?.scope).toContain('/')
})

test('offline event keeps the local-reader boundary visible to users', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByText('离线可读')).toBeVisible()
  await context.setOffline(true)
  // Playwright's network emulation does not consistently dispatch the DOM
  // event that browsers emit when the platform connectivity state changes.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByRole('status')).toContainText('当前离线：已导入的本地书籍仍可阅读')
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByText('离线可读')).toBeVisible()
})
