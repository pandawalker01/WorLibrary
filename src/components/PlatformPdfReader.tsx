import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { UiLocale } from '../lib/i18n'
import './platform-pdf-reader.css'

type PlatformPdfReaderProps = {
  editionId: string
  accessToken?: string
  uiLocale: UiLocale
}

type PdfDocument = {
  numPages: number
  getPage: (page: number) => Promise<PdfPage>
  destroy: () => Promise<void>
}

type PdfPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> }
}

type ReaderState =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

const labels = {
  'zh-CN': {
    loading: '正在建立受保护 PDF 阅读会话…',
    opening: '正在打开受保护 PDF…',
    failed: '无法打开受保护 PDF',
    failedCopy: '请检查你的阅读权限和网络后重试。正文不会保存到这台设备，也不会提供下载。',
    retry: '重试',
    previous: '上一页',
    next: '下一页',
    page: (current: number, total: number) => `第 ${current} / ${total} 页`,
    status: (current: number, total: number) => `受保护 PDF · 第 ${current} / ${total} 页`,
    renderFailed: '这一页暂时无法渲染，请切换页面后重试。',
  },
  en: {
    loading: 'Opening protected PDF reading session…',
    opening: 'Opening protected PDF…',
    failed: 'Protected PDF could not be opened',
    failedCopy: 'Check your reading access and connection, then retry. The book is not saved to this device and no download is offered.',
    retry: 'Retry',
    previous: 'Previous page',
    next: 'Next page',
    page: (current: number, total: number) => `Page ${current} of ${total}`,
    status: (current: number, total: number) => `Protected PDF · page ${current} of ${total}`,
    renderFailed: 'This page could not be rendered. Change pages and try again.',
  },
} as const

function contentError(response: Response) {
  if (response.status === 401 || response.status === 403) return new Error('READING_ACCESS_DENIED')
  if (response.status === 404) return new Error('PROTECTED_CONTENT_UNAVAILABLE')
  return new Error('PROTECTED_CONTENT_REQUEST_FAILED')
}

/**
 * Read an authorized PDF into ephemeral memory. This intentionally has no
 * cache, IndexedDB, OPFS, object URL, or download-path behavior.
 */
export async function fetchProtectedPlatformPdf(editionId: string, accessToken?: string, signal?: AbortSignal, maxBytes = 160 * 1024 * 1024): Promise<ArrayBuffer> {
  const response = await fetch(`/api/reader/content?editionId=${encodeURIComponent(editionId)}`, {
    headers: { Accept: 'application/pdf', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw contentError(response)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/pdf')) throw new Error('PROTECTED_CONTENT_NOT_PDF')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('PROTECTED_CONTENT_TOO_LARGE')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error('PROTECTED_CONTENT_EMPTY')
  if (bytes.byteLength > maxBytes) throw new Error('PROTECTED_CONTENT_TOO_LARGE')
  return bytes
}

export default function PlatformPdfReader({ editionId, accessToken, uiLocale }: PlatformPdfReaderProps) {
  const ui = labels[uiLocale]
  const readerRef = useRef<HTMLElement>(null)
  const canvasFrameRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const documentRef = useRef<PdfDocument | undefined>(undefined)
  const renderSequenceRef = useRef(0)
  const [document, setDocument] = useState<PdfDocument>()
  const [page, setPage] = useState(1)
  const [state, setState] = useState<ReaderState>({ kind: 'loading', message: ui.loading })
  const [attempt, setAttempt] = useState(0)
  const [canvasWidth, setCanvasWidth] = useState(0)
  const [renderError, setRenderError] = useState('')

  useEffect(() => {
    const frame = canvasFrameRef.current
    if (!frame) return
    const updateWidth = () => setCanvasWidth(frame.clientWidth)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setDocument(undefined)
    setPage(1)
    setRenderError('')
    setState({ kind: 'loading', message: ui.loading })

    void (async () => {
      try {
        const bytes = await fetchProtectedPlatformPdf(editionId, accessToken, controller.signal)
        if (!active) return
        setState({ kind: 'loading', message: ui.opening })
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc
        const loaded = await pdfjsLib.getDocument({ data: bytes }).promise as unknown as PdfDocument
        if (!active) {
          await loaded.destroy()
          return
        }
        documentRef.current = loaded
        setDocument(loaded)
        setState({ kind: 'ready' })
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : 'PROTECTED_CONTENT_REQUEST_FAILED' })
      }
    })()

    return () => {
      active = false
      controller.abort()
      const loaded = documentRef.current
      documentRef.current = undefined
      if (loaded) void loaded.destroy()
    }
  }, [editionId, accessToken, attempt, ui.loading, ui.opening])

  useEffect(() => {
    if (!document || !canvasRef.current) return
    let active = true
    const renderSequence = ++renderSequenceRef.current
    void (async () => {
      try {
        const pdfPage = await document.getPage(page)
        if (!active || renderSequence !== renderSequenceRef.current || !canvasRef.current) return
        const naturalViewport = pdfPage.getViewport({ scale: 1 })
        // Render to the available reading column instead of producing a
        // desktop-width canvas that CSS merely shrinks on narrow screens.
        const scale = Math.min(1.6, Math.max(0.35, (Math.max(1, canvasWidth - 24) / naturalViewport.width)))
        const viewport = pdfPage.getViewport({ scale })
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')
        if (!context) throw new Error('CANVAS_UNAVAILABLE')
        canvas.width = viewport.width
        canvas.height = viewport.height
        await pdfPage.render({ canvasContext: context, viewport }).promise
        if (!active || renderSequence !== renderSequenceRef.current) return
        setRenderError('')
      } catch {
        if (active) setRenderError(ui.renderFailed)
      }
    })()
    return () => { active = false }
  }, [canvasWidth, document, page, ui.renderFailed])

  const moveToPage = useCallback((requested: number) => {
    if (!document) return
    setPage(Math.max(1, Math.min(document.numPages, requested)))
  }, [document])

  const handleReaderKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!document || event.defaultPrevented) return
    if (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea, [contenteditable="true"]')) return
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      moveToPage(page - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      moveToPage(page + 1)
    }
  }, [document, moveToPage, page])

  if (state.kind === 'error') {
    return <section className="platform-pdf-reader__error" role="alert">
      <h2>{ui.failed}</h2>
      <p>{ui.failedCopy}</p>
      <p className="platform-pdf-reader__error-code">{state.message}</p>
      <button onClick={() => setAttempt((current) => current + 1)}>{ui.retry}</button>
    </section>
  }

  return <section ref={readerRef} className="platform-pdf-reader" tabIndex={0} aria-label={document ? ui.status(page, document.numPages) : ui.loading} aria-describedby="platform-pdf-reader-help" onKeyDown={handleReaderKeyDown}>
    <p className="platform-pdf-reader__status" role="status" aria-live="polite">
      {state.kind === 'loading' ? state.message : document ? ui.status(page, document.numPages) : ui.loading}
    </p>
    <p id="platform-pdf-reader-help" className="platform-pdf-reader__help">{uiLocale === 'en' ? 'Use Previous and Next, or focus this reading area and press Left/Right Arrow or Page Up/Page Down.' : '可使用上一页、下一页，或聚焦阅读区域后按左右方向键、Page Up/Page Down 翻页。'}</p>
    <div ref={canvasFrameRef} className="platform-pdf-reader__canvas" aria-busy={!document}><canvas ref={canvasRef} aria-hidden="true" /></div>
    {renderError && <p className="platform-pdf-reader__render-error" role="status">{renderError}</p>}
    <nav className="platform-pdf-reader__navigation" aria-label={ui.status(page, document?.numPages ?? 0)}>
      <button disabled={!document || page <= 1} onClick={() => moveToPage(page - 1)}>{ui.previous}</button>
      <span aria-live="polite">{document ? ui.page(page, document.numPages) : '…'}</span>
      <button disabled={!document || page >= (document?.numPages ?? 1)} onClick={() => moveToPage(page + 1)}>{ui.next}</button>
    </nav>
  </section>
}
