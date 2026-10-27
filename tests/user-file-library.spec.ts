import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { USER_FILE_CHUNK_SIZE, USER_FILE_MAX_BYTES, assertOwnedEditionId, chunkRange, describeUserFile } from '../src/lib/user-file-library'

test('private user file migration keeps manifests user-scoped and object keys service-only', async () => {
  const migration = await readFile('supabase/migrations/0014_private_user_file_library.sql', 'utf8')
  for (const table of ['user_file_manifests', 'user_file_chunks', 'user_storage_quotas']) expect(migration).toContain(`create table if not exists public.${table}`)
  expect(migration).toContain('alter table public.user_file_manifests enable row level security')
  expect(migration).toContain("media_type in ('application/epub+zip', 'application/pdf')")
  expect(migration).toContain("encryption_version text not null default 'managed-v1'")
  expect(migration).toContain("revoke all on public.user_file_manifests, public.user_file_chunks, public.user_storage_quotas from anon, authenticated")
  expect(migration).not.toContain('grant select on public.user_file_chunks')
})

test('user file validation accepts only bounded EPUB/PDF files and deterministic chunk ranges', () => {
  const file = { name: 'book.epub', type: 'application/epub+zip', size: USER_FILE_CHUNK_SIZE + 3, slice: Blob.prototype.slice }
  expect(describeUserFile(file)).toMatchObject({ mediaType: 'application/epub+zip', chunkCount: 2, chunkSize: USER_FILE_CHUNK_SIZE })
  expect(chunkRange(file, 0)).toEqual({ start: 0, end: USER_FILE_CHUNK_SIZE })
  expect(chunkRange(file, 1)).toEqual({ start: USER_FILE_CHUNK_SIZE, end: USER_FILE_CHUNK_SIZE + 3 })
  expect(() => describeUserFile({ ...file, type: 'application/zip' })).toThrow('仅支持 EPUB 或 PDF')
  expect(() => describeUserFile({ ...file, size: USER_FILE_MAX_BYTES + 1 })).toThrow('文件大小超出')
  expect(() => assertOwnedEditionId('not-a-uuid')).toThrow('版本 ID 无效')
})
