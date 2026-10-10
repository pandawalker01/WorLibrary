import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import EpubReader from './components/EpubReader'
import PdfReader from './components/PdfReader'
import HighlightsView from './components/HighlightsView'
import DataTransfer from './components/DataTransfer'
import './highlights.css'
import type { Highlight } from './lib/storage'
import './library.css'
import './settings.css'
import { deleteBook, linkBookEditions, listAlignments, listBooks, listEditions, refreshBookCover, saveBook, saveEditionProgress, searchBookTextIndex, updateBookCover, updateBookMetadata, type StoredBook } from './lib/storage'
import type { Alignment, Edition } from './lib/edition'
import EditionComparisonReader from './components/EditionComparisonReader'
import AuthPanel from './components/AuthPanel'
import { getSession, type AuthSession } from './lib/auth'
import { createRemoteClient } from './lib/remote'
import { createIndexedDbSyncAdapter, deleteRemoteHighlight, enqueueSync, flushQueuedSync } from './lib/sync'

type View = 'library' | 'reader' | 'highlights' | 'settings'
type DisplayBook = Pick<StoredBook, 'id' | 'title' | 'author' | 'language' | 'progress' | 'cover'> & Partial<Pick<StoredBook, 'fileName' | 'fileType' | 'storage' | 'createdAt' | 'location' | 'workId' | 'coverImage'>>

const sampleBooks: DisplayBook[] = [
  { id: 'invisible', title: 'The Invisible Life of Addie LaRue', author: 'V. E. Schwab', language: 'English · 3 versions', progress: 38, cover: 'ink' },
  { id: 'stranger', title: "L'Étranger", author: 'Albert Camus', language: 'Français · 2 versions', progress: 72, cover: 'sun' },
  { id: 'kafka', title: '变形记', author: 'Franz Kafka', language: '中文 · 2 versions', progress: 14, cover: 'red' },
]

function App() {
  const [books, setBooks] = useState<DisplayBook[]>([])
  const [view, setView] = useState<View>('library')
  const [language, setLanguage] = useState('中文')
  const [selectedBook, setSelectedBook] = useState<DisplayBook>(sampleBooks[0])
  const [compare, setCompare] = useState(false)
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
  const fileInput = useRef<HTMLInputElement>(null)
  const coverInput = useRef<HTMLInputElement>(null)
  const syncTimer = useRef<number | undefined>(undefined)

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
    void Promise.all([listBooks(), listEditions(), listAlignments()]).then(([savedBooks, savedEditions, savedAlignments]) => { setBooks(savedBooks); setEditions(savedEditions); setAlignments(savedAlignments) })
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
    let cancelled = false
    const query = searchQuery.trim()
    if (!query) { setTextMatches({}); return }
    void searchBookTextIndex(query).then((matches) => {
      if (cancelled) return
      setTextMatches(Object.fromEntries(matches.map((match) => [match.bookId, match.snippet])))
    }).catch(() => { if (!cancelled) setTextMatches({}) })
    return () => { cancelled = true }
  }, [searchQuery])


  const toast = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2800)
  }, [])

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
    setSelectedBook((current) => current.id === bookId ? { ...current, progress, location } : current)
    setBooks((current) => current.map((item) => item.id === bookId ? { ...item, progress, location } : item))
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

  return (
    <div className="app-shell">
      <aside className="rail">
        <button className="wordmark" onClick={() => setView('library')} aria-label="回到书库">WL<span>°</span></button>
        <nav aria-label="主导航">
          <button className={view === 'library' ? 'nav-item active' : 'nav-item'} onClick={() => setView('library')}><span>01</span>书库</button>
          <button className={view === 'highlights' ? 'nav-item active' : 'nav-item'} onClick={() => setView('highlights')}><span>02</span>摘录</button>
          <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}><span>03</span>设置</button>
        </nav>
        <div className={`rail-foot ${isOnline ? '' : 'is-offline'}`} title={isOnline ? '应用壳已缓存；已导入书籍可离线阅读' : '当前离线：仅可访问已缓存应用和本地书籍'}><i />{isOnline ? '离线可读' : '当前离线'}</div>
      </aside>

      <main className="content">
        {!isOnline && <div className="offline-banner" role="status">当前离线：已导入的本地书籍仍可阅读；翻译、OCR 与同步将在联网后恢复。</div>}
        <header className="topbar">
          <p className="eyebrow">PERSONAL WORLD LIBRARY / 001</p>
          <div className="top-actions">
            <button className="text-button" onClick={() => setView('settings')}>理解语言：<strong>{language}</strong>⌄</button>
            <button className="round-button" onClick={importBooks} aria-label="导入书籍">＋</button>
          </div>
        </header>

        {view === 'library' && <section className="library-view">
          <div className="hero"><div><p className="eyebrow">YOUR SHELF</p><h1>把世界的书，<em>读成自己的语言。</em></h1></div><p className="hero-copy">导入你的书，关联不同译本。划线即可获得翻译与解释——即使离线，也能继续阅读和思考。</p></div>
          <div className="library-search"><span aria-hidden="true">⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索书名、作者或正文（本地）" aria-label="搜索书库" />{searchQuery && <button onClick={() => setSearchQuery('')} aria-label="清除搜索">×</button>}</div>
          <div className="shelf-toolbar"><div className="filter-row"><button className={libraryFilter === 'all' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('all')}>全部 <b>{String(books.length).padStart(2, '0')}</b></button><button className={libraryFilter === 'reading' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('reading')}>正在读 <b>{String(books.filter((book) => book.progress > 0 && book.progress < 100).length).padStart(2, '0')}</b></button><button className={libraryFilter === 'multi' ? 'filter active' : 'filter'} onClick={() => setLibraryFilter('multi')}>多译本 <b>{String(books.filter((book) => Boolean(book.workId && editionCounts[book.workId] > 1)).length).padStart(2, '0')}</b></button></div><button className="sort-button" onClick={() => setSortNewest((current) => !current)}>{sortNewest ? '最近阅读 ↓' : '书名排序 A–Z'}</button></div>
          {normalizedSearch && <p className="library-search-result" role="status">找到 {filteredBooks.length} 本匹配书籍</p>}
          <div className="shelf">
            {filteredBooks.map((book) => <button className="book-card" key={book.id} onClick={() => { setSelectedBook(book); setView('reader') }}><div className={`cover ${book.cover}`}>{book.coverImage ? <img className="cover-image" src={book.coverImage} alt={`${book.title} 封面`} /> : <><span>{book.id === 'invisible' ? <>THE<br />INVISIBLE<br />LIFE</> : book.id === 'stranger' ? "L'ÉTRANGER" : <>变<br />形<br />记</>}</span><small>{book.author}</small></>}</div><div className="book-info"><p className="book-lang">{book.language}</p><h2>{book.title}</h2><p>{book.author}</p>{textMatches[book.id] && <p className="book-search-snippet" title={textMatches[book.id]}>正文命中：{textMatches[book.id]}</p>}<div className="progress"><i style={{ width: `${book.progress}%` }} /></div><small>{book.progress}% · 本地阅读</small></div></button>)}
            {books.length === 0 && <div className="library-no-results">你的书架还是空的。导入 EPUB 或 PDF 后，书籍会只保存在这台设备上。</div>}
            {books.length > 0 && filteredBooks.length === 0 && <div className="library-no-results">没有找到匹配的书籍或筛选结果</div>}
            <button className="import-card" onClick={importBooks}><span>＋</span><strong>导入我的书</strong><small>EPUB · PDF</small></button>
          </div>
        </section>}

        {view === 'highlights' && <HighlightsView books={books.filter((book): book is StoredBook => Boolean(book.storage && book.fileName))} onNotice={toast} onChanged={scheduleSync} onDeleted={(id) => { if (session) void deleteRemoteHighlight(createRemoteClient(session), id).catch(() => scheduleSync()); else scheduleSync() }} onOpenHighlight={(highlight: Highlight) => {
          const book = books.find((item) => item.id === highlight.bookId)
          if (!book?.storage || !book.fileName) {
            toast('找不到这本本地书籍，请重新导入')
            return
          }
          setSelectedBook({ ...book, location: highlight.location })
          setView('reader')
        }} />}

        {view === 'reader' && <section className="reader-view">
          <div className="reader-header"><button className="back-button" onClick={() => setView('library')}>← <span>书库</span></button><div className="reader-title"><strong>{selectedBook.title}</strong><small>{selectedBook.author}{selectedBook.fileName ? ' · 本地阅读' : ''}</small></div><div className="reader-tools"><button onClick={() => { if (!selectedRelatedEdition) { toast('请先导入并关联另一个译本，再进行对照阅读'); return } setCompare(!compare) }}>{compare ? '↹ 退出对照' : '⇄ 对照阅读'}</button><button onClick={() => setView('settings')}>{language.slice(0, 1)}</button><button onClick={() => toast('阅读排版设置将在阅读引擎接入后启用')}>Aa</button></div></div>
          {(() => {
            const currentEdition = selectedEdition
            const relatedEdition = selectedRelatedEdition
            const relatedBook = relatedEdition ? books.find((book) => book.id === relatedEdition.bookId) : undefined
            const renderReader = (book: DisplayBook) => {
              if (book.fileName?.toLowerCase().endsWith('.epub') && book.storage) return <EpubReader key={`epub-${book.id}`} book={book as StoredBook} targetLanguage={language} onNotice={toast} onProgress={(progress, location) => updateEditionProgress(book.id, progress, location)} />
              if (book.fileName?.toLowerCase().endsWith('.pdf') && book.storage) return <PdfReader key={`pdf-${book.id}`} book={book as StoredBook} targetLanguage={language} onNotice={toast} onProgress={(progress, location) => updateEditionProgress(book.id, progress, location)} />
              // Imported books are the only readable source. Never fall back to
              // the old showcase passage, especially in a comparison pane.
              return <div className="reader-source-unavailable" role="status">找不到这本本地书籍，请返回书库重新导入。</div>
            }
            if (!currentEdition || !relatedEdition || !relatedBook) return <><div className="edition-strip"><span>单版本阅读</span><button className="link-edition" onClick={() => { void linkCurrentEdition() }}>＋ 关联译本</button></div>{renderReader(selectedBook)}</>
            const comparisonAlignment = alignments.find((item) => item.workId === currentEdition.workId && ((item.leftEditionId === currentEdition.id && item.rightEditionId === relatedEdition.id) || (item.rightEditionId === currentEdition.id && item.leftEditionId === relatedEdition.id)))
            return <><div className="edition-strip"><span>正在阅读</span><button className="edition active">{currentEdition.language} <strong>{currentEdition.label}</strong></button><button className="edition" onClick={() => { setSelectedBook(relatedBook); setCompare(false) }}>{relatedEdition.language} <strong>{relatedEdition.label}</strong></button><button className="link-edition" onClick={() => { void linkCurrentEdition() }}>＋ 关联译本</button></div>{compare ? <EditionComparisonReader left={currentEdition} right={relatedEdition} alignment={comparisonAlignment} leftContent={renderReader(selectedBook)} rightContent={renderReader(relatedBook)} onSwitch={(edition) => { const next = books.find((book) => book.id === edition.bookId); if (next) { setSelectedBook(next); setCompare(false) } }} /> : renderReader(selectedBook)}</>
          })()}
          {assistantOpen && <aside className="ai-panel"><div className="panel-top"><span>✦</span><strong>阅读助手</strong><button onClick={() => setAssistantOpen(false)}>×</button></div><p className="ai-label">ENGLISH → {language}</p><blockquote>“But freedom, she would learn, is a word with a thousand meanings, and some of them are cages.”</blockquote><section><h3>翻译</h3><p>但她后来会明白，自由这个词有一千种含义，其中有些，恰恰是牢笼。</p></section><section><h3>通俗解释</h3><p>自由并不总是轻松美好的。有时我们以为自己在选择，却被选择的代价、规则或恐惧困住了。</p></section><small>AI 解释仅供学习参考 · 本地 Demo</small></aside>}
          <div className="reader-bottom"><span>{selectedBook.progress}%</span><div><i style={{ width: `${selectedBook.progress}%` }} /></div><span>{selectedBook.fileName ? '进度已保存到本机' : '4 / 11'}</span><button onClick={() => toast('OCR 是下一步真实服务接入点')}>◎ 扫描页？识别文字</button></div>
        </section>}

        {view === 'settings' && <section className="settings-view"><div className="settings-wrap"><p className="eyebrow">PREFERENCES</p><h1>你的阅读语言</h1><p className="settings-copy">AI 会把你划线的任意语言文本，翻译并解释成这个语言。</p><div className="language-grid">{['中文', 'English', '日本語', 'Français'].map((item) => <button className={language === item ? 'language-choice active' : 'language-choice'} key={item} onClick={() => { setLanguage(item); toast(`已将 AI 理解语言设为：${item}`) }}>{item}<span>{item === '中文' ? '简体中文' : item === 'English' ? '英语' : item === '日本語' ? '日语' : '法语'}</span></button>)}</div><div className="local-books"><h2>本地书籍管理</h2>{books.filter((book) => book.storage && book.fileName).map((book) => <div className="local-book-row" key={book.id}><span><strong>{book.title}</strong><small>{book.fileName} · {book.storage === 'opfs' ? '设备文件系统' : '浏览器数据库'}</small></span><div className="local-book-actions">{book.fileName?.toLowerCase().endsWith('.epub') && <button onClick={() => { void refreshCover(book) }} disabled={refreshingCoverId === book.id}>{refreshingCoverId === book.id ? '读取封面中…' : '重新读取封面'}</button>}<button onClick={() => selectCustomCover(book)}>上传本地封面</button><button onClick={() => setMetadataDraft(book as StoredBook)}>编辑信息</button><button className="danger" onClick={() => { void removeBook(book) }}>删除</button></div></div>)}</div><div className="settings-note"><span>◎</span><p><strong>你的书，留在你的设备上。</strong><br />已导入的书籍、阅读进度和摘录均可离线访问；仅在你请求解释或识别文字时，相关内容才会发送至 AI 服务。</p></div></div></section>}
      </main>
      {metadataDraft && <div className="metadata-dialog-backdrop" role="presentation"><form className="metadata-dialog" onSubmit={(event) => { void saveMetadata(event) }} aria-label="编辑书籍信息"><div><p className="eyebrow">LOCAL METADATA</p><h2>校正书籍信息</h2><p>只修改书架显示和本地阅读数据，不会改动或上传原始文件。</p></div><label>书名<input name="title" defaultValue={metadataDraft.title} autoFocus /></label><label>作者<input name="author" defaultValue={metadataDraft.author} /></label><div className="metadata-dialog-actions"><button type="button" onClick={() => setMetadataDraft(null)}>取消</button><button type="submit">保存信息</button></div></form></div>}
      {view === 'settings' && <AuthPanel onNotice={toast} onSessionChange={setSession} />}
      {notice && <div className="toast" role="status">{notice}</div>}
      {updateReady && <div className="update-toast" role="status">有新版本可用<button onClick={() => window.dispatchEvent(new Event('worlibrary:activate-update'))}>立即更新</button></div>}
      <DataTransfer onNotice={toast} onImported={() => { void listBooks().then((savedBooks) => setBooks(savedBooks)) }} />
      <input ref={fileInput} onChange={handleFiles} type="file" hidden accept=".epub,.pdf,.mobi,.cbz" multiple />
      <input ref={coverInput} onChange={(event) => { void handleCoverFile(event) }} type="file" hidden accept="image/*" />
    </div>
  )
}

export default App
