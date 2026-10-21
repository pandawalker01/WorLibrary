import type { PulledMetadataSyncChange } from './remote'
import type { RemoteBookMetadataShadow, UpsertRemoteBookMetadataShadow } from './storage'

/** The only persistence surface this projector may use. */
export type RemoteBookMetadataShadowStore = {
  upsert(input: UpsertRemoteBookMetadataShadow): Promise<RemoteBookMetadataShadow>
  delete(userId: string, editionId: string): Promise<boolean>
}

export type RemoteBookMetadataShadowProjectionResult =
  | { outcome: 'projected'; shadow: RemoteBookMetadataShadow }
  | { outcome: 'deleted'; deleted: boolean }
  | { outcome: 'ignored' }
  | { outcome: 'rejected'; error: Error }

export type ProjectRemoteEditionChangeInput = {
  userId: string
  change: PulledMetadataSyncChange
  shadows: RemoteBookMetadataShadowStore
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const allowedEditionPayloadKeys = new Set([
  'title', 'author', 'language', 'progress', 'location', 'file_name', 'file_type', 'file_size', 'cover',
])

function rejected(message: string): RemoteBookMetadataShadowProjectionResult {
  return { outcome: 'rejected', error: new Error(message) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safeString(value: unknown, label: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if ((!optional && !normalized) || normalized.length > maximum) throw new Error(`invalid ${label}`)
  if (/^(?:https?:|data:|blob:)/i.test(normalized)) throw new Error(`${label} cannot be a URL or data URL`)
  return normalized
}

function projectUpsert(input: ProjectRemoteEditionChangeInput): UpsertRemoteBookMetadataShadow {
  const { change } = input
  if (!isPlainObject(change.payload)) throw new Error('edition metadata payload must be a plain object')
  const keys = Object.keys(change.payload)
  if (keys.some((key) => !allowedEditionPayloadKeys.has(key))) {
    throw new Error('edition metadata payload contains an unsupported field')
  }
  const title = safeString(change.payload.title, 'title', 512)
  const author = safeString(change.payload.author, 'author', 512)
  const language = safeString(change.payload.language, 'language', 64)
  const location = safeString(change.payload.location, 'location', 4_096, true)
  const fileName = safeString(change.payload.file_name, 'file name', 512)
  const fileType = safeString(change.payload.file_type, 'file type', 24)
  if (fileType !== 'epub' && fileType !== 'pdf') throw new Error('edition file type must be epub or pdf')
  const progress = change.payload.progress
  const fileSize = change.payload.file_size
  if (!Number.isFinite(progress) || typeof progress !== 'number' || progress < 0 || progress > 100) {
    throw new Error('edition progress must be between 0 and 100')
  }
  if (!Number.isSafeInteger(fileSize) || typeof fileSize !== 'number' || fileSize < 0) {
    throw new Error('edition file size must be a non-negative safe integer')
  }
  const cover = change.payload.cover
  if (cover !== 'ink' && cover !== 'sun' && cover !== 'red') throw new Error('edition cover tone is invalid')
  return {
    userId: input.userId,
    editionId: change.entity_id,
    revision: change.entity_revision,
    sequence: change.sequence,
    title: title!,
    author: author!,
    language: language!,
    progress,
    location,
    fileName: fileName!,
    fileType,
    fileSize,
    cover,
  }
}

/**
 * Project an edition-only controlled change into a metadata shadow.  This
 * accepts no book bytes, cover image, object location, URL, or text body and
 * never returns a `StoredBook`. Unknown feed entities are deliberately
 * ignored: the change-feed caller decides whether its cursor may advance.
 */
export async function projectRemoteEditionChangeToShadow(input: ProjectRemoteEditionChangeInput): Promise<RemoteBookMetadataShadowProjectionResult> {
  const { change } = input
  if (change.entity_type !== 'edition') return { outcome: 'ignored' }
  if (!input.userId.trim()) return rejected('remote shadow requires an account id')
  if (!uuidPattern.test(change.entity_id)) return rejected('edition id must be a UUID')
  if (!Number.isSafeInteger(change.sequence) || change.sequence < 1) return rejected('change sequence is invalid')
  if (!Number.isSafeInteger(change.entity_revision) || change.entity_revision < 1) return rejected('edition revision is invalid')
  if (change.operation === 'delete') {
    if (!isPlainObject(change.payload) || Object.keys(change.payload).length > 0) {
      return rejected('edition delete payload must be empty')
    }
    return { outcome: 'deleted', deleted: await input.shadows.delete(input.userId, change.entity_id) }
  }
  if (change.operation !== 'upsert') return rejected('edition operation is invalid')
  try {
    return { outcome: 'projected', shadow: await input.shadows.upsert(projectUpsert(input)) }
  } catch (error) {
    return rejected(error instanceof Error ? error.message : 'edition metadata projection failed')
  }
}
