import { useEffect, useRef, useState } from 'react'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { getBookFile, saveHighlight, saveReadingProgress, type Highlight, type StoredBook } from '../lib/storage'
import '../pdf-reader.css'

type PdfReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
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

export default function PdfReader({ book, onNotice, onProgress, onHighlightSaved }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PdfDocument>()
  const documentRef = useRef<PdfDocument | undefined>(undefined)
  const [page, setPage] = useState(Number(book.location?.replace('pdf:', '')) || 1)
  const [status, setStatus] = useState('正在打开本地 PDF…')
  const [pageText, setPageText] = useState('')
  const [showText, setShowText] = useState(false)
  const [selectedText, setSelectedText] = useState('')

  useEffect(() => {
    let active = true
    async function openDocument() {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc
        const file = await getBookFile(book)
        const loaded = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise as unknown as PdfDocument
        if (!active) {
          await loaded.destroy()
          return
        }
        setDocument(loaded)
        documentRef.current = loaded
        setPage((current) => Math.min(current, loaded.numPages))
        setStatus('')
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
      const viewport = pdfPage.getViewport({ scale: 1.35 })
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
  }, [document, page, book.id, onNotice, onProgress])

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

  return <div className="pdf-reader-shell">
    <div className="pdf-reader-toolbar"><span>{status || `PDF 本地阅读 · 第 ${page} / ${document?.numPages ?? '…'} 页`}</span><div><button disabled={!pageText} onClick={() => setShowText((current) => !current)}>{showText ? '收起文字' : '查看文字'}</button><button disabled={!pageText} onClick={() => { void saveText(pageText) }}>保存整页</button><button disabled={!selectedText} onClick={() => { void saveText(selectedText) }}>保存选中</button><button disabled={!document || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><button disabled={!document || page >= (document?.numPages ?? 1)} onClick={() => setPage((current) => Math.min(document?.numPages ?? current, current + 1))}>下一页</button></div></div>
    {showText && <div ref={textLayerRef} className="pdf-text-layer" aria-label="PDF 当前页文字" onMouseUp={captureSelection}>{pageText}</div>}
    <div className="pdf-reader-frame"><canvas ref={canvasRef} /></div>
  </div>
}
