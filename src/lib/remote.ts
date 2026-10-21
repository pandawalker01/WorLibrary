import type { AuthSession } from './auth'

export type RemoteTable = 'works' | 'editions' | 'reading_progress' | 'highlights' | 'user_settings' | 'devices'

export type ControlledMetadataSyncEntity = 'work' | 'edition' | 'reading_progress' | 'highlight' | 'library_item' | 'setting'
export type ControlledMetadataSyncOperation = 'upsert' | 'delete'
export type ControlledMetadataSyncPayload = Record<string, unknown>

export type ApplyMetadataSyncChangeInput = {
  p_device_id: string
  p_operation_id: string
  p_entity_type: ControlledMetadataSyncEntity
  p_entity_id: string
  p_operation: ControlledMetadataSyncOperation
  p_base_revision: number
  p_payload?: ControlledMetadataSyncPayload
}

export type AppliedMetadataSyncChange = {
  sequence: number
  entity_revision: number
  operation: ControlledMetadataSyncOperation
  applied: boolean
}

export type PullMetadataSyncChangesInput = {
  p_after_sequence?: number
  p_limit?: number
}

export type PulledMetadataSyncChange = {
  sequence: number
  device_id: string
  operation_id: string
  entity_type: ControlledMetadataSyncEntity
  entity_id: string
  operation: ControlledMetadataSyncOperation
  entity_revision: number
  payload: ControlledMetadataSyncPayload
  occurred_at: string
}

export type ControlledMetadataSyncRpc = {
  apply_metadata_sync_change: {
    input: ApplyMetadataSyncChangeInput
    output: AppliedMetadataSyncChange[]
  }
  pull_metadata_sync_changes: {
    input: PullMetadataSyncChangesInput
    output: PulledMetadataSyncChange[]
  }
}

export type RemoteClientConfig = {
  url?: string
  anonKey?: string
  /** Bounded configuration is useful for tests and unavailable networks. */
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
}

export type RemoteClient = {
  select<T>(table: RemoteTable, query?: string): Promise<T[]>
  upsert<T extends Record<string, unknown>>(table: RemoteTable, rows: T | T[]): Promise<T[]>
  remove(table: RemoteTable, query: string): Promise<void>
  rpc<TName extends keyof ControlledMetadataSyncRpc>(
    name: TName,
    input: ControlledMetadataSyncRpc[TName]['input'],
  ): Promise<ControlledMetadataSyncRpc[TName]['output']>
}

export class RemoteRequestError extends Error {
  readonly status?: number
  readonly retryable: boolean
  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'RemoteRequestError'
    this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
const url = env.VITE_SUPABASE_URL
const anonKey = env.VITE_SUPABASE_ANON_KEY

const forbiddenPayloadKeys = new Set([
  'blob', 'bookblob', 'bookblobs', 'bookbytes', 'file', 'filebytes', 'filedata', 'bytes', 'binary', 'base64',
  'objectkey', 'objectlocator', 'contenturl', 'signedurl', 'url', 'uri', 'href',
  'rawcontent', 'content', 'body', 'fulltext', 'bookbody', 'documenttext', '正文', '原文', '原书',
])

function normalizedPayloadKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[_.\-\s]/g, '')
}

function isUnsupportedBinary(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    || (typeof Blob !== 'undefined' && value instanceof Blob)
}

function isUrlOrDataValue(value: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(value.trim())
}

/**
 * Reject values that could turn a metadata mutation into an original-file,
 * locator, or full-text upload. This is intentionally repeated server-side in
 * migration 0009: the browser check is a guardrail, not the authorization
 * boundary.
 */
export function assertMetadataOnlySyncPayload(payload: ControlledMetadataSyncPayload): void {
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object' || isUnsupportedBinary(payload)) {
    throw new TypeError('同步元数据必须是普通对象')
  }
  const visit = (value: unknown, path: string): void => {
    if (isUnsupportedBinary(value)) throw new TypeError(`同步元数据不能包含二进制内容（${path}）`)
    if (typeof value === 'string') {
      if (isUrlOrDataValue(value)) throw new TypeError(`同步元数据不能包含 URL 或数据地址（${path}）`)
      if (value.length > 32_768) throw new TypeError(`同步元数据字段过长（${path}）`)
      return
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (typeof value !== 'object') throw new TypeError(`同步元数据包含不支持的值（${path}）`)
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenPayloadKeys.has(normalizedPayloadKey(key))) {
        throw new TypeError(`同步元数据不能包含文件、对象定位或正文内容（${path}.${key}）`)
      }
      visit(child, `${path}.${key}`)
    }
  }
  visit(payload, 'payload')
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)))
}

export function createRemoteClient(session: AuthSession, config: RemoteClientConfig = {}): RemoteClient {
  const endpoint = config.url ?? url
  const key = config.anonKey ?? anonKey
  if (!endpoint || !key) throw new Error('尚未配置 Supabase')
  const timeoutMs = boundedInteger(config.timeoutMs, 15_000, 1, 30_000)
  const maxAttempts = boundedInteger(config.maxAttempts, 2, 1, 3)
  const retryDelayMs = boundedInteger(config.retryDelayMs, 250, 0, 5_000)
  const baseUrl = endpoint.replace(/\/$/, '')

  async function request<T>(path: string, init: RequestInit = {}, query = ''): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${baseUrl}/rest/v1/${path}${query ? `?${query}` : ''}`, {
          ...init,
          signal: controller.signal,
          headers: {
            apikey: key, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}),
          },
        })
        if (!response.ok) {
          const detail = await response.text()
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500
          throw new RemoteRequestError(`同步请求失败（${response.status}）：${detail.slice(0, 200)}`, { status: response.status, retryable })
        }
        if (response.status === 204) return undefined as T
        return await response.json() as T
      } catch (error) {
        const timeoutError = error instanceof DOMException && error.name === 'AbortError'
        const normalized = timeoutError ? new RemoteRequestError('同步请求超时，请检查网络后重试', { retryable: true }) : error
        if (attempt < maxAttempts && (normalized instanceof RemoteRequestError ? normalized.retryable : true)) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * attempt))
          continue
        }
        throw normalized
      } finally {
        globalThis.clearTimeout(timeout)
      }
    }
    throw new RemoteRequestError('同步请求失败')
  }
  return {
    select: <T>(table: RemoteTable, query = '') => request<T[]>(table, { method: 'GET', headers: { Accept: 'application/json' } }, query),
    upsert: <T extends Record<string, unknown>>(table: RemoteTable, rows: T | T[]) => {
      const values = (Array.isArray(rows) ? rows : [rows]).map((row) => ({ ...row, user_id: row.user_id ?? session.user.id }))
      return request<T[]>(table, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(values) })
    },
    remove: (table: RemoteTable, query: string) => request<void>(table, { method: 'DELETE' }, query).then(() => undefined),
    rpc: async <TName extends keyof ControlledMetadataSyncRpc>(name: TName, input: ControlledMetadataSyncRpc[TName]['input']) => {
      if (session.user.isAnonymous) throw new RemoteRequestError('匿名会话不能同步云端元数据')
      if (name === 'apply_metadata_sync_change') {
        const payload = (input as ApplyMetadataSyncChangeInput).p_payload ?? {}
        assertMetadataOnlySyncPayload(payload)
      }
      return request<ControlledMetadataSyncRpc[TName]['output']>(`rpc/${name}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: JSON.stringify(input),
      })
    },
  }
}
