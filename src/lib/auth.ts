export type AuthUser = {
  id: string
  email?: string
  isAnonymous: boolean
  createdAt?: string
}

export type AuthSession = {
  accessToken: string
  refreshToken: string
  expiresAt?: number
  user: AuthUser
}

export type AuthStateListener = (session: AuthSession | null) => void

const sessionKey = 'wor-library.auth.session'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

function configured() {
  return Boolean(supabaseUrl && supabaseAnonKey)
}

function userFromResponse(value: Record<string, unknown>): AuthUser {
  const user = (value.user ?? value) as Record<string, unknown>
  const appMetadata = (user.app_metadata ?? {}) as Record<string, unknown>
  return {
    id: String(user.id),
    email: typeof user.email === 'string' ? user.email : undefined,
    isAnonymous: appMetadata.is_anonymous === true || user.is_anonymous === true,
    createdAt: typeof user.created_at === 'string' ? user.created_at : undefined,
  }
}

function sessionFromResponse(value: Record<string, unknown>): AuthSession {
  const accessToken = String(value.access_token ?? '')
  const refreshToken = String(value.refresh_token ?? '')
  if (!accessToken || !refreshToken) throw new Error('登录响应缺少会话令牌')
  const expiresIn = typeof value.expires_in === 'number' ? value.expires_in : undefined
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    user: userFromResponse(value),
  }
}

function saveSession(session: AuthSession | null) {
  if (typeof window === 'undefined') return
  if (session) localStorage.setItem(sessionKey, JSON.stringify(session))
  else localStorage.removeItem(sessionKey)
}

/** Consume the Supabase implicit-flow redirect once after a magic-link click. */
async function consumeAuthRedirect(): Promise<AuthSession | null> {
  if (typeof window === 'undefined' || !window.location.hash) return null
  const params = new URLSearchParams(window.location.hash.slice(1))
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) return null
  const rawExpiresIn = Number(params.get('expires_in') ?? '')
  let user: AuthUser = { id: 'magic-link-user', email: params.get('email') ?? undefined, isAnonymous: false }
  if (supabaseUrl && supabaseAnonKey) {
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${accessToken}` } })
      if (response.ok) user = userFromResponse(await response.json() as Record<string, unknown>)
    } catch { /* keep a short-lived fallback identity until the next refresh */ }
  }
  const session: AuthSession = {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(rawExpiresIn) && rawExpiresIn > 0 ? Date.now() + rawExpiresIn * 1000 : undefined,
    user,
  }
  saveSession(session)
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`)
  return session
}

export function getStoredSession(): AuthSession | null {
  if (typeof window === 'undefined') return null
  try {
    const value = localStorage.getItem(sessionKey)
    return value ? JSON.parse(value) as AuthSession : null
  } catch {
    return null
  }
}

async function authRequest(path: string, init: RequestInit = {}) {
  if (!configured()) throw new Error('尚未配置 Supabase，请填写 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY')
  const response = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
    ...init,
    headers: { apikey: supabaseAnonKey!, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.msg === 'string' ? body.msg : typeof body.error_description === 'string' ? body.error_description : '身份服务请求失败')
  return body
}

export async function signInAnonymously(): Promise<AuthSession> {
  const session = sessionFromResponse(await authRequest('signup', { method: 'POST', body: JSON.stringify({ data: { is_anonymous: true } }) }))
  saveSession(session)
  return session
}

function currentMagicLinkRedirect(): string {
  if (typeof window === 'undefined') return ''
  // Routes live in the query string because Supabase returns tokens in the
  // hash. Preserve the current page without ever carrying a stale auth hash
  // into the next magic-link request.
  return `${window.location.origin}${window.location.pathname}${window.location.search}`
}

export async function sendMagicLink(email: string, redirectTo = currentMagicLinkRedirect()): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new Error('请输入有效的邮箱地址')
  await authRequest('otp', { method: 'POST', body: JSON.stringify({ email: normalizedEmail, create_user: true, options: { emailRedirectTo: redirectTo } }) })
}

export async function refreshSession(session = getStoredSession()): Promise<AuthSession | null> {
  if (!session?.refreshToken) return null
  const refreshed = sessionFromResponse(await authRequest('token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refreshToken }) }))
  saveSession(refreshed)
  return refreshed
}

export async function signOut(): Promise<void> {
  const session = getStoredSession()
  if (session && configured()) await authRequest('logout', { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}` } }).catch(() => undefined)
  saveSession(null)
}

export async function getSession(): Promise<AuthSession | null> {
  const session = await consumeAuthRedirect() ?? getStoredSession()
  if (!session) return null
  if (session.expiresAt && session.expiresAt < Date.now() + 30_000) {
    try { return await refreshSession(session) } catch {
      saveSession(null)
      return null
    }
  }
  return session
}

export function onAuthStateChange(listener: AuthStateListener): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = () => { void getSession().then(listener).catch(() => listener(null)) }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function isAuthConfigured() { return configured() }
