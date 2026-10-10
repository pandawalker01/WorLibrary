/**
 * Short-lived, in-memory reuse for selection AI requests.
 *
 * This deliberately never uses IndexedDB, localStorage, or the sync layer:
 * highlighted text can be sensitive and must disappear when the tab reloads.
 */
export const AI_RESULT_CACHE_TTL_MS = 15 * 60 * 1000
export const AI_RESULT_CACHE_MAX_ENTRIES = 60

type CacheEntry<T> = {
  expiresAt: number
  value: T
}

export type AiResultCache<T> = {
  getOrCreate: (key: string, request: () => Promise<T>) => Promise<{ value: T; hit: boolean }>
  clear: () => void
}

export function createAiResultCache<T>(
  ttlMs = AI_RESULT_CACHE_TTL_MS,
  maxEntries = AI_RESULT_CACHE_MAX_ENTRIES,
): AiResultCache<T> {
  const entries = new Map<string, CacheEntry<T>>()
  const pending = new Map<string, Promise<T>>()

  function read(key: string) {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key)
      return undefined
    }
    // Move a cache hit to the end so the oldest entry is evicted first.
    entries.delete(key)
    entries.set(key, entry)
    return entry.value
  }

  function write(key: string, value: T) {
    entries.delete(key)
    entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string)
  }

  return {
    async getOrCreate(key, request) {
      const cached = read(key)
      if (cached !== undefined) return { value: cached, hit: true }

      const inFlight = pending.get(key)
      if (inFlight) return { value: await inFlight, hit: true }

      const work = request()
      pending.set(key, work)
      try {
        const value = await work
        write(key, value)
        return { value, hit: false }
      } finally {
        pending.delete(key)
      }
    },
    clear() {
      entries.clear()
      pending.clear()
    },
  }
}

export function aiResultCacheKey(
  mode: 'translation' | 'explanation',
  text: string,
  targetLanguage: string,
  sourceLanguage = 'auto',
  context?: string,
) {
  return JSON.stringify([mode, text.trim(), targetLanguage, sourceLanguage, context?.trim() || ''])
}
