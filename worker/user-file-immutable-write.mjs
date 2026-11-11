import { verifyPrivateFileChunks } from './user-file-integrity.mjs'

const CHUNK_BYTES = 8 * 1024 * 1024
export class PrivateFileWriteError extends Error {
  constructor(code) { super(code); this.name = 'PrivateFileWriteError'; this.code = code }
}
const fail = (code) => { throw new PrivateFileWriteError(code) }
const hex = (value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Internal primitive, NOT an upload endpoint or authorization boundary.
 * Caller must have durably registered an owned, unique write intent first.
 * A successful return is not permission to activate or release cleanup quota.
 * Never replaces/deletes an existing object. Deletion fencing is separate.
 */
export async function putImmutablePrivateChunk(bucket, intent, bytes, digestFactory) {
  if (!intent || typeof intent.key !== 'string' || intent.key.length < 1 || intent.key.length > 1024
    || !Number.isSafeInteger(intent.size) || intent.size < 1 || intent.size > CHUNK_BYTES
    || typeof intent.hash !== 'string' || !/^[0-9a-f]{64}$/.test(intent.hash)
    || !(bytes instanceof Uint8Array) || bytes.byteLength !== intent.size) fail('INVALID_PRIVATE_WRITE_INTENT')
  // Copy before awaiting: a reused/mutated caller buffer cannot change the
  // stored bytes after the hash is checked. Memory remains bounded per chunk.
  const body = new Uint8Array(bytes)
  const { key, size, hash } = intent
  try {
    if (hex(await crypto.subtle.digest('SHA-256', body)) !== hash) fail('PRIVATE_WRITE_HASH_MISMATCH')
    const object = await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: '*' },
      sha256: hash,
      httpMetadata: { contentType: 'application/octet-stream' },
    })
    if (object !== null) {
      if (!object || object.size !== size) fail('PRIVATE_WRITE_RESULT_INVALID')
      return { created: true }
    }
    // A conditional miss is not success just because metadata says the same
    // hash. Read actual bytes; a zero-byte fence or collision must fail closed.
    await verifyPrivateFileChunks(
      { size, hash, chunkSize: CHUNK_BYTES, chunkCount: 1 },
      [{ index: 0, key, size, hash }], bucket, digestFactory,
    )
    return { created: false }
  } catch (error) {
    if (error instanceof PrivateFileWriteError) throw error
    // SDK messages can embed private locators. No logging, delete-on-error or
    // unconditional retry: the durable caller intent owns reconciliation.
    fail('PRIVATE_WRITE_FAILED')
  }
}
