import { BedDouble, Check, ChevronDown, Plus, Search, Store, Utensils, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Vendor, VendorType } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { cn, townKey } from '../lib/utils'

/**
 * Pick a supplier by typing: the day's own towns first, then the rest A–Z; restaurants and hotels told
 * apart by their icon; full names (never cut off in the list). A combobox for keyboards and screen
 * readers: ↑ ↓ move, Enter picks, Esc closes.
 */
export function VendorSelect({ vendors, types, value, onChange, className, disabled, onAddNew, note, cities, only, placeholder }: {
  vendors: Vendor[]; types: VendorType[]; value: string | null; onChange: (id: string | null) => void
  className?: string; disabled?: boolean
  onAddNew?: () => void   // "+ Add new…" (a quick-create dialog)
  note?: (v: Vendor) => string   // extra text after the name (languages, "not available")
  cities?: string[]       // the day's places: their suppliers are listed first
  only?: (v: Vendor) => boolean   // within the types, which ones fit (hotels that serve meals)
  placeholder?: string    // what to do while empty ("Choose a hotel…"), else "—"
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const current = vendors.find((v) => v.id === value)

  const key = (c: string) => townKey(c)   // one town in any alphabet (Tbilisi = თბილისი)
  const first = [...new Set((cities ?? []).map(key).filter(Boolean))]
  const firstKey = first.join('|')
  // Groups: the day's towns first (in the day's order), then the others A–Z, no town last. In a group,
  // restaurants before hotels.
  const groups = useMemo(() => {
    const text = q.trim().toLowerCase()
    const fits = vendors.filter((v) => (types.includes(v.type) && !v.placeholder && (!only || only(v))) || v.id === value)
      .filter((v) => !text || v.name.toLowerCase().includes(text) || (v.city ?? '').toLowerCase().includes(text))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'hotel' ? 1 : b.type === 'hotel' ? -1 : 0))
    const by = new Map<string, Vendor[]>()
    for (const v of fits) by.set(key(v.city ?? ''), [...(by.get(key(v.city ?? '')) ?? []), v])
    return [...by.entries()].sort(([a], [b]) => {
      const ra = first.indexOf(a), rb = first.indexOf(b)
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
      if (!a || !b) return a ? -1 : 1
      return a.localeCompare(b)
    }).map(([k, vs]) => ({ k, label: k ? vs[0].city.trim() : t('noCity'), today: first.includes(k), vs }))
  }, [vendors, types, only, value, q, firstKey])   // eslint-disable-line react-hooks/exhaustive-deps
  // One flat order for the keyboard: "none", the suppliers, "add new".
  const flat: (Vendor | 'none' | 'new')[] = [...(value ? ['none' as const] : []), ...groups.flatMap((g) => g.vs), ...(onAddNew ? ['new' as const] : [])]

  const place = () => button.current && setRect(button.current.getBoundingClientRect())
  useLayoutEffect(() => { if (open) place() }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false)
    }
    // The list follows its field when the page (or a drawer) scrolls.
    window.addEventListener('mousedown', away)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [open])
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const close = (focus = true) => { setOpen(false); setQ(''); if (focus) button.current?.focus() }
  const choose = (x: Vendor | 'none' | 'new') => {
    if (x === 'new') onAddNew?.()
    else onChange(x === 'none' ? null : x.id)
    close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) choose(flat[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') close(false)
  }
  const openList = () => {
    if (disabled) return
    setActive(Math.max(0, flat.findIndex((x) => typeof x !== 'string' && x.id === value)))
    setOpen(true)
  }
  const icon = (v: Vendor) => v.type === 'hotel' ? <BedDouble size={14} aria-hidden /> : v.type === 'restaurant' ? <Utensils size={14} aria-hidden /> : <Store size={14} aria-hidden />
  // Below the field, or above it when there is no room.
  const below = !rect || window.innerHeight - rect.bottom > 300 || rect.top < 300
  let i = -1
  const n = () => ++i

  return (
    <>
      <button ref={button} type="button" disabled={disabled} onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList() } }}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
        title={current ? [current.name, current.city].filter(Boolean).join(' · ') : undefined}
        className={cn('flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-left text-sm text-slate-800',
          'hover:border-slate-800 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500 disabled:hover:border-slate-300',
          className)}>
        {current ? <>
          <span className="shrink-0 text-slate-500">{icon(current)}</span>
          <span className="min-w-0 flex-1 truncate">{current.name}{note?.(current) ?? ''}</span>
        </> : <span className="min-w-0 flex-1 truncate text-slate-500">{placeholder ?? '—'}</span>}
        <ChevronDown size={16} className="shrink-0 text-slate-500" aria-hidden />
      </button>
      {open && rect && createPortal(
        <div ref={list} className="fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
          style={{ left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 288) - 8), width: Math.max(rect.width, 288),
            ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }), maxHeight: 340 }}>
          <div className="relative border-b border-slate-100 p-2">
            <Search size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(value ? 1 : 0) }} onKeyDown={onKey}
              role="combobox" aria-expanded aria-controls={`${id}-list`} aria-activedescendant={`${id}-o${active}`} aria-autocomplete="list"
              placeholder={t('searchNameOrTown')} aria-label={t('searchNameOrTown')}
              className="h-8 w-full rounded-md border border-slate-200 pl-7 pr-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </div>
          <div id={`${id}-list`} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
            {value && (() => { const k = n(); return (
              <div id={`${id}-o${k}`} data-i={k} role="option" aria-selected={active === k} onMouseDown={(e) => { e.preventDefault(); choose('none') }}
                onMouseEnter={() => setActive(k)}
                className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-500', active === k && 'bg-slate-100')}>
                <X size={14} aria-hidden />{t('noneChosen')}
              </div>) })()}
            {groups.map((g) => (
              <div key={g.k || '-'} role="group" aria-label={g.label}>
                <div className="px-3 pb-0.5 pt-2 text-xs font-semibold text-slate-500">{g.label}{g.today && <span className="font-normal"> · {t('thisDay')}</span>}</div>
                {g.vs.map((v) => { const k = n(); return (
                  <div key={v.id} id={`${id}-o${k}`} data-i={k} role="option" aria-selected={v.id === value}
                    onMouseDown={(e) => { e.preventDefault(); choose(v) }} onMouseEnter={() => setActive(k)}
                    className={cn('flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm', active === k && 'bg-brand-50')}>
                    <span className="mt-0.5 shrink-0 text-slate-500">{icon(v)}</span>
                    <span className="min-w-0 flex-1 break-words text-slate-800">{v.name}{note?.(v) && <span className="text-slate-500">{note(v)}</span>}</span>
                    {v.id === value && <Check size={14} className="mt-0.5 shrink-0 text-brand-700" aria-hidden />}
                  </div>) })}
              </div>
            ))}
            {groups.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">{t('nothingFound')}</p>}
            {onAddNew && (() => { const k = n(); return (
              <div id={`${id}-o${k}`} data-i={k} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); choose('new') }}
                onMouseEnter={() => setActive(k)}
                className={cn('mt-1 flex cursor-pointer items-center gap-2 border-t border-slate-100 px-3 py-2 text-sm font-medium text-brand-700', active === k && 'bg-brand-50')}>
                <Plus size={14} aria-hidden />{t('addNewShort')}
              </div>) })()}
          </div>
        </div>, document.body)}
    </>
  )
}
