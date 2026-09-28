declare module 'epubjs' {
  type EpubBook = {
    ready: Promise<unknown>
    loaded: { navigation: Promise<{ toc: Array<{ label: string; href: string }> }> }
    locations: {
      generate: (chars: number) => Promise<void>
      percentageFromCfi: (cfi: string) => number
    }
    renderTo: (element: HTMLElement, options: { width: string; height: string; allowScriptedContent?: boolean }) => EpubRendition
    destroy: () => void
  }

  type EpubRendition = {
    display: (target?: string) => Promise<void>
    on: (event: string, callback: (...args: any[]) => void) => void
    annotations?: { highlight: (cfi: string, styles?: Record<string, string>, data?: Record<string, unknown>) => void }
    destroy: () => void
  }

  const ePub: (book: ArrayBuffer) => EpubBook
  export default ePub
}
