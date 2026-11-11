import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { createUserFileConsentClient } from '../src/lib/user-file-consent'

const session = { accessToken: 'test-token', refreshToken: 'test-refresh', user: { id: '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de', isAnonymous: false } }
const state = { enabled: false, consented: false, quotaBytes: 1024, usedBytes: 0, reservedBytes: 0 }
const config = { url: 'https://supabase.example', anonKey: 'public-test-key' }

test('consent is explicit and uses dedicated account-bound RPCs without owner IDs or file data', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const client = createUserFileConsentClient(session, { ...config, fetch: async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) })
    return Response.json(calls.length === 1 ? state : { ...state, enabled: true, consented: true })
  } })
  await expect(client.getState()).resolves.toEqual(state)
  await expect(client.setEnabled(true)).resolves.toEqual({ ...state, enabled: true, consented: true })
  expect(calls).toEqual([
    { url: 'https://supabase.example/rest/v1/rpc/get_private_file_library_state', body: '{}' },
    { url: 'https://supabase.example/rest/v1/rpc/set_private_file_library_enabled', body: '{"p_enabled":true}' },
  ])
  expect(JSON.stringify(calls)).not.toMatch(/userId|editionId|metadata|fileName|blob|objectKey/)
})

test('anonymous and invalidated accounts cannot start a consent request', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => { calls += 1; return Response.json(state) }
  expect(() => createUserFileConsentClient({ ...session, user: { ...session.user, isAnonymous: true } }, { ...config, fetch })).toThrow('STABLE_ACCOUNT_REQUIRED')
  const client = createUserFileConsentClient(session, { ...config, fetch, isCurrent: () => false })
  await expect(client.setEnabled(true)).rejects.toThrow('PRIVATE_FILE_SESSION_INVALIDATED')
  expect(calls).toBe(0)
})

test('account invalidation during a request discards its result', async () => {
  let current = true
  const client = createUserFileConsentClient(session, { ...config, isCurrent: () => current, fetch: async () => { current = false; return Response.json(state) } })
  await expect(client.getState()).rejects.toThrow('PRIVATE_FILE_SESSION_INVALIDATED')
})

test('unsafe state and unconsented enable responses fail closed', async () => {
  for (const value of [{ ...state, enabled: true }, { ...state, usedBytes: -1 }, { ...state, objectKey: 'private/path' }]) {
    const client = createUserFileConsentClient(session, { ...config, fetch: async () => Response.json(value) })
    await expect(client.getState()).rejects.toThrow('INVALID_PRIVATE_FILE_STATE')
  }
})

test('forward consent migration keeps browser writes narrow and file admission service-only', async () => {
  const sql = (await readFile('supabase/migrations/0018_private_file_consent.sql', 'utf8')).replaceAll('\r\n', '\n')
  expect(sql).toContain('alter table public.user_file_library_preferences enable row level security')
  expect(sql).toContain('revoke all on public.user_file_library_preferences from public, anon, authenticated')
  expect(sql).toContain('v_user_id uuid := public.require_private_file_account()')
  expect(sql).toContain("auth.jwt()->>'is_anonymous'")
  expect(sql).toContain('set_private_file_library_enabled(p_enabled boolean)')
  expect(sql).toContain('accepted_at = coalesce(user_file_library_preferences.accepted_at, excluded.accepted_at)')
  expect(sql).toContain("raise exception 'private file consent required'")
  expect(sql).toContain('and user_id = p_user_id and deleted_at is null')
  expect(sql).toContain('pg_advisory_xact_lock')
  expect(sql).toContain('v_manifest.file_name <> p_file_name')
  expect(sql).toContain("if v_manifest.upload_state = 'deleted' then")
  expect(sql).not.toContain('and expires_at > now()')
  expect(sql).not.toMatch(/grant execute on function public.begin_user_file_upload[^;]+to authenticated/)
  expect(sql).not.toMatch(/\bp_metadata\b|\bp_settings\b|\bp_blob\b|\bp_file_bytes\b|alter function public.apply_/)
})
