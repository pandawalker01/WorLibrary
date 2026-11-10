import type { UserFileInput, UserFileUploadProgress } from './user-file-library'
import { assertOwnedEditionId, chunkRange, describeUserFile } from './user-file-library'

/** File bytes stay in the existing local book store, never in this journal. */
export type UserFileUploadTask = {
  userId: string
  editionId: string
  operationId: string
  fingerprint: string
  state: 'pending' | 'failed' | 'active'
  manifestId?: string
}

export type UploadTaskStore = {
  get(userId: string, editionId: string): Promise<UserFileUploadTask | undefined>
  put(task: UserFileUploadTask): Promise<void>
}

type UploadGateway = {
  initiate(editionId: string, file: UserFileInput, operationId: string): Promise<{ manifestId: string; uploadedChunks: number[] }>
  uploadChunk(manifestId: string, index: number, chunk: Blob): Promise<void>
  complete(manifestId: string): Promise<void>
}

export class UploadTaskCancelled extends Error {
  constructor() { super('Upload task is no longer current'); this.name = 'UploadTaskCancelled' }
}

/**
 * One runner owns the task journal for an account. Callers must serialise runs
 * and invalidate isCurrent on logout, account/session change or pause. An
 * already-sent request may finish, but cannot start another chunk or complete.
 */
export async function runUserFileUploadTask(options: {
  userId: string
  editionId: string
  file: File
  store: UploadTaskStore
  gateway: UploadGateway
  isCurrent: () => boolean
  onProgress?: (progress: UserFileUploadProgress) => void
}): Promise<string> {
  const { userId, editionId, file, store, gateway, isCurrent } = options
  const check = () => { if (!isCurrent()) throw new UploadTaskCancelled() }
  check()
  assertOwnedEditionId(userId)
  assertOwnedEditionId(editionId)
  const descriptor = describeUserFile(file)
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  check()
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const fingerprint = JSON.stringify([descriptor.name, descriptor.mediaType, descriptor.size, hash])
  const previous = await store.get(userId, editionId)
  check()
  const task: UserFileUploadTask = previous?.userId === userId && previous.editionId === editionId && previous.fingerprint === fingerprint
    ? { ...previous, state: 'pending' }
    : { userId, editionId, fingerprint, operationId: crypto.randomUUID(), state: 'pending' }
  // Persist the operation before any remote mutation. Failed persistence must
  // never create an upload that cannot be resumed with the same operation ID.
  await store.put(task)
  check()
  try {
    const started = await gateway.initiate(editionId, file, task.operationId)
    check()
    assertOwnedEditionId(started.manifestId)
    const completed = new Set(started.uploadedChunks)
    for (const index of completed) {
      if (!Number.isInteger(index) || index < 0 || index >= descriptor.chunkCount) throw new Error('Invalid uploaded chunk index')
    }
    let uploadedBytes = [...completed].reduce((sum, index) => {
      const range = chunkRange(file, index)
      return sum + range.end - range.start
    }, 0)
    const progress = () => {
      check()
      options.onProgress?.({ completedChunks: completed.size, totalChunks: descriptor.chunkCount, uploadedBytes, totalBytes: file.size })
    }
    progress()
    for (let index = 0; index < descriptor.chunkCount; index += 1) {
      if (completed.has(index)) continue
      check()
      const range = chunkRange(file, index)
      const chunk = file.slice(range.start, range.end)
      await gateway.uploadChunk(started.manifestId, index, chunk)
      check()
      completed.add(index)
      uploadedBytes += chunk.size
      progress()
    }
    check()
    await gateway.complete(started.manifestId)
    check()
    await store.put({ ...task, manifestId: started.manifestId, state: 'active' })
    check()
    return started.manifestId
  } catch (error) {
    if (isCurrent()) await store.put({ ...task, state: 'failed' })
    throw error
  }
}

/** Dedicated DB avoids competing with Agent B's metadata schema version. */
export function createUploadTaskStore(): UploadTaskStore {
  async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('worlibrary-private-upload-tasks', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('tasks')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Upload task storage is blocked'))
    })
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction('tasks', mode)
        const request = work(transaction.objectStore('tasks'))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error ?? new Error('Upload task write aborted'))
      })
    } finally { database.close() }
  }
  const key = (userId: string, editionId: string) => `${userId}:${editionId}`
  return {
    get: (userId, editionId) => transact('readonly', (store) => store.get(key(userId, editionId))),
    put: async (task) => { await transact('readwrite', (store) => store.put(task, key(task.userId, task.editionId))) },
  }
}
