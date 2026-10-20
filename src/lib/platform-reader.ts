export type PlatformReaderAccessMode = 'download' | 'stream' | 'preview' | 'external_reader' | 'catalog_only'

export type PlatformReaderAccess = {
  editionId: string
  accessMode: PlatformReaderAccessMode
  rightsNotice?: string
  delivery: { available: boolean; reason?: string; contentType?: 'application/epub+zip' | 'application/pdf' }
  externalReaderUrl?: string
}

export type ProtectedEpubContent = {
  bytes: ArrayBuffer
  contentType: string
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
    delivery?: { available?: unknown; reason?: unknown; content_type?: unknown }
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
    delivery: {
      available: payload.delivery.available,
      reason: typeof payload.delivery.reason === 'string' ? payload.delivery.reason : undefined,
      contentType: payload.delivery.content_type === 'application/epub+zip' || payload.delivery.content_type === 'application/pdf' ? payload.delivery.content_type : undefined,
    },
    externalReaderUrl: typeof payload.external_reader_url === 'string' ? payload.external_reader_url : undefined,
  }
}

/**
 * Retrieve an authorised platform EPUB into memory for the embedded reader.
 *
 * This deliberately does not create an object URL, a File, or an IndexedDB
 * record: the response is consumed by epub.js for the lifetime of the reader
 * component and is released when that component unmounts.
 */
export async function fetchProtectedEpubContent(editionId: string, accessToken?: string, maxBytes = 160 * 1024 * 1024): Promise<ProtectedEpubContent> {
  const response = await fetch(`/api/reader/content?editionId=${encodeURIComponent(editionId)}`, {
    headers: {
      Accept: 'application/epub+zip',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: { message?: unknown; code?: unknown; retryable?: unknown } } | undefined
    throw accessError(typeof payload?.error?.message === 'string' ? payload.error.message : 'Protected EPUB content is unavailable.', {
      status: response.status,
      code: typeof payload?.error?.code === 'string' ? payload.error.code : undefined,
      retryable: payload?.error?.retryable === true || response.status >= 500,
    })
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (contentType !== 'application/epub+zip') {
    throw accessError('The authorised platform content is not an EPUB.', { code: 'PLATFORM_CONTENT_NOT_EPUB' })
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw accessError('This EPUB is too large to open safely in the browser.', { code: 'PLATFORM_CONTENT_TOO_LARGE' })
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw accessError(bytes.byteLength === 0 ? 'The platform EPUB was empty.' : 'This EPUB is too large to open safely in the browser.', {
      code: bytes.byteLength === 0 ? 'PLATFORM_CONTENT_EMPTY' : 'PLATFORM_CONTENT_TOO_LARGE',
    })
  }
  return { bytes, contentType }
}
