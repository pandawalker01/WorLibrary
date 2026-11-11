import type { AuthSession } from './auth'

export type UserFileLibraryState = {
  enabled: boolean
  consented: boolean
  quotaBytes: number
  usedBytes: number
  reservedBytes: number
}

function parseState(value: unknown): UserFileLibraryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PRIVATE_FILE_STATE')
  const row = value as Record<string, unknown>
  const keys = ['enabled', 'consented', 'quotaBytes', 'usedBytes', 'reservedBytes']
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))
    || typeof row.enabled !== 'boolean' || typeof row.consented !== 'boolean'
    || (row.enabled && !row.consented)
    || ['quotaBytes', 'usedBytes', 'reservedBytes'].some((key) => !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) {
    throw new Error('INVALID_PRIVATE_FILE_STATE')
  }
  return { enabled: row.enabled, consented: row.consented, quotaBytes: Number(row.quotaBytes), usedBytes: Number(row.usedBytes), reservedBytes: Number(row.reservedBytes) }
}

/** Dedicated private-file RPCs: never route consent or file bytes through metadata sync. */
export function createUserFileConsentClient(session: AuthSession, config: {
  url?: string
  anonKey?: string
  fetch?: typeof globalThis.fetch
  isCurrent?: () => boolean
} = {}) {
  if (session.user.isAnonymous) throw new Error('STABLE_ACCOUNT_REQUIRED')
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
  const url = (config.url ?? env.VITE_SUPABASE_URL)?.replace(/\/$/, '')
  const anonKey = config.anonKey ?? env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('PRIVATE_FILE_STATE_UNAVAILABLE')
  const request = config.fetch ?? globalThis.fetch
  const check = () => { if (config.isCurrent && !config.isCurrent()) throw new Error('PRIVATE_FILE_SESSION_INVALIDATED') }
  async function rpc(name: 'get_private_file_library_state' | 'set_private_file_library_enabled', body: Record<string, boolean>) {
    check()
    const response = await request(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: anonKey!, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    check()
    if (!response.ok) throw new Error('PRIVATE_FILE_STATE_UNAVAILABLE')
    const value: unknown = await response.json()
    check()
    return parseState(value)
  }
  return {
    getState: () => rpc('get_private_file_library_state', {}),
    setEnabled: (enabled: boolean) => {
      if (typeof enabled !== 'boolean') throw new TypeError('EXPLICIT_PRIVATE_FILE_CHOICE_REQUIRED')
      return rpc('set_private_file_library_enabled', { p_enabled: enabled })
    },
  }
}
