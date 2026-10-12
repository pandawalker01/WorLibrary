import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ePub from 'epubjs'
import { getBookFile, listHighlights, saveBookTextIndex, saveHighlight, saveReadingProgress, type Highlight, type StoredBook } from '../lib/storage'
import { translateSelection } from '../lib/translation'
import { explainSelection } from '../lib/explanation'
import { clampFontScale, cycleTheme, loadReaderPreferences, readerThemeLabel, saveReaderPreferences, type ReaderPreferences } from '../lib/reader'
import { aiFeedbackFor, type AiFeedback } from '../lib/ai-feedback'
import { copy, type UiLocale } from '../lib/i18n'
import '../epub-reader.css'

type EpubReaderProps = {
  book: StoredBook
  onNotice: (message: string) => void
  onProgress: (progress: number, location: string) => void
  onHighlightSaved?: (highlight: Highlight) => void
  targetLanguage?: string
  uiLocale?: UiLocale
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

type Chapter = { label: string; href: string; subitems?: Chapter[] }

/** EPUB navigation is frequently nested (and occasionally has blank labels).
 * Flatten it once so the compact reader menu remains usable on both EPUB 2 NCX
 * and EPUB 3 nav documents. */
function usableChapters(toc: Chapter[] | undefined, spine: Array<{ href?: string; idref?: string }> = []): Chapter[] {
  const flattened: Array<{ label: string; href: string }> = []
  const visit = (items: Chapter[], depth = 0) => items.forEach((item, index) => {
    if (item.href) {
      const fallback = `第 ${flattened.length + 1} 节`
      const label = item.label?.replace(/\s+/g, ' ').trim() || fallback
      flattened.push({ label: `${depth ? '　'.repeat(Math.min(depth, 3)) : ''}${label}`, href: item.href })
    }
    if (item.subitems?.length) visit(item.subitems, depth + 1)
    // NCX producers sometimes create a label-only parent. Its children above
    // remain navigable, which is preferable to hiding the whole navigation.
    void index
  })
  if (toc?.length) visit(toc)
  if (flattened.length) return flattened
  return spine
    .filter((item) => item.href)
    .map((item, index) => ({ label: `第 ${index + 1} 节`, href: item.href! }))
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

export default function EpubReader({ book, onNotice, onProgress, onHighlightSaved, targetLanguage = '中文', uiLocale = 'zh-CN', preferences }: EpubReaderProps) {
  const ui = copy[uiLocale]
  const en = uiLocale === 'en'
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
        const spineItems = ((loadedBook as any).spine?.spineItems ?? []) as Array<{ href?: string; idref?: string; load?: (request: unknown) => Promise<{ textContent?: string | null }>; unload?: () => void }>
        // A surprising number of otherwise readable EPUBs omit a nav document
        // altogether. epub.js rejects `loaded.navigation` in that case, so keep
        // opening the book and derive a usable chapter list from its spine.
        let navigation: { toc?: Chapter[] } | undefined
        try {
          navigation = await loadedBook.loaded.navigation as { toc?: Chapter[] }
        } catch {
          navigation = undefined
        }
        const toc = usableChapters(navigation?.toc, spineItems)
        setChapters(toc)
        // Build a local-only full text index once the EPUB is opened. The extracted text
        // never leaves IndexedDB and is not included in remote sync snapshots.
        const sections = spineItems
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
          const chapter = toc.find((item) => href && (href === item.href || href.endsWith(item.href) || item.href.endsWith(href)))
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
      if (event.key === 'Escape') {
        if (pendingSelection) {
          event.preventDefault()
          setPendingSelection(undefined)
        } else if (showContents) {
          event.preventDefault()
          setShowContents(false)
        }
        return
      }
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
  }, [pendingSelection, showContents])

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
      <span aria-live="polite">{status || (en ? 'EPUB · local reading' : 'EPUB 本地阅读')}</span>
      <div className="reader-toolbar-actions"><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label={en ? 'Decrease font size' : '减小字号'}>A−</button><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label={en ? 'Increase font size' : '增大字号'}>A＋</button><button onClick={() => setReaderPreferences((current) => ({ ...current, theme: cycleTheme(current.theme) }))}>{readerThemeLabel(readerPreferences.theme)}</button>{chapters.length > 0 ? <button onClick={() => setShowContents(!showContents)} aria-expanded={showContents} aria-controls="epub-contents">{showContents ? ui.collapseContents : `${ui.contents} · ${chapters.length}`}</button> : <span className="epub-contents-unavailable" title={en ? 'This EPUB has no usable contents. You can still use page navigation.' : '此 EPUB 未提供可用目录，可继续使用上一页、下一页阅读'}>{ui.contentsUnavailable}</span>}</div>
    </div>
    <div className="epub-navigation" aria-label={en ? 'EPUB page navigation' : 'EPUB 翻页'}><button aria-label={ui.previousPage} onClick={() => { void renditionRef.current?.prev?.() }} disabled={!renditionRef.current || readingProgress <= 0}>{ui.previousPage}</button><span data-testid="epub-progress">{chapterLabel ? `${chapterLabel} · ` : ''}{pageLabel || (en ? 'Preparing reading view' : '准备阅读')}</span><button aria-label={ui.nextPage} onClick={() => { void renditionRef.current?.next?.() }} disabled={!renditionRef.current || readingProgress >= 100}>{ui.nextPage}</button></div>
    {pendingSelection && <section className="epub-selection-bar" aria-label={ui.selectedTextActions}>
      <span title={pendingSelection.text}>{pendingSelection.text}</span>
      <button className="translate-button" onClick={() => { void translatePendingSelection() }}>{translating ? (en ? 'Translating…' : '翻译中…') : ui.translation}</button>
      <button className="translate-button" onClick={() => { void explainPendingSelection() }}>{explaining ? (en ? 'Explaining…' : '解释中…') : ui.explanation}</button>
      <div className="selection-colors" aria-label={ui.highlightColors}><button className={`gold ${selectionColor === 'gold' ? 'active' : ''}`} aria-label={ui.gold} aria-pressed={selectionColor === 'gold'} onClick={() => setSelectionColor('gold')} /><button className={`rose ${selectionColor === 'rose' ? 'active' : ''}`} aria-label={ui.rose} aria-pressed={selectionColor === 'rose'} onClick={() => setSelectionColor('rose')} /><button className={`blue ${selectionColor === 'blue' ? 'active' : ''}`} aria-label={ui.blue} aria-pressed={selectionColor === 'blue'} onClick={() => setSelectionColor('blue')} /></div>
      <button onClick={() => { void persistSelection() }}>{ui.saveHighlight}</button>
      <button className="ghost" onClick={() => setPendingSelection(undefined)} aria-label={ui.closeSelection}>{ui.cancel}</button>
    </section>}
    {translation && <div className="epub-translation-result" data-testid="translation-result" aria-live="polite"><span>{ui.translation}</span>{translation}{explanation && <><span>{ui.explanation}</span>{explanation}</>}</div>}
    {aiFeedback && <div className="ai-request-feedback" role="status"><strong>{aiFeedback.title}</strong><span>{aiFeedback.detail}</span>{aiFeedback.retryable && pendingSelection && <button onClick={() => { void translatePendingSelection() }}>{ui.retryTranslation}</button>}</div>}
    {showContents && <nav id="epub-contents" className="epub-contents" aria-label={en ? 'Table of contents' : '章节目录'}>{chapters.map((chapter) => <button key={chapter.href} onClick={() => { void renditionRef.current?.display(chapter.href); setShowContents(false) }}>{chapter.label}</button>)}</nav>}
    <div className="epub-reader-frame" ref={mountRef} />
  </div>
}
