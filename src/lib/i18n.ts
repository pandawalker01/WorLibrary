export type UiLocale = 'zh-CN' | 'en'

export type ReadingLanguage = '中文' | 'English' | '日本語' | 'Français'

const UI_LOCALE_KEY = 'worlibrary.ui-locale'
const READING_LANGUAGE_KEY = 'worlibrary.reading-language'

export const UI_LOCALES: Array<{ value: UiLocale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

export const READING_LANGUAGES: Array<{ value: ReadingLanguage; zhLabel: string; enLabel: string }> = [
  { value: '中文', zhLabel: '简体中文', enLabel: 'Chinese (Simplified)' },
  { value: 'English', zhLabel: '英语', enLabel: 'English' },
  { value: '日本語', zhLabel: '日语', enLabel: 'Japanese' },
  { value: 'Français', zhLabel: '法语', enLabel: 'French' },
]

export function loadUiLocale(): UiLocale {
  try {
    return window.localStorage.getItem(UI_LOCALE_KEY) === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export function saveUiLocale(locale: UiLocale): void {
  try { window.localStorage.setItem(UI_LOCALE_KEY, locale) } catch { /* Storage must not block reading. */ }
}

export function loadReadingLanguage(): ReadingLanguage {
  try {
    const saved = window.localStorage.getItem(READING_LANGUAGE_KEY)
    return READING_LANGUAGES.some((language) => language.value === saved) ? saved as ReadingLanguage : '中文'
  } catch {
    return '中文'
  }
}

export function saveReadingLanguage(language: ReadingLanguage): void {
  try { window.localStorage.setItem(READING_LANGUAGE_KEY, language) } catch { /* Storage must not block reading. */ }
}

export const copy = {
  'zh-CN': {
    library: '书库', highlights: '摘录', profile: '我的', settings: '设置', account: '个人账户', signIn: '登录', guestAccount: '访客', offlineReady: '离线可读', offlineNow: '当前离线',
    offlineBanner: '当前离线：已导入的本地书籍仍可阅读；翻译、OCR 与同步将在联网后恢复。',
    updateReady: '有新版本可用', updateNow: '立即更新',
    interfaceLanguage: '界面语言', readingLanguage: '理解语言', importBook: '导入书籍',
    shelf: 'YOUR SHELF', hero: '把世界的书，', heroEmphasis: '读成自己的语言。',
    heroCopy: '导入你的书，关联不同译本。划线即可获得翻译与解释——即使离线，也能继续阅读和思考。',
    searchPlaceholder: '搜索书名、作者或正文（本地）', searchLibrary: '搜索书库', clearSearch: '清除搜索',
    all: '全部', reading: '正在读', editions: '多译本', recent: '最近阅读 ↓', alphabetical: '书名排序 A–Z',
    emptyShelf: '你的书架还是空的。导入 EPUB 或 PDF 后，书籍会只保存在这台设备上。',
    importMine: '导入我的书', localReading: '本地阅读', preferences: 'PREFERENCES',
    profileEyebrow: 'MY READING', profileTitle: '我的阅读', profileCopy: '阅读进度、摘录与时光，都留在这台设备上。', readingTime: '累计阅读', booksOwned: '本地书籍', booksInProgress: '正在阅读', booksCompleted: '已完成', highlightsSaved: '保存摘录', recentReading: '最近阅读', recentReadingCopy: '从上次停下的地方继续。', profileEmpty: '还没有阅读记录', profileEmptyCopy: '打开一本书开始阅读，时长和进度会自动保存在本地。', profileLocalOnly: '阅读数据仅保存在本地设备。', notReadYet: '尚未阅读',
    settingsTitle: '阅读与界面语言', uiLanguageTitle: '界面语言', uiLanguageCopy: '切换书库、设置和阅读器控制的界面文案；不会改变翻译目标语言。',
    readingLanguageTitle: '理解语言', readingLanguageCopy: 'AI 会把你划线的任意语言文本，翻译并解释成这个语言。',
    readingLanguageSaved: '已将 AI 理解语言设为：', uiLanguageSaved: '界面语言已切换为：',
    localBooks: '本地书籍管理', privacyTitle: '你的书，留在你的设备上。', privacyCopy: '已导入的书籍、阅读进度和摘录均可离线访问；仅在你请求解释或识别文字时，相关内容才会发送至 AI 服务。',
    booksMatched: '找到 {count} 本匹配书籍', noMatches: '没有找到匹配的书籍或筛选结果', textMatch: '正文命中：', cover: '封面',
    backToLibrary: '书库', compare: '⇄ 对照阅读', exitCompare: '↹ 退出对照', linkEdition: '＋ 关联译本', singleEdition: '单版本阅读', nowReading: '正在阅读',
    localFileMissing: '找不到这本本地书籍，请返回书库重新导入。', savedLocally: '进度已保存到本机', scanPage: '◎ 扫描页？识别文字',
    manageCover: '重新读取封面', readingCover: '读取封面中…', uploadCover: '上传本地封面', editInfo: '编辑信息', delete: '删除',
    exportReading: '导出阅读数据', importReading: '导入阅读数据', readingAssistant: '阅读助手', translation: '翻译', explanation: '解释',
    previousPage: '上一页', nextPage: '下一页', contents: '目录', collapseContents: '收起目录', contentsUnavailable: '目录不可用', saveHighlight: '保存摘录', cancel: '取消', closeSelection: '关闭选区操作', retryTranslation: '重试翻译',
    readerLayout: '阅读排版', fontSize: '字号', decreaseFont: '减小字号', increaseFont: '增大字号', readerTheme: '阅读主题', paperTheme: '纸张', sepiaTheme: '暖页', nightTheme: '夜间',
    selectedTextActions: '已选文字操作', highlightColors: '摘录颜色', gold: '金色', rose: '玫红', blue: '蓝色',
    pdfPageText: 'PDF 当前页文字', ocrPageText: 'OCR 当前页文字', ocrResults: '识别结果', ocrResultsCopy: '校正并确认后，可选择、复制、翻译或保存为摘录', ocrCorrectionLabel: '校正识别文字', confirmOcrCorrection: '确认校正', ocrCorrectionReady: '当前识别文字可直接使用；编辑后请确认。', ocrCorrectionSaved: '已确认校正；后续翻译和摘录会使用该文字。', ocrCorrectionPending: '编辑后请确认，翻译和摘录才会使用新文字。', retryOcr: '重新识别本页',
    excerptsTitle: '摘录空间', excerptsCopy: '把读过的句子留下来，按书籍回看，也可以随时补充自己的理解。', searchHighlights: '搜索摘录', highlightSearchPlaceholder: '句子、备注或书名', filterBooks: '筛选书籍', allHighlights: '全部摘录', noHighlights: '还没有摘录', noHighlightsCopy: '打开一本 EPUB，选择你想留下的句子即可保存到这里。', localHighlight: '本地摘录', openOriginal: '打开原文', editNote: '编辑备注', addNote: '添加备注', saveNote: '保存备注',
    accountSync: '账号与同步', syncLocal: '本地优先 · 尚未配置云端同步', syncPrivacy: '仅同步阅读进度、摘录与书籍信息；原始 EPUB/PDF 文件和封面始终留在本机。',
  },
  en: {
    library: 'Library', highlights: 'Highlights', profile: 'Me', settings: 'Settings', account: 'Account', signIn: 'Sign in', guestAccount: 'Guest', offlineReady: 'Offline ready', offlineNow: 'Offline',
    offlineBanner: 'You are offline: imported books remain readable; translation, OCR, and sync resume when you reconnect.',
    updateReady: 'A new version is ready', updateNow: 'Update now',
    interfaceLanguage: 'Interface', readingLanguage: 'Reading language', importBook: 'Import book',
    shelf: 'YOUR SHELF', hero: 'Read the world’s books', heroEmphasis: 'in your own language.',
    heroCopy: 'Import your books and link editions. Select a passage for translation and explanation—then keep reading, even offline.',
    searchPlaceholder: 'Search title, author, or text (local)', searchLibrary: 'Search library', clearSearch: 'Clear search',
    all: 'All', reading: 'Reading', editions: 'Editions', recent: 'Recent ↓', alphabetical: 'Title A–Z',
    emptyShelf: 'Your shelf is empty. Import an EPUB or PDF; books stay on this device.',
    importMine: 'Import my book', localReading: 'Local reading', preferences: 'PREFERENCES',
    profileEyebrow: 'MY READING', profileTitle: 'My reading', profileCopy: 'Your progress, highlights, and reading time stay on this device.', readingTime: 'Reading time', booksOwned: 'Local books', booksInProgress: 'In progress', booksCompleted: 'Completed', highlightsSaved: 'Saved highlights', recentReading: 'Continue reading', recentReadingCopy: 'Pick up right where you left off.', profileEmpty: 'No reading history yet', profileEmptyCopy: 'Open a book to start keeping time and progress on this device.', profileLocalOnly: 'Reading data is stored only on this device.', notReadYet: 'Not read yet',
    settingsTitle: 'Reading & interface languages', uiLanguageTitle: 'Interface language', uiLanguageCopy: 'Changes the library, settings, and reader controls. It does not change your translation target.',
    readingLanguageTitle: 'Reading language', readingLanguageCopy: 'AI translates and explains any selected passage into this language.',
    readingLanguageSaved: 'AI reading language set to: ', uiLanguageSaved: 'Interface language changed to: ',
    localBooks: 'Local books', privacyTitle: 'Your books stay on your device.', privacyCopy: 'Imported books, progress, and highlights work offline. Only text you ask to explain or recognize is sent to AI services.',
    booksMatched: '{count} matching books', noMatches: 'No books match this search or filter.', textMatch: 'Text match: ', cover: 'cover',
    backToLibrary: 'Library', compare: '⇄ Compare editions', exitCompare: '↹ Exit comparison', linkEdition: '＋ Link an edition', singleEdition: 'Single-edition reading', nowReading: 'Now reading',
    localFileMissing: 'This local book cannot be found. Return to the library and import it again.', savedLocally: 'Progress saved on this device', scanPage: '◎ Scan page · recognize text',
    manageCover: 'Read cover again', readingCover: 'Reading cover…', uploadCover: 'Upload local cover', editInfo: 'Edit details', delete: 'Delete',
    exportReading: 'Export reading data', importReading: 'Import reading data', readingAssistant: 'Reading assistant', translation: 'Translation', explanation: 'Explanation',
    previousPage: 'Previous page', nextPage: 'Next page', contents: 'Contents', collapseContents: 'Hide contents', contentsUnavailable: 'Contents unavailable', saveHighlight: 'Save highlight', cancel: 'Cancel', closeSelection: 'Close selected-text actions', retryTranslation: 'Retry translation',
    readerLayout: 'Reading layout', fontSize: 'Font size', decreaseFont: 'Decrease font size', increaseFont: 'Increase font size', readerTheme: 'Theme', paperTheme: 'Paper', sepiaTheme: 'Sepia', nightTheme: 'Night',
    selectedTextActions: 'Selected text actions', highlightColors: 'Highlight color', gold: 'Gold', rose: 'Rose', blue: 'Blue',
    pdfPageText: 'PDF text on this page', ocrPageText: 'OCR text on this page', ocrResults: 'Recognition result', ocrResultsCopy: 'Correct and confirm the text, then select, copy, translate, or save it as a highlight.', ocrCorrectionLabel: 'Correct recognized text', confirmOcrCorrection: 'Confirm correction', ocrCorrectionReady: 'This recognized text is ready to use. Confirm any edits first.', ocrCorrectionSaved: 'Correction confirmed. Translation and highlights now use this text.', ocrCorrectionPending: 'Confirm your edit before translation and highlights use the new text.', retryOcr: 'Retry this page',
    excerptsTitle: 'Your excerpts', excerptsCopy: 'Keep the sentences that matter, revisit them by book, and add your own reading notes.', searchHighlights: 'Search highlights', highlightSearchPlaceholder: 'Passage, note, or book', filterBooks: 'Filter books', allHighlights: 'All highlights', noHighlights: 'No highlights yet', noHighlightsCopy: 'Open an EPUB and select a passage to save it here.', localHighlight: 'Local highlight', openOriginal: 'Open original', editNote: 'Edit note', addNote: 'Add note', saveNote: 'Save note',
    accountSync: 'Account & sync', syncLocal: 'Local-first · cloud sync is not configured', syncPrivacy: 'Only reading progress, highlights, and book details sync. Original EPUB/PDF files and covers always stay on this device.',
  },
} as const

export type UiCopy = typeof copy[UiLocale]

export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}
