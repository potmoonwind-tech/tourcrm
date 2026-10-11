/**
 * "On the road" in the top bar, on every page: how many groups travel today, and in one click where each
 * one is (town, day n/m, tonight's hotel), each opening its day on the Today board.
 */
import { useQuery } from '@tanstack/react-query'
import { Bus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type DayViewRow } from '../lib/api'
import { wsPath } from '../lib/data'
import { diffDays, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { CodeChip } from './tour'

export function OnRoad() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const now = today()
  // The same light list Home uses (where each group is, without the hour-by-hour programme).
  const q = useQuery({ queryKey: ['day-light', ws.id, now], staleTime: 5 * 60_000,
    queryFn: () => api<DayViewRow[]>(wsPath(ws.id, `/day/${now}?light=1`)) })
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const rows = (q.data ?? []).filter((r) => r.tour.status !== 'cancelled')
  if (!rows.length) return null
  const label = t('onRoadN', { n: rows.length })
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title={label}
        className={cn('flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-700 hover:bg-slate-100', open && 'bg-slate-100')}>
        <Bus size={18} aria-hidden className="text-brand-600" />
        <span className="tabular-nums">{rows.length}</span>
        <span className="hidden lg:inline font-medium text-slate-600">{t('onRoad')}</span>
      </button>
      {open && (
        <div role="dialog" aria-label={label}
          className="animate-fade absolute right-0 z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white shadow-lg">
          <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">{label}</p>
          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {rows.map((r) => {
              const total = diffDays(r.tour.start_date, r.tour.end_date) + 1
              return (
                <li key={r.tour.id}>
                  <Link to={`/w/${ws.id}/day?open=${r.tour.id}`} onClick={() => setOpen(false)}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <CodeChip code={r.tour.code} color={r.tour.color} className="shrink-0 whitespace-nowrap" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{r.day.city || '—'}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {r.is_last_day ? t('onRoadLastDay') : r.day.hotel?.name ?? <span className="text-amber-700">{t('tlNoHotel')}</span>}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">{t('day')} {r.day.day_number}/{total}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
          <Link to={`/w/${ws.id}/day`} onClick={() => setOpen(false)}
            className="block border-t border-slate-100 px-4 py-2.5 text-center text-sm font-medium text-brand-700 hover:bg-slate-50">
            {t('onRoadOpenBoard')}
          </Link>
        </div>
      )}
    </div>
  )
}
