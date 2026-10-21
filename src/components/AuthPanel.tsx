import { useEffect, useState } from 'react'
import { getSession, isAuthConfigured, onAuthStateChange, sendMagicLink, signInAnonymously, signOut, type AuthSession } from '../lib/auth'
import { getSyncActivity, type SyncActivity } from '../lib/sync'
import { copy, type UiLocale } from '../lib/i18n'

type AuthPanelProps = { uiLocale: UiLocale; onNotice?: (message: string) => void; onSessionChange?: (session: AuthSession | null) => void; autoFocusEmail?: boolean }

export default function AuthPanel({ uiLocale, onNotice, onSessionChange, autoFocusEmail = false }: AuthPanelProps) {
  const ui = copy[uiLocale]
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
    if (!session) return ui.syncSignedOut
    if (session.user.isAnonymous) return ui.syncAnonymousUnavailable
    if (syncActivity.phase === 'syncing') return ui.syncMetadataInProgress
    if (syncActivity.phase === 'success') return ui.syncMetadataSuccess
    if (syncActivity.phase === 'failed') return `${ui.syncMetadataFailed} · ${syncActivity.error ?? ui.syncPermissionHelp}`
    return ui.syncPreview
  })()
  if (!isAuthConfigured()) return <section aria-label={ui.accountSync}><h2>{ui.accountSync}</h2><p role="status">{status}</p>{privacy}</section>
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true)
    try { await action(); onNotice?.(success) } catch (error) { onNotice?.(error instanceof Error ? error.message : ui.actionFailed) } finally { setBusy(false) }
  }
  if (session) return <section aria-label={ui.accountSync}><h2>{ui.accountSync}</h2><p>{session.user.isAnonymous ? ui.anonymousTrial : session.user.email}</p><p role="status">{status}</p>{session.user.isAnonymous ? <p className="sync-privacy">{ui.anonymousMigrationUnavailable}</p> : privacy}<button disabled={busy} onClick={() => { void run(async () => { await signOut(); setSession(null); onSessionChange?.(null) }, ui.syncSignedOut) }}>{ui.signOutAction}</button></section>
  return <section aria-label={ui.accountSync}><h2>{ui.accountSync}</h2><p role="status">{status}</p>{privacy}<button disabled={busy} onClick={() => { void run(async () => { const next = await signInAnonymously(); setSession(next); onSessionChange?.(next) }, ui.anonymousTrial) }}>{ui.tryAnonymous}</button><form onSubmit={(event) => { event.preventDefault(); void run(() => sendMagicLink(email), ui.magicLinkSent) }}><label>{ui.emailLabel} <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus={autoFocusEmail} /></label><button disabled={busy} type="submit">{ui.sendMagicLink}</button></form></section>
}
