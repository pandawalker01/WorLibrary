import type { AuthSession } from './auth'
import { assertOwnedEditionId } from './user-file-library'

export type PrivateFileDeletion = {
  userId: string; manifestId: string; editionId: string; label: string
  state: 'pending' | 'deleting' | 'failed'
}
export type PrivateFileDeletionStore = {
  list(userId: string): Promise<PrivateFileDeletion[]>
  put(job: PrivateFileDeletion): Promise<void>
  remove(userId: string, manifestId: string): Promise<void>
}
export const PRIVATE_DELETION_CHANGED = 'worlibrary:private-deletion-changed'
const notify = (userId: string) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PRIVATE_DELETION_CHANGED, { detail: { userId } }))
}
const validLabel = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f]/.test(value)
function validate(job: PrivateFileDeletion) {
  if (Object.keys(job).length !== 5 || Object.keys(job).some(key => !['userId', 'manifestId', 'editionId', 'label', 'state'].includes(key))) throw new Error('INVALID_PRIVATE_DELETION')
  assertOwnedEditionId(job.userId); assertOwnedEditionId(job.manifestId); assertOwnedEditionId(job.editionId)
  if (!validLabel(job.label) || !['pending', 'deleting', 'failed'].includes(job.state)) throw new Error('INVALID_PRIVATE_DELETION')
}

/** Persist before issuing DELETE. Suppression is still enforced by the client. */
export async function runPrivateFileDeletion(options: {
  job: PrivateFileDeletion; store: PrivateFileDeletionStore; isCurrent: () => boolean
  client: { deleteFromCloud(manifestId: string, editionId: string): Promise<'deleting' | 'deleted'> }
}): Promise<'deleting' | 'deleted'> {
  const { job, store, isCurrent, client } = options
  const check = () => { if (!isCurrent()) throw new Error('PRIVATE_DELETION_INVALIDATED') }
  validate(job); check()
  await store.put({ ...job, state: 'pending' }); notify(job.userId); check()
  try {
    const status = await client.deleteFromCloud(job.manifestId, job.editionId)
    check()
    if (status === 'deleted') await store.remove(job.userId, job.manifestId)
    else if (status === 'deleting') await store.put({ ...job, state: 'deleting' })
    else throw new Error('INVALID_PRIVATE_DELETION_RESPONSE')
    check(); notify(job.userId)
    return status
  } catch (error) {
    if (isCurrent()) { await store.put({ ...job, state: 'failed' }); notify(job.userId) }
    throw error
  }
}

/** Separate IDB avoids Agent B's metadata schema and contains no file bytes. */
export function createPrivateFileDeletionStore(): PrivateFileDeletionStore {
  async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('worlibrary-private-deletions', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('jobs')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('PRIVATE_DELETION_STORAGE_BLOCKED'))
    })
    try { return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('jobs', mode); const request = work(tx.objectStore('jobs'))
      tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('PRIVATE_DELETION_STORAGE_ABORTED'))
    }) } finally { db.close() }
  }
  const key = (userId: string, manifestId: string) => `${userId}:${manifestId}`
  return {
    list: async userId => {
      assertOwnedEditionId(userId)
      const rows = await transaction<PrivateFileDeletion[]>('readonly', store => store.getAll(IDBKeyRange.bound(`${userId}:`, `${userId}:\uffff`)))
      return rows.filter(row => {
        if (row?.userId !== userId) return false
        try { validate(row); return true } catch { return false }
      })
    },
    put: async job => { validate(job); await transaction('readwrite', store => store.put(job, key(job.userId, job.manifestId))) },
    remove: async (userId, manifestId) => {
      assertOwnedEditionId(userId); assertOwnedEditionId(manifestId)
      await transaction('readwrite', store => store.delete(key(userId, manifestId)))
    },
  }
}

export async function listRemotePrivateFileDeletions(session: AuthSession, config: {
  url?: string; anonKey?: string; fetch?: typeof globalThis.fetch; isCurrent?: () => boolean
} = {}): Promise<PrivateFileDeletion[]> {
  if (session.user.isAnonymous) throw new Error('STABLE_ACCOUNT_REQUIRED')
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
  const url = (config.url ?? env.VITE_SUPABASE_URL)?.replace(/\/$/, '')
  const anonKey = config.anonKey ?? env.VITE_SUPABASE_ANON_KEY
  const check = () => { if (config.isCurrent && !config.isCurrent()) throw new Error('PRIVATE_DELETION_INVALIDATED') }
  if (!url || !anonKey) throw new Error('PRIVATE_DELETION_STATUS_UNAVAILABLE')
  check()
  const response = await (config.fetch ?? globalThis.fetch)(`${url}/rest/v1/rpc/list_private_file_cleanup_jobs`, {
    method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, body: '{}',
  })
  check()
  if (!response.ok) throw new Error('PRIVATE_DELETION_STATUS_UNAVAILABLE')
  const rows: unknown = await response.json(); check()
  if (!Array.isArray(rows)) throw new Error('INVALID_PRIVATE_DELETION_STATUS')
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 3 || Object.keys(row).some(key => !['manifestId', 'editionId', 'fileName'].includes(key))) throw new Error('INVALID_PRIVATE_DELETION_STATUS')
    const job: PrivateFileDeletion = { userId: session.user.id, manifestId: row.manifestId, editionId: row.editionId, label: row.fileName, state: 'deleting' }
    validate(job); return job
  })
}
