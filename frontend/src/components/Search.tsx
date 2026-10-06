/**
 * Search everywhere: Ctrl+K (⌘K) or the magnifier opens one box that finds tours, tourists
 * (name or passport), clients, suppliers, routes — and for managers invoices and calculations.
 * Arrow keys move, Enter opens.
 */
import { useQuery } from '@tanstack/react-query'
import { Building2, Calculator, FileText, Map, Route, Search, Ticket, User, Users, UtensilsCrossed } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Dialog } from './overlay'

interface Hit { kind: string; id: string; title: string; subtitle: string; link: string }

const ICON: Record<string, ReactNode> = {
  tour: <Map size={16} />, participant: <User size={16} />, client: <Users size={16} />, vendor: <Building2 size={16} />,
  route: <Route size={16} />, invoice: <FileText size={16} />, quote: <Calculator size={16} />,
  menu: <UtensilsCrossed size={16} />, service: <Ticket size={16} />,
}

/** The magnifier button; also listens for Ctrl+K anywhere in the app. */
export function SearchButton({ className, shortcut = true, variant = 'icon' }: { className?: string; shortcut?: boolean; variant?: 'icon' | 'pill' }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!shortcut) return   // one listener only (the sidebar's); the phone bar's button just clicks
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcut])
  if (variant === 'pill') {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)} aria-label={t('searchAll')}
          className={cn('h-10 items-center gap-3 rounded-full bg-[var(--color-search-bg)] px-4 text-sm text-[var(--color-nav-icon)] hover:bg-[var(--color-search-hover)]', className)}>
          <Search size={18} /><span className="flex-1 text-left">{t('searchAnything')}</span>
          <kbd className="rounded border border-slate-300 px-1.5 text-[11px] text-[var(--color-nav-icon)]">Ctrl K</kbd>
        </button>
        {open && <SearchDialog onClose={() => setOpen(false)} />}
      </>
    )
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t('searchAll')} title={`${t('searchAll')} (Ctrl+K)`}
        className={cn('rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700', className)}>
        <Search size={18} />
      </button>
      {open && <SearchDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(0)
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 180); return () => clearTimeout(id) }, [q])
  const res = useQuery({
    queryKey: ['search', ws.id, debounced], enabled: debounced.length > 0,
    queryFn: () => api<Hit[]>(wsPath(ws.id, `/search?q=${encodeURIComponent(debounced)}`)),
    placeholderData: (prev) => prev,
  })
  const hits = debounced ? res.data ?? [] : []
  useEffect(() => setActive(0), [debounced])
  const go = (h: Hit) => { onClose(); navigate(`/w/${ws.id}/${h.link}`) }

  return (
    <Dialog title={t('searchAll')} onClose={onClose}>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-3 text-slate-400" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchAllPh')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            if (e.key === 'Enter' && hits[active]) { e.preventDefault(); go(hits[active]) }
          }}
          className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100" />
      </div>
      <ul className="mt-3 max-h-[60vh] space-y-0.5 overflow-y-auto" role="listbox">
        {!debounced && <li className="px-2 py-6 text-center text-sm text-slate-500">{t('searchAllHint')}</li>}
        {debounced && res.isSuccess && hits.length === 0 && <li className="px-2 py-6 text-center text-sm text-slate-500">{t('noMatch')}</li>}
        {hits.map((h, i) => (
          <li key={h.kind + h.id} role="option" aria-selected={i === active}>
            <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(h)}
              className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left', i === active ? 'bg-brand-50' : 'hover:bg-slate-50')}>
              <span className="text-slate-400">{ICON[h.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{h.title}</span>
                {h.subtitle && <span className="block truncate text-xs text-slate-500">{h.subtitle}</span>}
              </span>
              <span className="shrink-0 text-xs text-slate-400">{t(`searchKind_${h.kind}` as TKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
