import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('platform catalog migration separates private assets, user shelves, and server-managed entitlements', async () => {
  const migration = await readFile('supabase/migrations/0005_platform_catalog_and_library.sql', 'utf8')

  for (const table of ['catalog_works', 'catalog_editions', 'content_assets', 'access_policies', 'user_library_items', 'user_entitlements']) {
    expect(migration).toContain(`create table if not exists public.${table}`)
    expect(migration).toContain(`alter table public.${table} enable row level security`)
  }

  expect(migration).toContain("source_type in ('local_import', 'platform', 'external_catalog')")
  expect(migration).toContain("access_mode in ('download', 'stream', 'preview', 'external_reader', 'catalog_only')")
  expect(migration).toContain('revoke all on public.catalog_works, public.catalog_editions, public.content_assets')
  expect(migration).toContain('grant select on public.catalog_works, public.catalog_editions, public.access_policies')
  expect(migration).toContain('create policy "published catalog works are readable"')
  expect(migration).toContain('create policy "own user library items can be added"')
  expect(migration).toContain('grant update (shelf_status, metadata) on public.user_library_items')
  expect(migration).toContain('create policy "own user entitlements are readable"')
  expect(migration).not.toContain('grant select on public.content_assets')
  expect(migration).not.toContain('grant insert, update, delete on public.user_entitlements to authenticated')
})
