import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ePub from 'epubjs'
import { getBookFile, listHighlights, saveBookTextIndex, saveHighlight, saveReadingProgress, type Highlight, type StoredBook } from '../lib/storage'
import { translateSelection } from '../lib/translation'
import { explainSelection } from '../lib/explanation'
import { clampFontScale, cycleTheme, loadReaderPreferences, saveReaderPreferences, type ReaderPreferences } from '../lib/reader'
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
  onPreferencesChange?: (preferences: ReaderPreferences) => void
}

type Rendition = {
  display: (target?: string) => Promise<void>
  next?: () => Promise<void>
  prev?: () => Promise<void>
  on: (event: string, callback: (...args: any[]) => void) => void
  annotations?: { highlight: (cfi: string, styles?: Record<string, string>, data?: Record<string, unknown>) => void; remove?: (cfi: string, type?: string) => void }
  themes?: {
    fontSize: (size: string) => void
    override: (name: string, value: string, priority?: string) => void
  }
  destroy: () => void
}

type Chapter = { label: string; href: string; subitems?: Chapter[] }
type SelectionAnchor = { left: number; top: number }

function isReaderShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="textbox"], [role="dialog"], [role="menuitem"]'))
}

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
  return { fill, 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' }
}

function renderHighlight(rendition: Rendition | undefined, cfi: string, color: Highlight['color']) {
  // epub.js expects styles as its fifth argument. Passing them as the second
  // argument only stores metadata and leaves the SVG annotation uncoloured.
  const annotations = rendition?.annotations as unknown as {
    highlight?: (target: string, data?: Record<string, unknown>, callback?: () => void, className?: string, styles?: Record<string, string>) => void
  } | undefined
  annotations?.highlight?.(cfi, {}, undefined, 'worlibrary-highlight', highlightStyles(color))
}

export default function EpubReader({ book, onNotice, onProgress, onHighlightSaved, targetLanguage = '中文', uiLocale = 'zh-CN', preferences, onPreferencesChange }: EpubReaderProps) {
  const ui = copy[uiLocale]
  const en = uiLocale === 'en'
  const readerShellRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | undefined>(undefined)
  const [status, setStatus] = useState('正在打开本地文件…')
  const [openFailed, setOpenFailed] = useState(false)
  const [openAttempt, setOpenAttempt] = useState(0)
  const [chapters, setChapters] = useState<Array<{ label: string; href: string }>>([])
  const [showContents, setShowContents] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<{ text: string; cfi: string }>()
  const [selectionAnchor, setSelectionAnchor] = useState<SelectionAnchor>()
  const translationRequestRef = useRef(0)
  const activeSelectionCfiRef = useRef<string | undefined>(undefined)
  const [selectionColor, setSelectionColor] = useState<Highlight['color']>()
  const activeSelectionHighlightRef = useRef<string | undefined>(undefined)
  const [translation, setTranslation] = useState('')
  const [explanation, setExplanation] = useState('')
  const [translating, setTranslating] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [pageLabel, setPageLabel] = useState('')
  const [chapterLabel, setChapterLabel] = useState('')
  const chapterHrefRef = useRef('')
  const pageAtChapterEndRef = useRef(false)
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>(() => ({ ...loadReaderPreferences(), ...preferences }))
  const [aiFeedback, setAiFeedback] = useState<AiFeedback>()
  const themeLabel = readerPreferences.theme === 'paper' ? ui.paperTheme : readerPreferences.theme === 'sepia' ? ui.sepiaTheme : ui.nightTheme

  useEffect(() => {
    setReaderPreferences((current) => {
      const next = { ...current, ...preferences }
      return next.fontScale === current.fontScale && next.theme === current.theme && next.pdfZoom === current.pdfZoom ? current : next
    })
  }, [preferences?.fontScale, preferences?.theme, preferences?.pdfZoom])

  useEffect(() => {
    saveReaderPreferences(readerPreferences)
    applyReaderPreferences(renditionRef.current, readerPreferences)
    onPreferencesChange?.(readerPreferences)
  }, [readerPreferences, onPreferencesChange])

  useEffect(() => {
    let active = true
    let rendition: Rendition | undefined
    let publication: { destroy: () => void } | undefined

    async function openPublication() {
      setOpenFailed(false)
      setStatus(en ? 'Opening local file…' : '正在打开本地文件…')
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
          setPageLabel(displayed?.page && displayed?.total ? `${displayed.page} / ${displayed.total}` : `${progress}%`)
          const href = location.start?.href
          chapterHrefRef.current = href ?? ''
          pageAtChapterEndRef.current = Boolean(displayed?.page && displayed?.total && displayed.page >= displayed.total)
          const chapter = toc.find((item) => href && (href === item.href || href.endsWith(item.href) || item.href.endsWith(href)))
          setChapterLabel(chapter?.label ?? '')
          void saveReadingProgress(book.id, cfi, progress)
          onProgress(progress, cfi)
        })
        rendition.on('selected', (cfi: string, contents: { window?: Window }) => {
          const text = contents?.window?.getSelection()?.toString().trim() ?? ''
          if (!text) return
          clearSelectionHighlight()
          setTranslation('')
          setExplanation('')
          setAiFeedback(undefined)
          setSelectionColor(undefined)
          setSelectionAnchor(anchorForSelection(contents))
          activeSelectionCfiRef.current = cfi
          setPendingSelection({ text, cfi })
          // epub.js fires its selected event while its iframe is still
          // settling the selection range. Re-read the range on the next paint
          // so the popup follows the visible word instead of stale coordinates.
          contents.window?.requestAnimationFrame(() => {
            contents.window?.requestAnimationFrame(() => {
              if (activeSelectionCfiRef.current === cfi) setSelectionAnchor(anchorForSelection(contents))
            })
          })
        })
        await rendition.display(book.location)
        const savedHighlights = await listHighlights(book.id)
        savedHighlights.filter((highlight) => highlight.isHighlighted !== false).forEach((highlight) => renderHighlight(rendition, highlight.location, highlight.color))
        setStatus('')
      } catch (error) {
        setOpenFailed(true)
        setStatus(ui.readerOpenFailed)
        onNotice(en ? 'The EPUB could not be opened. Try again or import the file again from your library.' : '无法打开 EPUB。请重试；若仍失败，请返回书库重新导入。')
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
  }, [book.id, book.fileName, book.storage, en, onNotice, openAttempt, ui.readerOpenFailed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if (event.key === 'Escape') {
        if (pendingSelection) {
          event.preventDefault()
          dismissSelection()
        } else if (showContents) {
          event.preventDefault()
          setShowContents(false)
        }
        return
      }
      // Arrow keys navigate the publication only while the reading surface is
      // active. They must not hijack keyboard interaction with toolbar and
      // contents controls, where arrows may be used by assistive technology.
      if (isReaderShortcutTarget(event.target)) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        void goToNextPage()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void renditionRef.current?.prev?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [chapters, pendingSelection, showContents])

  // Start only after React commits the selected text. This makes the EPUB
  // iframe callback and the visible popup one transaction, while a newer
  // selection naturally supersedes an earlier in-flight response.
  useEffect(() => {
    if (pendingSelection) void translateText(pendingSelection.text)
  }, [pendingSelection?.cfi, pendingSelection?.text, targetLanguage])

  async function goToNextPage() {
    const rendition = renditionRef.current
    if (!rendition?.next) return
    const chapterBeforeMove = chapterHrefRef.current
    if (pageAtChapterEndRef.current && chapterBeforeMove) {
      const currentChapterIndex = chapters.findIndex((chapter) => chapter.href === chapterBeforeMove || chapterBeforeMove.endsWith(chapter.href) || chapter.href.endsWith(chapterBeforeMove))
      const nextChapter = currentChapterIndex >= 0 ? chapters[currentChapterIndex + 1] : undefined
      // EPUB.js's horizontal manager can stop at the exact right-hand edge of
      // a one-page spine item. The chapter list is already normalized from the
      // nav document or spine, so use it as a deterministic boundary fallback.
      if (nextChapter) return rendition.display(nextChapter.href)
    }
    await rendition.next()
  }

  async function persistSelection() {
    if (!pendingSelection) return
    try {
      const color = selectionColor ?? 'gold'
      const highlight = await saveHighlight({ bookId: book.id, text: pendingSelection.text, location: pendingSelection.cfi, color, isHighlighted: Boolean(selectionColor) })
      if (highlight.isHighlighted) {
        // Replace the provisional annotation with a fresh persisted one. Reusing
        // the provisional entry can leave epub.js with a stale annotation map,
        // so it disappears after the selection popup closes or the chapter reloads.
        clearSelectionHighlight()
        try { renderHighlight(renditionRef.current, highlight.location, highlight.color) } catch { /* storage still has the excerpt */ }
      }
      activeSelectionHighlightRef.current = undefined
      onHighlightSaved?.(highlight)
      dismissSelection()
      onNotice('摘录已保存到本地')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '摘录保存失败，请稍后重试')
    }
  }

  function dismissSelection() {
    translationRequestRef.current += 1
    clearSelectionHighlight()
    activeSelectionCfiRef.current = undefined
    setPendingSelection(undefined)
    setSelectionAnchor(undefined)
    setTranslation('')
    setExplanation('')
    setAiFeedback(undefined)
  }

  function clearSelectionHighlight() {
    const cfi = activeSelectionHighlightRef.current
    if (!cfi) return
    try { renditionRef.current?.annotations?.remove?.(cfi, 'highlight') } catch { /* closing a popup must not block the reader */ }
    activeSelectionHighlightRef.current = undefined
  }

  function chooseSelectionColor(color: Highlight['color']) {
    if (!pendingSelection) return
    clearSelectionHighlight()
    // Do not mark a selection merely because it was translated. The explicit
    // color choice is the user's request to create a visible EPUB annotation.
    try {
      renderHighlight(renditionRef.current, pendingSelection.cfi, color)
      activeSelectionHighlightRef.current = pendingSelection.cfi
    } catch { /* saving the excerpt below remains available for malformed CFIs */ }
    setSelectionColor(color)
  }

  function anchorForSelection(contents: { window?: Window }): SelectionAnchor | undefined {
    const frames = Array.from(mountRef.current?.querySelectorAll('iframe') ?? [])
    const iframe = frames.find((frame) => frame.contentWindow?.getSelection()?.toString().trim())
      ?? frames.find((frame) => frame.contentWindow === contents.window)
      ?? frames[0]
    const shell = readerShellRef.current
    const selection = iframe?.contentWindow?.getSelection() ?? contents.window?.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined
    const selectionRect = range?.getBoundingClientRect()
    if (!selectionRect || !iframe || !shell || (!selectionRect.width && !selectionRect.height)) return undefined

    const iframeRect = iframe.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    const availableWidth = Math.max(240, Math.min(390, shellRect.width - 32))
    const minCenter = availableWidth / 2 + 16
    const maxCenter = Math.max(minCenter, shellRect.width - availableWidth / 2 - 16)
    const center = iframeRect.left - shellRect.left + selectionRect.left + selectionRect.width / 2
    return {
      left: Math.min(Math.max(center, minCenter), maxCenter),
      top: Math.max(16, iframeRect.top - shellRect.top + selectionRect.bottom + 12),
    }
  }

  async function translateText(text: string) {
    const request = ++translationRequestRef.current
    setTranslating(true)
    setAiFeedback(undefined)
    try {
      const result = await translateSelection(text, targetLanguage)
      if (request === translationRequestRef.current) setTranslation(result.translation)
    } catch (error) {
      const feedback = aiFeedbackFor(error)
      if (request === translationRequestRef.current) {
        setAiFeedback(feedback)
        onNotice(feedback.title)
      }
    } finally {
      if (request === translationRequestRef.current) setTranslating(false)
    }
  }

  function retryTranslation() {
    if (pendingSelection) void translateText(pendingSelection.text)
  }

  async function explainPendingSelection() {
    if (!pendingSelection || explaining) return
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

  return <div ref={readerShellRef} className={`epub-reader-shell reader-theme-${readerPreferences.theme}`} style={{ '--reader-font-scale': readerPreferences.fontScale } as CSSProperties}>
    <div className="epub-reader-toolbar">
      <span aria-live="polite">{status || (en ? 'EPUB · local reading' : 'EPUB 本地阅读')}</span>
      <div className="reader-toolbar-actions"><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label={en ? 'Decrease font size' : '减小字号'}>A−</button><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label={en ? 'Increase font size' : '增大字号'}>A＋</button><button onClick={() => setReaderPreferences((current) => ({ ...current, theme: cycleTheme(current.theme) }))}>{themeLabel}</button>{chapters.length > 0 ? <button onClick={() => setShowContents(!showContents)} aria-expanded={showContents} aria-controls="epub-contents">{showContents ? ui.collapseContents : `${ui.contents} · ${chapters.length}`}</button> : <span className="epub-contents-unavailable" title={en ? 'This EPUB has no usable contents. You can still use page navigation.' : '此 EPUB 未提供可用目录，可继续使用上一页、下一页阅读'}>{ui.contentsUnavailable}</span>}</div>
    </div>
    {openFailed && <section className="reader-file-recovery" role="alert">
      <strong>{ui.readerOpenFailed}</strong>
      <p>{ui.readerOpenFailedCopy}</p>
      <button onClick={() => setOpenAttempt((current) => current + 1)}>{ui.retryOpenBook}</button>
    </section>}
    <div className="epub-navigation" aria-label={en ? 'EPUB page navigation' : 'EPUB 翻页'}><button aria-label={ui.previousPage} onClick={() => { void renditionRef.current?.prev?.() }}>{ui.previousPage}</button><span data-testid="epub-progress">{chapterLabel ? `${chapterLabel} · ` : ''}{pageLabel || (en ? 'Preparing reading view' : '准备阅读')}</span><button aria-label={ui.nextPage} onClick={() => { void goToNextPage() }}>{ui.nextPage}</button></div>
    {showContents && <nav id="epub-contents" className="epub-contents" aria-label={en ? 'Table of contents' : '章节目录'}>{chapters.map((chapter) => <button key={chapter.href} onClick={() => { void renditionRef.current?.display(chapter.href); setShowContents(false) }}>{chapter.label}</button>)}</nav>}
    <div className="epub-reader-frame" ref={mountRef} />
    {pendingSelection && <section className="reader-translation-popover epub-translation-popover" data-testid="translation-popover" aria-label={ui.selectedTextActions} style={selectionAnchor ? { '--selection-popover-left': `${selectionAnchor.left}px`, '--selection-popover-top': `${selectionAnchor.top}px` } as CSSProperties : undefined}>
      <div className="reader-translation-popover-heading"><span>{ui.translation}</span><button className="reader-translation-close" onClick={dismissSelection} aria-label={ui.closeSelection}>×</button></div>
      <p className="reader-translation-source" title={pendingSelection.text}>{pendingSelection.text}</p>
      {translating ? <p className="reader-translation-loading" aria-live="polite">{ui.translationLoading}</p> : translation && <div className="reader-translation-result" data-testid="translation-result" aria-live="polite">{translation}</div>}
      {explanation && <div className="reader-explanation-result"><span>{ui.explanation}</span>{explanation}</div>}
      {aiFeedback && <div className="ai-request-feedback" role="status"><strong>{aiFeedback.title}</strong><span>{aiFeedback.detail}</span>{aiFeedback.retryable && <button onClick={retryTranslation}>{ui.retryTranslation}</button>}</div>}
      <div className="reader-translation-actions"><button onClick={() => { void explainPendingSelection() }} disabled={explaining}>{explaining ? ui.explanationLoading : ui.explanation}</button><div className="selection-colors" aria-label={ui.highlightColors}><button className={`gold ${selectionColor === 'gold' ? 'active' : ''}`} aria-label={ui.gold} aria-pressed={selectionColor === 'gold'} onClick={() => chooseSelectionColor('gold')} /><button className={`rose ${selectionColor === 'rose' ? 'active' : ''}`} aria-label={ui.rose} aria-pressed={selectionColor === 'rose'} onClick={() => chooseSelectionColor('rose')} /><button className={`blue ${selectionColor === 'blue' ? 'active' : ''}`} aria-label={ui.blue} aria-pressed={selectionColor === 'blue'} onClick={() => chooseSelectionColor('blue')} /></div><button onClick={() => { void persistSelection() }}>{ui.saveHighlight}</button></div>
    </section>}
  </div>
}
