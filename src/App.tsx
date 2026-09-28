import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import EpubReader from './components/EpubReader'
import PdfReader from './components/PdfReader'
import HighlightsView from './components/HighlightsView'
import DataTransfer from './components/DataTransfer'
import './highlights.css'
import type { Highlight } from './lib/storage'
import './library.css'
import './settings.css'
import { deleteBook, listBooks, saveBook, type StoredBook } from './lib/storage'

type View = 'library' | 'reader' | 'highlights' | 'settings'
type DisplayBook = Pick<StoredBook, 'id' | 'title' | 'author' | 'language' | 'progress' | 'cover'> & Partial<Pick<StoredBook, 'fileName' | 'fileType' | 'storage' | 'createdAt' | 'location'>>

const sampleBooks: DisplayBook[] = [
  { id: 'invisible', title: 'The Invisible Life of Addie LaRue', author: 'V. E. Schwab', language: 'English · 3 versions', progress: 38, cover: 'ink' },
  { id: 'stranger', title: "L'Étranger", author: 'Albert Camus', language: 'Français · 2 versions', progress: 72, cover: 'sun' },
  { id: 'kafka', title: '变形记', author: 'Franz Kafka', language: '中文 · 2 versions', progress: 14, cover: 'red' },
]

function App() {
  const [books, setBooks] = useState<DisplayBook[]>(sampleBooks)
  const [view, setView] = useState<View>('library')
  const [language, setLanguage] = useState('中文')
  const [selectedBook, setSelectedBook] = useState<DisplayBook>(sampleBooks[0])
  const [compare, setCompare] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void listBooks().then((savedBooks) => setBooks([...sampleBooks, ...savedBooks]))
  }, [])


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
      toast(`已保存 ${saved.length} 本书 · 文件不会上传`)
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败，请重试')
    }
  }

  async function removeBook(book: DisplayBook) {
    if (!book.storage || !book.fileName) return
    if (!window.confirm(`确定从本地书库删除《${book.title}》吗？`)) return
    await deleteBook(book as StoredBook)
    setBooks((current) => current.filter((item) => item.id !== book.id))
    if (selectedBook.id === book.id) setSelectedBook(sampleBooks[0])
    toast('书籍、阅读进度和摘录已从本地删除')
  }

  return (
    <div className="app-shell">
      <aside className="rail">
        <button className="wordmark" onClick={() => setView('library')} aria-label="回到书库">WL<span>°</span></button>
        <nav aria-label="主导航">
          <button className={view === 'library' ? 'nav-item active' : 'nav-item'} onClick={() => setView('library')}><span>01</span>书库</button>
          <button className={view === 'highlights' ? 'nav-item active' : 'nav-item'} onClick={() => setView('highlights')}><span>02</span>摘录</button>
          <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}><span>03</span>设置</button>
        </nav>
        <div className="rail-foot"><i />离线可读</div>
      </aside>

      <main className="content">
        <header className="topbar">
          <p className="eyebrow">PERSONAL WORLD LIBRARY / 001</p>
          <div className="top-actions">
            <button className="text-button" onClick={() => setView('settings')}>理解语言：<strong>{language}</strong>⌄</button>
            <button className="round-button" onClick={importBooks} aria-label="导入书籍">＋</button>
          </div>
        </header>

        {view === 'library' && <section className="library-view">
          <div className="hero"><div><p className="eyebrow">YOUR SHELF</p><h1>把世界的书，<em>读成自己的语言。</em></h1></div><p className="hero-copy">导入你的书，关联不同译本。划线即可获得翻译与解释——即使离线，也能继续阅读和思考。</p></div>
          <div className="library-search"><span>⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索书名、作者或语言" aria-label="搜索书库" />{searchQuery && <button onClick={() => setSearchQuery('')} aria-label="清除搜索">×</button>}</div>
          <div className="shelf-toolbar"><div className="filter-row"><button className="filter active">全部 <b>{String(books.length).padStart(2, '0')}</b></button><button className="filter" onClick={() => toast('筛选状态已准备接入本地书架')}>正在读 <b>02</b></button><button className="filter" onClick={() => toast('多译本筛选将在版本模型接入后启用')}>多译本 <b>03</b></button></div><button className="sort-button">最近阅读 ↓</button></div>
          <div className="shelf">
            {books.filter((book) => [book.title, book.author, book.language].some((field) => field.toLowerCase().includes(searchQuery.trim().toLowerCase()))).map((book) => <button className="book-card" key={book.id} onClick={() => { setSelectedBook(book); setView('reader') }}><div className={`cover ${book.cover}`}><span>{book.id === 'invisible' ? <>THE<br />INVISIBLE<br />LIFE</> : book.id === 'stranger' ? "L'ÉTRANGER" : <>变<br />形<br />记</>}</span><small>{book.author}</small></div><div className="book-info"><p className="book-lang">{book.language}</p><h2>{book.title}</h2><p>{book.author}</p><div className="progress"><i style={{ width: `${book.progress}%` }} /></div><small>{book.progress}% · 本地阅读</small></div></button>)}
            {books.length > 0 && books.filter((book) => [book.title, book.author, book.language].some((field) => field.toLowerCase().includes(searchQuery.trim().toLowerCase()))).length === 0 && <div className="library-no-results">没有找到匹配的书籍</div>}
            <button className="import-card" onClick={importBooks}><span>＋</span><strong>导入我的书</strong><small>EPUB · PDF · MOBI · CBZ</small></button>
          </div>
        </section>}

        {view === 'highlights' && <HighlightsView books={books.filter((book): book is StoredBook => Boolean(book.storage && book.fileName))} onNotice={toast} onOpenHighlight={(highlight: Highlight) => {
          const book = books.find((item) => item.id === highlight.bookId)
          if (!book?.storage || !book.fileName) {
            toast('找不到这本本地书籍，请重新导入')
            return
          }
          setSelectedBook({ ...book, location: highlight.location })
          setView('reader')
        }} />}

        {view === 'reader' && <section className="reader-view">
          <div className="reader-header"><button className="back-button" onClick={() => setView('library')}>← <span>书库</span></button><div className="reader-title"><strong>{selectedBook.title}</strong><small>{selectedBook.author} · Chapter 4</small></div><div className="reader-tools"><button onClick={() => setCompare(!compare)}>{compare ? '↹ 退出对照' : '⇄ 对照阅读'}</button><button onClick={() => setView('settings')}>{language.slice(0, 1)}</button><button onClick={() => toast('阅读排版设置将在阅读引擎接入后启用')}>Aa</button></div></div>
          <div className="edition-strip"><span>正在阅读</span><button className="edition active">EN <strong>English original</strong></button><button className="edition" onClick={() => toast('译本切换将在 Edition 模型接入后启用')}>中 <strong>简体中文</strong></button><button className="link-edition" onClick={() => toast('请在本地导入另一个版本后关联')}>＋ 关联译本</button></div>
          {selectedBook.fileName?.toLowerCase().endsWith('.epub') && selectedBook.storage ? <EpubReader book={selectedBook as StoredBook} onNotice={toast} onProgress={(progress, location) => { setSelectedBook((current) => ({ ...current, progress, location })); setBooks((current) => current.map((item) => item.id === selectedBook.id ? { ...item, progress, location } : item)) }} /> : selectedBook.fileName?.toLowerCase().endsWith('.pdf') && selectedBook.storage ? <PdfReader book={selectedBook as StoredBook} onNotice={toast} onProgress={(progress, location) => { setSelectedBook((current) => ({ ...current, progress, location })); setBooks((current) => current.map((item) => item.id === selectedBook.id ? { ...item, progress, location } : item)) }} /> : <div className={compare ? 'reading-stage comparing' : 'reading-stage'}><article className="page primary-page"><div className="chapter-label">CHAPTER IV · A LIFE, UNLIVED</div><h2>One day, in the middle of a perfectly ordinary life, something extraordinary happened.</h2><p>Adeline LaRue had always believed the world was made of doors. A door was not just a passage from one room to another; it was a promise.</p><p className="selectable" onMouseUp={() => toast('已选择文字 · 点击“用 AI 解释”查看示例')}>But freedom, she would learn, is a word with a thousand meanings, and some of them are cages.</p><p>She did not know yet which doors would open for her, or which would close. She only knew that she had to keep walking.</p><button className="selection-tip" onClick={() => setAssistantOpen(true)}>选中这段文字 <strong>用 AI 解释 ✦</strong></button><footer className="page-footer"><span>041</span><i /><span>THE INVISIBLE LIFE</span></footer></article>{compare && <article className="page translation-page"><div className="chapter-label">第四章 · 未曾活过的一生</div><h2>平凡人生的正中央，某一天发生了一件非凡的事。</h2><p>阿黛琳·拉吕一直相信，世界是由门构成的。门不仅是通道；它更像一个承诺，意味着门的另一侧或许有什么能改变她生命的形状。</p><p>但她后来会明白，自由这个词有一千种含义，其中有些，恰恰是牢笼。</p><footer className="page-footer"><span>041</span><i /><span>无形人生</span></footer></article>}</div>}
          {assistantOpen && <aside className="ai-panel"><div className="panel-top"><span>✦</span><strong>阅读助手</strong><button onClick={() => setAssistantOpen(false)}>×</button></div><p className="ai-label">ENGLISH → {language}</p><blockquote>“But freedom, she would learn, is a word with a thousand meanings, and some of them are cages.”</blockquote><section><h3>翻译</h3><p>但她后来会明白，自由这个词有一千种含义，其中有些，恰恰是牢笼。</p></section><section><h3>通俗解释</h3><p>自由并不总是轻松美好的。有时我们以为自己在选择，却被选择的代价、规则或恐惧困住了。</p></section><small>AI 解释仅供学习参考 · 本地 Demo</small></aside>}
          <div className="reader-bottom"><span>{selectedBook.progress}%</span><div><i style={{ width: `${selectedBook.progress}%` }} /></div><span>4 / 11</span><button onClick={() => toast('OCR 是下一步真实服务接入点')}>◎ 扫描页？识别文字</button></div>
        </section>}

        {view === 'settings' && <section className="settings-view"><div className="settings-wrap"><p className="eyebrow">PREFERENCES</p><h1>你的阅读语言</h1><p className="settings-copy">AI 会把你划线的任意语言文本，翻译并解释成这个语言。</p><div className="language-grid">{['中文', 'English', '日本語', 'Français'].map((item) => <button className={language === item ? 'language-choice active' : 'language-choice'} key={item} onClick={() => { setLanguage(item); toast(`已将 AI 理解语言设为：${item}`) }}>{item}<span>{item === '中文' ? '简体中文' : item === 'English' ? '英语' : item === '日本語' ? '日语' : '法语'}</span></button>)}</div><div className="local-books"><h2>本地书籍管理</h2>{books.filter((book) => book.storage && book.fileName).map((book) => <div className="local-book-row" key={book.id}><span><strong>{book.title}</strong><small>{book.fileName} · {book.storage === 'opfs' ? '设备文件系统' : '浏览器数据库'}</small></span><button onClick={() => { void removeBook(book) }}>删除</button></div>)}</div><div className="settings-note"><span>◎</span><p><strong>你的书，留在你的设备上。</strong><br />已导入的书籍、阅读进度和摘录均可离线访问；仅在你请求解释或识别文字时，相关内容才会发送至 AI 服务。</p></div></div></section>}
      </main>
      {notice && <div className="toast" role="status">{notice}</div>}
      <DataTransfer onNotice={toast} onImported={() => { void listBooks().then((savedBooks) => setBooks([...sampleBooks, ...savedBooks])) }} />
      <input ref={fileInput} onChange={handleFiles} type="file" hidden accept=".epub,.pdf,.mobi,.cbz" multiple />
    </div>
  )
}

export default App
