import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('private highlight sync is authenticated, device-bound, and accepts only excerpt fields', async () => {
  const migration = await readFile('supabase/migrations/0012_private_highlight_sync_rpc.sql', 'utf8')

  expect(migration).toContain('create or replace function public.apply_private_highlight_sync_change')
  expect(migration).toMatch(/apply_private_highlight_sync_change[\s\S]*?security definer/)
  expect(migration).toContain("if v_user_id is null then\n    raise exception 'authentication required'")
  expect(migration).toContain('where id = p_device_id and user_id = v_user_id and revoked_at is null')
  expect(migration).toContain("raise exception 'active owned device required'")
  expect(migration).toContain("p_operation not in ('upsert', 'delete')")
  expect(migration).toContain("raise exception 'highlight delete cannot contain a payload'")
  expect(migration).toContain("'edition_id', p_edition_id")
  expect(migration).toContain("'text', p_text")
  expect(migration).toContain("'location', p_location")
  expect(migration).toContain("'note', nullif(p_note, '')")
  expect(migration).toContain("'color', v_color")
  expect(migration).toContain("'is_highlighted', p_is_highlighted")
  expect(migration).toContain('add column if not exists is_highlighted boolean not null default true')
  expect(migration).toContain("raise exception 'highlight edition, text, location, and display state are required'")
  expect(migration).toContain("p_is_highlighted is not null")
  expect(migration).toContain("p_is_highlighted")
  expect(migration).toContain("v_color not in ('gold', 'rose', 'blue')")
  expect(migration).toContain("'highlight', p_highlight_id::text")
  expect(migration).toContain("v_payload - 'is_highlighted'")
  expect(migration).toContain('set is_highlighted = p_is_highlighted')
  expect(migration).toContain('set payload = v_payload')
  expect(migration).toContain('revoke all on function public.apply_private_highlight_sync_change')
  expect(migration).toContain('to authenticated')

  const payloadStart = migration.indexOf('v_payload := jsonb_strip_nulls')
  const payloadEnd = migration.indexOf('));', payloadStart) + 3
  const payloadBlock = migration.slice(payloadStart, payloadEnd)
  for (const excludedField of ['book_id', 'file_name', 'file_type', 'file_size', 'cover', 'object_key', 'content_url', 'signed_url', 'blob']) {
    expect(payloadBlock).not.toContain(excludedField)
  }
})
