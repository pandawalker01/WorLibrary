import { expect, test } from '@playwright/test'
import { listRemotePrivateFileDeletions, runPrivateFileDeletion, type PrivateFileDeletion, type PrivateFileDeletionStore } from '../src/lib/user-file-delete-task'

const userId = '11111111-1111-4111-8111-111111111111'
const manifestId = '22222222-2222-4222-8222-222222222222'
const editionId = '33333333-3333-4333-8333-333333333333'
const job: PrivateFileDeletion = { userId, manifestId, editionId, label: 'original.pdf', state: 'pending' }
const session = { accessToken: 'synthetic-owner', refreshToken: 'synthetic-refresh', user: { id: userId, isAnonymous: false } }
function memory() {
  const rows = new Map<string, PrivateFileDeletion>()
  const key = (userId: string, manifestId: string) => `${userId}:${manifestId}`
  const store: PrivateFileDeletionStore = {
    list: async userId => [...rows.values()].filter(row => row.userId === userId),
    put: async row => { rows.set(key(row.userId, row.manifestId), { ...row }) },
    remove: async (userId, manifestId) => { rows.delete(key(userId, manifestId)) },
  }
  return { rows, store }
}

test('private deletion persists before network and removes only after an explicit deleted receipt', async () => {
  const { store } = memory(); let calls = 0
  const client = { deleteFromCloud: async (manifest: string, edition: string) => {
    expect(await store.list(userId)).toEqual([job]); expect([manifest, edition]).toEqual([manifestId, editionId])
    return ++calls === 1 ? 'deleting' as const : 'deleted' as const
  } }
  expect(await runPrivateFileDeletion({ job, store, client, isCurrent: () => true })).toBe('deleting')
  expect((await store.list(userId))[0].state).toBe('deleting')
  expect(await runPrivateFileDeletion({ job, store, client, isCurrent: () => true })).toBe('deleted')
  expect(await store.list(userId)).toEqual([])
})

test('journal failure prevents DELETE; network failure retains a retryable durable entry', async () => {
  const { store } = memory(); let calls = 0
  const client = { deleteFromCloud: async () => { calls++; throw new Error('synthetic network failure') } }
  await expect(runPrivateFileDeletion({ job, store: { ...store, put: async () => { throw new Error('storage blocked') } }, client, isCurrent: () => true })).rejects.toThrow('storage blocked')
  expect(calls).toBe(0)
  await expect(runPrivateFileDeletion({ job, store, client, isCurrent: () => true })).rejects.toThrow('synthetic network failure')
  expect(await store.list(userId)).toEqual([{ ...job, state: 'failed' }]); expect(calls).toBe(1)
})

test('session change during deletion leaves the original account pending and discards late completion', async () => {
  const { store } = memory(); let current = true
  await expect(runPrivateFileDeletion({ job, store, isCurrent: () => current, client: { deleteFromCloud: async () => { current = false; return 'deleted' } } })).rejects.toThrow('PRIVATE_DELETION_INVALIDATED')
  expect(await store.list(userId)).toEqual([job])
  expect(await store.list('44444444-4444-4444-8444-444444444444')).toEqual([])
})

test('remote cleanup status uses empty owner-bound RPC and rejects private or unknown fields', async () => {
  let captured: Request | undefined
  const config = { url: 'https://fixture.invalid', anonKey: 'synthetic-public', fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init)
    return Response.json([{ manifestId, editionId, fileName: 'original.pdf' }])
  } }
  expect(await listRemotePrivateFileDeletions(session, config)).toEqual([{ ...job, state: 'deleting' }])
  expect(captured!.url).toBe('https://fixture.invalid/rest/v1/rpc/list_private_file_cleanup_jobs')
  expect(await captured!.json()).toEqual({}); expect(captured!.headers.get('authorization')).toBe('Bearer synthetic-owner')
  await expect(listRemotePrivateFileDeletions(session, { ...config, fetch: async () => Response.json([{ manifestId, editionId, fileName: 'original.pdf', object_key: 'must-not-propagate' }]) })).rejects.toThrow('INVALID_PRIVATE_DELETION_STATUS')
})

test('A to B to A cannot revive an older deletion generation even with the same account ID', async () => {
  const { store } = memory(); let generation = 1; const original = generation
  await expect(runPrivateFileDeletion({ job, store, isCurrent: () => generation === original,
    client: { deleteFromCloud: async () => { generation++; generation++; return 'deleted' } },
  })).rejects.toThrow('PRIVATE_DELETION_INVALIDATED')
  expect(await store.list(userId)).toEqual([job])
})

test('anonymous and invalidated status requests cannot continue with another account', async () => {
  let calls = 0; let current = false
  const config = { url: 'https://fixture.invalid', anonKey: 'synthetic-public', isCurrent: () => current, fetch: async () => { calls++; current = false; return Response.json([{ manifestId, editionId, fileName: 'original.pdf' }]) } }
  await expect(listRemotePrivateFileDeletions({ ...session, user: { ...session.user, isAnonymous: true } }, config)).rejects.toThrow('STABLE_ACCOUNT_REQUIRED')
  await expect(listRemotePrivateFileDeletions(session, config)).rejects.toThrow('PRIVATE_DELETION_INVALIDATED'); expect(calls).toBe(0)
  current = true
  await expect(listRemotePrivateFileDeletions(session, config)).rejects.toThrow('PRIVATE_DELETION_INVALIDATED'); expect(calls).toBe(1)
})

test('deletion journal rejects accidental file payloads before any persistence or network', async () => {
  const { store } = memory(); let writes = 0; let requests = 0
  await expect(runPrivateFileDeletion({ job: { ...job, file: new Blob(['private bytes']) } as PrivateFileDeletion,
    store: { ...store, put: async () => { writes++ } }, isCurrent: () => true,
    client: { deleteFromCloud: async () => { requests++; return 'deleted' } },
  })).rejects.toThrow('INVALID_PRIVATE_DELETION')
  expect([writes, requests]).toEqual([0, 0])
})
