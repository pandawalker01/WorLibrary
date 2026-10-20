import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('platform content operations keep assets and rights server-managed and auditable', async () => {
  const migration = await readFile('supabase/migrations/0006_platform_content_operations.sql', 'utf8')

  for (const table of ['content_licenses', 'content_source_records', 'platform_content_audit_log']) {
    expect(migration).toContain(`create table if not exists public.${table}`)
    expect(migration).toContain(`alter table public.${table} enable row level security`)
  }

  expect(migration).toContain("expected_sha256 text not null check (expected_sha256 ~ '^[a-f0-9]{64}$')")
  expect(migration).toContain("review_status in ('pending', 'verified', 'rejected')")
  expect(migration).toContain("status in ('pending', 'active', 'expired', 'revoked')")
  expect(migration).toContain('add column if not exists source_record_id')
  expect(migration).toContain('add column if not exists license_id')
  expect(migration).toContain('create or replace function public.publish_platform_catalog_edition')
  expect(migration).toContain('create or replace function public.withdraw_platform_catalog_edition')
  expect(migration).toContain('create or replace function public.revoke_platform_content_license')
  expect(migration).toContain("a.sha256 = s.expected_sha256")
  expect(migration).toContain("s.review_status = 'verified'")
  expect(migration).toContain("l.status = 'active'")
  expect(migration).toContain('revoke all on public.content_licenses, public.content_source_records, public.platform_content_audit_log from anon, authenticated')
  expect(migration).toContain('revoke all on function public.publish_platform_catalog_edition(uuid, text) from public, anon, authenticated')
  expect(migration).toContain('grant execute on function public.publish_platform_catalog_edition(uuid, text) to service_role')
  expect(migration).not.toContain('grant select on public.content_assets')
})
