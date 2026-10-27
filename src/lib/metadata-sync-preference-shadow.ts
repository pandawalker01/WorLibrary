import type { PulledMetadataSyncChange } from './remote'
import { READER_LAYOUT_SETTING_KEY, READING_LANGUAGE_SETTING_KEY, type SyncedReaderPreference } from './metadata-sync-preference-intent'
import { clampFontScale, clampPdfZoom, type ReaderTheme } from './reader'

/** The host must durably apply only the current account's accepted preference before cursor advance. */
export type RemoteReaderPreferenceStore = {
  apply(input: { userId: string; preference: SyncedReaderPreference; revision: number; sequence: number }): Promise<unknown>
  clear(input: { userId: string; key: typeof READER_LAYOUT_SETTING_KEY | typeof READING_LANGUAGE_SETTING_KEY; revision: number; sequence: number }): Promise<unknown>
}

export type RemoteReaderPreferenceProjectionResult =
  | { outcome: 'applied'; preference: SyncedReaderPreference }
  | { outcome: 'cleared'; key: typeof READER_LAYOUT_SETTING_KEY | typeof READING_LANGUAGE_SETTING_KEY }
  | { outcome: 'ignored' }
  | { outcome: 'rejected'; error: Error }

export type ProjectRemoteReaderPreferenceChangeInput = { userId: string; change: PulledMetadataSyncChange; preferences: RemoteReaderPreferenceStore }

function rejected(message: string): RemoteReaderPreferenceProjectionResult { return { outcome: 'rejected', error: new Error(message) } }
function isPlainObject(value: unknown): value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null }
function validTheme(value: unknown): value is ReaderTheme { return value === 'paper' || value === 'sepia' || value === 'night' }
function validKey(value: string): value is typeof READER_LAYOUT_SETTING_KEY | typeof READING_LANGUAGE_SETTING_KEY { return value === READER_LAYOUT_SETTING_KEY || value === READING_LANGUAGE_SETTING_KEY }

function parsePreference(change: PulledMetadataSyncChange): SyncedReaderPreference {
  if (!isPlainObject(change.payload) || Object.keys(change.payload).length !== 1 || !('value' in change.payload) || !isPlainObject(change.payload.value)) throw new Error('reader preference payload must contain only an object value')
  const value = change.payload.value
  if (change.entity_id === READER_LAYOUT_SETTING_KEY) {
    if (Object.keys(value).some((key) => key !== 'theme' && key !== 'fontScale' && key !== 'pdfZoom')) throw new Error('reader layout contains an unsupported field')
    const fontScale = value.fontScale
    const pdfZoom = value.pdfZoom
    if (!validTheme(value.theme) || typeof fontScale !== 'number' || typeof pdfZoom !== 'number' || !Number.isFinite(fontScale) || !Number.isFinite(pdfZoom)) throw new Error('reader layout is invalid')
    return { key: READER_LAYOUT_SETTING_KEY, value: { theme: value.theme, fontScale: clampFontScale(fontScale), pdfZoom: clampPdfZoom(pdfZoom) } }
  }
  if (change.entity_id === READING_LANGUAGE_SETTING_KEY) {
    if (Object.keys(value).length !== 1 || typeof value.language !== 'string') throw new Error('reading language is invalid')
    const language = value.language.trim()
    if (!language || language.length > 64 || /^(?:https?:|data:|blob:)/i.test(language)) throw new Error('reading language is invalid')
    return { key: READING_LANGUAGE_SETTING_KEY, value: { language } }
  }
  throw new Error('unsupported reader preference key')
}

/** Apply a small, exact allowlist of same-account reader settings from the feed. */
export async function projectRemoteReaderPreferenceChange(input: ProjectRemoteReaderPreferenceChangeInput): Promise<RemoteReaderPreferenceProjectionResult> {
  const { change } = input
  if (change.entity_type !== 'setting') return { outcome: 'ignored' }
  if (!input.userId.trim()) return rejected('reader preference projection requires an account id')
  if (!validKey(change.entity_id)) return { outcome: 'ignored' }
  if (!Number.isSafeInteger(change.sequence) || change.sequence < 1 || !Number.isSafeInteger(change.entity_revision) || change.entity_revision < 1) return rejected('reader preference change version is invalid')
  try {
    if (change.operation === 'delete') {
      if (!isPlainObject(change.payload) || Object.keys(change.payload).length !== 0) return rejected('reader preference delete payload must be empty')
      await input.preferences.clear({ userId: input.userId, key: change.entity_id, revision: change.entity_revision, sequence: change.sequence })
      return { outcome: 'cleared', key: change.entity_id }
    }
    if (change.operation !== 'upsert') return rejected('reader preference operation is invalid')
    const preference = parsePreference(change)
    await input.preferences.apply({ userId: input.userId, preference, revision: change.entity_revision, sequence: change.sequence })
    return { outcome: 'applied', preference }
  } catch (error) { return rejected(error instanceof Error ? error.message : 'reader preference projection failed') }
}
