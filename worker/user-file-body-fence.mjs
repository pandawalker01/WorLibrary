export class PrivateFileFenceError extends Error {
  constructor() { super('PRIVATE_BODY_CLEANUP_PENDING'); this.name = 'PrivateFileFenceError'; this.code = 'PRIVATE_BODY_CLEANUP_PENDING' }
}

/** Internal only. SQL must already deny new intents for this manifest. */
export async function fencePrivateFileBodies(bucket, intents, acknowledge) {
  if (!Array.isArray(intents) || intents.some(intent => !intent || typeof intent.id !== 'string'
    || typeof intent.key !== 'string' || !intent.key.length || intent.key.length > 1024)
    || new Set(intents.map(intent => intent.id)).size !== intents.length
    || new Set(intents.map(intent => intent.key)).size !== intents.length) throw new PrivateFileFenceError()
  let fenced = 0
  try {
    for (const intent of intents) {
      // Deliberately retain the empty object forever. Deleting it would allow
      // a delayed If-None-Match:* PUT to recreate private bytes after cleanup.
      // No sensitive custom metadata, filename or plaintext hash is retained.
      const object = await bucket.put(intent.key, new Uint8Array(), {
        httpMetadata: { contentType: 'application/octet-stream' },
      })
      if (!object || object.size !== 0) throw new PrivateFileFenceError()
      const confirmed = await bucket.head(intent.key)
      if (!confirmed || confirmed.size !== 0) throw new PrivateFileFenceError()
      await acknowledge(intent.id)
      fenced += 1
    }
    return { fenced }
  } catch { throw new PrivateFileFenceError() }
}
