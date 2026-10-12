import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
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
import { createRemoteClient } from './lib/remote'
import { createIndexedDbSyncAdapter, deleteRemoteHighlight, enqueueSync, flushQueuedSync } from './lib/sync'
import { copy, interpolate, loadReadingLanguage, loadUiLocale, READING_LANGUAGES, saveReadingLanguage, saveUiLocale, UI_LOCALES, type ReadingLanguage } from './lib/i18n'
import { clampFontScale, loadReaderPreferences, type ReaderPreferences } from './lib/reader'

type View = 'library' | 'reader' | 'highlights' | 'profile' | 'settings'
type DisplayBook = Pick<StoredBook, 'id' | 'title' | 'author' | 'language' | 'progress' | 'cover'> & Partial<Pick<StoredBook, 'fileName' | 'fileType' | 'storage' | 'createdAt' | 'lastReadAt' | 'location' | 'workId' | 'coverImage'>>

const sampleBooks: DisplayBook[] = [
  { id: 'invisible', title: 'The Invisible Life of Addie LaRue', author: 'V. E. Schwab', language: 'English · 3 versions', progress: 38, cover: 'ink' },
  { id: 'stranger', title: "L'Étranger", author: 'Albert Camus', language: 'Français · 2 versions', progress: 72, cover: 'sun' },
  { id: 'kafka', title: '变形记', author: 'Franz Kafka', language: '中文 · 2 versions', progress: 14, cover: 'red' },
]

const READING_SECONDS_KEY = 'worlibrary.reading-seconds'
const READING_HISTORY_KEY = 'worlibrary.reading-history'
const READING_BY_BOOK_KEY = 'worlibrary.reading-by-book'

type ReadingHistory = Record<string, number>

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
  const [books, setBooks] = useState<DisplayBook[]>([])
  const [view, setView] = useState<View>('library')
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
  const [metadataDraft, setMetadataDraft] = useState<StoredBook | null>(null)
  const [refreshingCoverId, setRefreshingCoverId] = useState<string | null>(null)
  const [coverTargetId, setCoverTargetId] = useState<string | null>(null)
  const [highlightCount, setHighlightCount] = useState(0)
  const [readingSeconds, setReadingSeconds] = useState(loadReadingSeconds)
  const [readingHistory, setReadingHistory] = useState<ReadingHistory>(loadReadingHistory)
  const [bookReadingHistory, setBookReadingHistory] = useState<ReadingHistory>(loadBookReadingHistory)
  const fileInput = useRef<HTMLInputElement>(null)
  const coverInput = useRef<HTMLInputElement>(null)
  const syncTimer = useRef<number | undefined>(undefined)
  const ui = copy[uiLocale]
  const account = accountIdentity(session, ui.signIn, ui.guestAccount)

  const syncNow = useCallback(async () => {
    if (!session) return
    try {
      const result = await flushQueuedSync(createRemoteClient(session), createIndexedDbSyncAdapter())
      if (result.uploaded || result.downloaded) toast(`已同步 ${result.uploaded + result.downloaded} 项阅读数据`)
    } catch { toast('同步失败，网络恢复后会自动重试') }
  }, [session])

  const scheduleSync = useCallback(() => {
    enqueueSync()
    if (syncTimer.current) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => { void syncNow() }, 1200)
  }, [syncNow])

  useEffect(() => {
    void Promise.all([listBooks(), listEditions(), listAlignments(), listHighlights()]).then(([savedBooks, savedEditions, savedAlignments, savedHighlights]) => { setBooks(savedBooks); setEditions(savedEditions); setAlignments(savedAlignments); setHighlightCount(savedHighlights.length) })
  }, [])

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
    if (view !== 'reader') return
    const timer = window.setInterval(() => {
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
        const next = { ...current, [selectedBook.id]: (current[selectedBook.id] ?? 0) + 1 }
        saveBookReadingHistory(next)
        return next
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [selectedBook.id, view])
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
  useEffect(() => { document.documentElement.lang = uiLocale }, [uiLocale])
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


  const toast = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2800)
  }, [])

  function changeUiLocale(nextLocale: typeof uiLocale) {
    setUiLocale(nextLocale)
    toast(`${copy[nextLocale].uiLanguageSaved}${UI_LOCALES.find((item) => item.value === nextLocale)?.label ?? nextLocale}`)
  }

  function changeReadingLanguage(nextLanguage: ReadingLanguage) {
    setLanguage(nextLanguage)
    toast(`${ui.readingLanguageSaved}${nextLanguage}`)
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
  const recentBooks = books.filter((book) => Boolean(book.lastReadAt)).sort((left, right) => (right.lastReadAt ?? 0) - (left.lastReadAt ?? 0)).slice(0, 3)
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
          <p className="eyebrow">PERSONAL WORLD LIBRARY / 001</p>
          <div className="top-actions">
            <button className="text-button" onClick={() => setView('settings')}>{ui.readingLanguage}：<strong>{language}</strong>⌄</button>
            <button className="round-button" onClick={importBooks} aria-label={ui.importBook}>＋</button>
            <button className="account-button" onClick={() => setView('settings')} aria-label={`${ui.account}: ${account.label}`} title={ui.account}><span aria-hidden="true">{account.initials}</span><strong>{account.label}</strong></button>
          </div>
        </header>

        {view === 'library' && <section className="library-view">
          <div className="hero"><div><p className="eyebrow">{ui.shelf}</p><h1>{ui.hero}<em>{ui.heroEmphasis}</em></h1></div><p className="hero-copy">{ui.heroCopy}</p></div>
          <div className="library-search"><span aria-hidden="true">⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={ui.searchPlaceholder} aria-label={ui.searchLibrary} />{searchQuery && <button onClick={() => setSearchQuery('')} aria-label={ui.clearSearch}>×</button>}</div>
          <div className="shelf-toolbar"><div className="filter-row"><button className={libraryFilter === 'all' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('all')} aria-pressed={libraryFilter === 'all'}>{ui.all} <b>{String(books.length).padStart(2, '0')}</b></button><button className={libraryFilter === 'reading' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('reading')} aria-pressed={libraryFilter === 'reading'}>{ui.reading} <b>{String(books.filter((book) => book.progress > 0 && book.progress < 100).length).padStart(2, '0')}</b></button><button className={libraryFilter === 'multi' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('multi')} aria-pressed={libraryFilter === 'multi'}>{ui.editions} <b>{String(books.filter((book) => Boolean(book.workId && editionCounts[book.workId] > 1)).length).padStart(2, '0')}</b></button></div><button className="sort-button" onClick={() => setSortNewest((current) => !current)} aria-pressed={!sortNewest}>{sortNewest ? ui.recent : ui.alphabetical}</button></div>
          {normalizedSearch && <p className="library-search-result" role="status">{interpolate(ui.booksMatched, { count: filteredBooks.length })}</p>}
          <div className="shelf">
            {filteredBooks.map((book) => <button className="book-card" key={book.id} onClick={() => { setSelectedBook(book); setView('reader') }}><div className={`cover ${book.cover}`}>{book.coverImage ? <img className="cover-image" src={book.coverImage} alt={`${book.title} ${ui.cover}`} /> : <><span>{book.id === 'invisible' ? <>THE<br />INVISIBLE<br />LIFE</> : book.id === 'stranger' ? "L'ÉTRANGER" : book.id === 'kafka' ? <>变<br />形<br />记</> : book.title.slice(0, 18)}</span><small>{book.author}</small></>}</div><div className="book-info"><p className="book-lang">{book.language}</p><h2>{book.title}</h2><p>{book.author}</p>{textMatches[book.id] && <p className="book-search-snippet" title={textMatches[book.id]}>{ui.textMatch}{textMatches[book.id]}</p>}<div className="progress"><i style={{ width: `${book.progress}%` }} /></div><small>{book.progress}% · {ui.localReading}</small></div></button>)}
            {books.length === 0 && <div className="library-no-results">{ui.emptyShelf}</div>}
            {books.length > 0 && filteredBooks.length === 0 && <div className="library-no-results">{ui.noMatches}</div>}
            <button className="import-card" onClick={importBooks}><span>＋</span><strong>{ui.importMine}</strong><small>EPUB · PDF</small></button>
          </div>
        </section>}

        {view === 'highlights' && <HighlightsView uiLocale={uiLocale} books={books.filter((book): book is StoredBook => Boolean(book.storage && book.fileName))} onNotice={toast} onChanged={() => { scheduleSync(); void listHighlights().then((items) => setHighlightCount(items.length)) }} onDeleted={(id) => { if (session) void deleteRemoteHighlight(createRemoteClient(session), id).catch(() => scheduleSync()); else scheduleSync(); void listHighlights().then((items) => setHighlightCount(items.length)) }} onOpenHighlight={(highlight: Highlight) => {
          const book = books.find((item) => item.id === highlight.bookId)
          if (!book?.storage || !book.fileName) {
            toast('找不到这本本地书籍，请重新导入')
            return
          }
          setSelectedBook({ ...book, location: highlight.location })
          setView('reader')
        }} />}

        {view === 'profile' && <section className="profile-view">
          <p className="eyebrow">{ui.profileEyebrow}</p>
          <div className="profile-heading"><div><h1>{ui.profileTitle}</h1><p>{ui.profileCopy}</p></div><button className="profile-library-link" onClick={() => setView('library')}>{ui.library} →</button></div>
          <div className="profile-stats" aria-label={ui.profileTitle}>
            <article><span>{ui.readingTime}</span><strong>{formatReadingTime(readingSeconds, uiLocale)}</strong></article><article><span>{ui.booksOwned}</span><strong>{books.length}</strong></article><article><span>{ui.booksInProgress}</span><strong>{readingBooks.length}</strong></article><article><span>{ui.highlightsSaved}</span><strong>{highlightCount}</strong></article>
          </div>
          <section className="profile-weekly" aria-labelledby="profile-weekly-title"><div><p className="eyebrow">{ui.weeklyReading}</p><h2 id="profile-weekly-title">{ui.weeklyReadingTitle}</h2><p>{ui.weeklyReadingCopy}</p></div><div className="reading-bars" aria-label={ui.weeklyReading}>{weeklyReading.map((day) => <div className="reading-bar" key={day.key}><span title={interpolate(ui.dayReading, { day: day.label, time: formatReadingTime(day.seconds, uiLocale) })} style={{ height: `${Math.round((day.seconds / weeklyReadingMax) * 100)}%` }} /><small>{day.label}</small></div>)}</div></section>
          <section className="profile-recent" aria-labelledby="profile-recent-title"><div><p className="eyebrow">{ui.recentReading}</p><h2 id="profile-recent-title">{ui.recentReading}</h2><p>{ui.recentReadingCopy}</p></div>{recentBooks.length > 0 ? <div className="profile-book-list">{recentBooks.map((book) => <button key={book.id} onClick={() => { setSelectedBook(book); setView('reader') }}><span>{book.title}</span><small>{book.author} · {book.progress}% · {formatLastRead(book.lastReadAt, uiLocale, ui.notReadYet)}</small><em>{interpolate(ui.bookReadingTime, { time: formatReadingTime(bookReadingHistory[book.id] ?? 0, uiLocale) })}</em><i><b style={{ width: `${book.progress}%` }} /></i></button>)}</div> : <div className="profile-empty"><strong>{ui.profileEmpty}</strong><p>{ui.profileEmptyCopy}</p><button onClick={() => setView('library')}>{ui.importMine}</button></div>}</section>
          <p className="profile-footnote">{completedBooks.length > 0 ? `${ui.booksCompleted}：${completedBooks.length}` : ui.profileLocalOnly}</p>
        </section>}

        {view === 'reader' && <section className="reader-view">
          <div className="reader-header"><button className="back-button" onClick={() => { setReaderLayoutOpen(false); setView('library') }}>← <span>{ui.backToLibrary}</span></button><div className="reader-title"><strong>{selectedBook.title}</strong><small>{selectedBook.author}{selectedBook.fileName ? ` · ${ui.localReading}` : ''}</small></div><div className="reader-tools"><button onClick={importBooks}>{ui.importBook}</button><button onClick={() => { if (!selectedRelatedEdition) { toast(uiLocale === 'en' ? 'Import and link another edition before comparing.' : '请先导入并关联另一个译本，再进行对照阅读'); return } setCompare(!compare) }}>{compare ? ui.exitCompare : ui.compare}</button><button onClick={() => setView('settings')}>{language.slice(0, 1)}</button><button onClick={() => setReaderLayoutOpen((current) => !current)} aria-expanded={readerLayoutOpen} aria-controls="reader-layout-panel">Aa</button></div></div>
          {readerLayoutOpen && <aside id="reader-layout-panel" className="reader-layout-panel" role="dialog" aria-label={ui.readerLayout}><div><p className="eyebrow">{ui.readerLayout}</p><h2>{ui.readerLayout}</h2></div><div className="reader-layout-row"><span>{ui.fontSize}</span><div><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale - 0.05) }))} aria-label={ui.decreaseFont}>A−</button><strong>{Math.round(readerPreferences.fontScale * 100)}%</strong><button onClick={() => setReaderPreferences((current) => ({ ...current, fontScale: clampFontScale(current.fontScale + 0.05) }))} aria-label={ui.increaseFont}>A＋</button></div></div><div className="reader-layout-row"><span>{ui.readerTheme}</span><div className="reader-theme-choices"><button className={readerPreferences.theme === 'paper' ? 'active' : ''} aria-pressed={readerPreferences.theme === 'paper'} onClick={() => setReaderPreferences((current) => ({ ...current, theme: 'paper' }))}>{ui.paperTheme}</button><button className={readerPreferences.theme === 'sepia' ? 'active' : ''} aria-pressed={readerPreferences.theme === 'sepia'} onClick={() => setReaderPreferences((current) => ({ ...current, theme: 'sepia' }))}>{ui.sepiaTheme}</button><button className={readerPreferences.theme === 'night' ? 'active' : ''} aria-pressed={readerPreferences.theme === 'night'} onClick={() => setReaderPreferences((current) => ({ ...current, theme: 'night' }))}>{ui.nightTheme}</button></div></div></aside>}
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
        </section>}

        {view === 'settings' && <section className="settings-view"><div className="settings-wrap"><p className="eyebrow">{ui.preferences}</p><h1>{ui.settingsTitle}</h1><section className="language-section" aria-labelledby="ui-language-title"><div className="language-heading"><h2 id="ui-language-title">{ui.uiLanguageTitle}</h2><p>{ui.uiLanguageCopy}</p></div><div className="language-grid language-grid-compact">{UI_LOCALES.map((item) => <button className={uiLocale === item.value ? 'language-choice active' : 'language-choice'} key={item.value} onClick={() => changeUiLocale(item.value)} aria-pressed={uiLocale === item.value}>{item.label}<span>{item.value === 'zh-CN' ? 'Simplified Chinese' : 'English'}</span></button>)}</div></section><section className="language-section" aria-labelledby="reading-language-title"><div className="language-heading"><h2 id="reading-language-title">{ui.readingLanguageTitle}</h2><p>{ui.readingLanguageCopy}</p></div><div className="language-grid">{READING_LANGUAGES.map((item) => <button className={language === item.value ? 'language-choice active' : 'language-choice'} key={item.value} onClick={() => changeReadingLanguage(item.value)} aria-pressed={language === item.value}>{item.value}<span>{uiLocale === 'en' ? item.enLabel : item.zhLabel}</span></button>)}</div></section><div className="local-books"><h2>{ui.localBooks}</h2>{books.filter((book) => book.storage && book.fileName).map((book) => <div className="local-book-row" key={book.id}><span><strong>{book.title}</strong><small>{book.fileName} · {book.storage === 'opfs' ? (uiLocale === 'en' ? 'device file system' : '设备文件系统') : (uiLocale === 'en' ? 'browser database' : '浏览器数据库')}</small></span><div className="local-book-actions">{book.fileName?.toLowerCase().endsWith('.epub') && <button onClick={() => { void refreshCover(book) }} disabled={refreshingCoverId === book.id}>{refreshingCoverId === book.id ? ui.readingCover : ui.manageCover}</button>}<button onClick={() => selectCustomCover(book)}>{ui.uploadCover}</button><button onClick={() => setMetadataDraft(book as StoredBook)}>{ui.editInfo}</button><button className="danger" onClick={() => { void removeBook(book) }}>{ui.delete}</button></div></div>)}</div><div className="settings-note"><span>◎</span><p><strong>{ui.privacyTitle}</strong><br />{ui.privacyCopy}</p></div></div></section>}
      </main>
      {metadataDraft && <div className="metadata-dialog-backdrop"><form className="metadata-dialog" onSubmit={(event) => { void saveMetadata(event) }} role="dialog" aria-modal="true" aria-labelledby="metadata-dialog-title"><div><p className="eyebrow">LOCAL METADATA</p><h2 id="metadata-dialog-title">校正书籍信息</h2><p>只修改书架显示和本地阅读数据，不会改动或上传原始文件。</p></div><label>书名<input name="title" defaultValue={metadataDraft.title} autoFocus /></label><label>作者<input name="author" defaultValue={metadataDraft.author} /></label><div className="metadata-dialog-actions"><button type="button" onClick={() => setMetadataDraft(null)}>取消</button><button type="submit">保存信息</button></div></form></div>}
      {view === 'settings' && <AuthPanel uiLocale={uiLocale} onNotice={toast} onSessionChange={setSession} />}
      {notice && <div className="toast" role="status">{notice}</div>}
      {updateReady && <div className="update-toast" role="status">{ui.updateReady}<button onClick={() => window.dispatchEvent(new Event('worlibrary:activate-update'))}>{ui.updateNow}</button></div>}
      <DataTransfer uiLocale={uiLocale} onNotice={toast} onImported={() => { void listBooks().then((savedBooks) => setBooks(savedBooks)) }} />
      <input ref={fileInput} onChange={handleFiles} type="file" hidden accept=".epub,.pdf,.mobi,.cbz" multiple />
      <input ref={coverInput} onChange={(event) => { void handleCoverFile(event) }} type="file" hidden accept="image/*" />
    </div>
  )
}

export default App
