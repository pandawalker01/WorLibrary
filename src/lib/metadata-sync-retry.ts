import type { MetadataSyncCoordinatorResult } from './metadata-sync-coordinator'

export const MAX_METADATA_SYNC_RETRIES = 6

export function isRetryableMetadataSyncError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable === true
  }
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
}

export function shouldRetryMetadataSync(result: MetadataSyncCoordinatorResult): boolean {
  if (result.status === 'outbox-blocked') return result.flush?.reason === 'retryable-failure'
  if (result.status === 'pull-failed') {
    return result.pull?.reason === 'remote-failure' && isRetryableMetadataSyncError(result.error)
  }
  if (result.status === 'device-registration-failed') return isRetryableMetadataSyncError(result.error)
  return false
}

export function metadataSyncRetryDelayMs(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= MAX_METADATA_SYNC_RETRIES) return null
  return Math.min(60_000, 1_000 * 2 ** attempt)
}
