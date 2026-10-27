import type { AuthSession } from './auth'

export const USER_FILE_CHUNK_SIZE = 8 * 1024 * 1024
export const USER_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const USER_FILE_TYPES = ['application/epub+zip', 'application/pdf'] as const
export type UserFileType = typeof USER_FILE_TYPES[number]

export type UserFileInput = { name: string; type: string; size: number; slice: Blob['slice'] }
export type UserFileDescriptor = { name: string; mediaType: UserFileType; size: number; chunkSize: number; chunkCount: number }
export type UserFileManifest = { id: string; editionId: string; fileName: string; mediaType: UserFileType; size: number; uploadState: string; deletedAt: string | null }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fileNamePattern = /^[^\u0000-\u001f\\/]{1,240}$/

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

export type UserFileClientConfig = { url?: string; anonKey?: string; fetch?: typeof globalThis.fetch }

export function createUserFileClient(session: AuthSession, config: UserFileClientConfig = {}) {
  if (session.user.isAnonymous) throw new TypeError('匿名试用不能使用个人云书库')
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
  const url = (config.url ?? env.VITE_SUPABASE_URL)?.replace(/\/$/, '')
  const anonKey = config.anonKey ?? env.VITE_SUPABASE_ANON_KEY
  const request = config.fetch ?? globalThis.fetch
  if (!url || !anonKey) throw new Error('尚未配置 Supabase')
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
    async initiate(editionId: string, file: UserFileInput, idempotencyKey = crypto.randomUUID()): Promise<{ manifestId: string; descriptor: UserFileDescriptor; uploadSession: string }> {
      assertOwnedEditionId(editionId)
      if (!uuidPattern.test(idempotencyKey)) throw new TypeError('幂等键无效')
      const descriptor = describeUserFile(file)
      const response = await request(`${url}/api/user-files/initiate`, { method: 'POST', headers, body: JSON.stringify({ editionId, fileName: descriptor.name, mediaType: descriptor.mediaType, size: descriptor.size, chunkSize: descriptor.chunkSize, chunkCount: descriptor.chunkCount, idempotencyKey }) })
      const value = await responseValue(response)
      if (typeof value?.manifestId !== 'string' || typeof value?.uploadSession !== 'string') throw new Error('上传会话响应无效')
      return { manifestId: value.manifestId, descriptor, uploadSession: value.uploadSession }
    },
    async uploadChunk(manifestId: string, index: number, body: Blob, uploadSession: string): Promise<void> {
      if (!uuidPattern.test(manifestId) || !uploadSession || !Number.isInteger(index) || index < 0) throw new TypeError('上传分块参数无效')
      const response = await request(`${url}/api/user-files/${encodeURIComponent(manifestId)}/chunks/${index}`, { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/octet-stream', 'x-upload-session': uploadSession }, body })
      await responseValue(response)
    },
    async complete(manifestId: string, uploadSession: string): Promise<void> {
      if (!uuidPattern.test(manifestId) || !uploadSession) throw new TypeError('完成上传参数无效')
      await responseValue(await request(`${url}/api/user-files/${encodeURIComponent(manifestId)}/complete`, { method: 'POST', headers: { ...headers, 'x-upload-session': uploadSession } }))
    },
    async deleteFromCloud(manifestId: string): Promise<void> {
      if (!uuidPattern.test(manifestId)) throw new TypeError('文件清单 ID 无效')
      await responseValue(await request(`${url}/api/user-files/${encodeURIComponent(manifestId)}`, { method: 'DELETE', headers }))
    },
  }
}
