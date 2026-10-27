import type { AuthSession } from './auth'

export const USER_FILE_CHUNK_SIZE = 8 * 1024 * 1024
/** Matches the server-side P0 safety ceiling; larger files must be rejected before reading. */
export const USER_FILE_MAX_BYTES = 1024 * 1024 * 1024
export const USER_FILE_TYPES = ['application/epub+zip', 'application/pdf'] as const
export type UserFileType = typeof USER_FILE_TYPES[number]

export type UserFileInput = { name: string; type: string; size: number; slice: Blob['slice'] }
export type UserFileDescriptor = { name: string; mediaType: UserFileType; size: number; chunkSize: number; chunkCount: number }
export type UserFileManifest = { id: string; editionId: string; fileName: string; mediaType: UserFileType; size: number; uploadState: string; deletedAt: string | null }
export type UserFileUploadProgress = { completedChunks: number; totalChunks: number; uploadedBytes: number; totalBytes: number }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fileNamePattern = /^[^\u0000-\u001f\\/]{1,240}$/
const RECOVERY_DATABASE = 'worlibrary-private-file-recovery'
const RECOVERY_STORE = 'chunks'

function recoveryChunkKey(manifestId: string, index: number): string { return `${manifestId}:${index}` }

async function withRecoveryStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  const database = await new Promise<IDBDatabase | undefined>((resolve) => {
    const request = indexedDB.open(RECOVERY_DATABASE, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(RECOVERY_STORE)) request.result.createObjectStore(RECOVERY_STORE) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
  if (!database) return undefined
  try {
    return await new Promise<T | undefined>((resolve) => {
      const transaction = database.transaction(RECOVERY_STORE, mode)
      const request = work(transaction.objectStore(RECOVERY_STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
      transaction.onabort = () => resolve(undefined)
    })
  } finally { database.close() }
}

async function readRecoveryChunk(manifestId: string, index: number): Promise<Blob | undefined> {
  const value = await withRecoveryStore<Blob | undefined>('readonly', (store) => store.get(recoveryChunkKey(manifestId, index)))
  return value instanceof Blob ? value : undefined
}

async function writeRecoveryChunk(manifestId: string, index: number, chunk: Blob): Promise<void> {
  await withRecoveryStore<IDBValidKey>('readwrite', (store) => store.put(chunk, recoveryChunkKey(manifestId, index)))
}

async function clearRecoveryChunks(manifestId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await withRecoveryStore<undefined>('readwrite', (store) => store.delete(recoveryChunkKey(manifestId, index)))
}

export function describeUserFile(file: UserFileInput): UserFileDescriptor {
  if (!file || typeof file.name !== 'string' || !fileNamePattern.test(file.name.trim())) throw new TypeError('文件名无效')
  if (!USER_FILE_TYPES.includes(file.type as UserFileType)) throw new TypeError('仅支持 EPUB 或 PDF')
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > USER_FILE_MAX_BYTES) throw new TypeError('文件大小超出个人云书库限制')
  return { name: file.name.trim(), mediaType: file.type as UserFileType, size: file.size, chunkSize: USER_FILE_CHUNK_SIZE, chunkCount: Math.ceil(file.size / USER_FILE_CHUNK_SIZE) }
}

export function assertOwnedEditionId(editionId: string): void {
  if (!uuidPattern.test(editionId)) throw new TypeError('版本 ID 无效')
}

export function chunkRange(file: Pick<UserFileInput, 'size'>, index: number, chunkSize = USER_FILE_CHUNK_SIZE): { start: number; end: number } {
  if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(file.size / chunkSize)) throw new RangeError('分块序号无效')
  const start = index * chunkSize
  return { start, end: Math.min(file.size, start + chunkSize) }
}

async function sha256Hex(source: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await source.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export type UserFileClientConfig = { url?: string; anonKey?: string; gatewayUrl?: string; fetch?: typeof globalThis.fetch }

export function createUserFileClient(session: AuthSession, config: UserFileClientConfig = {}) {
  if (session.user.isAnonymous) throw new TypeError('匿名试用不能使用个人云书库')
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
  const url = (config.url ?? env.VITE_SUPABASE_URL)?.replace(/\/$/, '')
  const gatewayUrl = (config.gatewayUrl ?? (typeof window === 'undefined' ? '' : window.location.origin)).replace(/\/$/, '')
  const anonKey = config.anonKey ?? env.VITE_SUPABASE_ANON_KEY
  const request = config.fetch ?? globalThis.fetch
  if (!url || !anonKey || !gatewayUrl) throw new Error('尚未配置个人云书库')
  const headers = { apikey: anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }
  async function responseValue(response: Response): Promise<any> {
    const value = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(typeof value?.error?.message === 'string' ? value.error.message : '个人云书库请求失败')
    return value
  }
  return {
    async listManifests(): Promise<UserFileManifest[]> {
      const response = await request(`${url}/rest/v1/user_file_manifests?select=id,edition_id,file_name,media_type,plaintext_size,upload_state,deleted_at&deleted_at=is.null&order=updated_at.desc`, { headers })
      const rows = await responseValue(response)
      return Array.isArray(rows) ? rows.map((row) => ({ id: row.id, editionId: row.edition_id, fileName: row.file_name, mediaType: row.media_type, size: row.plaintext_size, uploadState: row.upload_state, deletedAt: row.deleted_at ?? null })) : []
    },
    async initiate(editionId: string, file: UserFileInput, idempotencyKey: string = crypto.randomUUID()): Promise<{ manifestId: string; descriptor: UserFileDescriptor; uploadedChunks: number[] }> {
      assertOwnedEditionId(editionId)
      if (!uuidPattern.test(idempotencyKey)) throw new TypeError('幂等键无效')
      const descriptor = describeUserFile(file)
      const plaintextHash = await sha256Hex(file as unknown as Blob)
      const response = await request(`${gatewayUrl}/api/user-files/initiate`, { method: 'POST', headers, body: JSON.stringify({ editionId, fileName: descriptor.name, mediaType: descriptor.mediaType, size: descriptor.size, chunkSize: descriptor.chunkSize, chunkCount: descriptor.chunkCount, plaintextHash, idempotencyKey }) })
      const value = await responseValue(response)
      if (typeof value?.manifestId !== 'string' || !Array.isArray(value?.uploadedChunks)) throw new Error('上传会话响应无效')
      return { manifestId: value.manifestId, descriptor, uploadedChunks: value.uploadedChunks.filter((index: unknown): index is number => Number.isInteger(index) && Number(index) >= 0) }
    },
    async uploadChunk(manifestId: string, index: number, body: Blob): Promise<void> {
      if (!uuidPattern.test(manifestId) || !Number.isInteger(index) || index < 0 || body.size < 1 || body.size > USER_FILE_CHUNK_SIZE) throw new TypeError('上传分块参数无效')
      const response = await request(`${gatewayUrl}/api/user-files/${encodeURIComponent(manifestId)}/chunks/${index}`, { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.size) }, body })
      await responseValue(response)
    },
    async complete(manifestId: string): Promise<void> {
      if (!uuidPattern.test(manifestId)) throw new TypeError('完成上传参数无效')
      await responseValue(await request(`${gatewayUrl}/api/user-files/${encodeURIComponent(manifestId)}/complete`, { method: 'POST', headers }))
    },
    /** Safe to call again after a tab/network interruption with the same idempotency key. */
    async upload(editionId: string, file: UserFileInput, options: { idempotencyKey?: string; onProgress?: (progress: UserFileUploadProgress) => void } = {}): Promise<string> {
      const started = await this.initiate(editionId, file, options.idempotencyKey)
      const completed = new Set(started.uploadedChunks)
      let uploadedBytes = [...completed].reduce((total, index) => total + (chunkRange(file, index).end - chunkRange(file, index).start), 0)
      options.onProgress?.({ completedChunks: completed.size, totalChunks: started.descriptor.chunkCount, uploadedBytes, totalBytes: started.descriptor.size })
      for (let index = 0; index < started.descriptor.chunkCount; index += 1) {
        if (completed.has(index)) continue
        const range = chunkRange(file, index, started.descriptor.chunkSize)
        const chunk = file.slice(range.start, range.end)
        await this.uploadChunk(started.manifestId, index, chunk)
        uploadedBytes += chunk.size; completed.add(index)
        options.onProgress?.({ completedChunks: completed.size, totalChunks: started.descriptor.chunkCount, uploadedBytes, totalBytes: started.descriptor.size })
      }
      await this.complete(started.manifestId)
      return started.manifestId
    },
    async restore(manifest: Pick<UserFileManifest, 'id' | 'fileName' | 'mediaType' | 'size'>, onProgress?: (progress: UserFileUploadProgress) => void): Promise<File> {
      if (!uuidPattern.test(manifest.id) || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || !USER_FILE_TYPES.includes(manifest.mediaType)) throw new TypeError('云端文件清单无效')
      const chunks: Blob[] = []; const count = Math.ceil(manifest.size / USER_FILE_CHUNK_SIZE); let restored = 0
      for (let index = 0; index < count; index += 1) {
        const expectedSize = Math.min(USER_FILE_CHUNK_SIZE, manifest.size - index * USER_FILE_CHUNK_SIZE)
        let chunk = await readRecoveryChunk(manifest.id, index)
        if (chunk?.size !== expectedSize) chunk = undefined
        if (!chunk) {
          const response = await request(`${gatewayUrl}/api/user-files/${encodeURIComponent(manifest.id)}/chunks/${index}`, { headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}` } })
          if (!response.ok) throw new Error('无法恢复云端原书，请稍后重试')
          chunk = await response.blob()
          if (chunk.size !== expectedSize) throw new Error('恢复的文件分块校验失败')
          // Persist each verified chunk before fetching the next one, so an
          // interrupted recovery resumes from missing chunks instead of making
          // an incomplete file visible to the local shelf.
          await writeRecoveryChunk(manifest.id, index, chunk)
        }
        chunks.push(chunk); restored += chunk.size
        onProgress?.({ completedChunks: index + 1, totalChunks: count, uploadedBytes: restored, totalBytes: manifest.size })
      }
      const restoredFile = new File(chunks, manifest.fileName, { type: manifest.mediaType })
      if (restoredFile.size !== manifest.size) throw new Error('恢复的文件大小校验失败')
      await clearRecoveryChunks(manifest.id, count)
      return restoredFile
    },
    async deleteFromCloud(manifestId: string): Promise<void> {
      if (!uuidPattern.test(manifestId)) throw new TypeError('文件清单 ID 无效')
      await responseValue(await request(`${gatewayUrl}/api/user-files/${encodeURIComponent(manifestId)}`, { method: 'DELETE', headers }))
    },
  }
}
