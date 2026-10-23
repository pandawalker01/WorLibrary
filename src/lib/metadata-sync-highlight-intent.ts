import type { AuthSession } from './auth'
import {
  resolveBrowserSyncClientInstanceId,
  type ClientInstanceStorage,
} from './device-registration-session'
import {
  createMetadataSyncOutboxEntry,
  type CreateMetadataSyncOutboxEntry,
  type Highlight,
  type MetadataSyncOutboxEntry,
} from './storage'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type HighlightMetadataSyncIntentInput = {
  session: AuthSession | null
  highlight: Highlight
  /** The stable edition identity; the browser-local book id never leaves this boundary. */
  editionId: string
  operation?: 'upsert' | 'delete'
  /** The last server revision accepted for this highlight. */
  baseRevision?: number
  operationId?: string
  deviceStorage?: ClientInstanceStorage | null
  createClientInstanceId?: () => string
  enqueue?: (input: CreateMetadataSyncOutboxEntry) => Promise<MetadataSyncOutboxEntry>
}

export type HighlightMetadataSyncIntentResult =
  | { status: 'queued'; entry: MetadataSyncOutboxEntry }
  | { status: 'no-stable-account' }
  | { status: 'storage-unavailable'; error?: unknown }
  | { status: 'invalid-highlight'; error: Error }

function stableSession(session: AuthSession | null): session is AuthSession {
  return Boolean(session && !session.user.isAnonymous && session.user.id.trim())
}

function safeString(value: string | undefined, label: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  const normalized = value?.trim() ?? ''
  if (!normalized && optional) return undefined
  if (!normalized || normalized.length > maximum) throw new Error(`invalid ${label}`)
  if (/^(?:https?:|data:|blob:)/i.test(normalized)) throw new Error(`${label} cannot be a URL or data URL`)
  return normalized
}

function validRevision(value: number | undefined): number {
  const revision = value ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('highlight base revision is invalid')
  return revision
}

function buildHighlightPayload(highlight: Highlight, editionId: string): Record<string, unknown> {
  if (!uuidPattern.test(highlight.id)) throw new Error('highlight requires a stable UUID')
  if (!uuidPattern.test(editionId)) throw new Error('highlight requires a stable edition UUID')
  if (highlight.color !== 'gold' && highlight.color !== 'rose' && highlight.color !== 'blue') throw new Error('highlight color is invalid')
  if (highlight.isHighlighted !== undefined && typeof highlight.isHighlighted !== 'boolean') throw new Error('highlight annotation state is invalid')

  const payload: Record<string, unknown> = {
    edition_id: editionId,
    text: safeString(highlight.text, 'highlight text', 16_384),
    location: safeString(highlight.location, 'highlight location', 4_096),
    color: highlight.color,
    is_highlighted: highlight.isHighlighted !== false,
  }
  const note = safeString(highlight.note, 'highlight note', 8_192, true)
  if (note !== undefined) payload.note = note
  return payload
}

/**
 * Queue one private highlight mutation only after its local write has
 * succeeded. The payload contains the user's explicitly authorised excerpt,
 * note, colour and reader location plus a stable edition reference. It never
 * includes the browser-local book id, EPUB/PDF bytes, cover binary, object
 * URLs, file names, or public-sharing fields.
 */
export async function enqueueLocalHighlightMetadataSyncIntent(input: HighlightMetadataSyncIntentInput): Promise<HighlightMetadataSyncIntentResult> {
  if (!stableSession(input.session)) return { status: 'no-stable-account' }

  const resolvedClient = resolveBrowserSyncClientInstanceId({
    session: input.session,
    storage: input.deviceStorage,
    createClientInstanceId: input.createClientInstanceId,
  })
  if (resolvedClient.status !== 'ready') return resolvedClient

  try {
    const operation = input.operation ?? 'upsert'
    if (operation !== 'upsert' && operation !== 'delete') throw new Error('highlight operation is invalid')
    if (!uuidPattern.test(input.highlight.id)) throw new Error('highlight requires a stable UUID')
    const payload = operation === 'upsert' ? buildHighlightPayload(input.highlight, input.editionId) : {}
    const entry = await (input.enqueue ?? createMetadataSyncOutboxEntry)({
      ...(input.operationId ? { operationId: input.operationId } : {}),
      userId: input.session.user.id,
      deviceClientId: resolvedClient.clientInstanceId,
      entityType: 'highlight',
      entityId: input.highlight.id,
      operation,
      baseRevision: validRevision(input.baseRevision),
      payload,
    })
    return { status: 'queued', entry }
  } catch (error) {
    return { status: 'invalid-highlight', error: error instanceof Error ? error : new Error('local highlight metadata is invalid') }
  }
}
