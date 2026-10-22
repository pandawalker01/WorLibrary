import type { RemoteBookMetadataShadow } from '../lib/storage'
import { copy, type UiLocale } from '../lib/i18n'
import './remote-book-metadata-shadows.css'

type RemoteBookMetadataShadowsProps = {
  /**
   * Callers decide which records are safe to show (for example, they omit
   * shadows that already have a matching, readable local edition).
   */
  shadows: RemoteBookMetadataShadow[]
  uiLocale: UiLocale
  /** Opens the caller-owned local import flow. It never opens a reader. */
  onReimport: (shadow: RemoteBookMetadataShadow) => void
}

/**
 * A deliberately non-reader representation of safely synchronised metadata.
 * It must never receive a local file, object address, reader callback, or cover
 * bytes: re-importing an original file is the only available interaction.
 */
export default function RemoteBookMetadataShadows({ shadows, uiLocale, onReimport }: RemoteBookMetadataShadowsProps) {
  const labels = copy[uiLocale]

  if (shadows.length === 0) return null

  return <section className="remote-book-metadata-shadows" aria-labelledby="remote-book-metadata-shadows-title">
    <h2 id="remote-book-metadata-shadows-title">{labels.remoteShelfHeading}</h2>
    <div className="remote-book-metadata-shadows__grid">
      {shadows.map((shadow) => <article className="remote-book-metadata-shadow" key={shadow.key}>
        <div className={`remote-book-metadata-shadow__cover ${shadow.cover}`} aria-hidden="true">{shadow.title.slice(0, 1)}</div>
        <div className="remote-book-metadata-shadow__content">
          <p className="remote-book-metadata-shadow__status">{labels.remoteShelfReimportStatus}</p>
          <h3>{shadow.title}</h3>
          <p className="remote-book-metadata-shadow__author">{shadow.author}</p>
          <p className="remote-book-metadata-shadow__language">{shadow.language}</p>
          <p className="remote-book-metadata-shadow__copy">{labels.remoteShelfReimportCopy}</p>
          <div className="remote-book-metadata-shadow__footer">
            <span>{labels.remoteShelfProgress} {Math.round(shadow.progress)}%</span>
            <button type="button" onClick={() => onReimport(shadow)}>{labels.remoteShelfReimportAction}</button>
          </div>
        </div>
      </article>)}
    </div>
  </section>
}
