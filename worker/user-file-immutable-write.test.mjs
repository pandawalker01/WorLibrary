import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { putImmutablePrivateChunk } from './user-file-immutable-write.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const intent = bytes => ({ key: 'synthetic-private-intent', size: bytes.length, hash: sha(bytes) })
function digestFactory() {
  const hash = createHash('sha256'); let finish; let fail
  const digest = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  const stream = new WritableStream({ write: bytes => hash.update(bytes), close: () => finish(Uint8Array.from(hash.digest()).buffer), abort: fail })
  stream.digest = digest
  return stream
}

test('immutable write rejects invalid descriptors and wrong bytes before any object IO', async () => {
  const bytes = Buffer.from('abc'); const valid = intent(bytes); let calls = 0
  const bucket = { put: async () => { calls++; return { size: 3 } } }
  for (const invalid of [{ ...valid, size: 0 }, { ...valid, size: 8388609 }, { ...valid, hash: 'bad' }, { ...valid, key: '' }]) {
    await assert.rejects(putImmutablePrivateChunk(bucket, invalid, bytes), { code: 'INVALID_PRIVATE_WRITE_INTENT' })
  }
  await assert.rejects(putImmutablePrivateChunk(bucket, valid, Buffer.from('xyz')), { code: 'PRIVATE_WRITE_HASH_MISMATCH' })
  assert.equal(calls, 0)
})

test('immutable write copies bytes before awaits and always uses a conditional checksum write', async () => {
  const bytes = Buffer.from('abc'); const valid = intent(bytes); const expected = { ...valid }; let stored
  const bucket = { put: async (key, body, options) => {
    stored = Buffer.from(body); assert.equal(key, expected.key)
    assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' }); assert.equal(options.sha256, expected.hash)
    return { size: body.length }
  } }
  const pending = putImmutablePrivateChunk(bucket, valid, bytes)
  bytes.fill(0); valid.key = 'mutated-private-key'; valid.hash = sha(bytes); valid.size = 1
  assert.deepEqual(await pending, { created: true }); assert.equal(stored.toString(), 'abc')
})

test('conditional miss verifies actual bytes for an identical retry without replacing the object', async () => {
  const bytes = Buffer.from('abc'); let puts = 0; let reads = 0
  const bucket = { put: async () => { puts++; return null }, get: async () => { reads++; return { size: 3, body: new Response(bytes).body } } }
  assert.deepEqual(await putImmutablePrivateChunk(bucket, intent(bytes), bytes, digestFactory), { created: false })
  assert.equal(puts, 1); assert.equal(reads, 1)
})

test('conflicts, missing retry objects and empty objects fail without cleanup or unconditional fallback', async () => {
  const bytes = Buffer.from('abc')
  for (const object of [null, { size: 0, body: new Response('').body }, { size: 3, body: new Response('xyz').body }]) {
    let puts = 0; let deletes = 0
    const bucket = { put: async () => { puts++; return null }, get: async () => object, delete: async () => { deletes++ } }
    await assert.rejects(putImmutablePrivateChunk(bucket, intent(bytes), bytes, digestFactory), { code: 'PRIVATE_WRITE_FAILED' })
    assert.equal(puts, 1); assert.equal(deletes, 0)
  }
})

test('unexpected SDK errors and invalid put receipts never expose locators or report success', async () => {
  const bytes = Buffer.from('abc')
  for (const bucket of [{ put: async () => { throw new Error('sensitive locator') } }, { put: async () => undefined }, { put: async () => ({ size: 2 }) }]) {
    await assert.rejects(putImmutablePrivateChunk(bucket, intent(bytes), bytes), error =>
      ['PRIVATE_WRITE_FAILED', 'PRIVATE_WRITE_RESULT_INVALID'].includes(error.code) && !error.message.includes('locator'))
  }
})

test('native R2 conditional writes preserve bytes under concurrent retries and conflicting uploads', async () => {
  const write = await readFile(new URL('./user-file-immutable-write.mjs', import.meta.url), 'utf8')
  const integrity = await readFile(new URL('./user-file-integrity.mjs', import.meta.url), 'utf8')
  const entry = `import { putImmutablePrivateChunk } from './user-file-immutable-write.mjs';
    export default { async fetch(request, env) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      try { return Response.json(await putImmutablePrivateChunk(env.TEST_FILES,
        {key:'synthetic-private-intent',size:bytes.length,hash:request.headers.get('x-fixture-hash')},bytes)); }
      catch(error) { return Response.json({code:error.code},{status:409}); }
    } };`
  const root = resolve('test-results-agent-a-immutable')
  const runtime = new Miniflare(convertV4MiniflareOptions({ port: 0, host: '127.0.0.1', cf: false, workers: [{
    name: 'immutable-file-write', compatibilityDate: '2026-10-15', r2Buckets: ['TEST_FILES'],
    modules: [{ type: 'ESModule', path: resolve(root, 'entry.mjs'), contents: entry },
      { type: 'ESModule', path: resolve(root, 'user-file-immutable-write.mjs'), contents: write },
      { type: 'ESModule', path: resolve(root, 'user-file-integrity.mjs'), contents: integrity }],
  }] }))
  try {
    const bytes = Buffer.from('abc'); const other = Buffer.from('xyz')
    const put = bytes => runtime.dispatchFetch('http://localhost/internal-fixture', { method: 'POST', body: bytes, headers: { 'x-fixture-hash': sha(bytes) } })
    const responses = await Promise.all([put(bytes), put(bytes)])
    assert.deepEqual(responses.map(response => response.status), [200, 200])
    const receipts = await Promise.all(responses.map(response => response.json()))
    assert.deepEqual(receipts.map(receipt => receipt.created).sort(), [false, true])
    const bucket = await runtime.getR2Bucket('TEST_FILES')
    const original = await bucket.get('synthetic-private-intent'); const etag = original.etag
    assert.equal(await original.text(), 'abc')
    const conflict = await put(other); assert.equal(conflict.status, 409)
    assert.deepEqual(await conflict.json(), { code: 'PRIVATE_WRITE_FAILED' })
    const unchanged = await bucket.get('synthetic-private-intent')
    assert.equal(unchanged.etag, etag); assert.equal(await unchanged.text(), 'abc')
    // A pre-existing empty object must not be mistaken for an uploaded chunk.
    // This tests fail-closed behavior, not adoption of a deletion-fence policy.
    await bucket.put('synthetic-private-intent', new Uint8Array())
    assert.equal((await put(bytes)).status, 409)
    assert.equal((await bucket.head('synthetic-private-intent')).size, 0)
  } finally { await runtime.dispose() }
})
