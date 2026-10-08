import { useEffect, useRef, useState, type CSSProperties } from 'react'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { getBookFile, saveBookTextIndex, saveHighlight, saveReadingProgress, type StoredBook } from '../lib/storage'
import { translateSelection } from '../lib/translation'
import { recognizePage } from '../lib/ocr'
import { clampFontScale, cycleTheme, DEFAULT_READER_PREFERENCES, readerThemeLabel, type ReaderPreferences } from '../lib/reader'
import type { Highlight } from '../lib/storage'
import '../pdf-reader.css'

type PdfReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
  targetLanguage?: string
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

export default function PdfReader({ book, onNotice, onProgress, targetLanguage = '中文', preferences, onHighlightSaved }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PdfDocument>()
  const documentRef = useRef<PdfDocument | undefined>(undefined)
  const [page, setPage] = useState(Number(book.location?.replace('pdf:', '')) || 1)
  const [status, setStatus] = useState('正在打开本地 PDF…')
  const [pageText, setPageText] = useState('')
  const [showText, setShowText] = useState(false)
  const [selectedText, setSelectedText] = useState('')
  const [translation, setTranslation] = useState('')
  const [translating, setTranslating] = useState(false)
  const [zoom, setZoom] = useState(1.35)
  const [ocrStatus, setOcrStatus] = useState<'idle' | 'uploading' | 'recognizing' | 'error'>('idle')
  const [ocrText, setOcrText] = useState('')
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>({ ...DEFAULT_READER_PREFERENCES, ...preferences })

  useEffect(() => { setReaderPreferences((current) => ({ ...current, ...preferences })) }, [preferences?.fontScale, preferences?.theme])

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
      const viewport = pdfPage.getViewport({ scale: zoom })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      await pdfPage.render({ canvasContext: context, viewport }).promise
      const textContent = await pdfPage.getTextContent()
      setPageText(textContent.items.map((item) => item.str ?? '').join(' ').replace(/\s+/g, ' ').trim())
      const progress = Math.round((page / document.numPages) * 100)
      const location = `pdf:${page}`
      void saveReadingProgress(book.id, location, progress)
      onProgress(progress, location)
    }).catch(() => onNotice('这一页 PDF 渲染失败，请尝试重新打开'))
    return () => { active = false }
  }, [document, page, zoom, book.id, onNotice, onProgress])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) return
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        setPage((current) => Math.max(1, current - 1))
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        setPage((current) => Math.min(document?.numPages ?? current, current + 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [document?.numPages])

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
    if (text && textLayerRef.current?.contains(selection?.anchorNode ?? null)) setSelectedText(text)
  }

  async function translateSelectedText() {
    if (!selectedText || translating) return
    setTranslating(true)
    try {
      const result = await translateSelection(selectedText, targetLanguage)
      setTranslation(result.translation)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '翻译失败，请稍后重试')
    } finally {
      setTranslating(false)
    }
  }

  async function recognizeCurrentPage() {
    if (!canvasRef.current || ocrStatus === 'uploading' || ocrStatus === 'recognizing') return
    setOcrStatus('uploading')
    setOcrText('')
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
    <div className="pdf-reader-toolbar"><span>{status || `PDF 本地阅读 · 第 ${page} / ${document?.numPages ?? '…'} 页 · ${Math.round(zoom / 1.35 * 100)}%`}</span><div><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label="减小字号">A−</button><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label="增大字号">A＋</button><button onClick={() => setZoom((current) => Math.max(0.75, Number((current - 0.15).toFixed(2))))} aria-label="缩小页面">−</button><button onClick={() => setZoom((current) => Math.min(2.5, Number((current + 0.15).toFixed(2))))} aria-label="放大页面">＋</button><button onClick={() => setReaderPreferences((current) => ({ ...current, theme: cycleTheme(current.theme) }))}>{readerThemeLabel(readerPreferences.theme)}</button><button onClick={() => { void recognizeCurrentPage() }} disabled={!document || ocrStatus === 'uploading' || ocrStatus === 'recognizing'}>{ocrStatus === 'uploading' ? '准备上传…' : ocrStatus === 'recognizing' ? '识别中…' : '识别当前页'}</button><button disabled={!pageText} onClick={() => setShowText((current) => !current)}>{showText ? '收起文字' : '查看文字'}</button><button disabled={!pageText} onClick={() => { void saveText(pageText) }}>保存整页</button><button disabled={!selectedText} onClick={() => { void saveText(selectedText) }}>保存选中</button><button disabled={!document || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><button disabled={!document || page >= (document?.numPages ?? 1)} onClick={() => setPage((current) => Math.min(document?.numPages ?? current, current + 1))}>下一页</button></div></div>
    {showText && <div ref={textLayerRef} className="pdf-text-layer" aria-label="PDF 当前页文字" onMouseUp={captureSelection}>{pageText}</div>}
    {selectedText && <div className="pdf-selection-bar"><span title={selectedText}>{selectedText}</span><button onClick={() => { void translateSelectedText() }}>{translating ? '翻译中…' : '翻译'}</button></div>}
    {translation && <div className="pdf-translation-result"><span>译文</span>{translation}</div>}
    {ocrText && <div className="pdf-text-layer" aria-label="OCR 当前页文字"><strong>识别结果</strong>{ocrText}</div>}
    {ocrStatus === 'error' && <p className="pdf-ocr-error" role="status">识别未完成。请检查网络或稍后重试；不会上传整本书。</p>}
    <div className="pdf-reader-frame"><canvas ref={canvasRef} /></div>
  </div>
}
