function usableUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value.trim()) ? value.trim().replace(/\/$/, '') : ''
}

function usableKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

// This adapter sends only an already-verified bearer token, request id, kind and
// quota limit to Supabase. It deliberately never receives or stores source text.
export function createSupabaseQuotaStore({ env = {}, fetchImpl = fetch } = {}) {
  const baseUrl = usableUrl(env.SUPABASE_URL)
  const anonKey = usableKey(env.SUPABASE_ANON_KEY)
  if (!baseUrl || !anonKey) return null

  async function call(functionName, accessToken, body) {
    if (!accessToken) throw Object.assign(new Error('verified access token required'), { code: 'quota_store_unavailable' })
    let response
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw Object.assign(new Error('quota store request failed'), { code: 'quota_store_unavailable', cause: error })
    }
    if (!response.ok) throw Object.assign(new Error(`quota store status ${response.status}`), { code: 'quota_store_unavailable' })
    return response.json()
  }

  return {
    async consume({ accessToken, requestId, kind, dailyLimit }) {
      const payload = await call('consume_ai_quota', accessToken, { p_request_id: requestId, p_kind: kind, p_daily_limit: dailyLimit })
      const row = Array.isArray(payload) ? payload[0] : payload
      if (!row || typeof row.allowed !== 'boolean' || typeof row.charged !== 'boolean' || !Number.isInteger(Number(row.used))) {
        throw Object.assign(new Error('invalid quota store response'), { code: 'quota_store_unavailable' })
      }
      return { allowed: row.allowed, charged: row.charged, used: Number(row.used) }
    },
    async release({ accessToken, requestId }) {
      const payload = await call('release_ai_quota', accessToken, { p_request_id: requestId })
      const row = Array.isArray(payload) ? payload[0] : payload
      if (typeof row !== 'boolean') throw Object.assign(new Error('invalid quota release response'), { code: 'quota_store_unavailable' })
      return row
    },
  }
}
