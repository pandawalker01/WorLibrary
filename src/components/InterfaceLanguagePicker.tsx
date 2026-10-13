import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { presentInterfaceLocales, type PresentedInterfaceLocale } from '../lib/interface-locale-registry'
import type { UiLocale } from '../lib/i18n'
import './interface-language-picker.css'

type InterfaceLanguagePickerProps = {
  value: UiLocale
  onChange: (value: UiLocale) => void
  locale: string
  label: string
  searchLabel: string
  searchPlaceholder: string
  availableLabel: string
  plannedLabel: string
  plannedCopy: string
  emptyLabel: string
}

type LocaleOption = PresentedInterfaceLocale & {
  searchText: string
}

/**
 * Shows the complete interface-language roadmap without allowing readers to
 * enter an interface whose translation pack is incomplete. Planned entries
 * remain searchable and visibly disabled rather than being silently hidden.
 */
export default function InterfaceLanguagePicker({
  value,
  onChange,
  locale,
  label,
  searchLabel,
  searchPlaceholder,
  availableLabel,
  plannedLabel,
  plannedCopy,
  emptyLabel,
}: InterfaceLanguagePickerProps) {
  const generatedId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const options = useMemo<LocaleOption[]>(() => presentInterfaceLocales(locale).map((item) => ({
    ...item,
    searchText: `${item.displayName} ${item.nativeName}`.toLocaleLowerCase(locale),
  })).sort((left, right) => {
    if (left.status !== right.status) return left.status === 'available' ? -1 : 1
    return left.displayName.localeCompare(right.displayName, locale)
  }), [locale])

  const selected = options.find((option) => option.code === value) ?? options[0]
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
    if (open) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  function closePicker() {
    setOpen(false)
    setQuery('')
  }

  function select(option: LocaleOption) {
    if (option.status !== 'available') return
    onChange(option.code as UiLocale)
    closePicker()
  }

  return <div className="interface-language-picker" ref={rootRef}>
    <span className="interface-language-picker__label" id={`${generatedId}-label`}>{label}</span>
    <button
      type="button"
      className="interface-language-picker__trigger"
      aria-labelledby={`${generatedId}-label ${generatedId}-value`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${generatedId}-listbox`}
      onClick={() => open ? closePicker() : setOpen(true)}
    >
      <span id={`${generatedId}-value`}>{selected?.displayName}</span>
      <span aria-hidden="true" className="interface-language-picker__chevron">⌄</span>
    </button>
    {open && <div className="interface-language-picker__popover">
      <input
        ref={searchRef}
        type="search"
        className="interface-language-picker__search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') closePicker() }}
        placeholder={searchPlaceholder}
        aria-label={searchLabel}
      />
      <div className="interface-language-picker__options" id={`${generatedId}-listbox`} role="listbox" aria-label={label}>
        {visibleOptions.map((option) => option.status === 'available' ? <button
          type="button"
          id={`${generatedId}-${option.code}`}
          key={option.code}
          role="option"
          aria-selected={option.code === value}
          className={option.code === value ? 'is-selected' : ''}
          onClick={() => select(option)}
        >
          <span><strong>{option.displayName}</strong>{option.nativeName !== option.displayName && <small>{option.nativeName}</small>}</span>
          <em>{availableLabel}</em>
        </button> : <div
          key={option.code}
          role="option"
          aria-selected="false"
          aria-disabled="true"
          className="interface-language-picker__planned"
        >
          <span><strong>{option.displayName}</strong>{option.nativeName !== option.displayName && <small>{option.nativeName}</small>}</span>
          <em>{plannedLabel}</em>
        </div>)}
        {visibleOptions.length === 0 && <p role="status">{emptyLabel}</p>}
      </div>
      <p className="interface-language-picker__note">{plannedCopy}</p>
    </div>}
  </div>
}
