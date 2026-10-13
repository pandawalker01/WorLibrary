/**
 * Metadata only: translations remain owned by i18n.ts.  A locale can be
 * planned here before its complete copy pack is shipped, without exposing a
 * partially translated interface to readers.
 */
export type InterfaceLocaleCode =
  | 'zh-CN'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'es'
  | 'de'
  | 'pt-BR'
  | 'ru'
  | 'ar'

export type InterfaceLocaleStatus = 'available' | 'planned'

export type InterfaceLocale = {
  code: InterfaceLocaleCode
  language: string
  region?: string
  status: InterfaceLocaleStatus
  recommended: boolean
  direction: 'ltr' | 'rtl'
}

/**
 * `available` means a complete interface copy pack exists. `planned` items
 * establish the expansion order only; callers must not offer them for UI
 * switching until their copy, layout, and accessibility checks are complete.
 */
export const INTERFACE_LOCALES: readonly InterfaceLocale[] = [
  { code: 'zh-CN', language: 'zh', region: 'CN', status: 'available', recommended: true, direction: 'ltr' },
  { code: 'en', language: 'en', status: 'available', recommended: true, direction: 'ltr' },
  { code: 'ja', language: 'ja', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'ko', language: 'ko', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'fr', language: 'fr', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'es', language: 'es', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'de', language: 'de', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'pt-BR', language: 'pt', region: 'BR', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'ru', language: 'ru', status: 'planned', recommended: true, direction: 'ltr' },
  { code: 'ar', language: 'ar', status: 'planned', recommended: true, direction: 'rtl' },
] as const

export const DEFAULT_INTERFACE_LOCALE: InterfaceLocaleCode = 'zh-CN'

function languagePart(locale: string): string {
  return locale.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase() ?? ''
}

export function availableInterfaceLocales(): readonly InterfaceLocale[] {
  return INTERFACE_LOCALES.filter((locale) => locale.status === 'available')
}

export function recommendedInterfaceLocales(includePlanned = false): readonly InterfaceLocale[] {
  return INTERFACE_LOCALES.filter((locale) => locale.recommended && (includePlanned || locale.status === 'available'))
}

/** Resolves browser or stored values without ever selecting a planned locale. */
export function resolveInterfaceLocale(value: string | null | undefined, fallback: InterfaceLocaleCode = DEFAULT_INTERFACE_LOCALE): InterfaceLocaleCode {
  const available = availableInterfaceLocales()
  const normalized = value?.trim().replace(/_/g, '-')
  const exact = available.find((locale) => locale.code.toLowerCase() === normalized?.toLowerCase())
  if (exact) return exact.code

  const matchingLanguage = available.find((locale) => locale.language === languagePart(normalized ?? ''))
  if (matchingLanguage) return matchingLanguage.code

  return available.some((locale) => locale.code === fallback) ? fallback : DEFAULT_INTERFACE_LOCALE
}

export function interfaceLocaleDirection(locale: string | null | undefined): 'ltr' | 'rtl' {
  const match = INTERFACE_LOCALES.find((item) => item.code.toLowerCase() === locale?.trim().replace(/_/g, '-').toLowerCase())
    ?? INTERFACE_LOCALES.find((item) => item.language === languagePart(locale ?? ''))
  return match?.direction ?? 'ltr'
}

export function isRightToLeftLocale(locale: string | null | undefined): boolean {
  return interfaceLocaleDirection(locale) === 'rtl'
}
