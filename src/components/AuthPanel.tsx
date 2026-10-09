import { useEffect, useState } from 'react'
import { getSession, isAuthConfigured, onAuthStateChange, sendMagicLink, signInAnonymously, signOut, type AuthSession } from '../lib/auth'
import { getSyncActivity, type SyncActivity } from '../lib/sync'

type AuthPanelProps = { onNotice?: (message: string) => void; onSessionChange?: (session: AuthSession | null) => void }

export default function AuthPanel({ onNotice, onSessionChange }: AuthPanelProps) {
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
  const privacy = <p className="sync-privacy">仅同步阅读进度、摘录与书籍信息；原始 EPUB/PDF 文件和封面始终留在本机。</p>
  const status = (() => {
    if (!isAuthConfigured()) return '本地优先 · 尚未配置云端同步'
    if (!session) return '未登录 · 当前仅保存在本机'
    if (syncActivity.phase === 'syncing') return '同步中 · 正在同步阅读数据'
    if (syncActivity.phase === 'success') return '同步成功 · 阅读数据已更新'
    if (syncActivity.phase === 'failed') return `同步失败，待重试 · ${syncActivity.error ?? '请检查网络或账号权限'}`
    return '同步就绪 · 阅读数据将在变更后同步'
  })()
  if (!isAuthConfigured()) return <section aria-label="账号同步"><h2>账号与同步</h2><p role="status">{status}</p>{privacy}</section>
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true)
    try { await action(); onNotice?.(success) } catch (error) { onNotice?.(error instanceof Error ? error.message : '操作失败，请稍后重试') } finally { setBusy(false) }
  }
  if (session) return <section aria-label="账号同步"><h2>账号与同步</h2><p>{session.user.isAnonymous ? '匿名试用' : session.user.email}</p><p role="status">{status}</p>{privacy}<button disabled={busy} onClick={() => { void run(async () => { await signOut(); setSession(null); onSessionChange?.(null) }, '已退出登录') }}>退出登录</button></section>
  return <section aria-label="账号同步"><h2>账号与同步</h2><p role="status">{status}</p>{privacy}<button disabled={busy} onClick={() => { void run(async () => { const next = await signInAnonymously(); setSession(next); onSessionChange?.(next) }, '已开启匿名试用') }}>匿名试用</button><form onSubmit={(event) => { event.preventDefault(); void run(() => sendMagicLink(email), '登录链接已发送，请检查邮箱') }}><label>邮箱 <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><button disabled={busy} type="submit">发送登录链接</button></form></section>
}
