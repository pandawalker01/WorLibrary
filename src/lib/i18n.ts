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
    library: '书库', highlights: '摘录', settings: '设置', offlineReady: '离线可读', offlineNow: '当前离线',
    offlineBanner: '当前离线：已导入的本地书籍仍可阅读；翻译、OCR 与同步将在联网后恢复。',
    interfaceLanguage: '界面语言', readingLanguage: '理解语言', importBook: '导入书籍',
    shelf: 'YOUR SHELF', hero: '把世界的书，', heroEmphasis: '读成自己的语言。',
    heroCopy: '导入你的书，关联不同译本。划线即可获得翻译与解释——即使离线，也能继续阅读和思考。',
    searchPlaceholder: '搜索书名、作者或正文（本地）', searchLibrary: '搜索书库', clearSearch: '清除搜索',
    all: '全部', reading: '正在读', editions: '多译本', recent: '最近阅读 ↓', alphabetical: '书名排序 A–Z',
    emptyShelf: '你的书架还是空的。导入 EPUB 或 PDF 后，书籍会只保存在这台设备上。',
    importMine: '导入我的书', localReading: '本地阅读', preferences: 'PREFERENCES',
    settingsTitle: '阅读与界面语言', uiLanguageTitle: '界面语言', uiLanguageCopy: '切换书库、设置和阅读器控制的界面文案；不会改变翻译目标语言。',
    readingLanguageTitle: '理解语言', readingLanguageCopy: 'AI 会把你划线的任意语言文本，翻译并解释成这个语言。',
    readingLanguageSaved: '已将 AI 理解语言设为：', uiLanguageSaved: '界面语言已切换为：',
    localBooks: '本地书籍管理', privacyTitle: '你的书，留在你的设备上。', privacyCopy: '已导入的书籍、阅读进度和摘录均可离线访问；仅在你请求解释或识别文字时，相关内容才会发送至 AI 服务。',
  },
  en: {
    library: 'Library', highlights: 'Highlights', settings: 'Settings', offlineReady: 'Offline ready', offlineNow: 'Offline',
    offlineBanner: 'You are offline: imported books remain readable; translation, OCR, and sync resume when you reconnect.',
    interfaceLanguage: 'Interface', readingLanguage: 'Reading language', importBook: 'Import book',
    shelf: 'YOUR SHELF', hero: 'Read the world’s books', heroEmphasis: 'in your own language.',
    heroCopy: 'Import your books and link editions. Select a passage for translation and explanation—then keep reading, even offline.',
    searchPlaceholder: 'Search title, author, or text (local)', searchLibrary: 'Search library', clearSearch: 'Clear search',
    all: 'All', reading: 'Reading', editions: 'Editions', recent: 'Recent ↓', alphabetical: 'Title A–Z',
    emptyShelf: 'Your shelf is empty. Import an EPUB or PDF; books stay on this device.',
    importMine: 'Import my book', localReading: 'Local reading', preferences: 'PREFERENCES',
    settingsTitle: 'Reading & interface languages', uiLanguageTitle: 'Interface language', uiLanguageCopy: 'Changes the library, settings, and reader controls. It does not change your translation target.',
    readingLanguageTitle: 'Reading language', readingLanguageCopy: 'AI translates and explains any selected passage into this language.',
    readingLanguageSaved: 'AI reading language set to: ', uiLanguageSaved: 'Interface language changed to: ',
    localBooks: 'Local books', privacyTitle: 'Your books stay on your device.', privacyCopy: 'Imported books, progress, and highlights work offline. Only text you ask to explain or recognize is sent to AI services.',
  },
} as const
