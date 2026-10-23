import type { AuthSession } from './auth'
import { resolveBrowserSyncClientInstanceId, type ClientInstanceStorage } from './device-registration-session'
import type { ReadingLanguage } from './i18n'
import { clampFontScale, clampPdfZoom, type ReaderPreferences, type ReaderTheme } from './reader'
import { createMetadataSyncOutboxEntry, type CreateMetadataSyncOutboxEntry, type MetadataSyncOutboxEntry } from './storage'

/** Stable, server-validated keys. Interface locale intentionally stays local. */
export const READER_LAYOUT_SETTING_KEY = 'reader.layout'
export const READING_LANGUAGE_SETTING_KEY = 'reader.language'

export type SyncedReaderLayout = Pick<ReaderPreferences, 'theme' | 'fontScale' | 'pdfZoom'>
export type SyncedReaderPreference =
  | { key: typeof READER_LAYOUT_SETTING_KEY; value: SyncedReaderLayout }
  | { key: typeof READING_LANGUAGE_SETTING_KEY; value: { language: ReadingLanguage } }

export type ReaderPreferenceSyncIntentInput = {
  session: AuthSession | null
  preference: SyncedReaderPreference
  baseRevision?: number
  operationId?: string
  deviceStorage?: ClientInstanceStorage | null
  createClientInstanceId?: () => string
  enqueue?: (input: CreateMetadataSyncOutboxEntry) => Promise<MetadataSyncOutboxEntry>
}

export type ReaderPreferenceSyncIntentResult =
  | { status: 'queued'; entry: MetadataSyncOutboxEntry }
  | { status: 'no-stable-account' }
  | { status: 'storage-unavailable'; error?: unknown }
  | { status: 'invalid-preference'; error: Error }

function stableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function validTheme(value: unknown): value is ReaderTheme {
  return value === 'paper' || value === 'sepia' || value === 'night'
}

function safeLanguage(value: unknown): string {
  if (typeof value !== 'string') throw new Error('reading language must be a string')
  const normalized = value.trim()
  if (!normalized || normalized.length > 64 || /^(?:https?:|data:|blob:)/i.test(normalized)) throw new Error('reading language is invalid')
  return normalized
}

/** Serialize only display choices; it has no file, book, excerpt, URL, or binary input surface. */
export function preferenceSyncPayload(preference: SyncedReaderPreference): Record<string, unknown> {
  if (preference.key === READER_LAYOUT_SETTING_KEY) {
    const value = preference.value
    if (!validTheme(value.theme) || !Number.isFinite(value.fontScale) || !Number.isFinite(value.pdfZoom)) throw new Error('reader layout preference is invalid')
    return { value: { theme: value.theme, fontScale: clampFontScale(value.fontScale), pdfZoom: clampPdfZoom(value.pdfZoom) } }
  }
  if (preference.key === READING_LANGUAGE_SETTING_KEY) return { value: { language: safeLanguage(preference.value.language) } }
  throw new Error('unsupported reader preference key')
}

/** Queue a stable-account preference update after its local write succeeds. */
export async function enqueueLocalReaderPreferenceSyncIntent(input: ReaderPreferenceSyncIntentInput): Promise<ReaderPreferenceSyncIntentResult> {
  if (!stableSession(input.session)) return { status: 'no-stable-account' }
  const client = resolveBrowserSyncClientInstanceId({ session: input.session, storage: input.deviceStorage, createClientInstanceId: input.createClientInstanceId })
  if (client.status !== 'ready') return client
  try {
    const baseRevision = input.baseRevision ?? 0
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error('preference base revision is invalid')
    const entry = await (input.enqueue ?? createMetadataSyncOutboxEntry)({
      ...(input.operationId ? { operationId: input.operationId } : {}),
      userId: input.session.user.id,
      deviceClientId: client.clientInstanceId,
      entityType: 'setting',
      entityId: input.preference.key,
      operation: 'upsert',
      baseRevision,
      payload: preferenceSyncPayload(input.preference),
    })
    return { status: 'queued', entry }
  } catch (error) {
    return { status: 'invalid-preference', error: error instanceof Error ? error : new Error('reader preference is invalid') }
  }
}
