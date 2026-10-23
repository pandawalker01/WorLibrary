import type { PulledMetadataSyncChange } from './remote'
import type { RemoteHighlightMetadataShadow, UpsertRemoteHighlightMetadataShadow } from './storage'

/** The only persistence surface remote excerpt projection may use. */
export type RemoteHighlightMetadataShadowStore = {
  upsert(input: UpsertRemoteHighlightMetadataShadow): Promise<RemoteHighlightMetadataShadow>
  delete(userId: string, highlightId: string): Promise<boolean>
}

export type RemoteHighlightMetadataShadowProjectionResult =
  | { outcome: 'projected'; shadow: RemoteHighlightMetadataShadow }
  | { outcome: 'deleted'; deleted: boolean }
  | { outcome: 'ignored' }
  | { outcome: 'rejected'; error: Error }

export type ProjectRemoteHighlightChangeInput = {
  userId: string
  change: PulledMetadataSyncChange
  highlights: RemoteHighlightMetadataShadowStore
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const allowedHighlightPayloadKeys = new Set([
  'edition_id', 'text', 'location', 'note', 'color', 'is_highlighted',
])

function rejected(message: string): RemoteHighlightMetadataShadowProjectionResult {
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
  // Excerpts are private account data, but a projected field must never be an
  // object locator or URL that a later UI could mistake for file access.
  if (/^(?:https?:|data:|blob:)/i.test(normalized)) throw new Error(`${label} cannot be a URL or data URL`)
  return normalized || undefined
}

function projectUpsert(input: ProjectRemoteHighlightChangeInput): UpsertRemoteHighlightMetadataShadow {
  const { change } = input
  if (!isPlainObject(change.payload)) throw new Error('highlight metadata payload must be a plain object')
  const keys = Object.keys(change.payload)
  if (keys.some((key) => !allowedHighlightPayloadKeys.has(key))) {
    throw new Error('highlight metadata payload contains an unsupported field')
  }
  const editionId = safeString(change.payload.edition_id, 'edition id', 64)
  if (!uuidPattern.test(editionId ?? '')) throw new Error('highlight edition id must be a UUID')
  const text = safeString(change.payload.text, 'text', 32_768)
  const location = safeString(change.payload.location, 'location', 4_096)
  const note = safeString(change.payload.note, 'note', 16_384, true)
  const color = change.payload.color
  if (color !== 'gold' && color !== 'rose' && color !== 'blue') throw new Error('highlight color is invalid')
  const isHighlighted = change.payload.is_highlighted
  if (isHighlighted !== undefined && typeof isHighlighted !== 'boolean') {
    throw new Error('highlight presentation state is invalid')
  }

  return {
    userId: input.userId,
    highlightId: change.entity_id,
    editionId: editionId!,
    revision: change.entity_revision,
    sequence: change.sequence,
    text: text!,
    location: location!,
    note,
    color,
    // Older server records predate explicit uncoloured excerpts. They were
    // visually highlighted, so preserve that legacy display behavior.
    isHighlighted: isHighlighted ?? true,
  }
}

/**
 * Project a controlled remote highlight into an account-scoped local shadow.
 * The allowlist deliberately excludes `book_id` and every file/object/URL
 * field: no cloud excerpt can establish reader access or local-file identity.
 */
export async function projectRemoteHighlightChangeToShadow(
  input: ProjectRemoteHighlightChangeInput,
): Promise<RemoteHighlightMetadataShadowProjectionResult> {
  const { change } = input
  if (change.entity_type !== 'highlight') return { outcome: 'ignored' }
  if (!input.userId.trim()) return rejected('remote highlight shadow requires an account id')
  if (!uuidPattern.test(change.entity_id)) return rejected('highlight id must be a UUID')
  if (!Number.isSafeInteger(change.sequence) || change.sequence < 1) return rejected('change sequence is invalid')
  if (!Number.isSafeInteger(change.entity_revision) || change.entity_revision < 1) return rejected('change revision is invalid')
  if (change.operation === 'delete') {
    if (!isPlainObject(change.payload) || Object.keys(change.payload).length > 0) {
      return rejected('highlight delete payload must be empty')
    }
    return { outcome: 'deleted', deleted: await input.highlights.delete(input.userId, change.entity_id) }
  }
  if (change.operation !== 'upsert') return rejected('highlight operation is invalid')
  try {
    return { outcome: 'projected', shadow: await input.highlights.upsert(projectUpsert(input)) }
  } catch (error) {
    return rejected(error instanceof Error ? error.message : 'highlight metadata projection failed')
  }
}
