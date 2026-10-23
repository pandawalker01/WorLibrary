import { expect, test } from '@playwright/test'
import type { AuthSession } from '../src/lib/auth'
import { SYNC_CLIENT_INSTANCE_STORAGE_KEY, type ClientInstanceStorage } from '../src/lib/device-registration-session'
import {
  enqueueLocalReaderPreferenceSyncIntent,
  preferenceSyncPayload,
  READER_LAYOUT_SETTING_KEY,
  READING_LANGUAGE_SETTING_KEY,
} from '../src/lib/metadata-sync-preference-intent'
import type { CreateMetadataSyncOutboxEntry, MetadataSyncOutboxEntry } from '../src/lib/storage'
import { readFile } from 'node:fs/promises'

const session: AuthSession = { accessToken: 'token', refreshToken: 'refresh', user: { id: 'stable-user', isAnonymous: false } }
const clientId = 'a1d8eb2c-6996-4b5a-928f-2c429c083e69'

function storage(): ClientInstanceStorage {
  return { getItem: (key) => { expect(key).toBe(SYNC_CLIENT_INSTANCE_STORAGE_KEY); return clientId }, setItem: () => { throw new Error('must not create an existing client id') } }
}

function capture(entries: CreateMetadataSyncOutboxEntry[]) {
  return async (input: CreateMetadataSyncOutboxEntry): Promise<MetadataSyncOutboxEntry> => {
    entries.push(input)
    return { ...input, operationId: input.operationId ?? 'a005f008-79a8-49f0-bdaa-0c9c468add46', status: 'pending', createdAt: 1 }
  }
}

test('stable account queues a bounded reader layout setting without any content data', async () => {
  const entries: CreateMetadataSyncOutboxEntry[] = []
  const result = await enqueueLocalReaderPreferenceSyncIntent({
    session, deviceStorage: storage(), enqueue: capture(entries),
    preference: { key: READER_LAYOUT_SETTING_KEY, value: { theme: 'night', fontScale: 1.81, pdfZoom: 9 } },
  })

  expect(result.status).toBe('queued')
  expect(entries).toEqual([{
    userId: 'stable-user', deviceClientId: clientId, entityType: 'setting', entityId: 'reader.layout', operation: 'upsert', baseRevision: 0,
    payload: { value: { theme: 'night', fontScale: 1.35, pdfZoom: 2.5 } },
  }])
  expect(JSON.stringify(entries)).not.toMatch(/book|file|blob|url|body|text/i)
})

test('reading-language payload has a closed, URL-free object shape', () => {
  expect(preferenceSyncPayload({ key: READING_LANGUAGE_SETTING_KEY, value: { language: ' 日本語 ' } })).toEqual({ value: { language: '日本語' } })
  for (const language of ['', 'https://example.test', 'data:text/plain,unsafe', 'x'.repeat(65)]) {
    expect(() => preferenceSyncPayload({ key: READING_LANGUAGE_SETTING_KEY, value: { language } })).toThrow()
  }
})

test('anonymous account has no preference queue or storage side effect', async () => {
  let inspected = false
  const result = await enqueueLocalReaderPreferenceSyncIntent({
    session: { ...session, user: { ...session.user, isAnonymous: true } },
    preference: { key: READING_LANGUAGE_SETTING_KEY, value: { language: '中文' } },
    deviceStorage: { getItem: () => { inspected = true; return null }, setItem: () => { inspected = true } },
  })
  expect(result).toEqual({ status: 'no-stable-account' })
  expect(inspected).toBe(false)
})

test('reader layout and understanding-language page actions use the preference intent instead of a generic setting channel', async () => {
  const source = await readFile('src/App.tsx', 'utf8')
  expect(source).toContain('enqueueLocalReaderPreferenceSyncIntent')
  expect(source).toContain("readMetadataSyncEntityRevision(current.user.id, 'setting', preference.key)")
  expect(source).toContain('preferences: {')
  expect(source).toContain('persistAccountReaderPreference')
  expect(source).toContain("key: READER_LAYOUT_SETTING_KEY, value: normalized")
  expect(source).toContain("key: READING_LANGUAGE_SETTING_KEY, value: { language: normalized }")
  expect(source).not.toContain("setReaderPreferences((current) => ({ ...current, theme:")
})
