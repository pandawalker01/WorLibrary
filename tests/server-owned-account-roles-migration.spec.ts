import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('account roles are server-owned, audited, and unavailable to browser sessions', async () => {
  const migration = await readFile('supabase/migrations/0010_server_owned_account_roles.sql', 'utf8')

  expect(migration).toContain('create table if not exists public.account_role_assignments')
  expect(migration).toContain("role in ('community_moderator', 'support_agent', 'platform_admin')")
  expect(migration).toContain('create table if not exists public.account_role_audit_log')
  expect(migration).toContain("action in ('granted', 'revoked')")
  expect(migration).toContain('alter table public.account_role_assignments enable row level security')
  expect(migration).toContain('alter table public.account_role_audit_log enable row level security')
  expect(migration).toContain('revoke all on table public.account_role_assignments from public, anon, authenticated')
  expect(migration).toContain('revoke all on table public.account_role_audit_log from public, anon, authenticated')
  expect(migration).toContain('create or replace function public.set_server_account_role')
  expect(migration).toContain("raise exception 'actor reference is required'")
  expect(migration).toContain("raise exception 'active server account role not found'")
  expect(migration).toContain("'granted'")
  expect(migration).toContain("'revoked'")
  expect(migration).toContain('revoke all on function public.set_server_account_role(uuid, text, boolean, text, uuid, text) from public, anon, authenticated')
  expect(migration).toContain('grant execute on function public.set_server_account_role(uuid, text, boolean, text, uuid, text) to service_role')

  expect(migration).not.toContain('grant select on public.account_role_assignments')
  expect(migration).not.toContain('grant insert on public.account_role_assignments')
  expect(migration).not.toContain('profiles.role')
  expect(migration).not.toContain('user_settings.role')
  expect(migration).not.toContain('raw_app_meta_data')
})
