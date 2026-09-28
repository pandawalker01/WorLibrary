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
}

export type Highlight = {
  id: string
  bookId: string
  text: string
  location: string
  note?: string
  color: 'gold' | 'rose' | 'blue'
  createdAt: number
}

const DB_NAME = 'wor-library'
const DB_VERSION = 2
const BOOKS_STORE = 'books'
const BLOBS_STORE = 'book-blobs'
const HIGHLIGHTS_STORE = 'highlights'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BOOKS_STORE)) db.createObjectStore(BOOKS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE)
      if (!db.objectStoreNames.contains(HIGHLIGHTS_STORE)) db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function transaction<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const request = operation(db.transaction(storeName, mode).objectStore(storeName))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  }))
}

function titleFromFile(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim() || '未命名书籍'
}

function extensionOf(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
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
  return books.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBook(file: File, index: number): Promise<StoredBook> {
  const extension = extensionOf(file.name)
  if (!['epub', 'pdf', 'mobi', 'cbz'].includes(extension)) throw new Error(`暂不支持 .${extension || 'unknown'} 文件`)
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
  await transaction('books', 'readwrite', (store) => store.put(book))
  return book
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
  const highlight: Highlight = { ...input, id: crypto.randomUUID(), createdAt: Date.now() }
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
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put({ ...current, note }))
}

export async function updateHighlightColor(id: string, color: Highlight['color']): Promise<void> {
  const current = await transaction<Highlight | undefined>(HIGHLIGHTS_STORE, 'readonly', (store) => store.get(id))
  if (!current) return
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.put({ ...current, color }))
}

export async function deleteHighlight(id: string): Promise<void> {
  await transaction(HIGHLIGHTS_STORE, 'readwrite', (store) => store.delete(id))
}

export async function deleteBook(book: StoredBook): Promise<void> {
  await transaction(BOOKS_STORE, 'readwrite', (store) => store.delete(book.id))
  await transaction(BLOBS_STORE, 'readwrite', (store) => store.delete(book.id))
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
