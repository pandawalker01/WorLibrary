import type { StoredBook, RemoteBookMetadataShadowReimportInput } from './storage'
import type { Work, Edition } from './edition'

/** Loaded only when recovering a file; bytes and readable records commit together. */
export async function commitRecoveredFile(input: {
  database: IDBDatabase; file: File; book: StoredBook; work: Work; edition: Edition
  isCurrent?: () => boolean; signal?: AbortSignal
}): Promise<void> {
  const check = () => { if (input.signal?.aborted || (input.isCurrent && !input.isCurrent())) throw new Error('RECOVERY_SESSION_INVALIDATED') }
  const { database } = input
  try {
    check()
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['books', 'book-blobs', 'works', 'editions'], 'readwrite')
      let failure: unknown
      let aborting = false
      const abort = (error: unknown) => {
        failure = error
        if (!aborting) { aborting = true; tx.abort() }
      }
      const cancel = () => abort(new Error('RECOVERY_SESSION_INVALIDATED'))
      input.signal?.addEventListener('abort', cancel, { once: true })
      const cleanup = () => input.signal?.removeEventListener('abort', cancel)
      const validate = () => {
        try { check() } catch (error) { abort(error) }
      }
      tx.oncomplete = () => { cleanup(); resolve() }
      tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error('Recovery transaction aborted')) }
      tx.onerror = () => { failure ??= tx.error }
      // Recheck duplicates inside the writing transaction: two concurrent
      // restores can both pass the earlier read-only validation.
      const existing = tx.objectStore('books').getAll()
      existing.onsuccess = () => {
        validate()
        if (aborting) return
        if ((existing.result as StoredBook[]).some((book) => book.editionId === input.edition.id || (book.fileName === input.book.fileName && book.fileSize === input.book.fileSize))) {
          abort(new Error('RECOVERY_ALREADY_PRESENT'))
          return
        }
        // Success events precede commit and can roll back all queued writes.
        for (const request of [
          tx.objectStore('book-blobs').put(input.file, input.book.id),
          tx.objectStore('books').put(input.book),
          tx.objectStore('works').put(input.work),
          tx.objectStore('editions').put(input.edition),
        ]) request.addEventListener('success', validate)
      }
    })
  } finally { database.close() }
}

export async function removeDeviceBookRecords(database: IDBDatabase, bookId: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['books', 'book-blobs', 'text-index', 'highlights'], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Device removal aborted'))
      tx.onerror = () => reject(tx.error)
      tx.objectStore('books').delete(bookId)
      tx.objectStore('book-blobs').delete(bookId)
      tx.objectStore('text-index').delete(bookId)
      const cursor = tx.objectStore('highlights').openCursor()
      cursor.onsuccess = () => {
        const item = cursor.result
        if (!item) return
        if (item.value.bookId === bookId) item.delete()
        item.continue()
      }
    })
  } finally { database.close() }
}

export async function removeDeviceBook(book: StoredBook, open: () => Promise<IDBDatabase>, account?: { id: string; isAnonymous: boolean }): Promise<void> {
  if (account && !account.isAnonymous && book.editionId) {
    const { createUploadTaskStore, suppressUserFileUploadTask } = await import('./user-file-upload-task')
    await suppressUserFileUploadTask(createUploadTaskStore(), account.id, book.editionId)
  }
  const storageManager = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  if (book.storage === 'opfs') {
    if (!storageManager.getDirectory) throw new Error('LOCAL_FILE_CLEANUP_UNAVAILABLE')
    try {
      const root = await storageManager.getDirectory()
      await root.removeEntry(`${book.id}-${book.fileName}`)
    } catch (error) {
      // Real cleanup failures keep the shelf record available for retry.
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
    }
  }
  await removeDeviceBookRecords(await open(), book.id)
}

type RecoveryDependencies = {
  openDatabase: () => Promise<IDBDatabase>
  readBooks: () => Promise<StoredBook[]>
  extensionOf: (name: string) => string
  assertNonEmptyMetadataSyncId: (value: string, label: string) => void
  assertSafeRemoteBookMetadataString: (value: string | undefined, label: string, maximum?: number, optional?: boolean) => void
  assertSafeRemoteBookMetadataNumber: (value: number, label: string, maximum: number) => void
}

export async function restoreRemoteShadow(input: RemoteBookMetadataShadowReimportInput, dependencies: RecoveryDependencies): Promise<StoredBook> {
  const { file, shadow } = input
  const { openDatabase, readBooks, extensionOf, assertNonEmptyMetadataSyncId, assertSafeRemoteBookMetadataString, assertSafeRemoteBookMetadataNumber } = dependencies
  if (shadow.needsReimport !== true) throw new Error('只能关联需要重新导入原书的已同步版本')
  const extension = extensionOf(file.name)
  if (!['epub', 'pdf'].includes(extension)) {
    throw new Error(`请选择与已同步版本匹配的 EPUB 或 PDF 原书，而不是 .${extension || 'unknown'} 文件`)
  }
  if (file.name !== shadow.fileName) {
    throw new Error('所选原书的文件名与已同步版本不一致；请从原设备选择同一份 EPUB/PDF 文件')
  }
  if (file.size !== shadow.fileSize) {
    throw new Error('所选原书的文件大小与已同步版本不一致；请从原设备选择同一份 EPUB/PDF 文件')
  }
  if (extensionOf(shadow.fileName) !== extension) {
    throw new Error('已同步版本的文件格式与所选原书不一致，不能关联')
  }
  if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} 超过 100 MB 限制`)

  assertNonEmptyMetadataSyncId(shadow.editionId, 'remote edition id')
  assertSafeRemoteBookMetadataString(shadow.title, 'title')
  assertSafeRemoteBookMetadataString(shadow.author, 'author')
  assertSafeRemoteBookMetadataString(shadow.language, 'language')
  assertSafeRemoteBookMetadataString(shadow.fileName, 'file name')
  assertSafeRemoteBookMetadataString(shadow.fileType, 'file type')
  assertSafeRemoteBookMetadataString(shadow.location, 'location', 4_096, true)
  assertSafeRemoteBookMetadataNumber(shadow.progress, 'progress', 100)
  assertSafeRemoteBookMetadataNumber(shadow.fileSize, 'file size', Number.MAX_SAFE_INTEGER)
  if (shadow.cover !== 'ink' && shadow.cover !== 'sun' && shadow.cover !== 'red') {
    throw new Error('已同步版本的封面元数据无效，不能关联')
  }

  // Do not call listBooks() here: its legacy edition migration can write old
  // records, while a rejected re-import must remain strictly write-free.
  const existing = await readBooks()
  if (existing.some((book) => book.editionId === shadow.editionId)) {
    throw new Error('这个已同步版本已经在本机书库中，无需再次重新导入')
  }
  if (existing.some((book) => book.fileName === file.name && book.fileSize === file.size)) {
    throw new Error(`${file.name} 已作为另一条本地书籍存在；请不要将普通导入记录重复关联`)
  }

  const id = crypto.randomUUID()
  // Recovery commits bytes and all readable records in one IndexedDB
  // transaction. A separately awaited OPFS write would escape its rollback.
  const storage: StoredBook['storage'] = 'indexeddb'
  const workId = crypto.randomUUID()
  const book: StoredBook = {
    id,
    title: shadow.title,
    author: shadow.author,
    language: shadow.language,
    progress: shadow.progress,
    cover: shadow.cover,
    fileName: shadow.fileName,
    fileType: shadow.fileType,
    fileSize: shadow.fileSize,
    storage,
    createdAt: Date.now(),
    location: shadow.location,
    workId,
    editionId: shadow.editionId,
  }
  const work: Work = { id: workId, title: book.title, author: book.author, editionIds: [shadow.editionId] }
  const edition: Edition = {
    id: shadow.editionId,
    workId,
    label: book.title,
    language: book.language,
    format: extension as Edition['format'],
    bookId: book.id,
    progress: book.progress,
    location: book.location,
  }
  await commitRecoveredFile({ database: await openDatabase(), file, book, work, edition, isCurrent: input.isCurrent, signal: input.signal })
  return book
}
