import { useEffect, useRef, useState } from 'react'
import ePub from 'epubjs'
import { getBookFile, listHighlights, saveHighlight, saveReadingProgress, type Highlight, type StoredBook } from '../lib/storage'
import '../epub-reader.css'

type EpubReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
  onHighlightSaved?: (highlight: Highlight) => void
}

type Rendition = {
  display: (target?: string) => Promise<void>
  on: (event: string, callback: (...args: any[]) => void) => void
  annotations?: { highlight: (cfi: string, styles?: Record<string, string>, data?: Record<string, unknown>) => void }
  destroy: () => void
}

export default function EpubReader({ book, onNotice, onProgress, onHighlightSaved }: EpubReaderProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | undefined>(undefined)
  const [status, setStatus] = useState('正在打开本地文件…')
  const [chapters, setChapters] = useState<Array<{ label: string; href: string }>>([])
  const [showContents, setShowContents] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<{ text: string; cfi: string }>()
  const [selectionColor, setSelectionColor] = useState<Highlight['color']>('gold')

  useEffect(() => {
    let active = true
    let rendition: Rendition | undefined
    let publication: { destroy: () => void } | undefined

    async function openPublication() {
      try {
        const file = await getBookFile(book)
        const loadedBook = ePub(await file.arrayBuffer())
        publication = loadedBook
        await loadedBook.ready
        if (!active || !mountRef.current) return
        const navigation = await loadedBook.loaded.navigation
        setChapters(navigation.toc ?? [])
        await loadedBook.locations.generate(1024)
        rendition = loadedBook.renderTo(mountRef.current, { width: '100%', height: '650px', allowScriptedContent: false })
        renditionRef.current = rendition
        rendition.on('relocated', (location) => {
          const cfi = location.start?.cfi
          if (!cfi) return
          const progress = Math.round(loadedBook.locations.percentageFromCfi(cfi) * 100)
          void saveReadingProgress(book.id, cfi, progress)
          onProgress(progress, cfi)
        })
        rendition.on('selected', (cfi: string, contents: { window?: Window }) => {
          const text = contents?.window?.getSelection()?.toString().trim() ?? ''
          if (!text) return
          setPendingSelection({ text, cfi })
          rendition?.annotations?.highlight(cfi, { fill: '#e6b160', 'fill-opacity': '0.35' })
        })
        await rendition.display(book.location)
        const savedHighlights = await listHighlights(book.id)
        savedHighlights.forEach((highlight) => rendition?.annotations?.highlight(highlight.location, { fill: '#e6b160', 'fill-opacity': '0.35' }))
        setStatus('')
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '无法打开这本 EPUB')
        onNotice('EPUB 解析失败，请确认文件完整后重新导入')
      }
    }
    void openPublication()
    return () => {
      active = false
      rendition?.destroy()
      renditionRef.current = undefined
      publication?.destroy()
      setPendingSelection(undefined)
    }
  }, [book.id, book.fileName, book.storage, onNotice])

  async function persistSelection() {
    if (!pendingSelection) return
    const highlight = await saveHighlight({ bookId: book.id, text: pendingSelection.text, location: pendingSelection.cfi, color: selectionColor })
    onHighlightSaved?.(highlight)
    setPendingSelection(undefined)
    onNotice('摘录已保存到本地')
  }

  return <div className="epub-reader-shell">
    <div className="epub-reader-toolbar">
      <span>{status || 'EPUB 本地阅读'}</span>
      {chapters.length > 0 && <button onClick={() => setShowContents(!showContents)}>{showContents ? '收起目录' : `目录 · ${chapters.length}`}</button>}
    </div>
    {pendingSelection && <div className="epub-selection-bar">
      <span title={pendingSelection.text}>{pendingSelection.text}</span>
      <div className="selection-colors" aria-label="摘录颜色"><button className={`gold ${selectionColor === 'gold' ? 'active' : ''}`} aria-label="金色" onClick={() => setSelectionColor('gold')} /><button className={`rose ${selectionColor === 'rose' ? 'active' : ''}`} aria-label="玫红" onClick={() => setSelectionColor('rose')} /><button className={`blue ${selectionColor === 'blue' ? 'active' : ''}`} aria-label="蓝色" onClick={() => setSelectionColor('blue')} /></div>
      <button onClick={() => { void persistSelection() }}>保存摘录</button>
      <button className="ghost" onClick={() => setPendingSelection(undefined)}>取消</button>
    </div>}
    {showContents && <nav className="epub-contents" aria-label="章节目录">{chapters.map((chapter) => <button key={chapter.href} onClick={() => { void renditionRef.current?.display(chapter.href); setShowContents(false) }}>{chapter.label}</button>)}</nav>}
    <div className="epub-reader-frame" ref={mountRef} />
  </div>
}
