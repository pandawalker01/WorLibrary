import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { getBookFile, saveBookTextIndex, saveHighlight, saveReadingProgress, type StoredBook } from '../lib/storage'
import { translateSelection } from '../lib/translation'
import { recognizePage } from '../lib/ocr'
import { aiFeedbackFor, type AiFeedback } from '../lib/ai-feedback'
import { clampFontScale, clampPdfZoom, cycleTheme, loadReaderPreferences, readerThemeLabel, saveReaderPreferences, type ReaderPreferences } from '../lib/reader'
import type { Highlight } from '../lib/storage'
import { copy, type UiLocale } from '../lib/i18n'
import '../pdf-reader.css'

type PdfReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
  targetLanguage?: string
  uiLocale?: UiLocale
  preferences?: Partial<ReaderPreferences>
  onHighlightSaved?: (highlight: Highlight) => void
}

type PdfDocument = {
  numPages: number
  getPage: (page: number) => Promise<PdfPage>
  destroy: () => Promise<void>
}

type PdfPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> }
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
}

export default function PdfReader({ book, onNotice, onProgress, targetLanguage = '中文', uiLocale = 'zh-CN', preferences, onHighlightSaved }: PdfReaderProps) {
  const ui = copy[uiLocale]
  const en = uiLocale === 'en'
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const ocrTextRef = useRef<HTMLDivElement>(null)
  const progressWriteRef = useRef(Promise.resolve())
  const [document, setDocument] = useState<PdfDocument>()
  const documentRef = useRef<PdfDocument | undefined>(undefined)
  const [page, setPage] = useState(Number(book.location?.replace('pdf:', '')) || 1)
  const intendedPageRef = useRef(page)
  const [status, setStatus] = useState('正在打开本地 PDF…')
  const [pageText, setPageText] = useState('')
  const [showText, setShowText] = useState(false)
  const [selectedText, setSelectedText] = useState('')
  const [translation, setTranslation] = useState('')
  const [translating, setTranslating] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<'idle' | 'uploading' | 'recognizing' | 'error'>('idle')
  const [ocrText, setOcrText] = useState('')
  const [aiFeedback, setAiFeedback] = useState<AiFeedback>()
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>(() => ({ ...loadReaderPreferences(), ...preferences }))

  const persistPageProgress = useCallback((nextPage: number, totalPages: number) => {
    const location = `pdf:${nextPage}`
    const progress = Math.round((nextPage / totalPages) * 100)
    progressWriteRef.current = progressWriteRef.current.catch(() => undefined).then(() => saveReadingProgress(book.id, location, progress))
    return progressWriteRef.current
  }, [book.id])

  const moveToPage = useCallback(async (requestedPage: number) => {
    if (!document) return
    const nextPage = Math.max(1, Math.min(document.numPages, requestedPage))
    if (nextPage === page) return
    // Mark the navigation immediately. An older render can finish while this
    // write is in flight; it must not append its former page to the queue.
    intendedPageRef.current = nextPage
    const location = `pdf:${nextPage}`
    const progress = Math.round((nextPage / document.numPages) * 100)
    try {
      // Do not reveal the new page until its location is durable: a refresh immediately
      // after a visible page turn must reopen at the page the reader just reached.
      await persistPageProgress(nextPage, document.numPages)
    } catch {
      onNotice('阅读进度暂未保存；请稍后重试')
    }
    onProgress(progress, location)
    setPage(nextPage)
  }, [document, onNotice, onProgress, page, persistPageProgress])

  useEffect(() => { setReaderPreferences((current) => ({ ...current, ...preferences })) }, [preferences?.fontScale, preferences?.pdfZoom, preferences?.theme])

  useEffect(() => {
    saveReaderPreferences(readerPreferences)
  }, [readerPreferences])

  // OCR and the selection toolbar describe a single rendered page. Clear them
  // when navigation succeeds so text from a former page can never be saved or
  // translated as though it belonged to the new location.
  useEffect(() => {
    setSelectedText('')
    setTranslation('')
    setAiFeedback(undefined)
    setOcrText('')
    setOcrStatus('idle')
  }, [page])

  useEffect(() => {
    let active = true
    async function openDocument() {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc
        const file = await getBookFile(book)
        const loaded = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise as unknown as PdfDocument
        if (!active) {
          if (typeof loaded.destroy === 'function') await loaded.destroy()
          return
        }
        setDocument(loaded)
        documentRef.current = loaded
        setPage((current) => Math.min(current, loaded.numPages))
        setStatus('')
        void (async () => {
          const pages: string[] = []
          for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
            if (!active) return
            try {
              const textContent = await loaded.getPage(pageNumber).then((pdfPage) => pdfPage.getTextContent())
              pages.push(textContent.items.map((item) => item.str ?? '').join(' '))
            } catch { /* keep the readable pages even if one page has no text layer */ }
          }
          await saveBookTextIndex(book.id, pages.join(' '))
        })()
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '无法打开这本 PDF')
        onNotice('PDF 解析失败，请确认文件完整后重新导入')
      }
    }
    void openDocument()
    return () => {
      active = false
      if (documentRef.current && typeof documentRef.current.destroy === 'function') void documentRef.current.destroy()
    }
  }, [book.id, book.fileName, book.storage, onNotice])

  useEffect(() => {
    if (!document || !canvasRef.current) return
    let active = true
    void document.getPage(page).then(async (pdfPage) => {
      if (!active || !canvasRef.current) return
      const viewport = pdfPage.getViewport({ scale: readerPreferences.pdfZoom })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      await pdfPage.render({ canvasContext: context, viewport }).promise
      if (!active || intendedPageRef.current !== page) return
      const textContent = await pdfPage.getTextContent()
      if (!active || intendedPageRef.current !== page) return
      setPageText(textContent.items.map((item) => item.str ?? '').join(' ').replace(/\s+/g, ' ').trim())
      const progress = Math.round((page / document.numPages) * 100)
      const location = `pdf:${page}`
      void persistPageProgress(page, document.numPages)
      onProgress(progress, location)
    }).catch(() => onNotice('这一页 PDF 渲染失败，请尝试重新打开'))
    return () => { active = false }
  }, [document, page, readerPreferences.pdfZoom, onNotice, onProgress, persistPageProgress])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedText) {
          event.preventDefault()
          setSelectedText('')
          window.getSelection()?.removeAllRanges()
        } else if (showText) {
          event.preventDefault()
          setShowText(false)
        }
        return
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) return
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        void moveToPage(page - 1)
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        void moveToPage(page + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moveToPage, page, selectedText, showText])

  async function saveText(text: string) {
    if (!text) {
      onNotice('这一页没有可提取的文本')
      return
    }
    const highlight = await saveHighlight({ bookId: book.id, text, location: `pdf:${page}`, color: 'gold' })
    onHighlightSaved?.(highlight)
    setSelectedText('')
    window.getSelection()?.removeAllRanges()
    onNotice(text === pageText ? 'PDF 页面文字已保存到摘录空间' : 'PDF 局部文字已保存到摘录空间')
  }

  function captureSelection() {
    const selection = window.getSelection()
    const text = selection?.toString().trim() ?? ''
    const selectionNode = selection?.anchorNode ?? null
    const belongsToReadableText = textLayerRef.current?.contains(selectionNode) || ocrTextRef.current?.contains(selectionNode)
    if (text && belongsToReadableText) setSelectedText(text)
  }

  async function translateSelectedText() {
    if (!selectedText || translating) return
    setTranslating(true)
    setAiFeedback(undefined)
    try {
      const result = await translateSelection(selectedText, targetLanguage)
      setTranslation(result.translation)
    } catch (error) {
      const feedback = aiFeedbackFor(error)
      setAiFeedback(feedback)
      onNotice(feedback.title)
    } finally {
      setTranslating(false)
    }
  }

  async function recognizeCurrentPage() {
    if (!canvasRef.current || ocrStatus === 'uploading' || ocrStatus === 'recognizing') return
    setOcrStatus('uploading')
    try {
      const image = await new Promise<Blob>((resolve, reject) => canvasRef.current?.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成当前页图片')), 'image/jpeg', 0.86))
      setOcrStatus('recognizing')
      const result = await recognizePage(image)
      setOcrText(result.text)
      setOcrStatus('idle')
      onNotice('当前页文字识别完成，仅上传本页图片')
    } catch (error) {
      setOcrStatus('error')
      onNotice(error instanceof Error ? error.message : '文字识别失败，请稍后重试')
    }
  }

  return <div className={`pdf-reader-shell reader-theme-${readerPreferences.theme}`} style={{ '--reader-font-scale': readerPreferences.fontScale } as CSSProperties}>
    <div className="pdf-reader-toolbar"><span aria-live="polite">{status || (en ? `PDF · local reading · page ${page} / ${document?.numPages ?? '…'} · ${Math.round(readerPreferences.pdfZoom / 1.35 * 100)}%` : `PDF 本地阅读 · 第 ${page} / ${document?.numPages ?? '…'} 页 · ${Math.round(readerPreferences.pdfZoom / 1.35 * 100)}%`)}</span><div><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label={en ? 'Decrease font size' : '减小字号'}>A−</button><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label={en ? 'Increase font size' : '增大字号'}>A＋</button><button onClick={() => setReaderPreferences((current) => ({ ...current, pdfZoom: clampPdfZoom(current.pdfZoom - 0.15) }))} aria-label={en ? 'Zoom out' : '缩小页面'}>−</button><button onClick={() => setReaderPreferences((current) => ({ ...current, pdfZoom: clampPdfZoom(current.pdfZoom + 0.15) }))} aria-label={en ? 'Increase page zoom' : '放大页面'}>＋</button><button onClick={() => setReaderPreferences((current) => ({ ...current, theme: cycleTheme(current.theme) }))}>{readerThemeLabel(readerPreferences.theme)}</button><button onClick={() => { void recognizeCurrentPage() }} disabled={!document || ocrStatus === 'uploading' || ocrStatus === 'recognizing'}>{ocrStatus === 'uploading' ? (en ? 'Preparing upload…' : '准备上传…') : ocrStatus === 'recognizing' ? (en ? 'Recognizing…' : '识别中…') : (en ? 'Recognize page' : '识别当前页')}</button><button disabled={!pageText} onClick={() => setShowText((current) => !current)} aria-pressed={showText} aria-controls="pdf-page-text">{showText ? (en ? 'Hide text' : '收起文字') : (en ? 'View text' : '查看文字')}</button><button disabled={!pageText} onClick={() => { void saveText(pageText) }}>{en ? 'Save page' : '保存整页'}</button><button disabled={!selectedText} onClick={() => { void saveText(selectedText) }}>{en ? 'Save selection' : '保存选中'}</button><button disabled={!document || page <= 1} onClick={() => { void moveToPage(page - 1) }}>{ui.previousPage}</button><button disabled={!document || page >= (document?.numPages ?? 1)} onClick={() => { void moveToPage(page + 1) }}>{ui.nextPage}</button></div></div>
    {showText && <div id="pdf-page-text" ref={textLayerRef} className="pdf-text-layer" tabIndex={0} aria-label={ui.pdfPageText} onMouseUp={captureSelection} onKeyUp={captureSelection}>{pageText}</div>}
    {selectedText && <section className="pdf-selection-bar" aria-label={ui.selectedTextActions}><span title={selectedText}>{selectedText}</span><button onClick={() => { void translateSelectedText() }}>{translating ? (en ? 'Translating…' : '翻译中…') : ui.translation}</button><button className="ghost" onClick={() => { setSelectedText(''); window.getSelection()?.removeAllRanges() }} aria-label={ui.closeSelection}>{ui.cancel}</button></section>}
    {translation && <div className="pdf-translation-result"><span>{ui.translation}</span>{translation}</div>}
    {ocrText && <section className="pdf-text-layer pdf-ocr-result" aria-label={ui.ocrPageText}>
      <div className="pdf-ocr-result-heading" role="status"><strong>{ui.ocrResults}</strong><span>{ui.ocrResultsCopy}</span></div>
      <div ref={ocrTextRef} className="pdf-ocr-selectable-text" tabIndex={0} onMouseUp={captureSelection} onKeyUp={captureSelection}>{ocrText}</div>
    </section>}
    {aiFeedback && <div className="ai-request-feedback" role="status"><strong>{aiFeedback.title}</strong><span>{aiFeedback.detail}</span>{aiFeedback.retryable && selectedText && <button onClick={() => { void translateSelectedText() }}>重试翻译</button>}</div>}
    {ocrStatus === 'error' && <div className="pdf-ocr-error" role="status"><span>{en ? 'Recognition did not finish. Check your connection and retry; the whole book is never uploaded.' : '识别未完成。请检查网络或稍后重试；不会上传整本书。'}</span><button onClick={() => { void recognizeCurrentPage() }}>{ui.retryOcr}</button></div>}
    <div className="pdf-reader-frame"><canvas ref={canvasRef} /></div>
  </div>
}
