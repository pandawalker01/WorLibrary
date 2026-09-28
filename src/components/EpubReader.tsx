import { useEffect, useRef, useState } from 'react'
import ePub from 'epubjs'
import { getBookFile, saveReadingProgress, type StoredBook } from '../lib/storage'

type EpubReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
}

type Rendition = {
  display: (target?: string) => Promise<void>
  on: (event: string, callback: (location: { start?: { cfi?: string } }) => void) => void
  destroy: () => void
}

export default function EpubReader({ book, onNotice, onProgress }: EpubReaderProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | undefined>(undefined)
  const [status, setStatus] = useState('正在打开本地文件…')
  const [chapters, setChapters] = useState<Array<{ label: string; href: string }>>([])
  const [showContents, setShowContents] = useState(false)

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
        await rendition.display(book.location)
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
    }
  }, [book.id, book.fileName, book.storage, onNotice])

  return <div className="epub-reader-shell">
    <div className="epub-reader-toolbar">
      <span>{status || 'EPUB 本地阅读'}</span>
      {chapters.length > 0 && <button onClick={() => setShowContents(!showContents)}>{showContents ? '收起目录' : `目录 · ${chapters.length}`}</button>}
    </div>
    {showContents && <nav className="epub-contents" aria-label="章节目录">{chapters.map((chapter) => <button key={chapter.href} onClick={() => { void renditionRef.current?.display(chapter.href); setShowContents(false) }}>{chapter.label}</button>)}</nav>}
    <div className="epub-reader-frame" ref={mountRef} />
  </div>
}
