import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { WORLD_LANGUAGE_CODES, worldLanguageName } from '../lib/world-library'
import './world-language-picker.css'

type WorldLanguagePickerProps = {
  value: string
  onChange: (value: string) => void
  locale: string
  label: string
  allLanguagesLabel: string
  searchLabel: string
  searchPlaceholder: string
  className?: string
  disabled?: boolean
}

type LanguageOption = { value: string; label: string; searchText: string }

function readableLanguageName(code: string, locale: string): string | undefined {
  const localized = worldLanguageName(code, locale)
  // Some engines canonicalize an ISO 639-3 code to a short, lowercase BCP-47
  // alias (for example `bis` -> `bi`) instead of returning a display name.
  // That is still a code, not readable UI text.
  if (localized && !/^[a-z]{2,3}$/.test(localized.trim()) && localized.toLocaleLowerCase() !== code.toLocaleLowerCase()) return localized

  // A browser can lack a localized label for a particular ISO 639-3 code while
  // still know its English name. Do not render a bare code as a user option.
  const english = worldLanguageName(code, 'en')
  if (english && !/^[a-z]{2,3}$/.test(english.trim()) && english.toLocaleLowerCase() !== code.toLocaleLowerCase()) return english
  return undefined
}

export default function WorldLanguagePicker({
  value,
  onChange,
  locale,
  label,
  allLanguagesLabel,
  searchLabel,
  searchPlaceholder,
  className = '',
  disabled = false,
}: WorldLanguagePickerProps) {
  const generatedId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const options = useMemo<LanguageOption[]>(() => WORLD_LANGUAGE_CODES
    .flatMap((code): LanguageOption[] => {
      const label = readableLanguageName(code, locale)
      return label ? [{ value: code, label, searchText: `${label} ${code}`.toLocaleLowerCase(locale) }] : []
    })
    // Keep the final rendering boundary defensive even if a browser's Intl
    // implementation returns a normalized code unexpectedly.
    .filter((option) => !/^[a-z]{2,3}$/.test(option.label.trim()))
    .sort((left, right) => left.label.localeCompare(right.label, locale)), [locale])

  const selected = options.find((option) => option.value === value)
  const visibleOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    return normalized ? options.filter((option) => option.searchText.includes(normalized)) : options
  }, [locale, options, query])

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  useEffect(() => {
    if (!open) return
    const selectedIndex = visibleOptions.findIndex((option) => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open]) // visible options deliberately update active position in the input handler.

  function openPicker() {
    if (disabled) return
    setQuery('')
    setOpen(true)
  }

  function select(option: LanguageOption | undefined) {
    if (!option) return
    onChange(option.value)
    setOpen(false)
    setQuery('')
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(visibleOptions.length - 1, 0)))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      select(visibleOptions[activeIndex])
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  function onSearchChange(nextQuery: string) {
    setQuery(nextQuery)
    setActiveIndex(0)
  }

  return <div className={`world-language-picker ${className}`.trim()} ref={rootRef}>
    <span className="world-language-picker__label" id={`${generatedId}-label`}>{label}</span>
    <button
      type="button"
      className="world-language-picker__trigger"
      aria-labelledby={`${generatedId}-label ${generatedId}-value`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${generatedId}-listbox`}
      disabled={disabled}
      onClick={() => open ? setOpen(false) : openPicker()}
    >
      <span id={`${generatedId}-value`}>{selected?.label ?? allLanguagesLabel}</span>
      <span aria-hidden="true" className="world-language-picker__chevron">⌄</span>
    </button>
    {open && <div className="world-language-picker__popover">
      <input
        ref={searchRef}
        type="search"
        className="world-language-picker__search"
        value={query}
        onChange={(event) => onSearchChange(event.target.value)}
        onKeyDown={onSearchKeyDown}
        placeholder={searchPlaceholder}
        aria-label={searchLabel}
        aria-controls={`${generatedId}-listbox`}
        aria-activedescendant={visibleOptions[activeIndex] ? `${generatedId}-${visibleOptions[activeIndex].value}` : undefined}
      />
      <div className="world-language-picker__options" id={`${generatedId}-listbox`} role="listbox" aria-label={label}>
        <button
          type="button"
          role="option"
          aria-selected={!value}
          className={!value ? 'is-selected' : ''}
          onClick={() => { onChange(''); setOpen(false); setQuery('') }}
        >{allLanguagesLabel}</button>
        {visibleOptions.map((option, index) => <button
          type="button"
          id={`${generatedId}-${option.value}`}
          key={option.value}
          role="option"
          aria-selected={option.value === value}
          className={`${option.value === value ? 'is-selected' : ''} ${index === activeIndex ? 'is-active' : ''}`.trim()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => select(option)}
        >{option.label}</button>)}
        {visibleOptions.length === 0 && <p role="status">{searchPlaceholder}</p>}
      </div>
    </div>}
  </div>
}
