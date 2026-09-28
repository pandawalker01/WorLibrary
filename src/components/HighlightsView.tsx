import { useEffect, useState } from 'react'
import { deleteHighlight, listHighlights, updateHighlightColor, updateHighlightNote, type Highlight, type StoredBook } from '../lib/storage'

type HighlightsViewProps = {
  books: StoredBook[]
  onNotice: (message: string) => void
  onOpenHighlight: (highlight: Highlight) => void
}

export default function HighlightsView({ books, onNotice, onOpenHighlight }: HighlightsViewProps) {
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [bookFilter, setBookFilter] = useState('all')
  const [editingId, setEditingId] = useState<string>()
  const [draftNote, setDraftNote] = useState('')

  useEffect(() => { void listHighlights().then(setHighlights) }, [])

  const visible = bookFilter === 'all' ? highlights : highlights.filter((item) => item.bookId === bookFilter)
  const titleFor = (bookId: string) => books.find((book) => book.id === bookId)?.title ?? '已移除的书籍'

  async function saveNote(id: string) {
    await updateHighlightNote(id, draftNote.trim())
    setHighlights((current) => current.map((item) => item.id === id ? { ...item, note: draftNote.trim() } : item))
    setEditingId(undefined)
    onNotice('备注已保存')
  }

  async function remove(id: string) {
    await deleteHighlight(id)
    setHighlights((current) => current.filter((item) => item.id !== id))
    onNotice('摘录已删除')
  }

  async function changeColor(id: string, color: Highlight['color']) {
    await updateHighlightColor(id, color)
    setHighlights((current) => current.map((item) => item.id === id ? { ...item, color } : item))
  }

  return <section className="highlights-view">
    <div className="highlights-heading"><div><p className="eyebrow">YOUR EXCERPTS</p><h1>摘录空间</h1><p>把读过的句子留下来，按书籍回看，也可以随时补充自己的理解。</p></div><label>筛选书籍<select value={bookFilter} onChange={(event) => setBookFilter(event.target.value)}><option value="all">全部摘录</option>{books.filter((book) => !book.id.startsWith('invisible') && !book.id.startsWith('stranger') && !book.id.startsWith('kafka')).map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label></div>
    {visible.length === 0 ? <div className="highlights-empty"><span>✦</span><strong>还没有摘录</strong><p>打开一本 EPUB，选择你想留下的句子即可保存到这里。</p></div> : <div className="highlight-list">{visible.map((item) => <article className={`highlight-card ${item.color}`} key={item.id}><div className="highlight-mark">“</div><blockquote>{item.text}</blockquote><p className="highlight-source">{titleFor(item.bookId)} · 本地摘录</p>{editingId === item.id ? <div className="highlight-editor"><textarea value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder="写下你的理解…" autoFocus /><div><button onClick={() => { void saveNote(item.id) }}>保存备注</button><button className="muted" onClick={() => setEditingId(undefined)}>取消</button></div></div> : <>{item.note && <p className="highlight-note">{item.note}</p>}<div className="highlight-actions"><button onClick={() => onOpenHighlight(item)}>打开原文</button><button onClick={() => { setEditingId(item.id); setDraftNote(item.note ?? '') }}>{item.note ? '编辑备注' : '添加备注'}</button><div className="highlight-colors" aria-label="摘录颜色"><button className="gold" aria-label="金色" onClick={() => { void changeColor(item.id, 'gold') }} /><button className="rose" aria-label="玫红" onClick={() => { void changeColor(item.id, 'rose') }} /><button className="blue" aria-label="蓝色" onClick={() => { void changeColor(item.id, 'blue') }} /></div><button onClick={() => { void remove(item.id) }}>删除</button></div></>}</article>)}</div>}
  </section>
}
