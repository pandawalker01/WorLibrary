import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ePub from 'epubjs'
import { getBookFile, listHighlights, saveBookTextIndex, saveHighlight, saveReadingProgress, type Highlight, type StoredBook } from '../lib/storage'
import { translateSelection } from '../lib/translation'
import { explainSelection } from '../lib/explanation'
import { clampFontScale, cycleTheme, loadReaderPreferences, readerThemeLabel, saveReaderPreferences, type ReaderPreferences } from '../lib/reader'
import { aiFeedbackFor, type AiFeedback } from '../lib/ai-feedback'
import '../epub-reader.css'

type EpubReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
  onHighlightSaved?: (highlight: Highlight) => void
  targetLanguage?: string
  preferences?: Partial<ReaderPreferences>
}

type Rendition = {
  display: (target?: string) => Promise<void>
  next?: () => Promise<void>
  prev?: () => Promise<void>
  on: (event: string, callback: (...args: any[]) => void) => void
  annotations?: { highlight: (cfi: string, styles?: Record<string, string>, data?: Record<string, unknown>) => void }
  themes?: {
    fontSize: (size: string) => void
    override: (name: string, value: string, priority?: string) => void
  }
  destroy: () => void
}

function applyReaderPreferences(rendition: Rendition | undefined, preferences: ReaderPreferences) {
  if (!rendition?.themes) return
  const colors = preferences.theme === 'night'
    ? { background: '#242220', foreground: '#e9e1d5' }
    : preferences.theme === 'sepia'
      ? { background: '#f0e4cf', foreground: '#514536' }
      : { background: '#f8f5ed', foreground: '#514c45' }
  rendition.themes.fontSize(`${Math.round(preferences.fontScale * 100)}%`)
  rendition.themes.override('background-color', colors.background, 'important')
  rendition.themes.override('color', colors.foreground, 'important')
}

function highlightStyles(color: Highlight['color']): Record<string, string> {
  const fill = color === 'rose' ? '#bf6d76' : color === 'blue' ? '#6886a7' : '#e6b160'
  return { fill, 'fill-opacity': '0.35' }
}

export default function EpubReader({ book, onNotice, onProgress, onHighlightSaved, targetLanguage = '中文', preferences }: EpubReaderProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | undefined>(undefined)
  const [status, setStatus] = useState('正在打开本地文件…')
  const [chapters, setChapters] = useState<Array<{ label: string; href: string }>>([])
  const [showContents, setShowContents] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<{ text: string; cfi: string }>()
  const [selectionColor, setSelectionColor] = useState<Highlight['color']>('gold')
  const selectionColorRef = useRef<Highlight['color']>('gold')
  const [translation, setTranslation] = useState('')
  const [explanation, setExplanation] = useState('')
  const [translating, setTranslating] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [readingProgress, setReadingProgress] = useState(0)
  const [pageLabel, setPageLabel] = useState('')
  const [chapterLabel, setChapterLabel] = useState('')
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>(() => ({ ...loadReaderPreferences(), ...preferences }))
  const [aiFeedback, setAiFeedback] = useState<AiFeedback>()

  useEffect(() => { selectionColorRef.current = selectionColor }, [selectionColor])

  useEffect(() => { setReaderPreferences((current) => ({ ...current, ...preferences })) }, [preferences?.fontScale, preferences?.theme])

  useEffect(() => {
    saveReaderPreferences(readerPreferences)
    applyReaderPreferences(renditionRef.current, readerPreferences)
  }, [readerPreferences])

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
        const toc = navigation.toc ?? []
        setChapters(toc)
        // Build a local-only full text index once the EPUB is opened. The extracted text
        // never leaves IndexedDB and is not included in remote sync snapshots.
        const sections = ((loadedBook as any).spine?.spineItems ?? []) as Array<{ load?: (request: unknown) => Promise<{ textContent?: string | null }>; unload?: () => void }>
        const indexedText: string[] = []
        for (const section of sections) {
          if (!active || !section.load) break
          try {
            const contents = await section.load((loadedBook as any).load.bind(loadedBook))
            const text = contents.textContent?.replace(/\s+/g, ' ').trim()
            if (text) indexedText.push(text)
          } catch { /* a malformed chapter should not prevent reading */ }
          section.unload?.()
        }
        if (indexedText.length > 0) void saveBookTextIndex(book.id, indexedText.join(' '))
        await loadedBook.locations.generate(1024)
        rendition = loadedBook.renderTo(mountRef.current, { width: '100%', height: '650px', allowScriptedContent: false })
        renditionRef.current = rendition
        applyReaderPreferences(rendition, readerPreferences)
        rendition.on('relocated', (location) => {
          const cfi = location.start?.cfi
          if (!cfi) return
          const progress = Math.round(loadedBook.locations.percentageFromCfi(cfi) * 100)
          const displayed = location.start?.displayed
          setReadingProgress(progress)
          setPageLabel(displayed?.page && displayed?.total ? `${displayed.page} / ${displayed.total}` : `${progress}%`)
          const href = location.start?.href
          const chapter = toc.find((item) => href && (href === item.href || href.endsWith(item.href)))
          setChapterLabel(chapter?.label ?? '')
          void saveReadingProgress(book.id, cfi, progress)
          onProgress(progress, cfi)
        })
        rendition.on('selected', (cfi: string, contents: { window?: Window }) => {
          const text = contents?.window?.getSelection()?.toString().trim() ?? ''
          if (!text) return
          setPendingSelection({ text, cfi })
          setTranslation('')
          setExplanation('')
          rendition?.annotations?.highlight(cfi, highlightStyles(selectionColorRef.current))
          setAiFeedback(undefined)
        })
        await rendition.display(book.location)
        const savedHighlights = await listHighlights(book.id)
        savedHighlights.forEach((highlight) => rendition?.annotations?.highlight(highlight.location, highlightStyles(highlight.color)))
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        void renditionRef.current?.next?.()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void renditionRef.current?.prev?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  async function persistSelection() {
    if (!pendingSelection) return
    try {
      const highlight = await saveHighlight({ bookId: book.id, text: pendingSelection.text, location: pendingSelection.cfi, color: selectionColor })
      onHighlightSaved?.(highlight)
      setPendingSelection(undefined)
      onNotice('摘录已保存到本地')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '摘录保存失败，请稍后重试')
    }
  }

  async function translatePendingSelection() {
    if (!pendingSelection || translating) return
    setTranslating(true)
    setAiFeedback(undefined)
    try {
      const result = await translateSelection(pendingSelection.text, targetLanguage)
      setTranslation(result.translation)
    } catch (error) {
      const feedback = aiFeedbackFor(error)
      setAiFeedback(feedback)
      onNotice(feedback.title)
    } finally {
      setTranslating(false)
    }
  }

  async function explainPendingSelection() {
    if (!pendingSelection || translating || explaining) return
    setExplaining(true)
    setAiFeedback(undefined)
    try {
      const result = await explainSelection(pendingSelection.text, targetLanguage)
      setTranslation(result.translation)
      setExplanation(result.explanation)
    } catch (error) {
      const feedback = aiFeedbackFor(error)
      setAiFeedback(feedback)
      onNotice(feedback.title)
    } finally {
      setExplaining(false)
    }
  }

  return <div className={`epub-reader-shell reader-theme-${readerPreferences.theme}`} style={{ '--reader-font-scale': readerPreferences.fontScale } as CSSProperties}>
    <div className="epub-reader-toolbar">
      <span>{status || 'EPUB 本地阅读'}</span>
      <div className="reader-toolbar-actions"><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label="减小字号">A−</button><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label="增大字号">A＋</button><button onClick={() => setReaderPreferences((current) => ({ ...current, theme: cycleTheme(current.theme) }))}>{readerThemeLabel(readerPreferences.theme)}</button>{chapters.length > 0 && <button onClick={() => setShowContents(!showContents)}>{showContents ? '收起目录' : `目录 · ${chapters.length}`}</button>}</div>
    </div>
    <div className="epub-navigation" aria-label="EPUB 翻页"><button aria-label="上一页" onClick={() => { void renditionRef.current?.prev?.() }} disabled={!renditionRef.current || readingProgress <= 0}>上一页</button><span data-testid="epub-progress">{chapterLabel ? `${chapterLabel} · ` : ''}{pageLabel || '准备阅读'}</span><button aria-label="下一页" onClick={() => { void renditionRef.current?.next?.() }} disabled={!renditionRef.current || readingProgress >= 100}>下一页</button></div>
    {pendingSelection && <div className="epub-selection-bar">
      <span title={pendingSelection.text}>{pendingSelection.text}</span>
      <button className="translate-button" onClick={() => { void translatePendingSelection() }}>{translating ? '翻译中…' : '翻译'}</button>
      <button className="translate-button" onClick={() => { void explainPendingSelection() }}>{explaining ? '解释中…' : '解释'}</button>
      <div className="selection-colors" aria-label="摘录颜色"><button className={`gold ${selectionColor === 'gold' ? 'active' : ''}`} aria-label="金色" onClick={() => setSelectionColor('gold')} /><button className={`rose ${selectionColor === 'rose' ? 'active' : ''}`} aria-label="玫红" onClick={() => setSelectionColor('rose')} /><button className={`blue ${selectionColor === 'blue' ? 'active' : ''}`} aria-label="蓝色" onClick={() => setSelectionColor('blue')} /></div>
      <button onClick={() => { void persistSelection() }}>保存摘录</button>
      <button className="ghost" onClick={() => setPendingSelection(undefined)}>取消</button>
    </div>}
    {translation && <div className="epub-translation-result" data-testid="translation-result" aria-live="polite"><span>译文</span>{translation}{explanation && <><span>解释</span>{explanation}</>}</div>}
    {aiFeedback && <div className="ai-request-feedback" role="status"><strong>{aiFeedback.title}</strong><span>{aiFeedback.detail}</span>{aiFeedback.retryable && pendingSelection && <button onClick={() => { void translatePendingSelection() }}>重试翻译</button>}</div>}
    {showContents && <nav className="epub-contents" aria-label="章节目录">{chapters.map((chapter) => <button key={chapter.href} onClick={() => { void renditionRef.current?.display(chapter.href); setShowContents(false) }}>{chapter.label}</button>)}</nav>}
    <div className="epub-reader-frame" ref={mountRef} />
  </div>
}
