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

const deviceRegistration = {
  p_client_instance_id: 'a1d8eb2c-6996-4b5a-928f-2c429c083e69',
  p_platform: 'web' as const,
  p_app_version: '0.1.0',
  p_metadata: { installation: 'browser' },
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

test('private highlight sync can only send the reviewed same-account excerpt fields', async () => {
  const originalFetch = globalThis.fetch
  let request: Request | undefined
  const highlight = {
    p_device_id: mutation.p_device_id, p_operation_id: mutation.p_operation_id, p_highlight_id: '3ce61155-bf0a-4a47-9b0c-f6d8d9f07f9e',
    p_operation: 'upsert' as const, p_base_revision: 0, p_edition_id: '4ce61155-bf0a-4a47-9b0c-f6d8d9f07f9e',
    p_text: 'Private excerpt', p_location: 'epubcfi(/6/4)', p_note: 'My note', p_color: 'gold' as const, p_is_highlighted: true,
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init)
    return new Response(JSON.stringify([{ sequence: 8, entity_revision: 1, operation: 'upsert', applied: true }]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const client = createRemoteClient(session, { url: 'https://sync.example.com/', anonKey: 'public-anon-key', retryDelayMs: 0 })
    await client.rpc('apply_private_highlight_sync_change', { ...highlight, file_name: 'must-not-send.epub' } as never)
    expect(request?.url).toBe('https://sync.example.com/rest/v1/rpc/apply_private_highlight_sync_change')
    expect(await request?.json()).toEqual(highlight)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('device registration is allowlisted, sends only its minimal input, and projects a safe response', async () => {
  const originalFetch = globalThis.fetch
  let request: Request | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init)
    return new Response(JSON.stringify({
      id: 'device-row-id',
      user_id: 'must-not-reach-browser-caller',
      client_instance_id: deviceRegistration.p_client_instance_id,
      platform: 'web',
      last_seen_at: '2026-10-21T00:00:00.000Z',
      revoked_at: null,
      metadata: { server_owned: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const client = createRemoteClient(session, { url: 'https://sync.example.com/', anonKey: 'public-anon-key', retryDelayMs: 0 })
    const unsafeAtRuntime = { ...deviceRegistration, p_user_id: 'another-user' } as typeof deviceRegistration
    await expect(client.rpc('register_sync_device', unsafeAtRuntime)).resolves.toEqual({
      id: 'device-row-id', clientInstanceId: deviceRegistration.p_client_instance_id, platform: 'web',
      lastSeenAt: '2026-10-21T00:00:00.000Z', revokedAt: null,
    })
    expect(request?.url).toBe('https://sync.example.com/rest/v1/rpc/register_sync_device')
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('apikey')).toBe('public-anon-key')
    expect(request?.headers.get('authorization')).toBe('Bearer session-jwt')
    expect(await request?.json()).toEqual(deviceRegistration)
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
  await expect(anonymous.rpc('register_sync_device', deviceRegistration)).rejects.toBeInstanceOf(RemoteRequestError)
})

test('controlled RPC rejects names outside the explicit allowlist before making a request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as typeof fetch
  try {
    const client = createRemoteClient(session, { url: 'https://sync.example.com', anonKey: 'public-anon-key', retryDelayMs: 0 })
    await expect(client.rpc('device_row_upsert' as never, {} as never)).rejects.toBeInstanceOf(RemoteRequestError)
    expect(calls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
