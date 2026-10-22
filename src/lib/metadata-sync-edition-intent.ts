import type { AuthSession } from './auth'
import {
  resolveBrowserSyncClientInstanceId,
  type ClientInstanceStorage,
} from './device-registration-session'
import {
  createMetadataSyncOutboxEntry,
  type CreateMetadataSyncOutboxEntry,
  type MetadataSyncOutboxEntry,
  type StoredBook,
} from './storage'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type EditionMetadataSyncIntentInput = {
  session: AuthSession | null
  book: StoredBook
  /** The local revision last accepted for this edition; new local books start at zero. */
  baseRevision?: number
  operationId?: string
  deviceStorage?: ClientInstanceStorage | null
  createClientInstanceId?: () => string
  enqueue?: (input: CreateMetadataSyncOutboxEntry) => Promise<MetadataSyncOutboxEntry>
}

export type EditionMetadataSyncIntentResult =
  | { status: 'queued'; entry: MetadataSyncOutboxEntry }
  | { status: 'no-stable-account' }
  | { status: 'storage-unavailable'; error?: unknown }
  | { status: 'invalid-book'; error: Error }

function stableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function safeString(value: string, label: string, maximum: number, optional = false): string | undefined {
  const normalized = value.trim()
  if (!normalized && optional) return undefined
  if (!normalized || normalized.length > maximum) throw new Error(`invalid ${label}`)
  if (/^(?:https?:|data:|blob:)/i.test(normalized)) throw new Error(`${label} cannot be a URL or data URL`)
  return normalized
}

function normalizedFileType(book: StoredBook): 'epub' | 'pdf' {
  const name = book.fileName.trim().toLowerCase()
  const mime = book.fileType.trim().toLowerCase()
  if (name.endsWith('.epub') || mime.includes('epub')) return 'epub'
  if (name.endsWith('.pdf') || mime.includes('pdf')) return 'pdf'
  throw new Error('local edition file type must be epub or pdf')
}

function buildEditionPayload(book: StoredBook): Record<string, unknown> {
  if (!uuidPattern.test(book.editionId ?? '')) throw new Error('local edition requires a stable UUID')
  if (!Number.isFinite(book.progress) || book.progress < 0 || book.progress > 100) throw new Error('local edition progress must be between 0 and 100')
  if (!Number.isSafeInteger(book.fileSize) || book.fileSize < 0) throw new Error('local edition file size is invalid')
  if (book.cover !== 'ink' && book.cover !== 'sun' && book.cover !== 'red') throw new Error('local edition cover tone is invalid')

  const payload: Record<string, unknown> = {
    title: safeString(book.title, 'title', 512),
    author: safeString(book.author, 'author', 512),
    language: safeString(book.language, 'language', 64),
    progress: book.progress,
    file_name: safeString(book.fileName, 'file name', 512),
    file_type: normalizedFileType(book),
    file_size: book.fileSize,
    cover: book.cover,
  }
  const location = book.location === undefined ? undefined : safeString(book.location, 'location', 4_096, true)
  if (location !== undefined) payload.location = location
  // The edition UUID is the outbox entity id. The optional work UUID only
  // preserves a stable relation and is not an object locator or file handle.
  if (book.workId && uuidPattern.test(book.workId)) payload.work_id = book.workId
  return payload
}

/**
 * Turn a local book record into a narrowly whitelisted edition upsert. This
 * is an intent only: it neither reads nor uploads the original EPUB/PDF or
 * cover image, and it cannot run for anonymous or absent sessions.
 */
export async function enqueueLocalEditionMetadataSyncIntent(input: EditionMetadataSyncIntentInput): Promise<EditionMetadataSyncIntentResult> {
  // Keep this guard before localStorage, outbox, UUID generation, or payload
  // inspection so anonymous trials have no cloud-sync side effects.
  if (!stableSession(input.session)) return { status: 'no-stable-account' }

  const resolvedClient = resolveBrowserSyncClientInstanceId({
    session: input.session,
    storage: input.deviceStorage,
    createClientInstanceId: input.createClientInstanceId,
  })
  if (resolvedClient.status !== 'ready') return resolvedClient

  try {
    const payload = buildEditionPayload(input.book)
    const baseRevision = input.baseRevision ?? 0
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error('local edition base revision is invalid')
    const entry = await (input.enqueue ?? createMetadataSyncOutboxEntry)({
      ...(input.operationId ? { operationId: input.operationId } : {}),
      userId: input.session.user.id,
      deviceClientId: resolvedClient.clientInstanceId,
      entityType: 'edition',
      entityId: input.book.editionId!,
      operation: 'upsert',
      baseRevision,
      payload,
    })
    return { status: 'queued', entry }
  } catch (error) {
    return { status: 'invalid-book', error: error instanceof Error ? error : new Error('local edition metadata is invalid') }
  }
}
