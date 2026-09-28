import type { AuthSession } from './auth'

export type RemoteTable = 'works' | 'editions' | 'reading_progress' | 'highlights' | 'user_settings' | 'devices'

export type RemoteClient = {
  select<T>(table: RemoteTable, query?: string): Promise<T[]>
  upsert<T extends Record<string, unknown>>(table: RemoteTable, rows: T | T[]): Promise<T[]>
  remove(table: RemoteTable, query: string): Promise<void>
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export function createRemoteClient(session: AuthSession): RemoteClient {
  if (!url || !anonKey) throw new Error('尚未配置 Supabase')
  async function request<T>(table: RemoteTable, init: RequestInit = {}, query = ''): Promise<T> {
    const response = await fetch(`${url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      ...init,
      headers: {
        apikey: anonKey!, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`同步请求失败（${response.status}）：${detail.slice(0, 200)}`)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
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
