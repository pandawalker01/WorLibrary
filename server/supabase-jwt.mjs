function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function audienceMatches(actual, expected) {
  if (!expected) return true
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected
}

/**
 * Creates a minimal Web Crypto verifier for Supabase's symmetric HS256 access
 * tokens. The secret is read only by the server runtime; no claim data is
 * returned to the browser beyond the internal identity object.
 */
export function createSupabaseJwtVerifier({ secret, issuer, audience = 'authenticated', now = () => Date.now() } = {}) {
  const signingSecret = typeof secret === 'string' ? secret.trim() : ''
  if (!signingSecret) return null
  const encoder = new TextEncoder()
  let keyPromise
  const key = () => {
    keyPromise ||= crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    return keyPromise
  }

  return async function verifySupabaseJwt(token) {
    try {
      const parts = typeof token === 'string' ? token.split('.') : []
      if (parts.length !== 3) return null
      const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])))
      if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null
      const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])))
      const signature = base64UrlToBytes(parts[2])
      const validSignature = await crypto.subtle.verify('HMAC', await key(), signature, encoder.encode(`${parts[0]}.${parts[1]}`))
      if (!validSignature) return null
      const currentSeconds = Math.floor(now() / 1000)
      if (typeof claims?.sub !== 'string' || !claims.sub.trim()) return null
      if (typeof claims.exp !== 'number' || claims.exp <= currentSeconds) return null
      if (typeof claims.nbf === 'number' && claims.nbf > currentSeconds) return null
      if (issuer && claims.iss !== issuer) return null
      if (!audienceMatches(claims.aud, audience)) return null
      return { id: claims.sub, anonymous: claims.is_anonymous === true }
    } catch {
      return null
    }
  }
}
