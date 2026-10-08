export type CoverTone = 'ink' | 'sun' | 'red'

export type StoredBook = {
  id: string
  title: string
  author: string
  language: string
  progress: number
  cover: CoverTone
  fileName: string
  fileType: string
  fileSize: number
  storage: 'opfs' | 'indexeddb'
  createdAt: number
  location?: string
  workId?: string
  editionId?: string
}

export type Highlight = {
  id: string
  bookId: string
  text: string
  location: string
  note?: string
  color: 'gold' | 'rose' | 'blue'
  createdAt: number
  /** Local edit time used only for metadata conflict resolution during sync. */
  updatedAt?: number
}

export type LibraryBackup = { version: 2; exportedAt: string; books: StoredBook[]; highlights: Highlight[]; files: Record<string, string>; works?: Work[]; editions?: Edition[]; alignments?: Alignment[] }

import type { Alignment, Edition, Work } from './edition'

const DB_NAME = 'wor-library'
const DB_VERSION = 4
const BOOKS_STORE = 'books'
const BLOBS_STORE = 'book-blobs'
const HIGHLIGHTS_STORE = 'highlights'
const WORKS_STORE = 'works'
const EDITIONS_STORE = 'editions'
const ALIGNMENTS_STORE = 'alignments'
const TEXT_INDEX_STORE = 'text-index'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('本地书库正在被旧页面占用，请关闭其他 WorLibrary 页面后刷新重试'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BOOKS_STORE)) db.createObjectStore(BOOKS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE)
      if (!db.objectStoreNames.contains(HIGHLIGHTS_STORE)) db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(WORKS_STORE)) db.createObjectStore(WORKS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(EDITIONS_STORE)) db.createObjectStore(EDITIONS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ALIGNMENTS_STORE)) db.createObjectStore(ALIGNMENTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(TEXT_INDEX_STORE)) db.createObjectStore(TEXT_INDEX_STORE, { keyPath: 'bookId' })
    }
    request.onsuccess = () => {
      const db = request.result
      // An older tab must release its connection when a newer schema is ready.
      // Otherwise a future import can wait forever on a blocked upgrade.
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

function transaction<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = operation(tx.objectStore(storeName))
    let value: T
    request.onerror = () => { db.close(); reject(request.error) }
    request.onsuccess = () => { value = request.result }
    tx.oncomplete = () => { db.close(); resolve(value) }
    tx.onabort = () => { db.close(); reject(tx.error ?? request.error) }
    tx.onerror = () => { db.close(); reject(tx.error ?? request.error) }
  }))
}

function titleFromFile(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim() || '未命名书籍'
}

function extensionOf(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

async function ensureEditionForBook(book: StoredBook): Promise<StoredBook> {
  if (book.workId && book.editionId) return book
  const workId = crypto.randomUUID()
  const editionId = crypto.randomUUID()
  const migratedBook = { ...book, workId, editionId }
  const work: Work = { id: workId, title: book.title, author: book.author, editionIds: [editionId] }
  const extension = extensionOf(book.fileName)
  const edition: Edition = { id: editionId, workId, label: book.title, language: book.language, format: (['epub', 'pdf', 'mobi', 'cbz'].includes(extension) ? extension : 'epub') as Edition['format'], bookId: book.id, progress: book.progress, location: book.location }
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.put(migratedBook))
  await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put(edition))
  return migratedBook
}

async function writeToOpfs(id: string, file: File) {
  const storageManager = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>
  }
  if (!storageManager.getDirectory) return false
  const root = await storageManager.getDirectory()
  const handle = await root.getFileHandle(`${id}-${file.name}`, { create: true })
  const writable = await handle.createWritable()
  await writable.write(file)
  await writable.close()
  return true
}

export async function listBooks(): Promise<StoredBook[]> {
  const books = await transaction<StoredBook[]>('books', 'readonly', (store) => store.getAll())
  const migrated = await Promise.all(books.map(ensureEditionForBook))
  return migrated.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBook(file: File, index: number): Promise<StoredBook> {
  const extension = extensionOf(file.name)
  if (!['epub', 'pdf'].includes(extension)) throw new Error(`暂不支持 .${extension || 'unknown'} 文件，目前仅支持 EPUB 和 PDF`)
  if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} 超过 100 MB 限制`)
  const existing = await listBooks()
  if (existing.some((book) => book.fileName === file.name && book.fileSize === file.size)) {
    throw new Error(`${file.name} 已在书库中，无需重复导入`)
  }

  const id = crypto.randomUUID()
  let storage: StoredBook['storage'] = 'indexeddb'
  try {
    storage = await writeToOpfs(id, file) ? 'opfs' : 'indexeddb'
  } catch {
    storage = 'indexeddb'
  }
  if (storage === 'indexeddb') await transaction('book-blobs', 'readwrite', (store) => store.put(file, id))

  const book: StoredBook = {
    id,
    title: titleFromFile(file.name),
    author: '本地导入',
    language: `本地 · ${extension.toUpperCase()}`,
    progress: 0,
    cover: (['ink', 'sun', 'red'] as CoverTone[])[index % 3],
    fileName: file.name,
    fileType: file.type || `application/${extension}`,
    fileSize: file.size,
    storage,
    createdAt: Date.now(),
  }
  const workId = crypto.randomUUID()
  const editionId = crypto.randomUUID()
  book.workId = workId
  book.editionId = editionId
  await transaction('books', 'readwrite', (store) => store.put(book))
  const work: Work = { id: workId, title: book.title, author: book.author, editionIds: [editionId] }
  const edition: Edition = { id: editionId, workId, label: book.title, language: book.language, format: extension as Edition['format'], bookId: book.id, progress: 0 }
  await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put(edition))
  return book
}

export async function listWorks(): Promise<Work[]> {
  return transaction<Work[]>(WORKS_STORE, 'readonly', (store) => store.getAll())
}

export async function listEditions(workId?: string): Promise<Edition[]> {
  const editions = await transaction<Edition[]>(EDITIONS_STORE, 'readonly', (store) => store.getAll())
  return editions.filter((edition) => !workId || edition.workId === workId)
}

export async function listAlignments(workId?: string): Promise<Alignment[]> {
  const alignments = await transaction<Alignment[]>(ALIGNMENTS_STORE, 'readonly', (store) => store.getAll())
  return alignments.filter((alignment) => !workId || alignment.workId === workId)
}

export async function linkBookEditions(leftBookId: string, rightBookId: string): Promise<{ work: Work; alignment: Alignment }> {
  const books = await listBooks()
  const left = books.find((book) => book.id === leftBookId)
  const right = books.find((book) => book.id === rightBookId)
  if (!left || !right || leftBookId === rightBookId) throw new Error('请选择两本不同的本地书籍')
  const editions = await listEditions()
  const leftEdition = editions.find((edition) => edition.bookId === leftBookId)
  const rightEdition = editions.find((edition) => edition.bookId === rightBookId)
  if (!leftEdition || !rightEdition) throw new Error('找不到版本元数据，请重新导入书籍')
  const work: Work = { id: leftEdition.workId, title: left.title, author: left.author, editionIds: [leftEdition.id, rightEdition.id] }
  const alignment: Alignment = { id: crypto.randomUUID(), workId: work.id, leftEditionId: leftEdition.id, rightEditionId: rightEdition.id, confidence: 0 }
  await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put({ ...rightEdition, workId: work.id }))
  await transaction('books', 'readwrite', (store) => {
    store.put({ ...left, workId: work.id, editionId: leftEdition.id })
    return store.put({ ...right, workId: work.id, editionId: rightEdition.id })
  })
  await transaction(ALIGNMENTS_STORE, 'readwrite', (store) => store.put(alignment))
  return { work, alignment }
}

export async function saveEditionProgress(editionId: string, location: string, progress: number): Promise<void> {
  const current = await transaction<Edition | undefined>(EDITIONS_STORE, 'readonly', (store) => store.get(editionId))
  if (!current) return
  await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put({ ...current, location, progress: Math.max(0, Math.min(100, progress)) }))
}

export async function getBookFile(book: StoredBook): Promise<File> {
  if (book.storage === 'opfs') {
    const storageManager = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>
    }
    if (storageManager.getDirectory) {
      const root = await storageManager.getDirectory()
      const handle = await root.getFileHandle(`${book.id}-${book.fileName}`)
      return handle.getFile()
    }
  }
  const blob = await transaction<Blob | undefined>('book-blobs', 'readonly', (store) => store.get(book.id))
  if (!blob) throw new Error('找不到本地书籍文件，请重新导入')
  return new File([blob], book.fileName, { type: book.fileType })
}

export type BookTextIndex = { bookId: string; text: string; updatedAt: number }

/** Store extracted text locally for search. This store is intentionally excluded from sync snapshots. */
export async function saveBookTextIndex(bookId: string, text: string): Promise<void> {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return
  await transaction(TEXT_INDEX_STORE, 'readwrite', (store) => store.put({ bookId, text: normalized.slice(0, 2_000_000), updatedAt: Date.now() } satisfies BookTextIndex))
}

export async function searchBookTextIndex(query: string): Promise<Array<{ bookId: string; snippet: string }>> {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return []
  const indexes = await transaction<BookTextIndex[]>(TEXT_INDEX_STORE, 'readonly', (store) => store.getAll())
  return indexes.filter((index) => index.text.toLocaleLowerCase().includes(normalized)).map((index) => {
    const source = index.text
    const at = source.toLocaleLowerCase().indexOf(normalized)
    const start = Math.max(0, at - 55)
    const end = Math.min(source.length, at + normalized.length + 95)
    return { bookId: index.bookId, snippet: `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}` }
  })
}

export async function saveReadingProgress(bookId: string, location: string, progress: number): Promise<void> {
  const current = await transaction<StoredBook | undefined>('books', 'readonly', (store) => store.get(bookId))
  if (!current) return
  await transaction('books', 'readwrite', (store) => store.put({
    ...current,
    location,
    progress: Math.max(0, Math.min(100, progress)),
  }))
}

export async function saveHighlight(input: Omit<Highlight, 'id' | 'createdAt'>): Promise<Highlight> {
  const now = Date.now()
  const highlight: Highlight = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put(highlight))
  return highlight
}

export async function listHighlights(bookId?: string): Promise<Highlight[]> {
  const highlights = await transaction<Highlight[]>(HIGHLIGHTS_STORE, 'readonly', (store) => store.getAll())
  return highlights.filter((highlight) => !bookId || highlight.bookId === bookId).sort((a, b) => b.createdAt - a.createdAt)
}

export async function updateHighlightNote(id: string, note: string): Promise<void> {
  const current = await transaction<Highlight | undefined>(HIGHLIGHTS_STORE, 'readonly', (store) => store.get(id))
  if (!current) return
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put({ ...current, note, updatedAt: Date.now() }))
}

export async function updateHighlightColor(id: string, color: Highlight['color']): Promise<void> {
  const current = await transaction<Highlight | undefined>(HIGHLIGHTS_STORE, 'readonly', (store) => store.get(id))
  if (!current) return
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put({ ...current, color, updatedAt: Date.now() }))
}

export async function deleteHighlight(id: string): Promise<void> {
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.delete(id))
}

export async function deleteBook(book: StoredBook): Promise<void> {
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.delete(book.id))
  await transaction(BLOBS_STORE, 'readwrite', (store) => store.delete(book.id))
  await transaction(TEXT_INDEX_STORE, 'readwrite', (store) => store.delete(book.id))
  const storageManager = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  if (book.storage === 'opfs' && storageManager.getDirectory) {
    try {
      const root = await storageManager.getDirectory()
      await root.removeEntry(`${book.id}-${book.fileName}`)
    } catch {
      // The metadata is already gone; a missing OPFS entry is safe to ignore.
    }
  }
  const highlights = await listHighlights(book.id)
  await Promise.all(highlights.map((highlight) => deleteHighlight(highlight.id)))
}

function encodeBytes(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  return btoa(binary)
}

function decodeBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function exportLibraryData(): Promise<LibraryBackup> {
  const books = await listBooks()
  const files: Record<string, string> = {}
  for (const book of books) {
    const buffer = await (await getBookFile(book)).arrayBuffer()
    files[book.id] = encodeBytes(new Uint8Array(buffer as ArrayBuffer))
  }
  return { version: 2, exportedAt: new Date().toISOString(), books, highlights: await listHighlights(), files, works: await listWorks(), editions: await listEditions(), alignments: await listAlignments() }
}

export async function importLibraryData(backup: LibraryBackup): Promise<{ books: number; highlights: number }> {
  if (backup.version !== 2 || !Array.isArray(backup.books) || !Array.isArray(backup.highlights) || !backup.files) throw new Error('备份版本过旧，请重新导出')
  for (const book of backup.books) {
    const bytes = decodeBytes(backup.files[book.id] ?? '')
    await transaction(BLOBS_STORE, 'readwrite', (store) => store.put(new Blob([bytes], { type: book.fileType }), book.id))
    await transaction(BOOKS_STORE, 'readwrite', (store) => store.put({ ...book, storage: 'indexeddb' }))
  }
  for (const highlight of backup.highlights) await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put(highlight))
  for (const work of backup.works ?? []) await transaction(WORKS_STORE, 'readwrite', (store) => store.put(work))
  for (const edition of backup.editions ?? []) await transaction(EDITIONS_STORE, 'readwrite', (store) => store.put(edition))
  for (const alignment of backup.alignments ?? []) await transaction(ALIGNMENTS_STORE, 'readwrite', (store) => store.put(alignment))
  return { books: backup.books.length, highlights: backup.highlights.length }
}
