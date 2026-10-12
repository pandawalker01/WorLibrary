import { useEffect, useState } from 'react'
import { getSession, isAuthConfigured, onAuthStateChange, sendMagicLink, signInAnonymously, signOut, type AuthSession } from '../lib/auth'
import { getSyncActivity, type SyncActivity } from '../lib/sync'
import { copy, type UiLocale } from '../lib/i18n'

type AuthPanelProps = { uiLocale: UiLocale; onNotice?: (message: string) => void; onSessionChange?: (session: AuthSession | null) => void }

export default function AuthPanel({ uiLocale, onNotice, onSessionChange }: AuthPanelProps) {
  const ui = copy[uiLocale]
  const en = uiLocale === 'en'
  const [session, setSession] = useState<AuthSession | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncActivity, setSyncActivity] = useState<SyncActivity>(() => getSyncActivity())
  useEffect(() => { void getSession().then((next) => { setSession(next); onSessionChange?.(next) }); return onAuthStateChange((next) => { setSession(next); onSessionChange?.(next) }) }, [onSessionChange])
  useEffect(() => {
    const refresh = () => setSyncActivity(getSyncActivity())
    window.addEventListener('worlibrary:sync-status', refresh)
    return () => window.removeEventListener('worlibrary:sync-status', refresh)
  }, [])
  const privacy = <p className="sync-privacy">{ui.syncPrivacy}</p>
  const status = (() => {
    if (!isAuthConfigured()) return ui.syncLocal
    if (!session) return en ? 'Signed out · data stays on this device' : '未登录 · 当前仅保存在本机'
    if (syncActivity.phase === 'syncing') return en ? 'Syncing · updating reading data' : '同步中 · 正在同步阅读数据'
    if (syncActivity.phase === 'success') return en ? 'Synced · reading data is up to date' : '同步成功 · 阅读数据已更新'
    if (syncActivity.phase === 'failed') return `${en ? 'Sync failed, will retry' : '同步失败，待重试'} · ${syncActivity.error ?? (en ? 'Check your network or account permissions' : '请检查网络或账号权限')}`
    return en ? 'Sync ready · reading data syncs after changes' : '同步就绪 · 阅读数据将在变更后同步'
  })()
  if (!isAuthConfigured()) return <section aria-label={ui.accountSync}><h2>{ui.accountSync}</h2><p role="status">{status}</p>{privacy}</section>
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true)
    try { await action(); onNotice?.(success) } catch (error) { onNotice?.(error instanceof Error ? error.message : (en ? 'Action failed. Please try again.' : '操作失败，请稍后重试')) } finally { setBusy(false) }
  }
  if (session) return <section aria-label={ui.accountSync}><h2>{ui.accountSync}</h2><p>{session.user.isAnonymous ? (en ? 'Anonymous trial' : '匿名试用') : session.user.email}</p><p role="status">{status}</p>{privacy}<button disabled={busy} onClick={() => { void run(async () => { await signOut(); setSession(null); onSessionChange?.(null) }, en ? 'Signed out' : '已退出登录') }}>{en ? 'Sign out' : '退出登录'}</button></section>
  return <section aria-label={ui.accountSync}><h2>{ui.accountSync}</h2><p role="status">{status}</p>{privacy}<button disabled={busy} onClick={() => { void run(async () => { const next = await signInAnonymously(); setSession(next); onSessionChange?.(next) }, en ? 'Anonymous trial started' : '已开启匿名试用') }}>{en ? 'Try anonymously' : '匿名试用'}</button><form onSubmit={(event) => { event.preventDefault(); void run(() => sendMagicLink(email), en ? 'Sign-in link sent. Check your email.' : '登录链接已发送，请检查邮箱') }}><label>{en ? 'Email' : '邮箱'} <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><button disabled={busy} type="submit">{en ? 'Send sign-in link' : '发送登录链接'}</button></form></section>
}
