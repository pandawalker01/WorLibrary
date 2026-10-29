import { READER_LAYOUT_SETTING_KEY, READING_LANGUAGE_SETTING_KEY, type SyncedReaderPreference } from './metadata-sync-preference-intent'
import { clampFontScale, clampPdfZoom, type ReaderTheme } from './reader'

export type AccountReaderPreferences = {
  layout?: Extract<SyncedReaderPreference, { key: typeof READER_LAYOUT_SETTING_KEY }>['value']
  language?: Extract<SyncedReaderPreference, { key: typeof READING_LANGUAGE_SETTING_KEY }>['value']['language']
}

type StoredAccountPreference = {
  preference: SyncedReaderPreference
  revision: number
  sequence: number
}

const ACCOUNT_PREFERENCE_STORAGE_PREFIX = 'worlibrary.remote-reader-preferences:'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validTheme(value: unknown): value is ReaderTheme {
  return value === 'paper' || value === 'sepia' || value === 'night'
}

function storageKey(userId: string): string {
  return `${ACCOUNT_PREFERENCE_STORAGE_PREFIX}${userId}`
}

function readStoredPreferences(userId: string): Partial<Record<typeof READER_LAYOUT_SETTING_KEY | typeof READING_LANGUAGE_SETTING_KEY, StoredAccountPreference>> {
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed as Partial<Record<typeof READER_LAYOUT_SETTING_KEY | typeof READING_LANGUAGE_SETTING_KEY, StoredAccountPreference>> : {}
  } catch {
    return {}
  }
}

/** Read only validated preferences from this account's durable local projection. */
export function loadAccountReaderPreferences(userId: string): AccountReaderPreferences {
  if (!userId.trim()) return {}
  try {
    const stored = readStoredPreferences(userId)
    const result: AccountReaderPreferences = {}
    const layout = stored[READER_LAYOUT_SETTING_KEY]
    if (isPlainObject(layout) && isPlainObject(layout.preference) && layout.preference.key === READER_LAYOUT_SETTING_KEY) {
      const value = layout.preference.value
      if (
        isPlainObject(value)
        && Object.keys(value).length === 3
        && validTheme(value.theme)
        && typeof value.fontScale === 'number'
        && Number.isFinite(value.fontScale)
        && typeof value.pdfZoom === 'number'
        && Number.isFinite(value.pdfZoom)
      ) {
        result.layout = { theme: value.theme, fontScale: clampFontScale(value.fontScale), pdfZoom: clampPdfZoom(value.pdfZoom) }
      }
    }

    const language = stored[READING_LANGUAGE_SETTING_KEY]
    if (isPlainObject(language) && isPlainObject(language.preference) && language.preference.key === READING_LANGUAGE_SETTING_KEY) {
      const value = language.preference.value
      if (isPlainObject(value) && Object.keys(value).length === 1 && typeof value.language === 'string') {
        const normalized = value.language.trim()
        if (normalized && normalized.length <= 64 && !/^(?:https?:|data:|blob:)/i.test(normalized)) result.language = normalized
      }
    }

    return result
  } catch {
    return {}
  }
}

/** Persist a remote setting under the stable account that owned the feed item. */
export function persistAccountReaderPreference(input: { userId: string; preference: SyncedReaderPreference; revision: number; sequence: number }): boolean {
  if (!input.userId.trim() || !Number.isSafeInteger(input.revision) || !Number.isSafeInteger(input.sequence)) return false
  try {
    const stored = readStoredPreferences(input.userId)
    const previous = stored[input.preference.key]
    if (previous && previous.sequence > input.sequence) return true
    stored[input.preference.key] = { preference: input.preference, revision: input.revision, sequence: input.sequence }
    window.localStorage.setItem(storageKey(input.userId), JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}

/** Clear only the named account/key pair; never touch another account's cached setting. */
export function clearAccountReaderPreference(input: { userId: string; key: typeof READER_LAYOUT_SETTING_KEY | typeof READING_LANGUAGE_SETTING_KEY; sequence: number }): boolean {
  if (!input.userId.trim() || !Number.isSafeInteger(input.sequence)) return false
  try {
    const stored = readStoredPreferences(input.userId)
    const previous = stored[input.key]
    if (previous && previous.sequence > input.sequence) return true
    delete stored[input.key]
    if (Object.keys(stored).length === 0) window.localStorage.removeItem(storageKey(input.userId))
    else window.localStorage.setItem(storageKey(input.userId), JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}
