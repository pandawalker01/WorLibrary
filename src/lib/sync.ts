import type { Highlight, StoredBook } from './storage'
import type { RemoteClient } from './remote'

export type SyncSnapshot = {
  books: StoredBook[]
  highlights: Highlight[]
  settings?: Record<string, unknown>
}

export type LocalSyncAdapter = {
  read(): Promise<SyncSnapshot>
  write(snapshot: SyncSnapshot): Promise<void>
}

type SyncQueueState = { pending: boolean; attempts: number; nextAttemptAt: number; lastError?: string }
export type SyncActivity = {
  phase: 'idle' | 'syncing' | 'success' | 'failed'
  updatedAt: number
  error?: string
}
const syncQueueKey = 'wor-library.sync.queue'
const deletionQueueKey = 'wor-library.sync.deleted-highlights'
const syncActivityKey = 'wor-library.sync.activity'

function readQueue(): SyncQueueState {
  if (typeof localStorage === 'undefined') return { pending: false, attempts: 0, nextAttemptAt: 0 }
  try { return JSON.parse(localStorage.getItem(syncQueueKey) ?? '') as SyncQueueState } catch { return { pending: false, attempts: 0, nextAttemptAt: 0 } }
}

function writeQueue(state: SyncQueueState) { if (typeof localStorage !== 'undefined') localStorage.setItem(syncQueueKey, JSON.stringify(state)) }
export function enqueueSync() { writeQueue({ ...readQueue(), pending: true, nextAttemptAt: 0 }) }
export function getSyncQueueState(): SyncQueueState { return readQueue() }

export function getSyncActivity(): SyncActivity {
  if (typeof localStorage === 'undefined') return { phase: 'idle', updatedAt: 0 }
  try {
    const value = JSON.parse(localStorage.getItem(syncActivityKey) ?? '') as Partial<SyncActivity>
    if (value.phase === 'syncing' || value.phase === 'success' || value.phase === 'failed' || value.phase === 'idle') return { phase: value.phase, updatedAt: Number(value.updatedAt) || 0, error: typeof value.error === 'string' ? value.error : undefined }
  } catch { /* use the default local-only state */ }
  return { phase: 'idle', updatedAt: 0 }
}

function writeSyncActivity(activity: SyncActivity) {
  if (typeof window === 'undefined') return
  localStorage.setItem(syncActivityKey, JSON.stringify(activity))
  window.dispatchEvent(new Event('worlibrary:sync-status'))
}

let activeFlush: Promise<{ uploaded: number; downloaded: number }> | undefined

function readDeletedHighlights(): string[] {
  if (typeof localStorage === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(deletionQueueKey) ?? '[]') as string[] } catch { return [] }
}

function queueDeletedHighlight(id: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(deletionQueueKey, JSON.stringify([...new Set([...readDeletedHighlights(), id])]))
}

export async function flushQueuedSync(remote: RemoteClient, local: LocalSyncAdapter): Promise<{ uploaded: number; downloaded: number }> {
  if (activeFlush) return activeFlush
  activeFlush = flushQueuedSyncInternal(remote, local)
  try { return await activeFlush } finally { activeFlush = undefined }
}

async function flushQueuedSyncInternal(remote: RemoteClient, local: LocalSyncAdapter): Promise<{ uploaded: number; downloaded: number }> {
  const current = readQueue()
  if (!current.pending) return { uploaded: 0, downloaded: 0 }
  if (current.nextAttemptAt > Date.now()) throw new Error('同步将在稍后自动重试')
  writeSyncActivity({ phase: 'syncing', updatedAt: Date.now() })
  try {
    for (const id of readDeletedHighlights()) await remote.remove('highlights', `id=eq.${encodeURIComponent(id)}`)
    const result = await syncLibrary(remote, local)
    if (typeof localStorage !== 'undefined') localStorage.removeItem(deletionQueueKey)
    writeQueue({ pending: false, attempts: 0, nextAttemptAt: 0 })
    writeSyncActivity({ phase: 'success', updatedAt: Date.now() })
    return result
  } catch (error) {
    const attempts = current.attempts + 1
    const delay = Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1000)
    const message = error instanceof Error ? error.message : '同步失败'
    writeQueue({ pending: true, attempts, nextAttemptAt: Date.now() + delay, lastError: message })
    writeSyncActivity({ phase: 'failed', updatedAt: Date.now(), error: message })
    throw error
  }
}

export async function deleteRemoteHighlight(remote: RemoteClient, id: string): Promise<void> {
  try { await remote.remove('highlights', `id=eq.${encodeURIComponent(id)}`) }
  catch (error) { queueDeletedHighlight(id); throw error }
}

const databaseName = 'wor-library'
const databaseVersion = 2
const booksStore = 'books'
const highlightsStore = 'highlights'

function openLocalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(booksStore)) db.createObjectStore(booksStore, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(highlightsStore)) db.createObjectStore(highlightsStore, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function readStore<T>(storeName: string): Promise<T[]> {
  return openLocalDatabase().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result as T[])
  }))
}

function replaceStore<T>(storeName: string, values: T[]): Promise<void> {
  return openLocalDatabase().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    for (const value of values) store.put(value)
    transaction.onerror = () => reject(transaction.error)
    transaction.oncomplete = () => resolve()
  }))
}

/** Adapter for the existing IndexedDB stores; book blobs are never uploaded. */
export function createIndexedDbSyncAdapter(): LocalSyncAdapter {
  return {
    async read() {
      let settings: Record<string, unknown> | undefined
      if (typeof localStorage !== 'undefined') {
        try { settings = JSON.parse(localStorage.getItem('wor-library.settings') ?? 'null') as Record<string, unknown> | undefined ?? undefined } catch { settings = undefined }
      }
      return { books: await readStore<StoredBook>(booksStore), highlights: await readStore<Highlight>(highlightsStore), settings }
    },
    async write(snapshot) {
      await replaceStore(booksStore, snapshot.books)
      await replaceStore(highlightsStore, snapshot.highlights)
      if (snapshot.settings && typeof localStorage !== 'undefined') localStorage.setItem('wor-library.settings', JSON.stringify(snapshot.settings))
    },
  }
}

type SyncRow = Record<string, unknown> & { id: string; updated_at: string }

function toBookRow(book: StoredBook): SyncRow {
  return { id: book.id, title: book.title, author: book.author, language: book.language, progress: book.progress, location: book.location ?? null, file_name: book.fileName, file_type: book.fileType, file_size: book.fileSize, cover: book.cover, created_at: new Date(book.createdAt).toISOString(), updated_at: new Date(book.createdAt).toISOString() }
}

function toHighlightRow(highlight: Highlight): SyncRow {
  return { id: highlight.id, book_id: highlight.bookId, edition_id: highlight.bookId, text: highlight.text, location: highlight.location, note: highlight.note ?? null, color: highlight.color, created_at: new Date(highlight.createdAt).toISOString(), updated_at: new Date(highlight.updatedAt ?? highlight.createdAt).toISOString() }
}

export async function syncLibrary(remote: RemoteClient, local: LocalSyncAdapter): Promise<{ uploaded: number; downloaded: number }> {
  const snapshot = await local.read()
  const [remoteBooks, remoteHighlights] = await Promise.all([remote.select<SyncRow>('editions'), remote.select<SyncRow>('highlights')])
  const books = new Map(snapshot.books.map((book) => [book.id, book]))
  for (const row of remoteBooks) {
    const remoteBook: StoredBook = { id: row.id, title: String(row.title), author: String(row.author), language: String(row.language), progress: Number(row.progress ?? 0), location: typeof row.location === 'string' ? row.location : undefined, fileName: String(row.file_name ?? ''), fileType: String(row.file_type ?? ''), fileSize: Number(row.file_size ?? 0), storage: 'indexeddb', cover: row.cover === 'sun' || row.cover === 'red' ? row.cover : 'ink', createdAt: Date.parse(String(row.created_at)) || Date.now() }
    const current = books.get(remoteBook.id)
    if (!current || Date.parse(row.updated_at) > current.createdAt) books.set(remoteBook.id, remoteBook)
  }
  const highlights = new Map(snapshot.highlights.map((highlight) => [highlight.id, highlight]))
  for (const row of remoteHighlights) {
    const createdAt = Date.parse(String(row.created_at)) || Date.now()
    const updatedAt = Date.parse(String(row.updated_at)) || createdAt
    const remoteHighlight: Highlight = { id: row.id, bookId: String(row.book_id ?? row.edition_id), text: String(row.text), location: String(row.location), note: typeof row.note === 'string' ? row.note : undefined, color: row.color === 'rose' || row.color === 'blue' ? row.color : 'gold', createdAt, updatedAt }
    const current = highlights.get(remoteHighlight.id)
    if (!current || updatedAt > (current.updatedAt ?? current.createdAt)) highlights.set(remoteHighlight.id, remoteHighlight)
  }
  const merged = { ...snapshot, books: [...books.values()], highlights: [...highlights.values()] }
  // Upload the merged view, never the stale local snapshot. This preserves the
  // last-write-wins decision when another device has newer data.
  await remote.upsert('editions', merged.books.map(toBookRow))
  await remote.upsert('highlights', merged.highlights.map(toHighlightRow))
  await local.write(merged)
  return { uploaded: snapshot.books.length + snapshot.highlights.length, downloaded: Math.max(0, merged.books.length - snapshot.books.length) + Math.max(0, merged.highlights.length - snapshot.highlights.length) }
}

export async function deleteRemoteAccount(remote: RemoteClient, userId: string): Promise<void> {
  await Promise.all(['editions', 'highlights', 'reading_progress', 'user_settings', 'devices', 'works'].map((table) => remote.remove(table as Parameters<RemoteClient['remove']>[0], `user_id=eq.${encodeURIComponent(userId)}`)))
}
