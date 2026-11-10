import type { StoredBook } from './storage'
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

export async function removeDeviceBook(book: StoredBook, open: () => Promise<IDBDatabase>): Promise<void> {
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
