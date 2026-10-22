import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('reading progress returns only the complete record that was committed to local storage', async () => {
  const source = await readFile('src/lib/storage.ts', 'utf8')
  const epubReader = await readFile('src/components/EpubReader.tsx', 'utf8')
  const pdfReader = await readFile('src/components/PdfReader.tsx', 'utf8')
  const implementation = source.slice(source.indexOf('export async function saveReadingProgress'), source.indexOf('export async function saveHighlight'))

  expect(implementation).toContain('Promise<StoredBook | null>')
  expect(implementation).toContain('if (!current) return null')
  expect(implementation).toContain('await transaction(\'books\', \'readwrite\', (store) => store.put(next))')
  expect(implementation).toContain('return next')
  expect(implementation).toContain('progress: Math.max(0, Math.min(100, progress))')
  expect(epubReader).toContain('onProgress(progress, cfi, persisted)')
  expect(epubReader).not.toContain('onProgress(progress, cfi)\n')
  expect(pdfReader).toContain('onProgress(progress, location, persisted)')
  expect(pdfReader).toContain('useRef<Promise<StoredBook | null>>(Promise.resolve(null))')
})
