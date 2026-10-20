import { useEffect, useRef, useState } from 'react'
import ePub from 'epubjs'
import { fetchProtectedEpubContent } from '../lib/platform-reader'
import type { UiLocale } from '../lib/i18n'
import './platform-epub-reader.css'

type PlatformEpubReaderProps = {
  editionId: string
  accessToken?: string
  uiLocale: UiLocale
}

type Rendition = {
  display: (target?: string) => Promise<void>
  next?: () => Promise<void>
  prev?: () => Promise<void>
  on: (event: string, callback: (...args: unknown[]) => void) => void
  destroy: () => void
}

type Publication = {
  ready: Promise<unknown>
  locations: { generate: (chars: number) => Promise<void>; percentageFromCfi: (cfi: string) => number }
  renderTo: (element: HTMLElement, options: { width: string; height: string; allowScriptedContent?: boolean }) => Rendition
  destroy: () => void
}

type ReaderState =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; retryable: boolean }

const labels = {
  'zh-CN': {
    loading: '正在安全打开 EPUB…',
    opening: '正在准备阅读页面…',
    failed: '无法打开平台 EPUB',
    retry: '重新打开',
    previous: '上一页',
    next: '下一页',
    page: '阅读位置',
    reader: '受保护 EPUB 阅读器',
    readingSurface: 'EPUB 阅读内容。聚焦后可按左右方向键翻页。',
    previousAria: '上一页',
    nextAria: '下一页',
    retryAria: '重新尝试打开受保护 EPUB',
    position: '当前位置',
    safety: '正文仅保留在当前阅读会话内存中；关闭页面后即释放，不会写入本地书库。',
  },
  en: {
    loading: 'Opening protected EPUB…',
    opening: 'Preparing reading pages…',
    failed: 'The platform EPUB could not be opened',
    retry: 'Try again',
    previous: 'Previous page',
    next: 'Next page',
    page: 'Reading position',
    reader: 'Protected EPUB reader',
    readingSurface: 'EPUB reading content. When focused, use Left and Right Arrow keys to turn pages.',
    previousAria: 'Previous page',
    nextAria: 'Next page',
    retryAria: 'Try opening the protected EPUB again',
    position: 'Current reading position',
    safety: 'Book text stays only in this reader session’s memory and is released when you leave; it is not saved to your local library.',
  },
} as const

/**
 * An intentionally narrow reader for authorised platform EPUBs.
 * It fetches the protected asset with the current bearer token, hands its
 * ArrayBuffer directly to epub.js, and never writes an object URL, File or
 * book record to browser persistence.
 */
export default function PlatformEpubReader({ editionId, accessToken, uiLocale }: PlatformEpubReaderProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ReaderState>({ kind: 'loading', message: labels[uiLocale].loading })
  const [pageLabel, setPageLabel] = useState('')
  const ui = labels[uiLocale]

  const turnPage = (direction: 'next' | 'previous') => {
    if (direction === 'next') void renditionRef.current?.next?.()
    else void renditionRef.current?.prev?.()
  }

  const handleReadingSurfaceKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      turnPage('next')
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      turnPage('previous')
    }
  }

  useEffect(() => {
    let active = true
    let publication: Publication | undefined
    let rendition: Rendition | undefined

    async function open() {
      setState({ kind: 'loading', message: ui.loading })
      setPageLabel('')
      try {
        const content = await fetchProtectedEpubContent(editionId, accessToken)
        if (!active || !mountRef.current) return
        setState({ kind: 'loading', message: ui.opening })
        publication = ePub(content.bytes) as unknown as Publication
        await publication.ready
        if (!active || !mountRef.current) return
        await publication.locations.generate(1024)
        rendition = publication.renderTo(mountRef.current, { width: '100%', height: '650px', allowScriptedContent: false })
        renditionRef.current = rendition
        rendition.on('relocated', (...event: unknown[]) => {
          const location = event[0] as { start?: { cfi?: string; displayed?: { page?: number; total?: number } } } | undefined
          const displayed = location?.start?.displayed
          const cfi = location?.start?.cfi
          if (displayed?.page && displayed.total) {
            setPageLabel(`${displayed.page} / ${displayed.total}`)
          } else if (cfi) {
            setPageLabel(`${Math.round(publication?.locations.percentageFromCfi(cfi) ?? 0) + 1}%`)
          }
        })
        await rendition.display()
        if (active) setState({ kind: 'ready' })
      } catch (error) {
        if (!active) return
        const details = error as { message?: string; retryable?: boolean; status?: number }
        setState({
          kind: 'error',
          message: details.message || ui.failed,
          retryable: details.retryable === true || (details.status ?? 0) >= 500,
        })
      }
    }

    void open()
    return () => {
      active = false
      rendition?.destroy()
      renditionRef.current = undefined
      publication?.destroy()
      // `content.bytes` is scoped to open(); clearing references above lets
      // the browser reclaim the protected response when this session ends.
    }
  }, [editionId, accessToken, attempt, ui.loading, ui.opening, ui.failed])

  if (state.kind === 'error') {
    return <div className="platform-epub-reader__error" role="alert" aria-live="assertive">
      <h2>{ui.failed}</h2>
      <p>{state.message}</p>
      <button type="button" aria-label={ui.retryAria} onClick={() => setAttempt((current) => current + 1)}>{ui.retry}</button>
    </div>
  }

  return <section className="platform-epub-reader" aria-label={ui.reader} onKeyDown={handleReadingSurfaceKeyDown}>
    {state.kind === 'loading' && <p className="platform-epub-reader__loading" role="status">{state.message}</p>}
    <div ref={mountRef} className="platform-epub-reader__frame" tabIndex={0} aria-label={ui.readingSurface} aria-busy={state.kind === 'loading'} aria-keyshortcuts="ArrowLeft ArrowRight" />
    {state.kind === 'ready' && <>
      <nav className="platform-epub-reader__navigation" aria-label={ui.page}>
        <button type="button" aria-label={ui.previousAria} onClick={() => turnPage('previous')}>{ui.previous}</button>
        <span aria-label={ui.position} aria-live="polite">{pageLabel || '—'}</span>
        <button type="button" aria-label={ui.nextAria} onClick={() => turnPage('next')}>{ui.next}</button>
      </nav>
      <p className="platform-epub-reader__safety">{ui.safety}</p>
    </>}
  </section>
}
