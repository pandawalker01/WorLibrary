import type { AuthSession } from './auth'

export type RemoteTable = 'works' | 'editions' | 'reading_progress' | 'highlights' | 'user_settings' | 'devices'

export type RemoteClient = {
  select<T>(table: RemoteTable, query?: string): Promise<T[]>
  upsert<T extends Record<string, unknown>>(table: RemoteTable, rows: T | T[]): Promise<T[]>
  remove(table: RemoteTable, query: string): Promise<void>
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

export function createRemoteClient(session: AuthSession, config: { url?: string; anonKey?: string } = {}): RemoteClient {
  const endpoint = config.url ?? url
  const key = config.anonKey ?? anonKey
  if (!endpoint || !key) throw new Error('尚未配置 Supabase')
  async function request<T>(table: RemoteTable, init: RequestInit = {}, query = ''): Promise<T> {
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timeout = globalThis.setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(`${endpoint}/rest/v1/${table}${query ? `?${query}` : ''}`, {
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
          await new Promise((resolve) => globalThis.setTimeout(resolve, 250 * attempt))
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
  }
}
