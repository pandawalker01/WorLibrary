import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import EpubReader from './components/EpubReader'
import PdfReader from './components/PdfReader'
import HighlightsView from './components/HighlightsView'
import DataTransfer from './components/DataTransfer'
import './highlights.css'
import { listHighlights, type Highlight } from './lib/storage'
import './library.css'
import './settings.css'
import { deleteBook, linkBookEditions, listAlignments, listBooks, listEditions, refreshBookCover, saveBook, saveEditionProgress, searchBookTextIndex, updateBookCover, updateBookMetadata, type StoredBook } from './lib/storage'
import type { Alignment, Edition } from './lib/edition'
import EditionComparisonReader from './components/EditionComparisonReader'
import AuthPanel from './components/AuthPanel'
import { getSession, type AuthSession } from './lib/auth'
import { copy, interpolate, loadReadingLanguage, loadUiLocale, saveReadingLanguage, saveUiLocale, type ReadingLanguage } from './lib/i18n'
import { clampFontScale, loadReaderPreferences, type ReaderPreferences } from './lib/reader'
import { loadSavedWorldBooks, saveWorldBook, searchWorldLibrary, worldBookIdentity, type WorldBook } from './lib/world-library'
import WorldLanguagePicker from './components/WorldLanguagePicker'
import ReadingLanguagePicker, { displayReadingLanguage } from './components/ReadingLanguagePicker'
import InterfaceLanguagePicker from './components/InterfaceLanguagePicker'
import { interfaceLocaleDirection, presentInterfaceLocales } from './lib/interface-locale-registry'

// Platform rendering pulls in EPUB.js/PDF.js integration. Keep it out of the
// personal-library shell until a user explicitly opens an authorised title.
const PlatformReader = lazy(() => import('./components/PlatformReader'))

type View = 'library' | 'reader' | 'highlights' | 'profile' | 'settings'
type DisplayBook = Pick<StoredBook, 'id' | 'title' | 'author' | 'language' | 'progress' | 'cover'> & Partial<Pick<StoredBook, 'fileName' | 'fileType' | 'storage' | 'createdAt' | 'lastReadAt' | 'location' | 'workId' | 'coverImage'>>
type AppRoute = { view: View; libraryMode: 'mine' | 'world'; bookId?: string; platformEditionId?: string }

function readAppRoute(): AppRoute {
  const params = new URLSearchParams(window.location.search)
  const candidate = params.get('view')
  const view: View = candidate === 'reader' || candidate === 'highlights' || candidate === 'profile' || candidate === 'settings' ? candidate : 'library'
  return { view, libraryMode: params.get('scope') === 'world' ? 'world' : 'mine', bookId: params.get('book') ?? undefined, platformEditionId: params.get('platformEdition') ?? undefined }
}

function writeAppRoute(route: AppRoute): void {
  const url = new URL(window.location.href)
  url.searchParams.set('view', route.view)
  if (route.view === 'library' && route.libraryMode === 'world') url.searchParams.set('scope', 'world')
  else url.searchParams.delete('scope')
  if (route.view === 'reader' && route.bookId) url.searchParams.set('book', route.bookId)
  else url.searchParams.delete('book')
  if (route.view === 'reader' && route.platformEditionId) url.searchParams.set('platformEdition', route.platformEditionId)
  else url.searchParams.delete('platformEdition')
  window.history.pushState({}, '', url)
}

const sampleBooks: DisplayBook[] = [
  { id: 'invisible', title: 'The Invisible Life of Addie LaRue', author: 'V. E. Schwab', language: 'English · 3 versions', progress: 38, cover: 'ink' },
  { id: 'stranger', title: "L'Étranger", author: 'Albert Camus', language: 'Français · 2 versions', progress: 72, cover: 'sun' },
  { id: 'kafka', title: '变形记', author: 'Franz Kafka', language: '中文 · 2 versions', progress: 14, cover: 'red' },
]

const READING_SECONDS_KEY = 'worlibrary.reading-seconds'
const READING_HISTORY_KEY = 'worlibrary.reading-history'
const READING_BY_BOOK_KEY = 'worlibrary.reading-by-book'
const PLATFORM_READING_METADATA_KEY = 'worlibrary.platform-reading-metadata'

type ReadingHistory = Record<string, number>
type PlatformReadingMetadata = Record<string, { editionId: string; title: string; author: string; lastReadAt: number }>

function loadReadingSeconds(): number {
  try { return Math.max(0, Number(window.localStorage.getItem(READING_SECONDS_KEY)) || 0) } catch { return 0 }
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function loadReadingHistory(): ReadingHistory {
  try {
    const value = JSON.parse(window.localStorage.getItem(READING_HISTORY_KEY) ?? '{}') as Record<string, unknown>
    const history: ReadingHistory = {}
    for (const [key, seconds] of Object.entries(value)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) history[key] = seconds
    }
    return history
  } catch {
    return {}
  }
}

function saveReadingHistory(history: ReadingHistory): void {
  try { window.localStorage.setItem(READING_HISTORY_KEY, JSON.stringify(history)) } catch { /* Reading must work without storage. */ }
}

function loadBookReadingHistory(): ReadingHistory {
  try {
    const value = JSON.parse(window.localStorage.getItem(READING_BY_BOOK_KEY) ?? '{}') as Record<string, unknown>
    const history: ReadingHistory = {}
    for (const [bookId, seconds] of Object.entries(value)) {
      if (bookId && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) history[bookId] = seconds
    }
    return history
  } catch {
    return {}
  }
}

function saveBookReadingHistory(history: ReadingHistory): void {
  try { window.localStorage.setItem(READING_BY_BOOK_KEY, JSON.stringify(history)) } catch { /* Reading must work without storage. */ }
}

/**
 * Platform reading history deliberately stores only shelf metadata. Protected
 * source files, reader locations and delivery URLs must never enter browser
 * persistence; the stable `platform:<editionId>` duration key is enough for
 * the local profile to show a reader where their time went.
 */
function loadPlatformReadingMetadata(): PlatformReadingMetadata {
  try {
    const value = JSON.parse(window.localStorage.getItem(PLATFORM_READING_METADATA_KEY) ?? '{}') as Record<string, unknown>
    const metadata: PlatformReadingMetadata = {}
    for (const [key, item] of Object.entries(value)) {
      if (!key.startsWith('platform:') || !item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      if (typeof candidate.editionId === 'string' && typeof candidate.title === 'string' && typeof candidate.author === 'string' && typeof candidate.lastReadAt === 'number' && Number.isFinite(candidate.lastReadAt)) {
        metadata[key] = { editionId: candidate.editionId, title: candidate.title, author: candidate.author, lastReadAt: candidate.lastReadAt }
      }
    }
    return metadata
  } catch {
    return {}
  }
}

function savePlatformReadingMetadata(metadata: PlatformReadingMetadata): void {
  try { window.localStorage.setItem(PLATFORM_READING_METADATA_KEY, JSON.stringify(metadata)) } catch { /* Reading must work without storage. */ }
}

function recentReadingDays(history: ReadingHistory, locale: 'zh-CN' | 'en') {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (6 - index))
    return {
      key: dayKey(date),
      label: new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'zh-CN', { weekday: 'short' }).format(date),
      seconds: history[dayKey(date)] ?? 0,
    }
  })
}

function formatReadingTime(seconds: number, locale: 'zh-CN' | 'en'): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (locale === 'en') return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${minutes} min`
  return hours > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${minutes} 分钟`
}

function formatLastRead(timestamp: number | undefined, locale: 'zh-CN' | 'en', notReadLabel: string): string {
  if (!timestamp) return notReadLabel
  return new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
}

function accountIdentity(session: AuthSession | null, signedOutLabel: string, guestLabel: string) {
  if (!session) return { label: signedOutLabel, initials: 'WL' }
  if (session.user.isAnonymous) return { label: guestLabel, initials: 'G' }
  const email = session.user.email ?? guestLabel
  return { label: email.split('@')[0], initials: email.slice(0, 2).toUpperCase() }
}

function App() {
  const initialRoute = useRef(readAppRoute()).current
  const [books, setBooks] = useState<DisplayBook[]>([])
  const [booksLoaded, setBooksLoaded] = useState(false)
  const [view, setView] = useState<View>(initialRoute.view)
  // The interface locale and AI reading language are intentionally distinct:
  // changing UI copy must never silently change a reader's translation target.
  const [uiLocale, setUiLocale] = useState(loadUiLocale)
  const [language, setLanguage] = useState<ReadingLanguage>(loadReadingLanguage)
  const [selectedBook, setSelectedBook] = useState<DisplayBook>(sampleBooks[0])
  const [compare, setCompare] = useState(false)
  const [readerLayoutOpen, setReaderLayoutOpen] = useState(false)
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>(loadReaderPreferences)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'reading' | 'multi'>('all')
  const [sortNewest, setSortNewest] = useState(true)
  const [textMatches, setTextMatches] = useState<Record<string, string>>({})
  const [editions, setEditions] = useState<Edition[]>([])
  const [alignments, setAlignments] = useState<Alignment[]>([])
  const [session, setSession] = useState<AuthSession | null>(null)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [updateReady, setUpdateReady] = useState(false)
  const [authDialogOpen, setAuthDialogOpen] = useState(false)
  const [metadataDraft, setMetadataDraft] = useState<StoredBook | null>(null)
  const [refreshingCoverId, setRefreshingCoverId] = useState<string | null>(null)
  const [coverTargetId, setCoverTargetId] = useState<string | null>(null)
  const [bookContextMenu, setBookContextMenu] = useState<{ book: DisplayBook; x: number; y: number } | null>(null)
  const [highlightCount, setHighlightCount] = useState(0)
  const [readingSeconds, setReadingSeconds] = useState(loadReadingSeconds)
  const [readingHistory, setReadingHistory] = useState<ReadingHistory>(loadReadingHistory)
  const [bookReadingHistory, setBookReadingHistory] = useState<ReadingHistory>(loadBookReadingHistory)
  const [platformReadingMetadata, setPlatformReadingMetadata] = useState<PlatformReadingMetadata>(loadPlatformReadingMetadata)
  const [libraryMode, setLibraryMode] = useState<'mine' | 'world'>(initialRoute.libraryMode)
  const [routedBookId, setRoutedBookId] = useState<string | undefined>(initialRoute.bookId)
  const [routedPlatformEditionId, setRoutedPlatformEditionId] = useState<string | undefined>(initialRoute.platformEditionId)
  const [worldQuery, setWorldQuery] = useState('')
  const [worldResults, setWorldResults] = useState<WorldBook[]>([])
  const [worldStatus, setWorldStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [savedWorldBooks, setSavedWorldBooks] = useState<WorldBook[]>(loadSavedWorldBooks)
  const [worldLanguage, setWorldLanguage] = useState('')
  const [multiLanguageOnly, setMultiLanguageOnly] = useState(false)
  const [worldHasSearched, setWorldHasSearched] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const coverInput = useRef<HTMLInputElement>(null)
  const ui = copy[uiLocale]
  const account = accountIdentity(session, ui.signIn, ui.guestAccount)

  const handleAuthSessionChange = useCallback((next: AuthSession | null) => {
    setSession(next)
    if (next && !next.user.isAnonymous) setAuthDialogOpen(false)
  }, [])

  const syncNow = useCallback(async () => {
    // The legacy full-table REST synchronizer has no account-scoped outbox,
    // server revisions, or a safe representation for metadata-only books.
    // Keep it disabled until the controlled RPC protocol is live.
    return undefined
  }, [])

  const scheduleSync = useCallback(() => {
    // Local reading must remain responsive while account metadata sync is
    // being rebuilt. In particular, never leave a cross-account legacy queue.
  }, [])

  useEffect(() => {
    void Promise.all([listBooks(), listEditions(), listAlignments(), listHighlights()]).then(([savedBooks, savedEditions, savedAlignments, savedHighlights]) => { setBooks(savedBooks); setEditions(savedEditions); setAlignments(savedAlignments); setHighlightCount(savedHighlights.length); setBooksLoaded(true) })
  }, [])

  useEffect(() => {
    const restoreRoute = () => {
      const route = readAppRoute()
      setView(route.view)
      setLibraryMode(route.libraryMode)
      setRoutedBookId(route.bookId)
      setRoutedPlatformEditionId(route.platformEditionId)
    }
    window.addEventListener('popstate', restoreRoute)
    return () => window.removeEventListener('popstate', restoreRoute)
  }, [])

  useEffect(() => {
    if (!booksLoaded || view !== 'reader' || !routedBookId || routedPlatformEditionId) return
    const routedBook = books.find((book) => book.id === routedBookId && book.storage && book.fileName)
    if (routedBook) { setSelectedBook(routedBook); return }
    setView('library')
    setRoutedBookId(undefined)
    toast('找不到这本本地书籍，请返回书库重新导入')
  }, [books, booksLoaded, routedBookId, routedPlatformEditionId, view])

  const selectedPlatformBook = routedPlatformEditionId
    ? savedWorldBooks.find((book) => book.platformEditionId === routedPlatformEditionId)
    : undefined
  const activeReadingBookKey = selectedPlatformBook?.platformEditionId
    ? `platform:${selectedPlatformBook.platformEditionId}`
    : routedPlatformEditionId ? undefined : selectedBook.id

  useEffect(() => {
    if (!booksLoaded || view !== 'reader' || !routedPlatformEditionId) return
    if (selectedPlatformBook) return
    setView('library')
    setRoutedPlatformEditionId(undefined)
    toast(uiLocale === 'en' ? 'This platform edition is not in your library.' : '找不到这本平台书籍，请返回书库重新加入。')
  }, [booksLoaded, routedPlatformEditionId, selectedPlatformBook, uiLocale, view])

  useEffect(() => {
    const currentRoute = readAppRoute()
    // A reader URL can arrive before IndexedDB has restored its book list. Do
    // not replace it with the default sample book while that restoration runs.
    if (view === 'reader' && currentRoute.bookId && currentRoute.bookId !== selectedBook.id && !routedPlatformEditionId) return
    const nextRoute: AppRoute = { view, libraryMode, bookId: view === 'reader' && !routedPlatformEditionId ? selectedBook.id : undefined, platformEditionId: view === 'reader' ? routedPlatformEditionId : undefined }
    if (currentRoute.view !== nextRoute.view || currentRoute.libraryMode !== nextRoute.libraryMode || currentRoute.bookId !== nextRoute.bookId || currentRoute.platformEditionId !== nextRoute.platformEditionId) writeAppRoute(nextRoute)
  }, [libraryMode, routedPlatformEditionId, selectedBook.id, view])

  useEffect(() => { void getSession().then((next) => { setSession(next); if (next) void syncNow() }) }, [syncNow])
  useEffect(() => {
    const onOnline = () => { setIsOnline(true); void syncNow() }
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [syncNow])
  useEffect(() => {
    const onUpdateReady = () => setUpdateReady(true)
    window.addEventListener('worlibrary:update-ready', onUpdateReady)
    return () => window.removeEventListener('worlibrary:update-ready', onUpdateReady)
  }, [])
  useEffect(() => {
    if (view !== 'reader') return
    const timer = window.setInterval(scheduleSync, 5000)
    return () => window.clearInterval(timer)
  }, [view, scheduleSync])
  useEffect(() => {
    if (view !== 'reader' || !activeReadingBookKey) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      setReadingSeconds((current) => {
        const next = current + 1
        try { window.localStorage.setItem(READING_SECONDS_KEY, String(next)) } catch { /* Reading must work without storage. */ }
        return next
      })
      setReadingHistory((current) => {
        const today = dayKey(new Date())
        const next = { ...current, [today]: (current[today] ?? 0) + 1 }
        saveReadingHistory(next)
        return next
      })
      setBookReadingHistory((current) => {
        const next = { ...current, [activeReadingBookKey]: (current[activeReadingBookKey] ?? 0) + 1 }
        saveBookReadingHistory(next)
        return next
      })
      if (selectedPlatformBook?.platformEditionId) {
        setPlatformReadingMetadata((current) => {
          const next = {
            ...current,
            [activeReadingBookKey]: {
              editionId: selectedPlatformBook.platformEditionId!,
              title: selectedPlatformBook.title,
              author: selectedPlatformBook.author,
              lastReadAt: Date.now(),
            },
          }
          savePlatformReadingMetadata(next)
          return next
        })
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [activeReadingBookKey, selectedPlatformBook, view])
  useEffect(() => { if (view === 'profile') void listHighlights().then((items) => setHighlightCount(items.length)) }, [view])

  useEffect(() => {
    let cancelled = false
    const query = searchQuery.trim()
    if (!query) { setTextMatches({}); return }
    void searchBookTextIndex(query).then((matches) => {
      if (cancelled) return
      setTextMatches(Object.fromEntries(matches.map((match) => [match.bookId, match.snippet])))
    }).catch(() => { if (!cancelled) setTextMatches({}) })
    return () => { cancelled = true }
  }, [searchQuery])

  useEffect(() => { saveUiLocale(uiLocale) }, [uiLocale])
  useEffect(() => { saveReadingLanguage(language) }, [language])
  useEffect(() => { document.documentElement.lang = uiLocale; document.documentElement.dir = interfaceLocaleDirection(uiLocale) }, [uiLocale])
  useEffect(() => {
    if (!metadataDraft) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMetadataDraft(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [metadataDraft])
  useEffect(() => {
    if (!authDialogOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setAuthDialogOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [authDialogOpen])
  useEffect(() => {
    if (!bookContextMenu) return
    const dismissMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.book-context-menu')) return
      setBookContextMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setBookContextMenu(null) }
    window.addEventListener('pointerdown', dismissMenu)
    window.addEventListener('keydown', dismissOnEscape)
    return () => { window.removeEventListener('pointerdown', dismissMenu); window.removeEventListener('keydown', dismissOnEscape) }
  }, [bookContextMenu])


  const toast = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2800)
  }, [])

  async function runWorldSearch(query: string, language = worldLanguage, multilingual = multiLanguageOnly) {
    if (!query.trim()) return
    setWorldStatus('loading')
    setWorldHasSearched(true)
    try {
      setWorldResults(await searchWorldLibrary(query, { language: language || undefined, multiLanguageOnly: multilingual }))
      setWorldStatus('idle')
    } catch {
      setWorldStatus('error')
    }
  }

  async function submitWorldSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runWorldSearch(worldQuery)
  }

  function useWorldRecommendation(query: string, multilingual = false) {
    setWorldQuery(query)
    setMultiLanguageOnly(multilingual)
    void runWorldSearch(query, worldLanguage, multilingual)
  }

  function addWorldBook(book: WorldBook) {
    setSavedWorldBooks(saveWorldBook(book))
    toast(interpolate(ui.worldBookSaved, { title: book.title }))
  }

  function openWorldBook(book: WorldBook) {
    // A platform edition is a reviewed copy that WorLibrary is allowed to
    // resolve through its own policy endpoint. Source catalog labels alone
    // never grant this path.
    if (book.platformEditionId) {
      setRoutedPlatformEditionId(book.platformEditionId)
      setRoutedBookId(undefined)
      setView('reader')
      return
    }
    window.open(book.access.url || book.sourceUrl, '_blank', 'noopener,noreferrer')
  }

  function worldAccessPresentation(book: WorldBook) {
    switch (book.access.mode) {
      // This is still source-hosted reading. Until WorLibrary has a verified
      // entitlement and a licensed delivery path, no result can open as an
      // in-app reader or offer a file download.
      case 'licensed_full_text': return { label: ui.onlineReadable, action: book.platformEditionId ? ui.readInWorLibrary : ui.readOnlineAtSource }
      case 'preview': return { label: ui.previewAccess, action: ui.previewAtSource }
      case 'catalog_only': return { label: ui.catalogRecordOnly, action: ui.viewAtSource }
      default: return { label: ui.sourceReading, action: ui.openAtSource }
    }
  }

  function changeUiLocale(nextLocale: typeof uiLocale) {
    setUiLocale(nextLocale)
    const localeName = presentInterfaceLocales(nextLocale, false).find((item) => item.code === nextLocale)?.displayName ?? nextLocale
    toast(`${copy[nextLocale].uiLanguageSaved}${localeName}`)
  }

  function changeReadingLanguage(nextLanguage: ReadingLanguage) {
    setLanguage(nextLanguage)
    toast(`${ui.readingLanguageSaved}${displayReadingLanguage(nextLanguage, uiLocale)}`)
  }

  function importBooks() { fileInput.current?.click() }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (files.length === 0) return
    toast('正在保存到本地设备…')
    try {
      const saved = await Promise.all(files.map((file, index) => saveBook(file, index)))
      setBooks((current) => [...current, ...saved])
      setEditions(await listEditions())
      scheduleSync()
      toast(`已保存 ${saved.length} 本书 · 文件不会上传`)
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败，请重试')
    }
  }

  async function linkCurrentEdition() {
    const candidates = books.filter((book) => book.storage && book.fileName && book.id !== selectedBook.id)
    if (candidates.length === 0) { toast('请先导入另一本译本'); return }
    const choice = window.prompt(`输入要关联的书籍编号：\n${candidates.map((book, index) => `${index + 1}. ${book.title}`).join('\n')}`, '1')
    const target = candidates[Number(choice) - 1]
    if (!target) { toast('未选择有效译本'); return }
    try {
      const result = await linkBookEditions(selectedBook.id, target.id)
      setBooks((current) => current.map((book) => book.id === selectedBook.id || book.id === target.id ? { ...book, workId: result.work.id } : book))
      setEditions(await listEditions())
      setAlignments(await listAlignments())
      toast(`已关联《${selectedBook.title}》与《${target.title}》`)
    } catch (error) { toast(error instanceof Error ? error.message : '关联译本失败') }
  }

  function updateEditionProgress(bookId: string, progress: number, location: string) {
    const lastReadAt = Date.now()
    setSelectedBook((current) => current.id === bookId ? { ...current, progress, location, lastReadAt } : current)
    setBooks((current) => current.map((item) => item.id === bookId ? { ...item, progress, location, lastReadAt } : item))
    const edition = editions.find((item) => item.bookId === bookId)
    if (edition) { setEditions((current) => current.map((item) => item.id === edition.id ? { ...item, progress, location } : item)); void saveEditionProgress(edition.id, location, progress) }
  }

  async function removeBook(book: DisplayBook) {
    if (!book.storage || !book.fileName) return
    if (!window.confirm(`确定从本地书库删除《${book.title}》吗？`)) return
    await deleteBook(book as StoredBook)
    setBooks((current) => current.filter((item) => item.id !== book.id))
    if (selectedBook.id === book.id) setSelectedBook(sampleBooks[0])
    toast('书籍、阅读进度和摘录已从本地删除')
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!metadataDraft) return
    const form = new FormData(event.currentTarget)
    try {
      const updated = await updateBookMetadata(metadataDraft.id, { title: String(form.get('title') ?? ''), author: String(form.get('author') ?? '') })
      setBooks((current) => current.map((book) => book.id === updated.id ? { ...book, title: updated.title, author: updated.author } : book))
      setSelectedBook((current) => current.id === updated.id ? { ...current, title: updated.title, author: updated.author } : current)
      setEditions(await listEditions())
      setMetadataDraft(null)
      scheduleSync()
      toast('书籍信息已在本地更新')
    } catch (error) { toast(error instanceof Error ? error.message : '书籍信息保存失败，请重试') }
  }

  async function refreshCover(book: DisplayBook) {
    if (!book.storage || !book.fileName || refreshingCoverId) return
    setRefreshingCoverId(book.id)
    try {
      const updated = await refreshBookCover(book.id)
      setBooks((current) => current.map((item) => item.id === updated.id ? { ...item, coverImage: updated.coverImage } : item))
      setSelectedBook((current) => current.id === updated.id ? { ...current, coverImage: updated.coverImage } : current)
      toast('已从 EPUB 重新读取原书封面')
    } catch (error) { toast(error instanceof Error ? error.message : '封面读取失败，请稍后重试') } finally { setRefreshingCoverId(null) }
  }

  function selectCustomCover(book: DisplayBook) {
    setCoverTargetId(book.id)
    coverInput.current?.click()
  }

  async function handleCoverFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    const targetId = coverTargetId
    setCoverTargetId(null)
    if (!file || !targetId) return
    try {
      const updated = await updateBookCover(targetId, file)
      setBooks((current) => current.map((item) => item.id === updated.id ? { ...item, coverImage: updated.coverImage } : item))
      setSelectedBook((current) => current.id === updated.id ? { ...current, coverImage: updated.coverImage } : current)
      toast('已设置本地书籍封面')
    } catch (error) { toast(error instanceof Error ? error.message : '封面保存失败，请稍后重试') }
  }

  const selectedEdition = editions.find((edition) => edition.bookId === selectedBook.id)
  // A comparison must always be between two different imported files. Filtering
  // by bookId (not only editionId) keeps a stale/migrated duplicate edition from
  // rendering the current book in both panes.
  const selectedRelatedEdition = selectedEdition
    ? editions.find((edition) => edition.workId === selectedEdition.workId && edition.bookId !== selectedBook.id)
    : undefined
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const editionCounts = editions.reduce<Record<string, number>>((counts, edition) => { counts[edition.workId] = (counts[edition.workId] ?? 0) + 1; return counts }, {})
  const filteredBooks = books
    .filter((book) => !normalizedSearch || [book.title, book.author, book.language, book.fileName ?? '', book.fileType ?? ''].some((field) => field.toLowerCase().includes(normalizedSearch)) || Boolean(textMatches[book.id]))
    .filter((book) => libraryFilter === 'all' || (libraryFilter === 'reading' ? book.progress > 0 && book.progress < 100 : Boolean(book.workId && editionCounts[book.workId] > 1)))
    .sort((left, right) => sortNewest ? (right.createdAt ?? 0) - (left.createdAt ?? 0) : left.title.localeCompare(right.title))
  const readingBooks = books.filter((book) => book.progress > 0 && book.progress < 100)
  const completedBooks = books.filter((book) => book.progress >= 100)
  const recentReadingItems = [
    ...books.filter((book) => Boolean(book.lastReadAt)).map((book) => ({ kind: 'local' as const, id: book.id, title: book.title, author: book.author, progress: book.progress, lastReadAt: book.lastReadAt!, readingKey: book.id })),
    ...savedWorldBooks.flatMap((book) => {
      if (!book.platformEditionId) return []
      const readingKey = `platform:${book.platformEditionId}`
      const metadata = platformReadingMetadata[readingKey]
      return metadata ? [{ kind: 'platform' as const, id: book.platformEditionId, title: book.title, author: book.author, lastReadAt: metadata.lastReadAt, readingKey }] : []
    }),
  ].sort((left, right) => right.lastReadAt - left.lastReadAt).slice(0, 3)
  const weeklyReading = recentReadingDays(readingHistory, uiLocale)
  const weeklyReadingMax = Math.max(1, ...weeklyReading.map((day) => day.seconds))

  return (
    <div className="app-shell">
      <aside className="rail">
        <button className="wordmark" onClick={() => setView('library')} aria-label={ui.library}>WL</button>
        <nav aria-label={uiLocale === 'en' ? 'Main navigation' : '主导航'}>
          <button className={view === 'library' ? 'nav-item active' : 'nav-item'} onClick={() => setView('library')} aria-current={view === 'library' ? 'page' : undefined}>{ui.library}</button>
          <button className={view === 'highlights' ? 'nav-item active' : 'nav-item'} onClick={() => setView('highlights')} aria-current={view === 'highlights' ? 'page' : undefined}>{ui.highlights}</button>
          <button className={view === 'profile' ? 'nav-item active' : 'nav-item'} onClick={() => setView('profile')} aria-current={view === 'profile' ? 'page' : undefined}>{ui.profile}</button>
          <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')} aria-current={view === 'settings' ? 'page' : undefined}>{ui.settings}</button>
        </nav>
        <div className={`rail-foot ${isOnline ? '' : 'is-offline'}`} title={isOnline ? ui.offlineReady : ui.offlineNow}><i />{isOnline ? ui.offlineReady : ui.offlineNow}</div>
      </aside>

      <main className="content">
        {!isOnline && <div className="offline-banner" role="status">{ui.offlineBanner}</div>}
        <header className="topbar">
          <div className="top-actions">
            <ReadingLanguagePicker value={language} onChange={changeReadingLanguage} locale={uiLocale} label={ui.readingLanguage} searchLabel={ui.searchReadingLanguage} searchPlaceholder={ui.searchReadingLanguagePlaceholder} className="header-reading-language-picker" compact />
            <button className="account-button" onClick={() => { if (session) setView('settings'); else setAuthDialogOpen(true) }} aria-label={`${ui.account}: ${account.label}`} title={ui.account}><span aria-hidden="true">{account.initials}</span><strong>{account.label}</strong></button>
          </div>
        </header>

        {view === 'library' && <section className={`library-view ${libraryMode === 'world' ? 'is-world-library' : ''}`}>
          {libraryMode === 'mine' && <div className="hero"><div><h1>{ui.hero}<em>{ui.heroEmphasis}</em></h1></div><p className="hero-copy">{ui.heroCopy}</p></div>}
          <div className="library-mode-switch" role="tablist" aria-label={ui.libraryMode}><button role="tab" aria-selected={libraryMode === 'mine'} className={libraryMode === 'mine' ? 'active' : ''} onClick={() => setLibraryMode('mine')}>{ui.myLibrary}</button><button role="tab" aria-selected={libraryMode === 'world'} className={libraryMode === 'world' ? 'active' : ''} onClick={() => setLibraryMode('world')}>{ui.worldLibrary}</button></div>
          {libraryMode === 'mine' ? <>
            <div className="library-search"><span aria-hidden="true">⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={ui.searchPlaceholder} aria-label={ui.searchLibrary} />{searchQuery && <button onClick={() => setSearchQuery('')} aria-label={ui.clearSearch}>×</button>}</div>
            <div className="shelf-toolbar"><div className="filter-row"><button className={libraryFilter === 'all' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('all')} aria-pressed={libraryFilter === 'all'}>{ui.all} <b>{String(books.length).padStart(2, '0')}</b></button><button className={libraryFilter === 'reading' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('reading')} aria-pressed={libraryFilter === 'reading'}>{ui.reading} <b>{String(books.filter((book) => book.progress > 0 && book.progress < 100).length).padStart(2, '0')}</b></button><button className={libraryFilter === 'multi' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('multi')} aria-pressed={libraryFilter === 'multi'}>{ui.editions} <b>{String(books.filter((book) => Boolean(book.workId && editionCounts[book.workId] > 1)).length).padStart(2, '0')}</b></button></div><button className="sort-button" onClick={() => setSortNewest((current) => !current)} aria-pressed={!sortNewest}>{sortNewest ? ui.recent : ui.alphabetical}</button></div>
            {normalizedSearch && <p className="library-search-result" role="status">{interpolate(ui.booksMatched, { count: filteredBooks.length })}</p>}
            <div className="shelf">
              {filteredBooks.map((book) => <button className="book-card" key={book.id} onClick={() => { setSelectedBook(book); setView('reader') }} onContextMenu={(event) => { if (!book.storage || !book.fileName) return; event.preventDefault(); setBookContextMenu({ book, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 210)) }) }}><div className={`cover ${book.cover}`}>{book.coverImage ? <img className="cover-image" src={book.coverImage} alt={`${book.title} ${ui.cover}`} /> : <><span>{book.id === 'invisible' ? <>THE<br />INVISIBLE<br />LIFE</> : book.id === 'stranger' ? "L'ÉTRANGER" : book.id === 'kafka' ? <>变<br />形<br />记</> : book.title.slice(0, 18)}</span><small>{book.author}</small></>}</div><div className="book-info"><p className="book-lang">{ui.localImport} · {book.language}</p><h2>{book.title}</h2><p>{book.author}</p>{textMatches[book.id] && <p className="book-search-snippet" title={textMatches[book.id]}>{ui.textMatch}{textMatches[book.id]}</p>}<div className="progress"><i style={{ width: `${book.progress}%` }} /></div><small>{book.progress}% · {ui.offlineReadable}</small></div></button>)}
              {books.length === 0 && savedWorldBooks.length === 0 && <div className="library-no-results">{ui.emptyShelf}</div>}
              {books.length > 0 && filteredBooks.length === 0 && <div className="library-no-results">{ui.noMatches}</div>}
              <button className="import-card" onClick={importBooks}><span>＋</span><strong>{ui.importMine}</strong><small>EPUB · PDF</small></button>
            </div>
            {savedWorldBooks.length > 0 && <section className="saved-world-shelf" aria-labelledby="saved-online-books"><div><h2 id="saved-online-books">{ui.savedOnlineBooks}</h2></div><div className="world-results">{savedWorldBooks.map((book) => { const access = worldAccessPresentation(book); return <article className="world-book-card" key={worldBookIdentity(book)}><div className="world-cover">{book.coverUrl ? <img src={book.coverUrl} referrerPolicy="no-referrer" alt={`${book.title} ${ui.cover}`} /> : <span>{book.title.slice(0, 2)}</span>}</div><div><span className="source-badge">{ui.onlineSaved}</span><h3>{book.title}</h3><p>{book.author || ui.unknownAuthor}{book.year ? ` · ${book.year}` : ''}</p><small>{ui.onlineSource} {book.sourceName} · <span className="world-access-badge">{access.label}</span></small><button onClick={() => openWorldBook(book)}>{access.action}</button></div></article> })}</div></section>}
          </> : <section className="world-library-view" aria-label={ui.worldLibrary}><section className="world-recommendations" aria-labelledby="world-recommendations-title"><div><h3 id="world-recommendations-title">{ui.recommendedReading}</h3><p>{ui.recommendedReadingCopy}</p></div><div className="recommendation-chips"><button onClick={() => useWorldRecommendation('world classics', true)}>{ui.recommendationClassics}</button><button onClick={() => useWorldRecommendation('literature', true)}>{ui.recommendationTranslation}</button><button onClick={() => useWorldRecommendation('public domain')}>{ui.recommendationPublicDomain}</button></div></section><form className="world-search-form" onSubmit={submitWorldSearch}><input value={worldQuery} onChange={(event) => setWorldQuery(event.target.value)} placeholder={ui.searchWorldPlaceholder} aria-label={ui.searchWorld} /><button type="submit">{ui.searchWorld}</button></form><div className="world-filters" aria-label={ui.worldFilters}><WorldLanguagePicker value={worldLanguage} onChange={setWorldLanguage} locale={uiLocale} label={ui.catalogLanguage} allLanguagesLabel={ui.allLanguages} searchLabel={ui.searchCatalogLanguage} searchPlaceholder={ui.searchCatalogLanguagePlaceholder} /><label className="world-multilingual-filter"><input type="checkbox" checked={multiLanguageOnly} onChange={(event) => setMultiLanguageOnly(event.target.checked)} /><span>{ui.multiLanguageOnly}</span><small>{ui.multiLanguageHint}</small></label></div><p className="world-rights-notice">{ui.worldRightsNotice}</p>{worldStatus === 'loading' && <p role="status">{ui.worldLoading}</p>}{worldStatus === 'error' && <p role="alert">{ui.worldUnavailable}</p>}{worldStatus === 'idle' && worldHasSearched && worldResults.length === 0 && <p role="status">{ui.worldEmpty}</p>}<div className="world-results">{worldResults.map((book) => { const saved = savedWorldBooks.some((item) => worldBookIdentity(item) === worldBookIdentity(book)); const access = worldAccessPresentation(book); return <article className="world-book-card" data-source-id={book.sourceId} key={worldBookIdentity(book)}><div className="world-cover">{book.coverUrl ? <img src={book.coverUrl} referrerPolicy="no-referrer" alt={`${book.title} ${ui.cover}`} /> : <span>{book.title.slice(0, 2)}</span>}</div><div><span className="source-badge">{ui.onlineSource} {book.sourceName}</span><h3>{book.title}</h3><p>{book.author || ui.unknownAuthor}{book.year ? ` · ${book.year}` : ''}</p><small><span className="world-access-badge">{access.label}</span>{book.languages.length ? ` · ${interpolate(ui.languagesAvailable, { count: book.languages.length })}` : ''}{book.editionCount ? ` · ${interpolate(ui.editionsAvailable, { count: book.editionCount })}` : ''}</small><div className="world-card-actions"><button onClick={() => addWorldBook(book)} disabled={saved}>{saved ? ui.savedToMyLibrary : ui.addToMyLibrary}</button><button className="text-action" onClick={() => openWorldBook(book)}>{access.action}</button></div></div></article> })}</div></section>}
        </section>}

        {view === 'highlights' && <HighlightsView uiLocale={uiLocale} books={books.filter((book): book is StoredBook => Boolean(book.storage && book.fileName))} onNotice={toast} onChanged={() => { scheduleSync(); void listHighlights().then((items) => setHighlightCount(items.length)) }} onDeleted={() => { void listHighlights().then((items) => setHighlightCount(items.length)) }} onOpenHighlight={(highlight: Highlight) => {
          const book = books.find((item) => item.id === highlight.bookId)
          if (!book?.storage || !book.fileName) {
            toast('找不到这本本地书籍，请重新导入')
            return
          }
          setSelectedBook({ ...book, location: highlight.location })
          setView('reader')
        }} />}

        {view === 'profile' && <section className="profile-view">
          <div className="profile-heading"><div><h1>{ui.profileTitle}</h1><p>{ui.profileCopy}</p></div><button className="profile-library-link" onClick={() => setView('library')}>{ui.library} →</button></div>
          <div className="profile-stats" aria-label={ui.profileTitle}>
            <article><span>{ui.readingTime}</span><strong>{formatReadingTime(readingSeconds, uiLocale)}</strong></article><article><span>{ui.booksOwned}</span><strong>{books.length}</strong></article><article><span>{ui.booksInProgress}</span><strong>{readingBooks.length}</strong></article><article><span>{ui.highlightsSaved}</span><strong>{highlightCount}</strong></article>
          </div>
          <section className="profile-weekly" aria-labelledby="profile-weekly-title"><div><h2 id="profile-weekly-title">{ui.weeklyReadingTitle}</h2><p>{ui.weeklyReadingCopy}</p></div><div className="reading-bars" aria-label={ui.weeklyReading}>{weeklyReading.map((day) => <div className="reading-bar" key={day.key}><span title={interpolate(ui.dayReading, { day: day.label, time: formatReadingTime(day.seconds, uiLocale) })} style={{ height: `${Math.round((day.seconds / weeklyReadingMax) * 100)}%` }} /><small>{day.label}</small></div>)}</div></section>
          <section className="profile-recent" aria-labelledby="profile-recent-title"><div><h2 id="profile-recent-title">{ui.recentReading}</h2><p>{ui.recentReadingCopy}</p></div>{recentReadingItems.length > 0 ? <div className="profile-book-list">{recentReadingItems.map((item) => <button key={`${item.kind}:${item.id}`} onClick={() => { if (item.kind === 'platform') { setRoutedPlatformEditionId(item.id); setRoutedBookId(undefined); setView('reader') } else { const book = books.find((candidate) => candidate.id === item.id); if (book) { setSelectedBook(book); setRoutedBookId(book.id); setRoutedPlatformEditionId(undefined); setView('reader') } } }}><span>{item.title}</span><small>{item.author} · {item.kind === 'local' ? `${item.progress}% · ` : ''}{formatLastRead(item.lastReadAt, uiLocale, ui.notReadYet)}</small><em>{interpolate(ui.bookReadingTime, { time: formatReadingTime(bookReadingHistory[item.readingKey] ?? 0, uiLocale) })}</em>{item.kind === 'local' && <i><b style={{ width: `${item.progress}%` }} /></i>}</button>)}</div> : <div className="profile-empty"><strong>{ui.profileEmpty}</strong><p>{ui.profileEmptyCopy}</p><button onClick={() => setView('library')}>{ui.importMine}</button></div>}</section>
          <p className="profile-footnote">{completedBooks.length > 0 ? `${ui.booksCompleted}：${completedBooks.length}` : ui.profileLocalOnly}</p>
        </section>}

        {view === 'reader' && (selectedPlatformBook ? <Suspense fallback={<section className="reader-view" role="status">正在打开平台阅读器…</section>}><PlatformReader editionId={selectedPlatformBook.platformEditionId!} title={selectedPlatformBook.title} author={selectedPlatformBook.author} uiLocale={uiLocale} accessToken={session?.accessToken} onBack={() => { setRoutedPlatformEditionId(undefined); setView('library') }} /></Suspense> : <section className="reader-view">
          <div className="reader-header"><button className="back-button" onClick={() => { setReaderLayoutOpen(false); setView('library') }}>← <span>{ui.backToLibrary}</span></button><div className="reader-title"><strong>{selectedBook.title}</strong><small>{selectedBook.author}{selectedBook.fileName ? ` · ${ui.localReading}` : ''}</small></div><div className="reader-tools"><button onClick={importBooks}>{ui.importBook}</button><button onClick={() => { if (!selectedRelatedEdition) { toast(uiLocale === 'en' ? 'Import and link another edition before comparing.' : '请先导入并关联另一个译本，再进行对照阅读'); return } setCompare(!compare) }}>{compare ? ui.exitCompare : ui.compare}</button><button onClick={() => setView('settings')}>{language.slice(0, 1)}</button><button onClick={() => setReaderLayoutOpen((current) => !current)} aria-expanded={readerLayoutOpen} aria-controls="reader-layout-panel">Aa</button></div></div>
          {readerLayoutOpen && <aside id="reader-layout-panel" className="reader-layout-panel" role="dialog" aria-label={ui.readerLayout}><div><h2>{ui.readerLayout}</h2></div><div className="reader-layout-row"><span>{ui.fontSize}</span><div><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label={ui.decreaseFont}>A−</button><strong>{Math.round(readerPreferences.fontScale * 100)}%</strong><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label={ui.increaseFont}>A＋</button></div></div><div className="reader-layout-row"><span>{ui.readerTheme}</span><div className="reader-theme-choices"><button className={readerPreferences.theme === 'paper' ? 'active' : ''} aria-pressed={readerPreferences.theme === 'paper'} onClick={() => setReaderPreferences((current) => ({ ...current, theme: 'paper' }))}>{ui.paperTheme}</button><button className={readerPreferences.theme === 'sepia' ? 'active' : ''} aria-pressed={readerPreferences.theme === 'sepia'} onClick={() => setReaderPreferences((current) => ({ ...current, theme: 'sepia' }))}>{ui.sepiaTheme}</button><button className={readerPreferences.theme === 'night' ? 'active' : ''} aria-pressed={readerPreferences.theme === 'night'} onClick={() => setReaderPreferences((current) => ({ ...current, theme: 'night' }))}>{ui.nightTheme}</button></div></div></aside>}
          {(() => {
            const currentEdition = selectedEdition
            const relatedEdition = selectedRelatedEdition
            const relatedBook = relatedEdition ? books.find((book) => book.id === relatedEdition.bookId) : undefined
            const renderReader = (book: DisplayBook) => {
              if (book.fileName?.toLowerCase().endsWith('.epub') && book.storage) return <EpubReader key={`epub-${book.id}`} book={book as StoredBook} targetLanguage={language} uiLocale={uiLocale} preferences={readerPreferences} onPreferencesChange={setReaderPreferences} onNotice={toast} onProgress={(progress, location) => updateEditionProgress(book.id, progress, location)} />
              if (book.fileName?.toLowerCase().endsWith('.pdf') && book.storage) return <PdfReader key={`pdf-${book.id}`} book={book as StoredBook} targetLanguage={language} uiLocale={uiLocale} preferences={readerPreferences} onPreferencesChange={setReaderPreferences} onNotice={toast} onProgress={(progress, location) => updateEditionProgress(book.id, progress, location)} />
              // Imported books are the only readable source. Never fall back to
              // the old showcase passage, especially in a comparison pane.
              return <div className="reader-source-unavailable" role="status">{ui.localFileMissing}</div>
            }
            if (!currentEdition || !relatedEdition || !relatedBook) return <><div className="edition-strip"><span>{ui.singleEdition}</span><button className="link-edition" onClick={() => { void linkCurrentEdition() }}>{ui.linkEdition}</button></div>{renderReader(selectedBook)}</>
            const comparisonAlignment = alignments.find((item) => item.workId === currentEdition.workId && ((item.leftEditionId === currentEdition.id && item.rightEditionId === relatedEdition.id) || (item.rightEditionId === currentEdition.id && item.leftEditionId === relatedEdition.id)))
            return <><div className="edition-strip"><span>{ui.nowReading}</span><button className="edition active">{currentEdition.language} <strong>{currentEdition.label}</strong></button><button className="edition" onClick={() => { setSelectedBook(relatedBook); setCompare(false) }}>{relatedEdition.language} <strong>{relatedEdition.label}</strong></button><button className="link-edition" onClick={() => { void linkCurrentEdition() }}>{ui.linkEdition}</button></div>{compare ? <EditionComparisonReader left={currentEdition} right={relatedEdition} alignment={comparisonAlignment} leftContent={renderReader(selectedBook)} rightContent={renderReader(relatedBook)} onSwitch={(edition) => { const next = books.find((book) => book.id === edition.bookId); if (next) { setSelectedBook(next); setCompare(false) } }} /> : renderReader(selectedBook)}</>
          })()}
          {assistantOpen && <aside className="ai-panel"><div className="panel-top"><span>✦</span><strong>阅读助手</strong><button onClick={() => setAssistantOpen(false)}>×</button></div><p className="ai-label">ENGLISH → {language}</p><blockquote>“But freedom, she would learn, is a word with a thousand meanings, and some of them are cages.”</blockquote><section><h3>翻译</h3><p>但她后来会明白，自由这个词有一千种含义，其中有些，恰恰是牢笼。</p></section><section><h3>通俗解释</h3><p>自由并不总是轻松美好的。有时我们以为自己在选择，却被选择的代价、规则或恐惧困住了。</p></section><small>AI 解释仅供学习参考 · 本地 Demo</small></aside>}
          <div className="reader-bottom"><span>{selectedBook.progress}%</span><div><i style={{ width: `${selectedBook.progress}%` }} /></div><span>{selectedBook.fileName ? ui.savedLocally : '4 / 11'}</span><button onClick={() => toast(uiLocale === 'en' ? 'OCR is available from the PDF reader.' : 'OCR 是下一步真实服务接入点')}>{ui.scanPage}</button></div>
        </section>)}

        {view === 'settings' && <section className="settings-view"><div className="settings-wrap"><h1>{ui.settingsTitle}</h1><section className="language-section" aria-labelledby="ui-language-title"><div className="language-heading"><h2 id="ui-language-title">{ui.uiLanguageTitle}</h2><p>{ui.uiLanguageCopy}</p></div><InterfaceLanguagePicker value={uiLocale} onChange={changeUiLocale} locale={uiLocale} label={ui.interfaceLanguagePickerLabel} searchLabel={ui.searchInterfaceLanguage} searchPlaceholder={ui.searchInterfaceLanguagePlaceholder} availableLabel={ui.interfaceLanguageAvailable} plannedLabel={ui.interfaceLanguagePlanned} plannedCopy={ui.interfaceLanguagePlannedCopy} emptyLabel={ui.interfaceLanguageEmpty} /></section><section className="language-section" aria-labelledby="reading-language-title"><div className="language-heading"><h2 id="reading-language-title">{ui.readingLanguageTitle}</h2><p>{ui.readingLanguageCopy}</p></div><ReadingLanguagePicker value={language} onChange={changeReadingLanguage} locale={uiLocale} label={ui.readingLanguagePickerLabel} searchLabel={ui.searchReadingLanguage} searchPlaceholder={ui.searchReadingLanguagePlaceholder} /></section><div className="settings-note"><span>◎</span><p><strong>{ui.privacyTitle}</strong><br />{ui.privacyCopy}</p></div></div></section>}
      </main>
      {bookContextMenu && <div className="book-context-menu" role="menu" aria-label={ui.localBooks} style={{ left: bookContextMenu.x, top: bookContextMenu.y }}><strong>{bookContextMenu.book.title}</strong>{bookContextMenu.book.fileName?.toLowerCase().endsWith('.epub') && <button role="menuitem" onClick={() => { void refreshCover(bookContextMenu.book); setBookContextMenu(null) }} disabled={refreshingCoverId === bookContextMenu.book.id}>{refreshingCoverId === bookContextMenu.book.id ? ui.readingCover : ui.manageCover}</button>}<button role="menuitem" onClick={() => { selectCustomCover(bookContextMenu.book); setBookContextMenu(null) }}>{ui.uploadCover}</button><button role="menuitem" onClick={() => { setMetadataDraft(bookContextMenu.book as StoredBook); setBookContextMenu(null) }}>{ui.editInfo}</button><button className="danger" role="menuitem" onClick={() => { void removeBook(bookContextMenu.book); setBookContextMenu(null) }}>{ui.delete}</button></div>}
      {metadataDraft && <div className="metadata-dialog-backdrop"><form className="metadata-dialog" onSubmit={(event) => { void saveMetadata(event) }} role="dialog" aria-modal="true" aria-labelledby="metadata-dialog-title"><div><h2 id="metadata-dialog-title">校正书籍信息</h2><p>只修改书架显示和本地阅读数据，不会改动或上传原始文件。</p></div><label>书名<input name="title" defaultValue={metadataDraft.title} autoFocus /></label><label>作者<input name="author" defaultValue={metadataDraft.author} /></label><div className="metadata-dialog-actions"><button type="button" onClick={() => setMetadataDraft(null)}>取消</button><button type="submit">保存信息</button></div></form></div>}
      {authDialogOpen && <div className="auth-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setAuthDialogOpen(false) }}><section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title"><div className="auth-dialog-heading"><div><h2 id="auth-dialog-title">{ui.accountSync}</h2></div><button type="button" onClick={() => setAuthDialogOpen(false)} aria-label={ui.cancel} title={ui.cancel}>×</button></div><AuthPanel uiLocale={uiLocale} onNotice={toast} onSessionChange={handleAuthSessionChange} autoFocusEmail /></section></div>}
      {view === 'settings' && <AuthPanel uiLocale={uiLocale} onNotice={toast} onSessionChange={handleAuthSessionChange} />}
      {notice && <div className="toast" role="status">{notice}</div>}
      {updateReady && <div className="update-toast" role="status">{ui.updateReady}<button onClick={() => window.dispatchEvent(new Event('worlibrary:activate-update'))}>{ui.updateNow}</button></div>}
      <DataTransfer uiLocale={uiLocale} onNotice={toast} onImported={() => { void listBooks().then((savedBooks) => setBooks(savedBooks)) }} />
      <input ref={fileInput} onChange={handleFiles} type="file" hidden accept=".epub,.pdf,.mobi,.cbz" multiple />
      <input ref={coverInput} onChange={(event) => { void handleCoverFile(event) }} type="file" hidden accept="image/*" />
    </div>
  )
}

export default App
