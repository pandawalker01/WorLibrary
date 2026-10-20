import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('metadata sync foundation is user-scoped, tombstoned, and file-free', async () => {
  const migration = await readFile('supabase/migrations/0008_metadata_sync_foundation.sql', 'utf8')

  for (const table of ['user_setting_values', 'sync_tombstones', 'sync_changes', 'reading_events', 'reading_statistics']) {
    expect(migration).toContain(`create table if not exists public.${table}`)
    expect(migration).toContain(`alter table public.${table} enable row level security`)
  }
  expect(migration).toContain('add column if not exists client_instance_id uuid')
  expect(migration).toContain('add column if not exists revision bigint not null default 0')
  expect(migration).toContain("entity_type in ('work', 'edition', 'reading_progress', 'highlight', 'library_item', 'setting')")
  expect(migration).toContain("purge_after timestamptz not null default (now() + interval '90 days')")
  expect(migration).toContain('unique (user_id, mutation_id)')
  expect(migration).toContain('create or replace function public.register_sync_device')
  expect(migration).toContain("if auth.uid() is null then raise exception 'authentication required'")
  expect(migration).toContain('revoke insert, update, delete on public.user_setting_values, public.sync_tombstones, public.sync_changes, public.reading_events, public.reading_statistics from authenticated')
  expect(migration).toContain('grant execute on function public.register_sync_device(uuid, text, text, jsonb) to authenticated')
  expect(migration).not.toContain('book-blobs')
  expect(migration).not.toContain('object_key')
})
