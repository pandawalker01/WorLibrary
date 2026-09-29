import { useEffect, useState } from 'react'
import { getSession, isAuthConfigured, onAuthStateChange, sendMagicLink, signInAnonymously, signOut, type AuthSession } from '../lib/auth'

type AuthPanelProps = { onNotice?: (message: string) => void; onSessionChange?: (session: AuthSession | null) => void }

export default function AuthPanel({ onNotice, onSessionChange }: AuthPanelProps) {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getSession().then((next) => { setSession(next); onSessionChange?.(next) }); return onAuthStateChange((next) => { setSession(next); onSessionChange?.(next) }) }, [onSessionChange])
  if (!isAuthConfigured()) return <section aria-label="账号同步"><h2>账号与同步</h2><p>尚未配置云端同步，当前数据仅保存在本地设备。</p></section>
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true)
    try { await action(); onNotice?.(success) } catch (error) { onNotice?.(error instanceof Error ? error.message : '操作失败，请稍后重试') } finally { setBusy(false) }
  }
  if (session) return <section aria-label="账号同步"><h2>账号与同步</h2><p>{session.user.isAnonymous ? '匿名试用' : session.user.email}</p><button disabled={busy} onClick={() => { void run(async () => { await signOut(); setSession(null); onSessionChange?.(null) }, '已退出登录') }}>退出登录</button></section>
  return <section aria-label="账号同步"><h2>账号与同步</h2><p>注册后可在其他设备恢复进度和摘录，书籍文件仍留在本地。</p><button disabled={busy} onClick={() => { void run(async () => { const next = await signInAnonymously(); setSession(next); onSessionChange?.(next) }, '已开启匿名试用') }}>匿名试用</button><form onSubmit={(event) => { event.preventDefault(); void run(() => sendMagicLink(email), '登录链接已发送，请检查邮箱') }}><label>邮箱 <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><button disabled={busy} type="submit">发送登录链接</button></form></section>
}
