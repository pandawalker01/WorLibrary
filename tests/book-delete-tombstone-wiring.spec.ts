import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('local book deletion queues account-scoped excerpt tombstones before an identity-only edition tombstone', async () => {
  const source = await readFile('src/App.tsx', 'utf8')

  expect(source).toContain('const queueEditionMetadataDeleteSync')
  expect(source).toContain("operation: 'delete'")
  expect(source).toContain('editionId,\n        operation: \'delete\'')
  expect(source).toContain('await deleteBook(book as StoredBook)')
  expect(source).toContain("await queueHighlightMetadataSync(highlight, 'delete', book.editionId)")
  expect(source).toContain('await queueEditionMetadataDeleteSync(book.editionId)')

  const localDelete = source.indexOf('await deleteBook(book as StoredBook)')
  const highlightDelete = source.indexOf("await queueHighlightMetadataSync(highlight, 'delete', book.editionId)")
  const editionDelete = source.indexOf('await queueEditionMetadataDeleteSync(book.editionId)')
  expect(localDelete).toBeGreaterThan(-1)
  expect(highlightDelete).toBeGreaterThan(localDelete)
  expect(editionDelete).toBeGreaterThan(highlightDelete)
})
