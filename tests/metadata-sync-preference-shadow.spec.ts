import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { READER_LAYOUT_SETTING_KEY, READING_LANGUAGE_SETTING_KEY } from '../src/lib/metadata-sync-preference-intent'
import { clearAccountReaderPreference, loadAccountReaderPreferences, persistAccountReaderPreference } from '../src/lib/account-reader-preferences'
import { projectRemoteReaderPreferenceChange } from '../src/lib/metadata-sync-preference-shadow'

const ids = { user: 'stable-user', device: '9c025db3-12bc-4c7b-8be7-b6d0bd658fba', operation: '31e5ed3a-7258-4f7f-a53d-5d43a02f4aec' }

function change(overrides: Record<string, unknown> = {}) {
  return {
    sequence: 3, device_id: ids.device, operation_id: ids.operation,
    entity_type: 'setting' as const, entity_id: READER_LAYOUT_SETTING_KEY, operation: 'upsert' as const, entity_revision: 2,
    payload: { value: { theme: 'sepia', fontScale: 1.1, pdfZoom: 1.5 } }, occurred_at: '2026-10-23T00:00:00.000Z', ...overrides,
  }
}

test('only account-scoped, exact reader layout fields project from a setting feed change', async () => {
  const applied: unknown[] = []
  const result = await projectRemoteReaderPreferenceChange({
    userId: ids.user, change: change(),
    preferences: { apply: async (input) => { applied.push(input) }, clear: async () => {} },
  })
  expect(result).toEqual({ outcome: 'applied', preference: { key: READER_LAYOUT_SETTING_KEY, value: { theme: 'sepia', fontScale: 1.1, pdfZoom: 1.5 } } })
  expect(applied).toEqual([{ userId: ids.user, preference: { key: READER_LAYOUT_SETTING_KEY, value: { theme: 'sepia', fontScale: 1.1, pdfZoom: 1.5 } }, revision: 2, sequence: 3 }])
})

test('unknown setting keys are ignored while malformed or file-bearing supported values reject before applying', async () => {
  const applied: unknown[] = []
  const preferences = { apply: async (input: unknown) => { applied.push(input) }, clear: async () => {} }
  await expect(projectRemoteReaderPreferenceChange({ userId: ids.user, change: change({ entity_id: 'profile.avatar', payload: { value: { source: 'https://example.test/avatar.png' } } }), preferences })).resolves.toEqual({ outcome: 'ignored' })
  for (const payload of [
    { value: { theme: 'paper', fontScale: 1, pdfZoom: 1.35, file: 'book.epub' } },
    { value: { theme: 'paper', fontScale: '1', pdfZoom: 1.35 } },
    { value: { language: 'https://example.test' } },
  ]) {
    const entityId = 'language' in (payload.value as object) ? READING_LANGUAGE_SETTING_KEY : READER_LAYOUT_SETTING_KEY
    const result = await projectRemoteReaderPreferenceChange({ userId: ids.user, change: change({ entity_id: entityId, payload }), preferences })
    expect(result.outcome).toBe('rejected')
  }
  expect(applied).toEqual([])
})

test('supported deleted setting clears only the current account after an empty-payload check', async () => {
  const cleared: unknown[] = []
  const result = await projectRemoteReaderPreferenceChange({
    userId: ids.user, change: change({ entity_id: READING_LANGUAGE_SETTING_KEY, operation: 'delete', payload: {} }),
    preferences: { apply: async () => {}, clear: async (input) => { cleared.push(input) } },
  })
  expect(result).toEqual({ outcome: 'cleared', key: READING_LANGUAGE_SETTING_KEY })
  expect(cleared).toEqual([{ userId: ids.user, key: READING_LANGUAGE_SETTING_KEY, revision: 2, sequence: 3 }])
})

test('cached reader preferences are validated and isolated by stable account', () => {
  const values = new Map<string, string>()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
        removeItem: (key: string) => { values.delete(key) },
      },
    },
  })

  try {
    expect(persistAccountReaderPreference({
      userId: 'account-a',
      preference: { key: READER_LAYOUT_SETTING_KEY, value: { theme: 'night', fontScale: 1.2, pdfZoom: 1.5 } },
      revision: 2,
      sequence: 7,
    })).toBe(true)
    expect(persistAccountReaderPreference({
      userId: 'account-b',
      preference: { key: READING_LANGUAGE_SETTING_KEY, value: { language: '日本語' } },
      revision: 1,
      sequence: 3,
    })).toBe(true)

    expect(loadAccountReaderPreferences('account-a')).toEqual({
      layout: { theme: 'night', fontScale: 1.2, pdfZoom: 1.5 },
    })
    expect(loadAccountReaderPreferences('account-b')).toEqual({ language: '日本語' })
    expect(loadAccountReaderPreferences('')).toEqual({})
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('stale preference upserts and clears succeed without replacing a newer cached value', () => {
  const values = new Map<string, string>()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
        removeItem: (key: string) => { values.delete(key) },
      },
    },
  })

  try {
    const currentPreference = { key: READER_LAYOUT_SETTING_KEY, value: { theme: 'night' as const, fontScale: 1.2, pdfZoom: 1.5 } }
    expect(persistAccountReaderPreference({
      userId: ids.user, preference: currentPreference, revision: 4, sequence: 10,
    })).toBe(true)
    expect(persistAccountReaderPreference({
      userId: ids.user,
      preference: { key: READER_LAYOUT_SETTING_KEY, value: { theme: 'paper', fontScale: 1, pdfZoom: 1 } },
      revision: 3,
      sequence: 9,
    })).toBe(true)
    expect(clearAccountReaderPreference({ userId: ids.user, key: READER_LAYOUT_SETTING_KEY, sequence: 8 })).toBe(true)
    expect(loadAccountReaderPreferences(ids.user)).toEqual({
      layout: { theme: 'night', fontScale: 1.2, pdfZoom: 1.5 },
    })
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('App restores account-scoped preferences and invalidates on account changes and explicit sign-out', async () => {
  const source = await readFile('src/App.tsx', 'utf8')
  expect(source).toContain('loadAccountReaderPreferences(next.user.id)')
  expect(source).toContain('ACTIVE_SYNC_ACCOUNT_KEY')
  expect(source).toContain('readerPreferencesRef.current = DEFAULT_READER_PREFERENCES')
  expect(source).toContain('handleAuthSessionChange(null)')
  expect(source).toContain('metadataSyncRuntimeRef.current?.invalidate(previous.user.id)')
})
