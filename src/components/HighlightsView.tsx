import { useEffect, useState } from 'react'
import { deleteHighlight, listHighlights, updateHighlightColor, updateHighlightNote, type Highlight, type RemoteHighlightMetadataShadow, type StoredBook } from '../lib/storage'
import { copy, type UiLocale } from '../lib/i18n'

type HighlightsViewProps = {
  uiLocale: UiLocale
  books: StoredBook[]
  onNotice: (message: string) => void
  onOpenHighlight: (highlight: Highlight) => void
  onChanged?: () => void
  /** Called only with the durable record returned by the local storage layer. */
  onHighlightChanged?: (highlight: Highlight) => void
  /** The returned record is needed to queue a same-account delete tombstone. */
  onHighlightDeleted?: (highlight: Highlight) => void
  /**
   * Account-scoped feed projections. They remain read-only here: a remote
   * excerpt is never silently written into the local highlight store.
   */
  remoteHighlights?: RemoteHighlightMetadataShadow[]
}

export default function HighlightsView({ uiLocale, books, onNotice, onOpenHighlight, onChanged, onHighlightChanged, onHighlightDeleted, remoteHighlights = [] }: HighlightsViewProps) {
  const ui = copy[uiLocale]
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [bookFilter, setBookFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [draftNote, setDraftNote] = useState('')

  useEffect(() => { void listHighlights().then(setHighlights) }, [])

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const visible = highlights.filter((item) => {
    const matchesBook = bookFilter === 'all' || item.bookId === bookFilter
    const source = `${item.text} ${item.note ?? ''} ${books.find((book) => book.id === item.bookId)?.title ?? ''}`.toLowerCase()
    return matchesBook && (!normalizedSearch || source.includes(normalizedSearch))
  })
  const visibleRemote = remoteHighlights
    .filter((item) => !highlights.some((local) => local.id === item.highlightId))
    .filter((item) => {
      const matchesBook = bookFilter === 'all'
      const source = `${item.text} ${item.note ?? ''}`.toLowerCase()
      return matchesBook && (!normalizedSearch || source.includes(normalizedSearch))
    })
  const titleFor = (bookId: string) => books.find((book) => book.id === bookId)?.title ?? (uiLocale === 'en' ? 'Removed book' : '已移除的书籍')

  async function saveNote(id: string) {
    const persisted = await updateHighlightNote(id, draftNote.trim())
    if (!persisted) return
    setHighlights((current) => current.map((item) => item.id === id ? persisted : item))
    setEditingId(undefined)
    onChanged?.()
    onHighlightChanged?.(persisted)
    onNotice(uiLocale === 'en' ? 'Note saved' : '备注已保存')
  }

  async function remove(id: string) {
    const deleted = await deleteHighlight(id)
    if (!deleted) return
    setHighlights((current) => current.filter((item) => item.id !== id))
    onHighlightDeleted?.(deleted)
    onNotice(uiLocale === 'en' ? 'Highlight deleted' : '摘录已删除')
  }

  async function changeColor(id: string, color: Highlight['color']) {
    const persisted = await updateHighlightColor(id, color)
    if (!persisted) return
    setHighlights((current) => current.map((item) => item.id === id ? persisted : item))
    onChanged?.()
    onHighlightChanged?.(persisted)
  }

  return <section className="highlights-view">
    <div className="highlights-heading"><div><h1>{ui.excerptsTitle}</h1><p>{ui.excerptsCopy}</p></div><div className="highlights-filters"><label>{ui.searchHighlights}<input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={ui.highlightSearchPlaceholder} aria-label={ui.searchHighlights} /></label><label>{ui.filterBooks}<select value={bookFilter} onChange={(event) => setBookFilter(event.target.value)} aria-label={ui.filterBooks}><option value="all">{ui.allHighlights}</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label></div></div>
    {visible.length === 0 && visibleRemote.length === 0 ? <div className="highlights-empty"><span>✦</span><strong>{ui.noHighlights}</strong><p>{ui.noHighlightsCopy}</p></div> : <div className="highlight-list">{visible.map((item) => <article className={`highlight-card ${item.color}`} key={item.id}><div className="highlight-mark">“</div><blockquote>{item.text}</blockquote><p className="highlight-source">{titleFor(item.bookId)} · {ui.localHighlight}</p>{editingId === item.id ? <div className="highlight-editor"><textarea value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder={uiLocale === 'en' ? 'Write your own reading…' : '写下你的理解…'} autoFocus /><div><button onClick={() => { void saveNote(item.id) }}>{ui.saveNote}</button><button className="muted" onClick={() => setEditingId(undefined)}>{ui.cancel}</button></div></div> : <>{item.note && <p className="highlight-note">{item.note}</p>}<div className="highlight-actions"><button onClick={() => onOpenHighlight(item)}>{ui.openOriginal}</button><button onClick={() => { setEditingId(item.id); setDraftNote(item.note ?? '') }}>{item.note ? ui.editNote : ui.addNote}</button><div className="highlight-colors" aria-label={uiLocale === 'en' ? 'Highlight color' : '摘录颜色'}><button className="gold" aria-label={uiLocale === 'en' ? 'Gold' : '金色'} onClick={() => { void changeColor(item.id, 'gold') }} /><button className="rose" aria-label={uiLocale === 'en' ? 'Rose' : '玫红'} onClick={() => { void changeColor(item.id, 'rose') }} /><button className="blue" aria-label={uiLocale === 'en' ? 'Blue' : '蓝色'} onClick={() => { void changeColor(item.id, 'blue') }} /></div><button onClick={() => { void remove(item.id) }}>{ui.delete}</button></div></>}</article>)}{visibleRemote.map((item) => <article className={`highlight-card remote-highlight-shadow ${item.color}`} key={`remote:${item.highlightId}`}><div className="highlight-mark">“</div><blockquote>{item.text}</blockquote><p className="highlight-source">{ui.syncedPrivateHighlight}</p>{item.note && <p className="highlight-note">{item.note}</p>}<p className="remote-highlight-copy">{ui.syncedPrivateHighlightCopy}</p></article>)}</div>}
  </section>
}
