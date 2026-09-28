import type { ReactNode } from 'react'
import { alignmentMode, type Alignment, type Edition } from '../lib/edition'
import '../reader-layout.css'

type EditionComparisonReaderProps = {
  left: Edition
  right: Edition
  alignment?: Alignment
  leftContent: ReactNode
  rightContent: ReactNode
  onSwitch?: (edition: Edition) => void
}

export default function EditionComparisonReader({ left, right, alignment, leftContent, rightContent, onSwitch }: EditionComparisonReaderProps) {
  const mode = alignmentMode(alignment)
  return <section className={`edition-comparison ${mode}`} aria-label="双译本对照阅读">
    <div className="edition-comparison-header"><div><span>对照阅读</span><strong>{mode === 'aligned' ? '章节已对齐' : '独立滚动'}</strong></div><button onClick={() => onSwitch?.(right)}>切换到 {right.label}</button></div>
    <div className="edition-comparison-panes"><article><header><span>{left.language}</span><strong>{left.label}</strong></header>{leftContent}</article><article><header><span>{right.language}</span><strong>{right.label}</strong></header>{rightContent}</article></div>
    {mode === 'independent' && <p className="edition-comparison-note">当前版本无法可靠对齐，两个栏可以独立滚动，不会覆盖各自进度。</p>}
  </section>
}
