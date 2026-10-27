import { expect, test } from '@playwright/test'
import {
  isRetryableMetadataSyncError,
  MAX_METADATA_SYNC_RETRIES,
  metadataSyncRetryDelayMs,
  shouldRetryMetadataSync,
} from '../src/lib/metadata-sync-retry'

test('network failures are retryable while authorization and validation failures are not', () => {
  expect(isRetryableMetadataSyncError(new TypeError('Failed to fetch'))).toBe(true)
  expect(isRetryableMetadataSyncError(new DOMException('request timed out', 'AbortError'))).toBe(true)
  expect(isRetryableMetadataSyncError({ retryable: true })).toBe(true)
  expect(isRetryableMetadataSyncError({ retryable: false })).toBe(false)
  expect(isRetryableMetadataSyncError(new Error('invalid payload'))).toBe(false)
})

test('sync retries only transient coordinator failures with bounded exponential delay', () => {
  expect(shouldRetryMetadataSync({
    status: 'outbox-blocked',
    flush: { reason: 'retryable-failure', attempted: 1, confirmed: 0 },
  })).toBe(true)
  expect(shouldRetryMetadataSync({
    status: 'outbox-blocked',
    flush: { reason: 'permanent-failure', attempted: 1, confirmed: 0 },
  })).toBe(false)
  expect(shouldRetryMetadataSync({
    status: 'pull-failed',
    pull: { reason: 'remote-failure', nextSequence: 0, pages: 1, received: 0, applied: 0, error: new TypeError('offline') },
    error: new TypeError('offline'),
  })).toBe(true)
  expect(shouldRetryMetadataSync({ status: 'invalidated' })).toBe(false)

  expect(Array.from({ length: MAX_METADATA_SYNC_RETRIES }, (_, attempt) => metadataSyncRetryDelayMs(attempt)))
    .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000])
  expect(metadataSyncRetryDelayMs(MAX_METADATA_SYNC_RETRIES)).toBeNull()
  expect(metadataSyncRetryDelayMs(-1)).toBeNull()
})
