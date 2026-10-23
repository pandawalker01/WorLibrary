import type { AuthSession } from './auth'

export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 80
export const PROFILE_BIO_MAX_LENGTH = 500
export const PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024
export const PROFILE_AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type ProfileAvatarContentType = typeof PROFILE_AVATAR_CONTENT_TYPES[number]

export type AccountProfile = {
  id: string
  displayName: string | null
  bio: string | null
  avatarPath: string | null
  isPublic: boolean
  isAnonymous: boolean
  updatedAt: string | null
}

export type UpdateAccountProfileInput = {
  displayName?: string | null
  bio?: string | null
  avatarPath?: string | null
  isPublic?: boolean
}

export type AvatarUploadCandidate = {
  name: string
  type: string
  size: number
}

export type PreparedAvatarUpload = {
  path: string
  contentType: ProfileAvatarContentType
  size: number
}

export type AccountProfileClientConfig = {
  url?: string
  anonKey?: string
  fetch?: typeof globalThis.fetch
}

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
const pathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/avatar\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp)$/i
const avatarBucket = 'profile-avatars'

function normalizeOptionalText(value: string | null | undefined, maxLength: number, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError(`${label}必须是文本`)
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maxLength) throw new TypeError(`${label}最多 ${maxLength} 个字符`)
  if (/\p{Cc}/u.test(normalized)) throw new TypeError(`${label}不能包含控制字符`)
  return normalized
}

function extensionForContentType(type: ProfileAvatarContentType): 'jpg' | 'png' | 'webp' {
  return type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length) as 'png' | 'webp'
}

function storageObjectUrl(baseUrl: string, path: string): string {
  const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `${baseUrl}/storage/v1/object/${avatarBucket}/${encodedPath}`
}

function assertOwnAvatarPath(userId: string, path: string): void {
  if (!pathPattern.test(path) || !path.startsWith(`${userId}/avatar/`)) throw new TypeError('头像引用格式无效')
}

function validateAvatarCandidate(candidate: AvatarUploadCandidate): asserts candidate is AvatarUploadCandidate & { type: ProfileAvatarContentType } {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.name !== 'string') throw new TypeError('请选择头像图片')
  if (!PROFILE_AVATAR_CONTENT_TYPES.includes(candidate.type as ProfileAvatarContentType)) throw new TypeError('头像仅支持 JPEG、PNG 或 WebP 图片')
  if (!Number.isInteger(candidate.size) || candidate.size < 1 || candidate.size > PROFILE_AVATAR_MAX_BYTES) {
    throw new TypeError('头像大小必须在 1 字节至 5 MiB 之间')
  }
}

function detectedAvatarContentType(bytes: Uint8Array): ProfileAvatarContentType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/**
 * Read the minimum image header before a future uploader sends any bytes.
 * MIME type alone is attacker-controlled, so callers must await this check
 * for a real File/Blob and a server uploader must repeat it before Storage.
 */
export async function validateAvatarImageFile(file: AvatarUploadCandidate & Pick<Blob, 'slice'>): Promise<void> {
  validateAvatarCandidate(file)
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const detectedType = detectedAvatarContentType(bytes)
  if (!detectedType || detectedType !== file.type) throw new TypeError('头像文件内容不是声明的图片格式')
}

function asProfile(value: unknown): AccountProfile {
  const record = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined
  if (!record || typeof record.id !== 'string') throw new TypeError('账户资料响应无效')
  return {
    id: record.id,
    displayName: typeof record.display_name === 'string' ? record.display_name : null,
    bio: typeof record.bio === 'string' ? record.bio : null,
    avatarPath: typeof record.avatar_path === 'string' ? record.avatar_path : null,
    isPublic: record.is_public === true,
    isAnonymous: record.is_anonymous === true,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
  }
}

/** Validate only the fields that may be sent through the profile REST surface. */
export function validateAccountProfileUpdate(input: UpdateAccountProfileInput): Record<string, string | boolean | null> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('账户资料必须是对象')
  const output: Record<string, string | boolean | null> = {}
  const displayName = normalizeOptionalText(input.displayName, PROFILE_DISPLAY_NAME_MAX_LENGTH, '公开昵称')
  const bio = normalizeOptionalText(input.bio, PROFILE_BIO_MAX_LENGTH, '个人简介')
  if (displayName !== undefined) output.display_name = displayName
  if (bio !== undefined) output.bio = bio
  if (input.isPublic !== undefined) {
    if (typeof input.isPublic !== 'boolean') throw new TypeError('公开资料开关无效')
    output.is_public = input.isPublic
  }
  if (input.avatarPath !== undefined) {
    if (input.avatarPath !== null && (typeof input.avatarPath !== 'string' || !pathPattern.test(input.avatarPath))) {
      throw new TypeError('头像引用格式无效')
    }
    output.avatar_path = input.avatarPath
  }
  if (!Object.keys(output).length) throw new TypeError('没有可更新的账户资料字段')
  return output
}

/**
 * Validate an image before the later dedicated Storage uploader is introduced.
 *
 * This intentionally does not call Storage and does not indicate success: the
 * caller must upload this exact candidate to `profile-avatars`, then PATCH
 * `avatar_path` only after Storage has accepted it. Migration 0011 enforces
 * that the object path is owned by the profile and is a supported <= 5 MiB
 * image, so a browser cannot point a profile at another account's object.
 */
export function prepareAvatarUpload(userId: string, candidate: AvatarUploadCandidate, objectId = crypto.randomUUID()): PreparedAvatarUpload {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new TypeError('账户 ID 无效')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)) {
    throw new TypeError('头像对象 ID 无效')
  }
  validateAvatarCandidate(candidate)
  const contentType = candidate.type
  return { path: `${userId}/avatar/${objectId}.${extensionForContentType(contentType)}`, contentType, size: candidate.size }
}

/** Browser-safe REST client for account profile rows; it never handles email. */
export function createAccountProfileClient(session: AuthSession, config: AccountProfileClientConfig = {}) {
  if (session.user.isAnonymous) throw new TypeError('匿名试用不能创建公开账户资料')
  const url = (config.url ?? env.VITE_SUPABASE_URL)?.replace(/\/$/, '')
  const anonKey = config.anonKey ?? env.VITE_SUPABASE_ANON_KEY
  const request = config.fetch ?? globalThis.fetch
  if (!url || !anonKey) throw new Error('尚未配置 Supabase')
  const headers = { apikey: anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }
  const ownerFilter = `id=eq.${encodeURIComponent(session.user.id)}`
  const select = 'id,display_name,bio,avatar_path,is_public,is_anonymous,updated_at'

  async function readResponse(response: Response): Promise<unknown> {
    const value = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error('账户资料请求失败')
    return value
  }

  return {
    async getOwnProfile(): Promise<AccountProfile | null> {
      const response = await request(`${url}/rest/v1/profiles?${ownerFilter}&select=${encodeURIComponent(select)}`, { headers })
      const value = await readResponse(response)
      if (Array.isArray(value) && value.length === 0) return null
      return asProfile(value)
    },
    async updateOwnProfile(input: UpdateAccountProfileInput): Promise<AccountProfile> {
      const body = validateAccountProfileUpdate(input)
      const response = await request(`${url}/rest/v1/profiles?${ownerFilter}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(body),
      })
      return asProfile(await readResponse(response))
    },
    /** Upload only into this user's private Storage prefix. */
    async uploadOwnAvatar(file: File): Promise<PreparedAvatarUpload> {
      await validateAvatarImageFile(file)
      const prepared = prepareAvatarUpload(session.user.id, file)
      const response = await request(storageObjectUrl(url, prepared.path), {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': prepared.contentType, 'x-upsert': 'false' },
        body: file,
      })
      if (!response.ok) throw new Error('头像上传失败')
      return prepared
    },
    /** Delete only a private object owned by the current session user. */
    async deleteOwnAvatar(path: string): Promise<void> {
      assertOwnAvatarPath(session.user.id, path)
      const response = await request(storageObjectUrl(url, path), {
        method: 'DELETE',
        headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}` },
      })
      if (!response.ok && response.status !== 404) throw new Error('旧头像清理失败')
    },
  }
}
