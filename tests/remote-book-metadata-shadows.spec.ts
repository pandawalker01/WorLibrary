import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const componentPath = new URL('../src/components/RemoteBookMetadataShadows.tsx', import.meta.url)
const i18nPath = new URL('../src/lib/i18n.ts', import.meta.url)

test('remote shadow shelf offers a gateway restore only for a caller-confirmed private manifest', async () => {
  const [source, i18n] = await Promise.all([readFile(componentPath, 'utf8'), readFile(i18nPath, 'utf8')])

  expect(source).toContain('copy[uiLocale]')
  expect(source).toContain('remoteShelfReimportStatus')
  expect(source).toContain('remoteShelfReimportCopy')
  expect(source).toContain('remoteShelfReimportAction')
  expect(i18n).toContain("remoteShelfReimportStatus: '需重新导入原书'")
  expect(i18n).toContain("remoteShelfReimportCopy: 'This book’s metadata and reading progress are here")
  expect(source).toContain('onReimport(shadow)')
  expect(source).toContain('cloudEditionIds')
  expect(source).toContain('onRestore?.(shadow)')
  expect(source).toContain('cloudRecoverable')
  expect(source).toContain('cloudRestore')
  expect(i18n).toContain("cloudRecoverable: '云端可恢复'")
  expect(i18n).toContain("cloudRecoverable: 'Recoverable from cloud'")
  expect(source).not.toContain('onOpen')
  expect(source).not.toContain('location')
  expect(source).not.toContain('fileName')
  expect(source).not.toContain('fileType')
  expect(source).not.toContain('fileSize')
  expect(source).not.toContain('coverImage')
  expect(source).not.toContain('URL')
})
