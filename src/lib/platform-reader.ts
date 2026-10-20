export type PlatformReaderAccessMode = 'download' | 'stream' | 'preview' | 'external_reader' | 'catalog_only'

export type PlatformReaderAccess = {
  editionId: string
  accessMode: PlatformReaderAccessMode
  rightsNotice?: string
  delivery: { available: boolean; reason?: string }
  externalReaderUrl?: string
}

type PlatformReaderError = Error & { status?: number; code?: string; retryable?: boolean }

function accessError(message: string, details: { status?: number; code?: string; retryable?: boolean } = {}): PlatformReaderError {
  return Object.assign(new Error(message), details)
}

export async function requestPlatformReaderAccess(editionId: string, accessToken?: string): Promise<PlatformReaderAccess> {
  const response = await fetch(`/api/reader/access?editionId=${encodeURIComponent(editionId)}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  })
  const payload = await response.json().catch(() => undefined) as {
    editionId?: unknown
    access_mode?: unknown
    rights_notice?: unknown
    delivery?: { available?: unknown; reason?: unknown }
    external_reader_url?: unknown
    error?: { message?: unknown; code?: unknown; retryable?: unknown }
  } | undefined
  if (!response.ok) {
    throw accessError(typeof payload?.error?.message === 'string' ? payload.error.message : 'Reader access is unavailable.', {
      status: response.status,
      code: typeof payload?.error?.code === 'string' ? payload.error.code : undefined,
      retryable: payload?.error?.retryable === true,
    })
  }
  const accessMode = payload?.access_mode
  if (typeof payload?.editionId !== 'string' || !['download', 'stream', 'preview', 'external_reader', 'catalog_only'].includes(String(accessMode)) || !payload.delivery || typeof payload.delivery.available !== 'boolean') {
    throw accessError('Reader access returned an invalid decision.', { code: 'ACCESS_RESPONSE_INVALID' })
  }
  return {
    editionId: payload.editionId,
    accessMode: accessMode as PlatformReaderAccessMode,
    rightsNotice: typeof payload.rights_notice === 'string' ? payload.rights_notice : undefined,
    delivery: { available: payload.delivery.available, reason: typeof payload.delivery.reason === 'string' ? payload.delivery.reason : undefined },
    externalReaderUrl: typeof payload.external_reader_url === 'string' ? payload.external_reader_url : undefined,
  }
}
