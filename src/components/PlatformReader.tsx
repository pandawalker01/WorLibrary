import { useEffect, useState } from 'react'
import { requestPlatformReaderAccess, type PlatformReaderAccess } from '../lib/platform-reader'
import type { UiLocale } from '../lib/i18n'
import PlatformEpubReader from './PlatformEpubReader'
import PlatformPdfReader from './PlatformPdfReader'
import './platform-reader.css'

type PlatformReaderProps = {
  editionId: string
  title: string
  author?: string
  uiLocale: UiLocale
  accessToken?: string
  onBack: () => void
}

type ReaderState =
  | { kind: 'loading' }
  | { kind: 'ready'; access: PlatformReaderAccess }
  | { kind: 'error'; message: string; retryable: boolean }

const labels = {
  'zh-CN': {
    back: '← 返回书库', checking: '正在验证平台阅读权限…', unavailable: '平台内容尚未配置，不能打开', unavailableCopy: '该版本已识别为可在线阅读，但平台尚未配置合规正文交付。不会跳转到第三方页面，也不会显示不存在的正文。', retry: '重新验证', rights: '访问说明', error: '暂时无法验证阅读权限', errorCopy: '请稍后重试；若问题持续，请返回书库查看该书的来源与可读状态。', unsupported: '暂不支持此平台文件格式', unsupportedCopy: '交付端点没有返回可安全渲染的 EPUB 或 PDF 格式；正文不会被下载或保存。',
  },
  en: {
    back: '← Back to library', checking: 'Checking platform reading access…', unavailable: 'This platform title is not configured yet', unavailableCopy: 'This edition is marked as online-readable, but compliant content delivery has not been configured. WorLibrary will not redirect you to a third-party page or pretend that text is available.', retry: 'Check again', rights: 'Access details', error: 'Reading access could not be verified', errorCopy: 'Try again shortly. If this continues, return to the library to review this title’s source and access state.', unsupported: 'This platform file format is not supported yet', unsupportedCopy: 'The delivery endpoint did not return a safely renderable EPUB or PDF format. Book text is neither downloaded nor saved.',
  },
} as const

export default function PlatformReader({ editionId, title, author, uiLocale, accessToken, onBack }: PlatformReaderProps) {
  const [state, setState] = useState<ReaderState>({ kind: 'loading' })
  const ui = labels[uiLocale]

  const checkAccess = () => {
    setState({ kind: 'loading' })
    void requestPlatformReaderAccess(editionId, accessToken)
      .then((access) => setState({ kind: 'ready', access }))
      .catch((error: unknown) => {
        const details = error as { message?: string; retryable?: boolean; status?: number }
        setState({ kind: 'error', message: details.message || ui.error, retryable: details.retryable === true || (details.status ?? 0) >= 500 })
      })
  }

  useEffect(() => { checkAccess() }, [editionId, accessToken])

  return <section className="platform-reader" aria-labelledby="platform-reader-title">
    <header className="platform-reader__header">
      <button className="back-button" onClick={onBack}>{ui.back}</button>
      <div><h1 id="platform-reader-title">{title}</h1>{author && <p>{author}</p>}</div>
    </header>
    <div className="platform-reader__stage" aria-live="polite">
      {state.kind === 'loading' && <p role="status">{ui.checking}</p>}
      {state.kind === 'error' && <div className="platform-reader__notice is-error" role="alert"><h2>{ui.error}</h2><p>{state.message}</p><p>{ui.errorCopy}</p><button onClick={checkAccess}>{ui.retry}</button></div>}
      {state.kind === 'ready' && !state.access.delivery.available && <div className="platform-reader__notice" role="status"><h2>{ui.unavailable}</h2><p>{ui.unavailableCopy}</p>{state.access.rightsNotice && <p><strong>{ui.rights}：</strong>{state.access.rightsNotice}</p>}<button onClick={checkAccess}>{ui.retry}</button></div>}
      {state.kind === 'ready' && state.access.delivery.available && state.access.delivery.contentType === 'application/epub+zip' && <PlatformEpubReader editionId={editionId} accessToken={accessToken} uiLocale={uiLocale} />}
      {state.kind === 'ready' && state.access.delivery.available && state.access.delivery.contentType === 'application/pdf' && <PlatformPdfReader editionId={editionId} accessToken={accessToken} uiLocale={uiLocale} />}
      {state.kind === 'ready' && state.access.delivery.available && !state.access.delivery.contentType && <div className="platform-reader__notice" role="status"><h2>{ui.unsupported}</h2><p>{ui.unsupportedCopy}</p>{state.access.rightsNotice && <p><strong>{ui.rights}：</strong>{state.access.rightsNotice}</p>}<button onClick={checkAccess}>{ui.retry}</button></div>}
    </div>
  </section>
}
