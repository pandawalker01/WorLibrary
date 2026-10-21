import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('controlled metadata sync RPCs are authenticated, idempotent, revisioned, and file-free', async () => {
  const migration = await readFile('supabase/migrations/0009_controlled_metadata_sync_rpc.sql', 'utf8')

  expect(migration).toContain('create or replace function public.apply_metadata_sync_change')
  expect(migration).toContain('create or replace function public.pull_metadata_sync_changes')
  expect(migration).toContain('create or replace function public.controlled_sync_payload_has_forbidden_key')
  expect(migration).toMatch(/controlled_sync_payload_has_forbidden_key[\s\S]*?security definer/)
  expect(migration).toMatch(/assert_controlled_sync_payload[\s\S]*?security definer/)
  expect(migration).toContain("if v_user_id is null then raise exception 'authentication required'")
  expect(migration).toContain('where id = p_device_id and user_id = v_user_id and revoked_at is null')
  expect(migration).toContain("raise exception 'active owned device required'")
  expect(migration).toContain('where user_id = v_user_id and mutation_id = p_operation_id')
  expect(migration).toContain("raise exception 'operation id was already used for another mutation'")
  expect(migration).toContain("raise exception 'stale base revision'")
  expect(migration).toContain("raise exception 'deleted entity cannot be resurrected; create a new id'")
  expect(migration).toContain("raise exception 'entity id belongs to another account'")
  expect(migration).toContain("raise exception 'published platform edition required'")
  expect(migration).toContain('insert into public.sync_tombstones')
  expect(migration).toContain('add column if not exists payload jsonb not null default')
  expect(migration).toContain('where c.user_id = auth.uid() and c.sequence > p_after_sequence')
  expect(migration).toContain('p_limit not between 1 and 200')
  expect(migration).toContain('grant execute on function public.apply_metadata_sync_change')
  expect(migration).toContain('grant execute on function public.pull_metadata_sync_changes')

  for (const forbiddenField of ['book_blob', 'object_key', 'content_url', 'signed_url', 'raw_content']) {
    expect(migration).toContain(`'${forbiddenField}'`)
  }
  expect(migration).toContain("'book-blobs'")
  expect(migration).not.toContain('user_file_chunks')
  expect(migration).not.toContain('PLATFORM_CONTENT')
})
