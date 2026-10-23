import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  PROFILE_AVATAR_MAX_BYTES,
  createAccountProfileClient,
  prepareAvatarUpload,
  validateAvatarImageFile,
  validateAccountProfileUpdate,
} from '../src/lib/account-profile'
import type { AuthSession } from '../src/lib/auth'

const session: AuthSession = {
  accessToken: 'session-jwt',
  refreshToken: 'refresh-token',
  user: { id: '7a62ece5-bab6-41af-b2e5-563507eeed27', email: 'private@example.test', isAnonymous: false },
}

test('profile update uses a narrow public-profile payload and never copies email', async () => {
  const originalFetch = globalThis.fetch
  let request: Request | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init)
    return new Response(JSON.stringify([{
      id: session.user.id, display_name: '阅读熊猫', bio: '一本书一段路。', avatar_path: null,
      is_public: true, is_anonymous: false, updated_at: '2026-10-22T00:00:00.000Z',
    }]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const client = createAccountProfileClient(session, { url: 'https://profile.example.com/', anonKey: 'public-anon-key' })
    await expect(client.updateOwnProfile({ displayName: ' 阅读熊猫 ', bio: ' 一本书一段路。 ', isPublic: true })).resolves.toMatchObject({ displayName: '阅读熊猫', isPublic: true })
    expect(request?.url).toContain('/rest/v1/profiles?id=eq.7a62ece5-bab6-41af-b2e5-563507eeed27')
    expect(request?.method).toBe('PATCH')
    expect(request?.headers.get('authorization')).toBe('Bearer session-jwt')
    const requestPayload = await request?.json()
    expect(requestPayload).toEqual({ display_name: '阅读熊猫', bio: '一本书一段路。', is_public: true })
    expect(JSON.stringify(requestPayload)).not.toContain('private@example.test')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('profile service rejects invalid text, untrusted avatar paths, anonymous users, and unsafe avatar candidates', async () => {
  expect(() => validateAccountProfileUpdate({ displayName: 'x'.repeat(81) })).toThrow('公开昵称最多 80 个字符')
  expect(() => validateAccountProfileUpdate({ bio: '\u0000' })).toThrow('个人简介不能包含控制字符')
  expect(() => validateAccountProfileUpdate({ avatarPath: 'another-account/avatar/fake.png' })).toThrow('头像引用格式无效')
  expect(() => createAccountProfileClient({ ...session, user: { ...session.user, isAnonymous: true } }, { url: 'https://profile.example.com', anonKey: 'key' })).toThrow('匿名试用不能创建公开账户资料')
  expect(() => prepareAvatarUpload(session.user.id, { name: 'avatar.gif', type: 'image/gif', size: 12 }, 'd7798f86-b1c2-46ca-af26-ae0f048648f2')).toThrow('头像仅支持')
  expect(() => prepareAvatarUpload(session.user.id, { name: 'avatar.png', type: 'image/png', size: PROFILE_AVATAR_MAX_BYTES + 1 }, 'd7798f86-b1c2-46ca-af26-ae0f048648f2')).toThrow('头像大小')
  expect(prepareAvatarUpload(session.user.id, { name: 'avatar.webp', type: 'image/webp', size: 128 }, 'd7798f86-b1c2-46ca-af26-ae0f048648f2')).toEqual({
    path: '7a62ece5-bab6-41af-b2e5-563507eeed27/avatar/d7798f86-b1c2-46ca-af26-ae0f048648f2.webp',
    contentType: 'image/webp', size: 128,
  })
  await expect(validateAvatarImageFile(Object.assign(new Blob(['not an image'], { type: 'image/png' }), { name: 'avatar.png' }))).rejects.toThrow('头像文件内容不是声明的图片格式')
  await expect(validateAvatarImageFile(Object.assign(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), { name: 'avatar.png' }))).resolves.toBeUndefined()
})

test('account profile migration keeps email and roles out of browser-editable profiles and locks avatar objects to their owner', async () => {
  const migration = await readFile('supabase/migrations/0011_account_profile_and_avatar_foundation.sql', 'utf8')

  expect(migration).toContain("add column if not exists bio text")
  expect(migration).toContain("add column if not exists avatar_path text")
  expect(migration).toContain("add column if not exists is_public boolean")
  expect(migration).toContain("'profile-avatars'")
  expect(migration).toContain('5242880')
  expect(migration).toContain("array['image/jpeg', 'image/png', 'image/webp']")
  expect(migration).toContain('avatar path must belong to the profile owner')
  expect(migration).toContain('owned avatar object is required before saving its reference')
  expect(migration).toContain('anonymous accounts cannot publish a profile')
  expect(migration).toContain('for update to authenticated')
  expect(migration).toContain('owner_id = auth.uid()::text')
  expect(migration).toContain("p.avatar_path = storage.objects.name")
  expect(migration).toContain('this migration only creates Storage policy and metadata checks')
  expect(migration).not.toContain('email text')
  expect(migration).not.toContain('profiles.role')
  expect(migration).not.toContain('grant insert on public.profiles')
})
