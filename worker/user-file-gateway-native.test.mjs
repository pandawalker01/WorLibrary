import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const owner = '11111111-1111-4111-8111-111111111111'
const manifestId = '22222222-2222-4222-8222-222222222222'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Real Worker routing + native R2/DigestStream. SQL replies are a minimal
// synthetic service model; real SQL locks/permissions use the separate PG suite.
async function gateway(t, bytes = Buffer.from('abcd')) {
  const state = { enabled: true, status: 'uploading', generation: 0, intents: new Map(), chunks: new Map(), used: 0, reserved: bytes.length, calls: [] }
  const descriptor = { size: bytes.length, hash: sha(bytes), chunkSize: 8388608, chunkCount: Math.ceil(bytes.length / 8388608) }
  const error = message => Response.json({ message }, { status: 409 })
  const outboundService = async request => {
    const url = new URL(request.url)
    assert.equal(url.hostname, 'fixture.invalid', 'No external network allowed')
    if (url.pathname === '/auth/v1/user') return Response.json({ id: request.headers.get('authorization')?.includes('other') ? randomUUID() : owner })
    if (!url.pathname.includes('/rpc/')) {
      if (url.pathname.endsWith('/user_file_chunks')) return Response.json([...state.chunks.values()].map(chunk => ({ object_key: chunk.key, ciphertext_size: chunk.size,
        manifest: { user_id: owner, upload_state: state.status, deleted_at: state.status === 'deleting' || state.status === 'deleted' ? 'deleted' : null } })))
      return Response.json(state.status === 'active' ? [{ id: manifestId }] : [])
    }
    const name = url.pathname.split('/').at(-1); const body = await request.json(); state.calls.push(name)
    if (body.p_user_id !== owner) return error('manifest not found')
    if (name === 'prepare_private_file_chunk') {
      if (!state.enabled || state.status !== 'uploading') return error('upload is not active')
      let intent = [...state.intents.values()].find(intent => intent.index === body.p_chunk_index)
      if (intent && intent.hash !== body.p_hash) return error('intent conflict')
      if (!intent) { const id = randomUUID(); intent = { id, key: `private-intents/${id}`, hash: body.p_hash, size: body.p_size, index: body.p_chunk_index, fenced: false }; state.intents.set(id, intent) }
      return Response.json({ id: intent.id, key: intent.key, hash: intent.hash, size: intent.size })
    }
    if (name === 'commit_private_file_chunk') {
      const intent = state.intents.get(body.p_intent_id)
      if (!state.enabled || state.status !== 'uploading' || !intent || intent.fenced) return error('upload is not active')
      if (!state.chunks.has(intent.index)) { state.chunks.set(intent.index, intent); state.generation++ }
      return Response.json(null)
    }
    if (name === 'get_private_file_verification_snapshot') {
      if (!state.enabled || !['uploading', 'active'].includes(state.status)) return error('manifest is not verifiable')
      return Response.json({ generation: state.generation, manifest: descriptor, chunks: [...state.chunks.values()].map(i => ({ index: i.index, key: i.key, hash: i.hash, size: i.size })) })
    }
    if (name === 'complete_verified_user_file_upload') {
      if (!state.enabled || !['uploading', 'active'].includes(state.status) || body.p_generation !== state.generation
        || body.p_verified_hash !== descriptor.hash || body.p_verified_size !== descriptor.size) return error('verification rejected')
      state.status = 'active'; state.used = bytes.length; state.reserved = 0; return Response.json(true)
    }
    if (name === 'request_user_file_delete') { if (state.status !== 'deleted') state.status = 'deleting'; return Response.json([{ manifest_id: manifestId, object_keys: [] }]) }
    if (name === 'get_private_file_cleanup_intents') return Response.json([...state.intents.values()].map(i => ({ id: i.id, key: i.key })))
    if (name === 'ack_private_file_body_fence') { state.intents.get(body.p_intent_id).fenced = true; return Response.json(null) }
    if (name === 'finish_user_file_delete') {
      if ([...state.intents.values()].some(i => !i.fenced)) return error('cleanup incomplete')
      state.status = 'deleted'; state.used = 0; state.reserved = 0; return Response.json(null)
    }
    throw new Error('Unexpected synthetic service operation')
  }
  const entry = `import worker from './index.mjs';
    let waiting=false, go=false;
    async function waitHere() {waiting=true; while(!go) await new Promise(done=>setTimeout(done,5));waiting=false;}
    export default { async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if(path==='/__fixture/waiting') return Response.json({waiting});
      if(path==='/__fixture/release') { go=true; return new Response('ok'); }
      if(request.headers.has('x-fixture-declared-size')) {
        const headers=new Headers(request.headers);headers.set('content-length',request.headers.get('x-fixture-declared-size'));
        request=new Request(request,{headers});
      }
      let zeros=0;
      const bucket = {
        async put(key,body,options) {
          if(options?.onlyIf && request.headers.has('x-fixture-hold')) {
            await waitHere();
          }
          if(body.byteLength===0 && ++zeros===Number(request.headers.get('x-fixture-fail-fence'))) throw new Error('synthetic SDK failure');
          return env.USER_BACKUPS.put(key,body,options);
        },
        async get(key) { const value=await env.USER_BACKUPS.get(key);
          if(request.headers.has('x-fixture-hold-read')) await waitHere();
          return value;
        },
        head:key=>env.USER_BACKUPS.head(key),
        delete() {throw new Error('physical deletion path forbidden');}
      };
      return worker.fetch(request,{...env,USER_BACKUPS:bucket});
    } };`
  const names = ['index.mjs', 'user-file-integrity.mjs', 'user-file-immutable-write.mjs', 'user-file-body-fence.mjs']
  const root = resolve('test-results-agent-a-native-gateway')
  const modules = await Promise.all(names.map(async name => ({ type: 'ESModule', path: resolve(root, name), contents: await readFile(new URL(name, import.meta.url), 'utf8') })))
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false, workers: [{
    name: 'private-file-gateway', compatibilityDate: '2026-10-15', modules: [{ type: 'ESModule', path: resolve(root, 'entry.mjs'), contents: entry }, ...modules],
    r2Buckets: ['USER_BACKUPS'], bindings: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service' }, outboundService,
  }] }))
  t.after(() => runtime.dispose())
  const call = (suffix, method = 'POST', body, headers = {}) => runtime.dispatchFetch(`http://localhost/api/user-files/${manifestId}${suffix}`, {
    method, body, headers: { authorization: 'Bearer synthetic-owner', ...(body ? { 'content-length': String(body.length) } : {}), ...headers },
  })
  const wait = async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const response = await runtime.dispatchFetch('http://localhost/__fixture/waiting')
      if ((await response.json()).waiting) return
      await new Promise(done => setTimeout(done, 10))
    }
    assert.fail('Expected controlled IO boundary')
  }
  const release = () => runtime.dispatchFetch('http://localhost/__fixture/release')
  return { runtime, state, call, wait, release, bucket: await runtime.getR2Bucket('USER_BACKUPS') }
}

test('native gateway completes only after byte verification and serves private bytes without locators', async t => {
  const g = await gateway(t)
  assert.equal((await g.call('/chunks/0', 'POST', Buffer.from('abcd'))).status, 200)
  assert.deepEqual(await (await g.call('/complete')).json(), { ok: true })
  assert.equal((await g.call('/complete')).status, 200); assert.equal(g.state.used, 4)
  const read = await g.call('/chunks/0', 'GET'); assert.equal(read.status, 200); assert.equal(await read.text(), 'abcd')
  assert.doesNotMatch(JSON.stringify([...read.headers]), /private-intents|synthetic-service/)
  const intent = [...g.state.intents.values()][0]
  await g.bucket.put(intent.key, Buffer.from('wxyz'))
  assert.equal((await g.call('/complete')).status, 409)
  assert.ok(g.state.calls.includes('complete_verified_user_file_upload'))
  assert.ok(!g.state.calls.includes('complete_user_file_upload')); assert.ok(!g.state.calls.includes('record_user_file_chunk'))
})

test('native delete fences an unconfirmed intent before delayed PUT and late receipt cannot resurrect bytes', async t => {
  const g = await gateway(t)
  const pending = g.call('/chunks/0', 'POST', Buffer.from('abcd'), { 'x-fixture-hold': '1' })
  await g.wait(); assert.equal(g.state.intents.size, 1); assert.equal(g.state.chunks.size, 0)
  assert.deepEqual(await (await g.call('', 'DELETE')).json(), { status: 'deleted' })
  const key = [...g.state.intents.values()][0].key
  assert.equal((await g.bucket.head(key)).size, 0)
  await g.release(); assert.equal((await pending).status, 409)
  assert.equal((await g.bucket.head(key)).size, 0); assert.equal(g.state.reserved, 0)
  assert.equal((await g.call('/chunks/0', 'POST', Buffer.from('abcd'))).status, 409)
  assert.equal((await g.call('/chunks/0', 'GET')).status, 404)
})

test('native corrupt bytes before activation never issue a verified completion receipt', async t => {
  const g = await gateway(t)
  assert.equal((await g.call('/chunks/0', 'POST', Buffer.from('abcd'))).status, 200)
  await g.bucket.put([...g.state.intents.values()][0].key, Buffer.from('wxyz'))
  assert.equal((await g.call('/complete')).status, 409)
  assert.equal(g.state.status, 'uploading'); assert.equal(g.state.used, 0); assert.equal(g.state.reserved, 4)
  assert.ok(!g.state.calls.includes('complete_verified_user_file_upload'))
})

test('native deletion after upload clears body, retains no sensitive metadata and is repeatable while paused', async t => {
  const g = await gateway(t)
  assert.equal((await g.call('/chunks/0', 'POST', Buffer.from('abcd'))).status, 200)
  assert.equal((await g.call('/complete')).status, 200); g.state.enabled = false
  assert.deepEqual(await (await g.call('', 'DELETE')).json(), { status: 'deleted' })
  assert.deepEqual(await (await g.call('', 'DELETE')).json(), { status: 'deleted' })
  const object = await g.bucket.get([...g.state.intents.values()][0].key)
  assert.equal(await object.text(), ''); assert.deepEqual(object.customMetadata, {})
  assert.equal(g.state.used, 0)
})

test('native partial fence failure preserves deleting and quota until retry confirms every intent', async t => {
  const bytes = Buffer.alloc(8388612, 7); const g = await gateway(t, bytes)
  assert.equal((await g.call('/chunks/0', 'POST', bytes.subarray(0, 8388608))).status, 200)
  assert.equal((await g.call('/chunks/1', 'POST', bytes.subarray(8388608))).status, 200)
  assert.equal((await g.call('/complete')).status, 200)
  assert.deepEqual(await (await g.call('', 'DELETE', undefined, { 'x-fixture-fail-fence': '2' })).json(), { status: 'deleting' })
  assert.equal(g.state.used, bytes.length); assert.equal(g.state.status, 'deleting')
  assert.equal([...g.state.intents.values()].filter(i => i.fenced).length, 1)
  assert.deepEqual(await (await g.call('', 'DELETE')).json(), { status: 'deleted' })
  assert.equal(g.state.used, 0)
  for (const i of g.state.intents.values()) assert.equal((await g.bucket.head(i.key)).size, 0)
})

test('native paused in-flight upload remains registered and rejected until deletion fences it', async t => {
  const g = await gateway(t)
  const pending = g.call('/chunks/0', 'POST', Buffer.from('abcd'), { 'x-fixture-hold': '1' })
  await g.wait(); g.state.enabled = false; await g.release()
  assert.equal((await pending).status, 409); assert.equal(g.state.chunks.size, 0); assert.equal(g.state.reserved, 4)
  assert.equal((await g.call('/chunks/0', 'POST', Buffer.from('abcd'))).status, 409)
  assert.deepEqual(await (await g.call('', 'DELETE')).json(), { status: 'deleted' })
  assert.equal((await g.bucket.head([...g.state.intents.values()][0].key)).size, 0)
})

test('native snapshot held across deletion cannot activate, and zero fences cannot be served as body', async t => {
  const g = await gateway(t)
  assert.equal((await g.call('/chunks/0', 'POST', Buffer.from('abcd'))).status, 200)
  const pending = g.call('/complete', 'POST', undefined, { 'x-fixture-hold-read': '1' })
  await g.wait(); await g.call('', 'DELETE'); await g.release()
  assert.equal((await pending).status, 409); assert.equal(g.state.status, 'deleted'); assert.equal(g.state.used, 0)
  // Even a stale/faulty service row claiming active must not serve an empty fence.
  g.state.status = 'active'
  assert.equal((await g.call('/chunks/0', 'GET')).status, 404)
})

test('native old or foreign write identity and oversized stream cannot write or leak private locators', async t => {
  const g = await gateway(t)
  const foreign = await g.call('/chunks/0', 'POST', Buffer.from('abcd'), { authorization: 'Bearer synthetic-other' })
  assert.equal(foreign.status, 409); assert.equal(g.state.intents.size, 0)
  assert.doesNotMatch(await foreign.text(), /private-intents|synthetic-service|object_key/)
  // Header/body disagreement is checked while reading before admission.
  const oversized = await g.call('/chunks/0', 'POST', Buffer.from('abcde'), { 'x-fixture-declared-size': '4' })
  assert.equal(oversized.status, 400); assert.equal(g.state.intents.size, 0)
})

test('native read rechecks active ownership after object IO across deletion', async t => {
  const g = await gateway(t)
  await g.call('/chunks/0', 'POST', Buffer.from('abcd')); await g.call('/complete')
  const pending = g.call('/chunks/0', 'GET', undefined, { 'x-fixture-hold-read': '1' })
  await g.wait(); await g.call('', 'DELETE'); await g.release()
  const response = await pending
  assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /abcd/)
})
