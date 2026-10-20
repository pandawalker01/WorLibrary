import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('dynamic platform delivery and staff roles remain server-only', async () => {
  const migration = await readFile('supabase/migrations/0007_platform_delivery_resolution_and_staff_roles.sql', 'utf8')

  expect(migration).toContain('create table if not exists public.platform_staff_roles')
  expect(migration).toContain("role in ('content_reviewer', 'content_publisher', 'content_admin')")
  expect(migration).toContain('alter table public.platform_staff_roles enable row level security')
  expect(migration).toContain('revoke all on public.platform_staff_roles from anon, authenticated')
  expect(migration).toContain('create or replace function public.resolve_platform_reader_delivery')
  expect(migration).toContain("asset.storage_provider = 'r2'")
  expect(migration).toContain("asset.media_type in ('application/epub+zip', 'application/pdf')")
  expect(migration).toContain("policy_candidate.territory_code in (v_territory_code, 'ZZ')")
  expect(migration).toContain('not policy.requires_entitlement')
  expect(migration).toContain('entitlement.user_id = p_user_id')
  expect(migration).toContain('revoke all on function public.resolve_platform_reader_delivery(uuid, uuid, text) from public, anon, authenticated')
  expect(migration).toContain('grant execute on function public.resolve_platform_reader_delivery(uuid, uuid, text) to service_role')
  expect(migration).toContain('update public.access_policies')
  expect(migration).toContain('set published_at = coalesce(published_at, now()), withdrawn_at = null')
  expect(migration).not.toContain('grant select on public.platform_staff_roles')
})
