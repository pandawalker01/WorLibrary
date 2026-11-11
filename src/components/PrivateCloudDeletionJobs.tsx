import { useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import type { UiLocale } from '../lib/i18n'
import { privateCloudCopy } from '../lib/private-cloud-copy'
import { createUserFileClient } from '../lib/user-file-library'
import { createPrivateFileDeletionStore, listRemotePrivateFileDeletions, PRIVATE_DELETION_CHANGED, runPrivateFileDeletion, type PrivateFileDeletion } from '../lib/user-file-delete-task'

export default function PrivateCloudDeletionJobs({ session, uiLocale, onSettled }: { session: AuthSession; uiLocale: UiLocale; onSettled: () => void }) {
  const text = privateCloudCopy(uiLocale)
  const [jobs, setJobs] = useState<PrivateFileDeletion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [notice, setNotice] = useState<'deletePending' | 'deleteFailed' | 'deleteDone' | ''>('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const busy = useRef(false)
  const currentSession = useRef(session); currentSession.current = session
  const settled = useRef(onSettled); settled.current = onSettled
  const mounted = useRef(false); const loadEpoch = useRef(0)
  const sessionEpoch = useRef(0)
  const controllers = useRef(new Set<AbortController>())
  const isCurrent = () => mounted.current && currentSession.current === session

  async function network<T>(work: (request: typeof fetch) => Promise<T>): Promise<T> {
    const controller = new AbortController(); controllers.current.add(controller)
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try { return await work((input, init) => fetch(input, { ...init, signal: controller.signal })) }
    finally { window.clearTimeout(timeout); controllers.current.delete(controller) }
  }
  async function load() {
    const epoch = ++loadEpoch.current
    const results = await Promise.allSettled([
      createPrivateFileDeletionStore().list(session.user.id),
      network(request => listRemotePrivateFileDeletions(session, { fetch: request, isCurrent })),
    ])
    if (!isCurrent() || epoch !== loadEpoch.current) return
    const [local, remote] = results
    const merged = new Map<string, PrivateFileDeletion>()
    if (remote.status === 'fulfilled') for (const job of remote.value) merged.set(job.manifestId, job)
    if (local.status === 'fulfilled') for (const job of local.value) merged.set(job.manifestId, job)
    setJobs([...merged.values()]); setLoadError(results.some(result => result.status === 'rejected')); setLoading(false)
  }
  useEffect(() => {
    mounted.current = true; busy.current = false; setJobs([]); setLoading(true); setNotice(''); setBusyId(null)
    void load()
    const refresh = () => { if (document.visibilityState !== 'hidden') void load() }
    const changed = (event: Event) => { if ((event as CustomEvent<{ userId: string }>).detail?.userId === session.user.id) void load() }
    window.addEventListener(PRIVATE_DELETION_CHANGED, changed); window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      mounted.current = false; loadEpoch.current++
      sessionEpoch.current++
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
      window.removeEventListener(PRIVATE_DELETION_CHANGED, changed); window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [session])
  async function retry(job: PrivateFileDeletion) {
    if (busy.current || !isCurrent()) return
    const epoch = sessionEpoch.current
    const taskCurrent = () => isCurrent() && sessionEpoch.current === epoch
    busy.current = true; setBusyId(job.manifestId); setNotice('')
    try {
      const result = await network(request => runPrivateFileDeletion({ job, store: createPrivateFileDeletionStore(), isCurrent: taskCurrent,
        client: createUserFileClient(session, { fetch: request, isCurrent: taskCurrent }),
      }))
      if (!taskCurrent()) return
      setNotice(result === 'deleted' ? 'deleteDone' : 'deletePending')
      settled.current(); await load()
    } catch {
      if (taskCurrent()) { setNotice('deleteFailed'); await load() }
    } finally {
      if (taskCurrent()) { busy.current = false; setBusyId(null) }
    }
  }
  return <section className="private-cloud-deletions" aria-labelledby="private-cloud-deletions-title" data-testid="private-cloud-deletions">
    <h3 id="private-cloud-deletions-title">{text.deletionTitle}</h3>
    {loading && <p role="status">{text.deletionLoading}</p>}
    {loadError && <p role="status">{text.deletionUnavailable}</p>}
    {notice && <p role="status">{text[notice]}</p>}
    {!loading && !loadError && !jobs.length && <p>{text.deletionEmpty}</p>}
    <ul>{jobs.map(job => <li key={job.manifestId} data-testid={`private-delete-${job.manifestId}`}><span>{job.label}</span> <span>{job.state === 'failed' ? text.deleteFailed : text.deletePending}</span> <button type="button" disabled={busyId !== null} onClick={() => { void retry(job) }} aria-label={`${text.retryDelete} ${job.label}`}>{busyId === job.manifestId ? text.deleting : text.retryDelete}</button></li>)}</ul>
    <button type="button" disabled={busyId !== null} onClick={() => { setLoading(true); void load() }}>{text.reloadDeletions}</button>
  </section>
}
