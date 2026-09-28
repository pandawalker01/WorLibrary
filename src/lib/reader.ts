export type ReaderTheme = 'paper' | 'night' | 'sepia'

export type ReaderPreferences = {
  theme: ReaderTheme
  fontScale: number
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = { theme: 'paper', fontScale: 1 }

export function clampFontScale(value: number): number {
  return Math.max(0.85, Math.min(1.35, Number(value.toFixed(2))))
}

export function cycleTheme(theme: ReaderTheme): ReaderTheme {
  return theme === 'paper' ? 'sepia' : theme === 'sepia' ? 'night' : 'paper'
}

export function readerThemeLabel(theme: ReaderTheme): string {
  return theme === 'paper' ? '纸张' : theme === 'sepia' ? '暖页' : '夜间'
}
