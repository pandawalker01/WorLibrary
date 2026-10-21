import { expect, test } from '@playwright/test'
import { assertMetadataOnlySyncPayload, createRemoteClient, RemoteRequestError } from '../src/lib/remote'
import type { AuthSession } from '../src/lib/auth'

const session: AuthSession = {
  accessToken: 'session-jwt',
  refreshToken: 'refresh-token',
  user: { id: 'stable-user', isAnonymous: false },
}

const mutation = {
  p_device_id: 'a1d8eb2c-6996-4b5a-928f-2c429c083e69',
  p_operation_id: '2ce61155-bf0a-4a47-9b0c-f6d8d9f07f9e',
  p_entity_type: 'setting' as const,
  p_entity_id: 'reader.theme',
  p_operation: 'upsert' as const,
  p_base_revision: 0,
  p_payload: { value: 'paper' },
}

test('controlled sync RPC posts only to the typed Supabase RPC endpoint with session headers', async () => {
  const originalFetch = globalThis.fetch
  let request: Request | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init)
    return new Response(JSON.stringify([{ sequence: 8, entity_revision: 1, operation: 'upsert', applied: true }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const client = createRemoteClient(session, { url: 'https://sync.example.com/', anonKey: 'public-anon-key', retryDelayMs: 0 })
    await expect(client.rpc('apply_metadata_sync_change', mutation)).resolves.toEqual([
      { sequence: 8, entity_revision: 1, operation: 'upsert', applied: true },
    ])
    expect(request?.url).toBe('https://sync.example.com/rest/v1/rpc/apply_metadata_sync_change')
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('apikey')).toBe('public-anon-key')
    expect(request?.headers.get('authorization')).toBe('Bearer session-jwt')
    expect(await request?.json()).toEqual(mutation)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('controlled sync RPC retries only within its bounded retry budget', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('busy', { status: 503 })
  }) as typeof fetch
  try {
    const client = createRemoteClient(session, { url: 'https://sync.example.com', anonKey: 'public-anon-key', maxAttempts: 2, retryDelayMs: 0 })
    await expect(client.rpc('apply_metadata_sync_change', mutation)).rejects.toBeInstanceOf(RemoteRequestError)
    expect(calls).toBe(2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('controlled sync RPC rejects nested file, locator, URL, and full-content payloads before any request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; return new Response('[]', { status: 200 }) }) as typeof fetch
  try {
    const client = createRemoteClient(session, { url: 'https://sync.example.com', anonKey: 'public-anon-key', retryDelayMs: 0 })
    for (const payload of [
      { metadata: { object_key: 'private/user.epub' } },
      { metadata: { landing: 'https://source.example.com/book' } },
      { metadata: { raw_content: 'an entire book body' } },
      { metadata: { 正文: '不应上传的全文' } },
      { metadata: { bytes: new Uint8Array([1, 2, 3]) } },
    ]) {
      await expect(client.rpc('apply_metadata_sync_change', { ...mutation, p_payload: payload })).rejects.toBeInstanceOf(TypeError)
    }
    expect(() => assertMetadataOnlySyncPayload({ metadata: { signed_url: 'opaque' } })).toThrow(TypeError)
    expect(calls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('controlled RPC does not allow an anonymous session to upload metadata', async () => {
  const anonymous = createRemoteClient({ ...session, user: { ...session.user, isAnonymous: true } }, {
    url: 'https://sync.example.com', anonKey: 'public-anon-key', retryDelayMs: 0,
  })
  await expect(anonymous.rpc('apply_metadata_sync_change', mutation)).rejects.toBeInstanceOf(RemoteRequestError)
})
