import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('device removal never sends global metadata tombstones', async () => {
  const source = (await readFile('src/App.tsx', 'utf8')).replaceAll('\r\n', '\n')
  const removal = source.slice(source.indexOf('async function removeBook('), source.indexOf('async function deleteCloudCopy'))
  expect(removal).toContain('await deleteBook(book as StoredBook)')
  expect(removal).not.toMatch(/queueHighlightMetadataSync|queueEditionMetadataDeleteSync|operation: 'delete'/)
  expect(removal).toContain('ui.cloudDeviceRemoveConfirm')
  expect(removal).toContain('catch { toast(ui.actionFailed) }')
  const intent = await readFile('src/lib/metadata-sync-edition-intent.ts', 'utf8')
  expect(intent).toContain("'delete'")
})
