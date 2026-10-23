import { expect, test } from '@playwright/test'
import { READER_LAYOUT_SETTING_KEY, READING_LANGUAGE_SETTING_KEY } from '../src/lib/metadata-sync-preference-intent'
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
