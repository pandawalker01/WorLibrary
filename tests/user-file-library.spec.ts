import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { USER_FILE_CHUNK_SIZE, USER_FILE_MAX_BYTES, assertOwnedEditionId, chunkRange, createUserFileClient, describeUserFile } from '../src/lib/user-file-library'

const appPath = new URL('../src/App.tsx', import.meta.url)

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

test('forward migration labels P0 as private storage rather than application-layer encryption', async () => {
  const migration = await readFile('supabase/migrations/0017_private_user_file_storage_and_quota_fix.sql', 'utf8')
  expect(migration).toContain('rename column encryption_version to storage_mode')
  expect(migration).toContain("alter column storage_mode set default 'private-r2-v1'")
  expect(migration).toContain('does not claim application-layer encryption')
})

test('forward deletion migration releases used quota only for an active-file charge', async () => {
  const migration = await readFile('supabase/migrations/0017_private_user_file_storage_and_quota_fix.sql', 'utf8')
  const finish = migration.slice(migration.indexOf('create or replace function public.finish_user_file_delete'), migration.indexOf('create or replace function public.reap_expired_user_file_uploads'))
  expect(finish).toContain("if not found or v_manifest.upload_state = 'deleted' then return; end if;")
  expect(finish).toContain("if v_manifest.upload_state = 'active' then\n    v_quota_bucket := 'used';")
  expect(finish).toContain("elsif v_manifest.upload_state in ('uploading', 'verifying') then\n    v_quota_bucket := 'reserved';")
  expect(finish).toContain("elsif v_manifest.upload_state = 'deleting' then\n    v_quota_bucket := v_manifest.delete_quota_bucket;")
  expect(finish).toContain('used_bytes = greatest(0, used_bytes - v_manifest.plaintext_size)')
  expect(finish).toContain('reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes)')
})

test('forward deletion migration snapshots active charges and keeps repeated complete/delete requests idempotent', async () => {
  const migration = await readFile('supabase/migrations/0017_private_user_file_storage_and_quota_fix.sql', 'utf8')
  const requestDelete = migration.slice(migration.indexOf('create or replace function public.request_user_file_delete'), migration.indexOf('create or replace function public.finish_user_file_delete'))
  const complete = migration.slice(migration.indexOf('create or replace function public.complete_user_file_upload'), migration.indexOf('create or replace function public.request_user_file_delete'))
  expect(requestDelete).toContain("if v_manifest.upload_state not in ('deleted', 'deleting') then")
  expect(requestDelete).toContain("case when v_manifest.upload_state = 'active' then 'used' else 'reserved' end")
  expect(complete).toContain("if v_manifest.upload_state = 'active' then return true; end if;")
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
  await expect(client.restore({ id: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', fileName: 'book.pdf', mediaType: 'application/pdf', size: 4, plaintextHash: 'a'.repeat(64) })).rejects.toThrow('分块校验失败')
  expect(requests).toEqual(['https://app.example/api/user-files/018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de/chunks/0'])
  expect(requests[0]).not.toContain('bucket')
  expect(requests[0]).not.toContain('r2')
})

test('a same-size corrupted cached recovery chunk is cleared so retry downloads and restores the verified file', async () => {
  let cached: Blob | undefined = new Blob([new Uint8Array([9, 9, 9, 9])])
  const calls: string[] = []; let cleared = 0
  const session = { accessToken: 'short-lived-token', user: { id: 'account-a', isAnonymous: false } }
  const client = createUserFileClient(session, {
    url: 'https://supabase.example', anonKey: 'public-anon-key', gatewayUrl: 'https://app.example',
    fetch: async (input) => { calls.push(String(input)); return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }) },
    recoveryCache: { get: async () => cached, put: async (_manifestId, _index, chunk) => { cached = chunk }, clear: async () => { cached = undefined; cleared += 1 } },
  })
  const manifest = { id: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', fileName: 'book.pdf', mediaType: 'application/pdf' as const, size: 4, plaintextHash: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }
  await expect(client.restore(manifest)).rejects.toThrow('完整性校验失败')
  expect(calls).toEqual([])
  expect(cleared).toBe(1)
  await expect(client.restore(manifest)).resolves.toMatchObject({ name: 'book.pdf', size: 4, type: 'application/pdf' })
  expect(calls).toEqual(['https://app.example/api/user-files/018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de/chunks/0'])
  expect(cleared).toBe(2)
})

test('a failed cloud hash check cannot invoke the local shelf importer', async () => {
  const source = await readFile(appPath, 'utf8')
  const recovery = source.slice(source.indexOf('async function restoreCloudShadow'), source.indexOf('function removeBookFromDevice'))
  expect(recovery.indexOf('await (await createCloudFileClient(current)).restore(manifest)')).toBeLessThan(recovery.indexOf('await reimportRemoteBookMetadataShadow'))
  expect(recovery).toContain('catch (error)')
})
