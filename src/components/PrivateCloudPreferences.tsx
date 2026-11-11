import { useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import type { UiLocale } from '../lib/i18n'
import { privateCloudCopy } from '../lib/private-cloud-copy'
import { createUserFileConsentClient, type UserFileLibraryState } from '../lib/user-file-consent'
import './private-cloud.css'
import PrivateCloudDeletionJobs from './PrivateCloudDeletionJobs'

export default function PrivateCloudPreferences({ session, uiLocale }: { session: AuthSession; uiLocale: UiLocale }) {
  const text = privateCloudCopy(uiLocale)
  const [state, setState] = useState<UserFileLibraryState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const currentSession = useRef(session)
  currentSession.current = session
  const mounted = useRef(false)
  const activeRequest = useRef(0)
  const busyRef = useRef(false)
  const refreshQueued = useRef(false)
  const controllers = useRef(new Set<AbortController>())
  const focusBeforeDialog = useRef<HTMLElement | null>(null)
  const checkbox = useRef<HTMLInputElement>(null)

  async function request(enabled?: boolean) {
    if (session.user.isAnonymous) return
    if (busyRef.current) { if (enabled === undefined) refreshQueued.current = true; return }
    busyRef.current = true; setBusy(true); setError('')
    const run = ++activeRequest.current
    const isCurrent = () => mounted.current && currentSession.current === session && activeRequest.current === run
    const controller = new AbortController(); controllers.current.add(controller)
    const timer = window.setTimeout(() => controller.abort(), 8000)
    try {
      const client = createUserFileConsentClient(session, { isCurrent, fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }) })
      const next = enabled === undefined ? await client.getState() : await client.setEnabled(enabled)
      if (!isCurrent()) return
      setState(next)
      if (enabled !== undefined) { setDialog(false); setAgreed(false); focusBeforeDialog.current?.focus() }
    } catch {
      if (isCurrent()) { setState(null); setError(enabled === undefined ? 'unavailable' : 'saveFailed') }
    } finally {
      window.clearTimeout(timer); controllers.current.delete(controller)
      if (isCurrent()) {
        busyRef.current = false; setBusy(false)
        if (refreshQueued.current) { refreshQueued.current = false; void request() }
      }
    }
  }

  useEffect(() => {
    mounted.current = true; busyRef.current = false; refreshQueued.current = false; setState(null); setDialog(false); setAgreed(false)
    void request()
    return () => {
      mounted.current = false; activeRequest.current++
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
    }
  }, [session])

  useEffect(() => { if (dialog) checkbox.current?.focus() }, [dialog])
  const closeDialog = () => {
    if (busyRef.current) return
    setDialog(false); setAgreed(false); focusBeforeDialog.current?.focus()
  }
  const format = (bytes: number) => `${new Intl.NumberFormat(uiLocale, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`
  const open = () => { focusBeforeDialog.current = document.activeElement as HTMLElement; setAgreed(false); setDialog(true) }

  return <section className="private-cloud-card" aria-labelledby="private-cloud-title" data-testid="private-cloud-preferences">
    <h2 id="private-cloud-title">{text.title}</h2>
    <p role="status">{busy ? (state ? text.saving : text.loading) : !state && !error ? text.loading : error ? text[error as 'unavailable' | 'saveFailed'] : state?.enabled ? text.enabled : state?.consented ? text.paused : text.disabled}</p>
    <p>{text.scope}</p>
    {state && <>
      <p>{text.usage}: {format(state.usedBytes)} / {format(state.quotaBytes)} · {text.reserved}: {format(state.reservedBytes)}</p>
      {state.consented && <p>{text.pausedCopy}</p>}
    </>}
    <button type="button" disabled={busy} onClick={() => {
      if (!state) void request()
      else if (state.enabled) void request(false)
      else if (state.consented) void request(true)
      else open()
    }}>{busy ? text.saving : !state ? text.retry : state.enabled ? text.pause : state.consented ? text.resume : text.enable}</button>
    <PrivateCloudDeletionJobs key={session.user.id} session={session} uiLocale={uiLocale} onSettled={() => { void request() }} />
    {dialog && <div className="auth-dialog-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) closeDialog() }}>
      <section className="auth-dialog private-cloud-consent" role="dialog" aria-modal="true" aria-labelledby="private-cloud-consent-title" tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); closeDialog() }
          if (event.key === 'Tab') {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')]
            if (!controls.length) { event.preventDefault(); event.currentTarget.focus(); return }
            const next = event.shiftKey ? controls.at(-1) : controls[0]
            if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) { event.preventDefault(); next?.focus() }
          }
        }}>
        <h2 id="private-cloud-consent-title">{text.consentTitle}</h2><p>{text.consentCopy}</p>
        {error && <p role="alert">{text.saveFailed}</p>}
        <label><input ref={checkbox} type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} />{text.agree}</label>
        <div><button type="button" disabled={busy} onClick={closeDialog}>{error ? text.close : text.cancel}</button>{error ? <button type="button" onClick={() => { closeDialog(); void request() }}>{text.reload}</button> : <button type="button" disabled={!agreed || busy} onClick={() => { if (agreed) void request(true) }}>{busy ? text.saving : text.confirm}</button>}</div>
      </section>
    </div>}
  </section>
}
