import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { verifyPrivateFileChunks } from './user-file-integrity.mjs'

const CHUNK = 8 * 1024 * 1024
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function digestFactory() {
  const hash = createHash('sha256'); let finish; let fail
  const digest = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  const stream = new WritableStream({
    write(bytes) { hash.update(bytes) },
    close() { finish(Uint8Array.from(hash.digest()).buffer) },
    abort(error) { fail(error) },
  })
  stream.digest = digest
  return stream
}
function fixture(bytes) {
  const rows = []; const objects = new Map()
  for (let index = 0; index < Math.ceil(bytes.length / CHUNK); index += 1) {
    const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK)
    const key = `fixture-private-${index}`
    rows.push({ index, key, size: part.length, hash: sha(part) }); objects.set(key, part)
  }
  let open = 0; let maxOpen = 0; let maxRead = 0; let cancelled = 0
  const bucket = { async get(key) {
    const part = objects.get(key); if (!part) return null
    open += 1; maxOpen = Math.max(maxOpen, open); let offset = 0; let closed = false
    const close = () => { if (!closed) { closed = true; open -= 1 } }
    return { size: part.length, body: new ReadableStream({
      pull(controller) {
        if (offset === part.length) { close(); controller.close(); return }
        const next = part.subarray(offset, offset + 65536); offset += next.length
        maxRead = Math.max(maxRead, next.length); controller.enqueue(next)
      },
      cancel() { cancelled += 1; close() },
    }) }
  } }
  return { manifest: { size: bytes.length, hash: sha(bytes), chunkSize: CHUNK, chunkCount: rows.length }, rows, objects, bucket, stats: () => ({ maxOpen, maxRead, cancelled }) }
}

test('integrity checks a known SHA-256 vector from actual streamed bytes', async () => {
  const f = fixture(Buffer.from('abc'))
  assert.equal(f.manifest.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.deepEqual(await verifyPrivateFileChunks(f.manifest, f.rows, f.bucket, digestFactory), { size: 3, sha256: f.manifest.hash })
})

test('multi-chunk verification consumes one bounded object stream at a time', async () => {
  const bytes = Buffer.alloc(CHUNK + 3, 7); const f = fixture(bytes)
  assert.deepEqual(await verifyPrivateFileChunks(f.manifest, f.rows, f.bucket, digestFactory), { size: bytes.length, sha256: sha(bytes) })
  assert.equal(f.stats().maxOpen, 1); assert.ok(f.stats().maxRead <= 65536)
})

test('same-size corruption is rejected at the chunk digest before activation can be requested', async () => {
  const f = fixture(Buffer.from('abc')); f.objects.set(f.rows[0].key, Buffer.from('xyz'))
  await assert.rejects(verifyPrivateFileChunks(f.manifest, f.rows, f.bucket, digestFactory), { code: 'PRIVATE_CHUNK_HASH_MISMATCH' })
})

test('valid per-chunk hashes cannot substitute for a matching whole-file hash', async () => {
  const f = fixture(Buffer.from('abc')); f.manifest.hash = sha(Buffer.from('xyz'))
  await assert.rejects(verifyPrivateFileChunks(f.manifest, f.rows, f.bucket, digestFactory), { code: 'PRIVATE_FILE_HASH_MISMATCH' })
})

test('missing objects and truncated or oversized bodies fail closed', async () => {
  const f = fixture(Buffer.from('abcd'))
  f.objects.clear()
  await assert.rejects(verifyPrivateFileChunks(f.manifest, f.rows, f.bucket, digestFactory), { code: 'PRIVATE_OBJECT_UNAVAILABLE' })
  for (const bytes of [Buffer.from('abc'), Buffer.from('abcde')]) {
    const bucket = { get: async () => ({ size: 4, body: new Response(bytes).body }) }
    await assert.rejects(verifyPrivateFileChunks(f.manifest, f.rows, bucket, digestFactory), { code: 'PRIVATE_OBJECT_SIZE_MISMATCH' })
  }
  let cancelled = 0
  const wrongSize = { get: async () => ({ size: 3, body: new ReadableStream({ cancel() { cancelled += 1 } }) }) }
  await assert.rejects(verifyPrivateFileChunks(f.manifest, f.rows, wrongSize, digestFactory), { code: 'PRIVATE_OBJECT_SIZE_MISMATCH' })
  assert.equal(cancelled, 1)
})

test('invalid ledger order and oversized manifests cause zero object reads', async () => {
  const f = fixture(Buffer.from('abc')); let reads = 0
  const bucket = { get: async () => { reads += 1; return null } }
  await assert.rejects(verifyPrivateFileChunks(f.manifest, [{ ...f.rows[0], index: 1 }], bucket, digestFactory), { code: 'INVALID_CHUNK_LEDGER' })
  await assert.rejects(verifyPrivateFileChunks({ ...f.manifest, size: 1024 ** 3 + 1 }, f.rows, bucket, digestFactory), { code: 'INVALID_FILE_DESCRIPTOR' })
  assert.equal(reads, 0)
})

test('SDK failures never propagate internal object locations', async () => {
  const f = fixture(Buffer.from('abc'))
  const bucket = { get: async () => { throw new Error('internal sensitive object locator') } }
  await assert.rejects(verifyPrivateFileChunks(f.manifest, f.rows, bucket, digestFactory), (error) => error.code === 'PRIVATE_INTEGRITY_READ_FAILED' && !error.message.includes('locator'))
})

test('native workerd DigestStream verifies local R2 bodies without a Node digest fallback', async () => {
  const source = await readFile(new URL('./user-file-integrity.mjs', import.meta.url), 'utf8')
  const bytes = Buffer.alloc(CHUNK + 3, 19); const f = fixture(bytes)
  const entry = `import { verifyPrivateFileChunks } from './integrity.mjs';
    export default { async fetch(request, env) {
      const input = await request.json();
      try { return Response.json(await verifyPrivateFileChunks(input.manifest, input.rows, env.TEST_FILES)); }
      catch (error) { return Response.json({ code: error.code }, { status: 409 }); }
    } };`
  const runtime = new Miniflare(convertV4MiniflareOptions({ port: 0, host: '127.0.0.1', cf: false, workers: [{ name: 'private-file-integrity', compatibilityDate: '2026-10-15',
    modules: [{ type: 'ESModule', path: resolve('test-results-agent-a-integrity/entry.mjs'), contents: entry },
      { type: 'ESModule', path: resolve('test-results-agent-a-integrity/integrity.mjs'), contents: source }],
    r2Buckets: ['TEST_FILES'], }],
  }))
  try {
    const bucket = await runtime.getR2Bucket('TEST_FILES')
    for (const [key, value] of f.objects) await bucket.put(key, value)
    const verify = () => runtime.dispatchFetch('http://localhost/verify', { method: 'POST', body: JSON.stringify({ manifest: f.manifest, rows: f.rows }) })
    const response = await verify(); assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { size: bytes.length, sha256: sha(bytes) })
    await bucket.put(f.rows[1].key, Buffer.from([8, 8, 8]))
    const corrupt = await verify(); assert.equal(corrupt.status, 409)
    assert.deepEqual(await corrupt.json(), { code: 'PRIVATE_CHUNK_HASH_MISMATCH' })
  } finally { await runtime.dispose() }
})
