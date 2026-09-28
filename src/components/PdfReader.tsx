import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { getBookFile, saveReadingProgress, type StoredBook } from '../lib/storage'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

type PdfReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
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

export default function PdfReader({ book, onNotice, onProgress }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PdfDocument>()
  const documentRef = useRef<PdfDocument | undefined>(undefined)
  const [page, setPage] = useState(Number(book.location?.replace('pdf:', '')) || 1)
  const [status, setStatus] = useState('正在打开本地 PDF…')

  useEffect(() => {
    let active = true
    async function openDocument() {
      try {
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
      const progress = Math.round((page / document.numPages) * 100)
      const location = `pdf:${page}`
      void saveReadingProgress(book.id, location, progress)
      onProgress(progress, location)
    }).catch(() => onNotice('这一页 PDF 渲染失败，请尝试重新打开'))
    return () => { active = false }
  }, [document, page, book.id, onNotice, onProgress])

  return <div className="pdf-reader-shell">
    <div className="pdf-reader-toolbar"><span>{status || `PDF 本地阅读 · 第 ${page} / ${document?.numPages ?? '…'} 页`}</span><div><button disabled={!document || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><button disabled={!document || page >= (document?.numPages ?? 1)} onClick={() => setPage((current) => Math.min(document?.numPages ?? current, current + 1))}>下一页</button></div></div>
    <div className="pdf-reader-frame"><canvas ref={canvasRef} /></div>
  </div>
}
