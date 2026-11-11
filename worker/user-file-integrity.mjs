const CHUNK_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024 * 1024
const HASH = /^[0-9a-f]{64}$/i

export class PrivateFileIntegrityError extends Error {
  constructor(code) { super(code); this.name = 'PrivateFileIntegrityError'; this.code = code }
}
const fail = (code) => { throw new PrivateFileIntegrityError(code) }
const hex = (value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

function nativeDigest() {
  if (typeof crypto.DigestStream !== 'function') fail('PRIVATE_INTEGRITY_RUNTIME_UNAVAILABLE')
  return new crypto.DigestStream('SHA-256')
}
function channel(factory) {
  const stream = factory()
  const digest = stream.digest
  // Abort can reject digest before the caller gets to await it.
  digest.catch(() => {})
  return { writer: stream.getWriter(), digest }
}
async function abort(channel) { if (channel) await channel.writer.abort().catch(() => {}) }

/**
 * Internal only: caller must first obtain an owned, versioned server snapshot.
 * Reads actual R2 bodies with backpressure. Never buffers a whole file, writes
 * storage, changes quota, logs keys or treats the result as activation authority.
 * Activation still needs a snapshot-generation/state CAS after verification.
 */
export async function verifyPrivateFileChunks(manifest, chunks, bucket, digestFactory = nativeDigest) {
  if (!manifest || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_FILE_BYTES
    || manifest.chunkSize !== CHUNK_BYTES || !Number.isSafeInteger(manifest.chunkCount)
    || manifest.chunkCount !== Math.ceil(manifest.size / CHUNK_BYTES) || typeof manifest.hash !== 'string' || !HASH.test(manifest.hash)) {
    fail('INVALID_FILE_DESCRIPTOR')
  }
  if (!Array.isArray(chunks) || chunks.length !== manifest.chunkCount || chunks.some((row, index) =>
    !row || row.index !== index || typeof row.key !== 'string' || row.key.length < 1 || row.key.length > 1024
    || row.size !== Math.min(CHUNK_BYTES, manifest.size - index * CHUNK_BYTES) || typeof row.hash !== 'string' || !HASH.test(row.hash))) {
    fail('INVALID_CHUNK_LEDGER')
  }
  let whole
  try {
    whole = channel(digestFactory)
    let total = 0
    for (const row of chunks) {
      const object = await bucket.get(row.key)
      if (!object?.body || typeof object.body.getReader !== 'function') fail('PRIVATE_OBJECT_UNAVAILABLE')
      if (object.size !== row.size) { await object.body.cancel().catch(() => {}); fail('PRIVATE_OBJECT_SIZE_MISMATCH') }
      const part = channel(digestFactory)
      const reader = object.body.getReader()
      let bytes = 0; let ended = false
      try {
        while (true) {
          const value = await reader.read()
          if (value.done) { ended = true; break }
          if (!(value.value instanceof Uint8Array)) fail('PRIVATE_INTEGRITY_READ_FAILED')
          bytes += value.value.byteLength
          if (bytes > row.size) fail('PRIVATE_OBJECT_SIZE_MISMATCH')
          await Promise.all([whole.writer.write(value.value), part.writer.write(value.value)])
        }
        if (bytes !== row.size) fail('PRIVATE_OBJECT_SIZE_MISMATCH')
        await part.writer.close()
        if (hex(await part.digest) !== row.hash.toLowerCase()) fail('PRIVATE_CHUNK_HASH_MISMATCH')
        total += bytes
      } catch (error) {
        await abort(part)
        throw error
      } finally {
        if (!ended) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    await whole.writer.close()
    const sha256 = hex(await whole.digest)
    if (total !== manifest.size || sha256 !== manifest.hash.toLowerCase()) fail('PRIVATE_FILE_HASH_MISMATCH')
    return { size: total, sha256 }
  } catch (error) {
    await abort(whole)
    if (error instanceof PrivateFileIntegrityError) throw error
    // SDK errors can contain internal object locations: never propagate them.
    fail('PRIVATE_INTEGRITY_READ_FAILED')
  }
}
