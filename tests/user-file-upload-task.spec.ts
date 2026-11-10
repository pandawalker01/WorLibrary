import { expect, test } from '@playwright/test'
import { runUserFileUploadTask, suppressUserFileUploadTask, UploadTaskCancelled, type UserFileUploadTask, type UploadTaskStore } from '../src/lib/user-file-upload-task'
import { USER_FILE_CHUNK_SIZE } from '../src/lib/user-file-library'

const userId = '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7de'
const editionId = '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7df'
const manifestId = '018f7b9c-3e2f-7b4c-8a7c-56cf4c39b7d0'
function journal() {
  const tasks = new Map<string, UserFileUploadTask>()
  const store: UploadTaskStore = {
    get: async (user, edition) => tasks.get(`${user}:${edition}`),
    put: async (task) => {
      const key = `${task.userId}:${task.editionId}`
      if (tasks.get(key)?.state !== 'suppressed' || task.state === 'suppressed') tasks.set(key, structuredClone(task))
    },
  }
  return { store, tasks }
}

test('interrupted upload reuses its persisted operation and skips server-confirmed chunks on retry', async () => {
  const { store } = journal()
  const file = new File([new Uint8Array(USER_FILE_CHUNK_SIZE + 2)], 'book.pdf', { type: 'application/pdf' })
  const operations: string[] = []; const chunks: number[] = []; let interrupted = true; let complete = 0
  const gateway = {
    initiate: async (_edition: string, _file: unknown, operation: string) => {
      expect((await store.get(userId, editionId))?.operationId).toBe(operation)
      operations.push(operation)
      return { manifestId, uploadedChunks: operations.length > 1 ? [0] : [] }
    },
    uploadChunk: async (_manifest: string, index: number) => {
      chunks.push(index)
      if (index === 1 && interrupted) { interrupted = false; throw new Error('offline') }
    },
    complete: async () => { complete += 1 },
  }
  const options = { userId, editionId, file, store, gateway, isCurrent: () => true }
  await expect(runUserFileUploadTask(options)).rejects.toThrow('offline')
  expect((await store.get(userId, editionId))?.state).toBe('failed')
  await expect(runUserFileUploadTask(options)).resolves.toBe(manifestId)
  expect(operations[0]).toBe(operations[1])
  expect(chunks).toEqual([0, 1, 1])
  expect(complete).toBe(1)
  expect((await store.get(userId, editionId))?.state).toBe('active')
})

test('account change during a chunk prevents complete and further progress without losing the operation', async () => {
  const { store } = journal(); let current = true; let completions = 0; let progress = 0
  await expect(runUserFileUploadTask({
    userId, editionId, file: new File(['pdf'], 'book.pdf', { type: 'application/pdf' }), store,
    isCurrent: () => current, onProgress: () => { progress += 1 },
    gateway: {
      initiate: async () => ({ manifestId, uploadedChunks: [] }),
      uploadChunk: async () => { current = false }, complete: async () => { completions += 1 },
    },
  })).rejects.toBeInstanceOf(UploadTaskCancelled)
  expect(completions).toBe(0)
  expect(progress).toBe(1)
  expect((await store.get(userId, editionId))?.state).toBe('pending')
})

test('same name and size with different bytes gets a new operation; accounts never share one', async () => {
  const { store } = journal(); const operations: string[] = []
  const gateway = {
    initiate: async (_edition: string, _file: unknown, operation: string) => { operations.push(operation); return { manifestId, uploadedChunks: [] } },
    uploadChunk: async () => {}, complete: async () => {},
  }
  for (const [owner, bytes] of [[userId, 'one'], [userId, 'two'], [editionId, 'two']]) {
    await runUserFileUploadTask({ userId: owner, editionId, file: new File([bytes], 'book.pdf', { type: 'application/pdf' }), store, gateway, isCurrent: () => true })
  }
  expect(new Set(operations).size).toBe(3)
})

test('failed durable write prevents all remote mutations', async () => {
  let requests = 0
  await expect(runUserFileUploadTask({
    userId, editionId, file: new File(['pdf'], 'book.pdf', { type: 'application/pdf' }), isCurrent: () => true,
    store: { get: async () => undefined, put: async () => { throw new Error('quota') } },
    gateway: { initiate: async () => { requests += 1; return { manifestId, uploadedChunks: [] } }, uploadChunk: async () => {}, complete: async () => {} },
  })).rejects.toThrow('quota')
  expect(requests).toBe(0)
})

test('cloud deletion during a chunk prevents completion and survives a stale failure receipt and retry', async () => {
  const { store } = journal(); let initiations = 0; let completions = 0
  const options = {
    userId, editionId, file: new File(['pdf'], 'book.pdf', { type: 'application/pdf' }), store, isCurrent: () => true,
    gateway: {
      initiate: async () => { initiations += 1; return { manifestId, uploadedChunks: [] } },
      uploadChunk: async () => suppressUserFileUploadTask(store, userId, editionId),
      complete: async () => { completions += 1 },
    },
  }
  await expect(runUserFileUploadTask(options)).rejects.toBeInstanceOf(UploadTaskCancelled)
  expect((await store.get(userId, editionId))?.state).toBe('suppressed')
  await expect(runUserFileUploadTask({ ...options, file: new File(['new'], 'book.pdf', { type: 'application/pdf' }) })).rejects.toBeInstanceOf(UploadTaskCancelled)
  expect(initiations).toBe(1)
  expect(completions).toBe(0)
})

test('suppression before any upload has run is durable and does not affect another account', async () => {
  const { store } = journal()
  await suppressUserFileUploadTask(store, userId, editionId)
  const tombstone = await store.get(userId, editionId)
  expect(tombstone?.state).toBe('suppressed')
  expect(tombstone?.fingerprint).toBe('')
  expect(await store.get(editionId, editionId)).toBeUndefined()
})
