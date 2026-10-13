import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { WORLD_LANGUAGE_CODES } from '../lib/world-library'
import './reading-language-picker.css'

type ReadingLanguagePickerProps = {
  value: string
  onChange: (value: string) => void
  locale: string
  label: string
  searchLabel: string
  searchPlaceholder: string
  emptyLabel?: string
  disabled?: boolean
  className?: string
}

type LanguageOption = {
  id: string
  value: string
  label: string
  englishLabel: string
  searchText: string
}

const legacyValues: Record<string, string> = {
  '中文': 'Chinese (Simplified)',
  English: 'English',
  '日本語': 'Japanese',
  'Français': 'French',
}

function isReadableLanguageName(value: string | undefined, code: string): value is string {
  if (!value) return false
  const normalized = value.trim()
  return Boolean(normalized) && !/^[a-z]{2,3}$/i.test(normalized) && normalized.toLocaleLowerCase() !== code.toLocaleLowerCase()
}

function languageName(code: string, locale: string): string | undefined {
  try {
    const localized = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    if (isReadableLanguageName(localized, code)) return localized
  } catch { /* A browser without Intl.DisplayNames falls back to English below. */ }

  try {
    const english = new Intl.DisplayNames(['en'], { type: 'language' }).of(code)
    return isReadableLanguageName(english, code) ? english : undefined
  } catch {
    return undefined
  }
}

/**
 * A controlled, searchable target-language selector for AI translation and
 * explanation. Its externally stored value is always an English display name,
 * never an ISO code, so it can be sent directly to human-facing AI prompts.
 */
export default function ReadingLanguagePicker({
  value,
  onChange,
  locale,
  label,
  searchLabel,
  searchPlaceholder,
  emptyLabel = searchPlaceholder,
  disabled = false,
  className = '',
}: ReadingLanguagePickerProps) {
  const generatedId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const options = useMemo<LanguageOption[]>(() => {
    const seenValues = new Set<string>()
    return WORLD_LANGUAGE_CODES.flatMap((code): LanguageOption[] => {
      const englishLabel = languageName(code, 'en')
      if (!englishLabel || seenValues.has(englishLabel)) return []
      seenValues.add(englishLabel)
      const label = languageName(code, locale) ?? englishLabel
      return [{
        id: code,
        value: englishLabel,
        label,
        englishLabel,
        searchText: `${label} ${englishLabel}`.toLocaleLowerCase(locale),
      }]
    }).sort((left, right) => left.label.localeCompare(right.label, locale))
  }, [locale])

  const normalizedValue = legacyValues[value] ?? value
  const selected = options.find((option) => option.value === normalizedValue)
  const visibleOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    return normalized ? options.filter((option) => option.searchText.includes(normalized)) : options
  }, [locale, options, query])

  useEffect(() => {
    function closeOnOutsidePointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsidePointer)
    return () => document.removeEventListener('mousedown', closeOnOutsidePointer)
  }, [])

  useEffect(() => {
    if (!open) return
    setActiveIndex(Math.max(0, visibleOptions.findIndex((option) => option.value === normalizedValue)))
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open]) // Query navigation owns the active index after the picker opens.

  function closePicker() {
    setOpen(false)
    setQuery('')
  }

  function select(option: LanguageOption | undefined) {
    if (!option) return
    onChange(option.value)
    closePicker()
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(visibleOptions.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      select(visibleOptions[activeIndex])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closePicker()
    }
  }

  return <div className={`reading-language-picker ${className}`.trim()} ref={rootRef}>
    <span className="reading-language-picker__label" id={`${generatedId}-label`}>{label}</span>
    <button
      type="button"
      className="reading-language-picker__trigger"
      aria-labelledby={`${generatedId}-label ${generatedId}-value`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${generatedId}-listbox`}
      disabled={disabled}
      onClick={() => open ? closePicker() : setOpen(true)}
    >
      <span id={`${generatedId}-value`}>{selected?.label ?? legacyValues[value] ?? value}</span>
      <span aria-hidden="true" className="reading-language-picker__chevron">⌄</span>
    </button>
    {open && <div className="reading-language-picker__popover">
      <input
        ref={searchRef}
        type="search"
        className="reading-language-picker__search"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
        onKeyDown={onSearchKeyDown}
        placeholder={searchPlaceholder}
        aria-label={searchLabel}
        aria-controls={`${generatedId}-listbox`}
        aria-activedescendant={visibleOptions[activeIndex] ? `${generatedId}-${visibleOptions[activeIndex].id}` : undefined}
      />
      <div className="reading-language-picker__options" id={`${generatedId}-listbox`} role="listbox" aria-label={label}>
        {visibleOptions.map((option, index) => <button
          type="button"
          id={`${generatedId}-${option.id}`}
          key={option.id}
          role="option"
          aria-selected={option.value === normalizedValue}
          className={`${option.value === normalizedValue ? 'is-selected' : ''} ${index === activeIndex ? 'is-active' : ''}`.trim()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => select(option)}
        >
          <span>{option.label}</span>
          {option.label !== option.englishLabel && <small>{option.englishLabel}</small>}
        </button>)}
        {visibleOptions.length === 0 && <p role="status">{emptyLabel}</p>}
      </div>
    </div>}
  </div>
}
