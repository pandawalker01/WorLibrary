export type ReaderTheme = 'paper' | 'night' | 'sepia'

export type ReaderPreferences = {
  theme: ReaderTheme
  fontScale: number
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = { theme: 'paper', fontScale: 1 }

const READER_PREFERENCES_KEY = 'worlibrary.reader-preferences'

function isReaderTheme(value: unknown): value is ReaderTheme {
  return value === 'paper' || value === 'sepia' || value === 'night'
}

/**
 * Reader preferences are deliberately device-local. They only affect rendering,
 * so they do not need to be part of a book backup or a remote sync payload.
 */
export function loadReaderPreferences(): ReaderPreferences {
  try {
    const raw = window.localStorage.getItem(READER_PREFERENCES_KEY)
    if (!raw) return DEFAULT_READER_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<ReaderPreferences>
    return {
      theme: isReaderTheme(parsed.theme) ? parsed.theme : DEFAULT_READER_PREFERENCES.theme,
      fontScale: typeof parsed.fontScale === 'number' ? clampFontScale(parsed.fontScale) : DEFAULT_READER_PREFERENCES.fontScale,
    }
  } catch {
    return DEFAULT_READER_PREFERENCES
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences): void {
  try {
    window.localStorage.setItem(READER_PREFERENCES_KEY, JSON.stringify({
      theme: preferences.theme,
      fontScale: clampFontScale(preferences.fontScale),
    }))
  } catch {
    // Private browsing or a full storage quota must not prevent reading.
  }
}

export function clampFontScale(value: number): number {
  return Math.max(0.85, Math.min(1.35, Number(value.toFixed(2))))
}

export function cycleTheme(theme: ReaderTheme): ReaderTheme {
  return theme === 'paper' ? 'sepia' : theme === 'sepia' ? 'night' : 'paper'
}

export function readerThemeLabel(theme: ReaderTheme): string {
  return theme === 'paper' ? '纸张' : theme === 'sepia' ? '暖页' : '夜间'
}
