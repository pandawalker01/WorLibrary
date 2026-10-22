import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const storagePath = new URL('../src/lib/storage.ts', import.meta.url)

test('remote shadow re-import accepts only a user-selected matching local EPUB/PDF', async () => {
  const source = await readFile(storagePath, 'utf8')
  const type = source.slice(
    source.indexOf('export type RemoteBookMetadataShadowReimport ='),
    source.indexOf('export type RemoteBookMetadataShadowReimportInput'),
  )
  const input = source.slice(
    source.indexOf('export type RemoteBookMetadataShadowReimportInput'),
    source.indexOf('export type LibraryBackup'),
  )
  const implementation = source.slice(
    source.indexOf('export async function reimportRemoteBookMetadataShadow'),
    source.indexOf('/** Correct shelf metadata locally'),
  )

  expect(type).toContain("'editionId'")
  expect(type).toContain("'needsReimport'")
  expect(type).toContain("'location'")
  expect(type).toContain("'fileName'")
  expect(type).toContain("'fileSize'")
  expect(type).not.toMatch(/userId|revision|sequence|\bkey\b|body/i)
  expect(input).toContain('file: File')
  expect(input).toContain('shadow: RemoteBookMetadataShadowReimport')
  expect(implementation).toContain("file.name !== shadow.fileName")
  expect(implementation).toContain('file.size !== shadow.fileSize')
  expect(implementation).toContain('shadow.needsReimport !== true')
  expect(implementation).toContain("['epub', 'pdf'].includes(extension)")
  expect(implementation).toContain('book.editionId === shadow.editionId')
  expect(implementation).toContain('book.fileName === file.name && book.fileSize === file.size')
  expect(implementation).toContain('editionId: shadow.editionId')
  expect(implementation).toContain('location: shadow.location')
  expect(implementation).not.toMatch(/fetch\(|URL\.|objectURL|userId|revision|sequence|\bbody\b/i)
})
