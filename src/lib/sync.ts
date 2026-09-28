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

type SyncRow = Record<string, unknown> & { id: string; updated_at: string }

function toBookRow(book: StoredBook): SyncRow {
  return { id: book.id, title: book.title, author: book.author, language: book.language, progress: book.progress, location: book.location ?? null, file_name: book.fileName, file_type: book.fileType, file_size: book.fileSize, cover: book.cover, created_at: new Date(book.createdAt).toISOString(), updated_at: new Date(book.createdAt).toISOString() }
}

function toHighlightRow(highlight: Highlight): SyncRow {
  return { id: highlight.id, book_id: highlight.bookId, text: highlight.text, location: highlight.location, note: highlight.note ?? null, color: highlight.color, created_at: new Date(highlight.createdAt).toISOString(), updated_at: new Date(highlight.createdAt).toISOString() }
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
    const remoteHighlight: Highlight = { id: row.id, bookId: String(row.book_id), text: String(row.text), location: String(row.location), note: typeof row.note === 'string' ? row.note : undefined, color: row.color === 'rose' || row.color === 'blue' ? row.color : 'gold', createdAt: Date.parse(String(row.created_at)) || Date.now() }
    const current = highlights.get(remoteHighlight.id)
    if (!current || remoteHighlight.createdAt > current.createdAt) highlights.set(remoteHighlight.id, remoteHighlight)
  }
  await remote.upsert('editions', snapshot.books.map(toBookRow))
  await remote.upsert('highlights', snapshot.highlights.map(toHighlightRow))
  const merged = { ...snapshot, books: [...books.values()], highlights: [...highlights.values()] }
  await local.write(merged)
  return { uploaded: snapshot.books.length + snapshot.highlights.length, downloaded: Math.max(0, merged.books.length - snapshot.books.length) + Math.max(0, merged.highlights.length - snapshot.highlights.length) }
}

export async function deleteRemoteAccount(remote: RemoteClient, userId: string): Promise<void> {
  await Promise.all(['editions', 'highlights', 'reading_progress', 'user_settings', 'devices', 'works'].map((table) => remote.remove(table as Parameters<RemoteClient['remove']>[0], `user_id=eq.${encodeURIComponent(userId)}`)))
}
