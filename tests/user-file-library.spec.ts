import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { USER_FILE_CHUNK_SIZE, USER_FILE_MAX_BYTES, assertOwnedEditionId, chunkRange, createUserFileClient, describeUserFile } from '../src/lib/user-file-library'

test('private user file migration keeps manifests user-scoped and object keys service-only', async () => {
  const migration = await readFile('supabase/migrations/0014_private_user_file_library.sql', 'utf8')
  for (const table of ['user_file_manifests', 'user_file_chunks', 'user_storage_quotas']) expect(migration).toContain(`create table if not exists public.${table}`)
  expect(migration).toContain('alter table public.user_file_manifests enable row level security')
  expect(migration).toContain("media_type in ('application/epub+zip', 'application/pdf')")
  expect(migration).toContain("encryption_version text not null default 'managed-v1'")
  expect(migration).toContain("revoke all on public.user_file_manifests, public.user_file_chunks, public.user_storage_quotas from anon, authenticated")
  expect(migration).not.toContain('grant select on public.user_file_chunks')
})

test('private file gateway migration uses service-only transactions, quota reservation, and 30-day deletion tombstones', async () => {
  const migration = await readFile('supabase/migrations/0015_private_user_file_gateway.sql', 'utf8')
  expect(migration).toContain('create table if not exists public.user_file_tombstones')
  expect(migration).toContain("now() + interval '30 days'")
  expect(migration).toContain('create or replace function public.begin_user_file_upload')
  expect(migration).toContain('create or replace function public.complete_user_file_upload')
  expect(migration).toContain('create or replace function public.request_user_file_delete')
  expect(migration).toContain('grant execute on function public.begin_user_file_upload')
  expect(migration).not.toContain('grant execute on function public.begin_user_file_upload(uuid, uuid, text, text, bigint, integer, integer, uuid, text) to authenticated')
})

test('finishing deletion releases only the quota bucket originally charged and is idempotent', async () => {
  const migration = await readFile('supabase/migrations/0015_private_user_file_gateway.sql', 'utf8')
  const finish = migration.slice(migration.indexOf('create or replace function public.finish_user_file_delete'), migration.indexOf('create or replace function public.reap_expired_user_file_uploads'))
  expect(finish).toContain("if v_manifest.upload_state = 'deleted' then return; end if;")
  expect(finish).toContain('if v_manifest.reserved_bytes > 0 then')
  expect(finish).toContain('reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes)')
  expect(finish).toContain('used_bytes = greatest(0, used_bytes - v_manifest.plaintext_size)')
  expect(finish).not.toContain('used_bytes = greatest(0, used_bytes - (select plaintext_size')
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

test('cloud restore downloads only authenticated chunks and rejects a partial final file', async () => {
  const requests: string[] = []
  const session = { accessToken: 'short-lived-token', user: { id: 'account-a', isAnonymous: false } }
  const client = createUserFileClient(session, {
    url: 'https://supabase.example',
    anonKey: 'public-anon-key',
    gatewayUrl: 'https://app.example',
    fetch: async (input) => {
      requests.push(String(input))
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    },
  })
  await expect(client.restore({ id: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', fileName: 'book.pdf', mediaType: 'application/pdf', size: 4 })).rejects.toThrow('分块校验失败')
  expect(requests).toEqual(['https://app.example/api/user-files/018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de/chunks/0'])
  expect(requests[0]).not.toContain('bucket')
  expect(requests[0]).not.toContain('r2')
})
