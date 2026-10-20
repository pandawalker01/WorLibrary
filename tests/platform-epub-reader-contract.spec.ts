import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('protected EPUB reader keeps content in-memory and exposes localized keyboard navigation', async () => {
  const component = await readFile('src/components/PlatformEpubReader.tsx', 'utf8')
  const client = await readFile('src/lib/platform-reader.ts', 'utf8')

  expect(component).toContain('fetchProtectedEpubContent(editionId, accessToken)')
  expect(component).toContain('ePub(content.bytes)')
  expect(component).toContain('aria-keyshortcuts="ArrowLeft ArrowRight"')
  expect(component).toContain('ui.readingSurface')
  expect(component).toContain("turnPage('next')")
  expect(component).toContain('rendition?.destroy()')
  expect(component).toContain('publication?.destroy()')
  expect(component).not.toContain('saveBook')
  expect(component).not.toContain('localStorage')
  expect(component).not.toContain('indexedDB')
  expect(component).not.toContain('URL.createObjectURL')

  expect(client).toContain("cache: 'no-store'")
  expect(client).toContain('Authorization: `Bearer ${accessToken}`')
  expect(client).toContain("contentType !== 'application/epub+zip'")
  expect(client).not.toContain('r2ObjectKey')
})
