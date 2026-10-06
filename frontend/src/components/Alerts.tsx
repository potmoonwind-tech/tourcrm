/**
 * Conflicts and things that need attention (server: app/routers/alerts.py).
 * Notice bars on a tour, a bell with the agency-wide count, a list on Home.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, Bell, ChevronDown, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type TourAlert } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'

export function useAlerts(tourId?: string) {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['alerts', ws.id, tourId ?? 'all'],
    queryFn: () => api<TourAlert[]>(wsPath(ws.id, tourId ? `/tours/${tourId}/alerts` : '/alerts')),
    staleTime: 30_000,
  })
}

/** The alert in words, in the user's language. */
export function useAlertText() {
  const { t, lang } = useI18n()
  return (a: TourAlert) => {
    const p: Record<string, string | number> = { ...a.params }
    for (const k of ['from', 'to']) if (typeof p[k] === 'string') p[k] = fmt(p[k] as string, lang)
    if (a.code === 'plan_incomplete') p.what = String(p.what).split(',').map((w) => t(`planGap_${w}` as TKey)).join(', ')
    return t(`alert_${a.code}` as TKey, p)
  }
}

const STYLE = {
  error: { bar: 'border-red-200 bg-red-50 text-red-900', icon: <AlertCircle size={18} className="shrink-0 text-red-600" /> },
  warning: { bar: 'border-amber-200 bg-amber-50 text-amber-900', icon: <AlertTriangle size={18} className="shrink-0 text-amber-600" /> },
  info: { bar: 'border-sky-200 bg-sky-50 text-sky-900', icon: <Info size={18} className="shrink-0 text-sky-600" /> },
}

/** Notice bars at the top of a tour: problems first, each with where to fix it. */
export function AlertBars({ tourId, onTab }: { tourId: string; onTab: (tab: string) => void }) {
  const { t } = useI18n()
  const text = useAlertText()
  const alerts = useAlerts(tourId)
  const [all, setAll] = useState(false)
  const rows = alerts.data ?? []
  if (!rows.length) return null
  const urgent = rows.filter((a) => a.severity !== 'info')
  const infos = rows.filter((a) => a.severity === 'info')
  const shown = all ? urgent : urgent.slice(0, 3)
  return (
    <div className="space-y-2" role="status">
      {shown.map((a, i) => (
        <div key={i} className={cn('flex items-start gap-2 rounded-xl border px-4 py-2.5 text-sm', STYLE[a.severity].bar)}>
          {STYLE[a.severity].icon}
          <span className="min-w-0 flex-1">{a.day ? <b className="mr-1">{t('day')} {a.day}:</b> : null}{text(a)}</span>
          {a.link && <button type="button" className="shrink-0 font-medium underline" onClick={() => onTab(a.link)}>{t('fixIt')}</button>}
        </div>
      ))}
      {urgent.length > 3 && (
        <button type="button" onClick={() => setAll(!all)} className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-800">
          <ChevronDown size={15} className={cn(all && 'rotate-180')} />{all ? t('showLess') : t('showMoreN', { n: urgent.length - 3 })}
        </button>
      )}
      {infos.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
          <Info size={15} className="text-sky-600" />
          {infos.map((a, i) => (
            <button type="button" key={i} onClick={() => a.link && onTab(a.link)} className={cn(a.link && 'hover:underline')}>{text(a)}</button>
          ))}
        </p>
      )}
    </div>
  )
}

/** The bell: errors and warnings across all tours. */
export function AlertBell() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const text = useAlertText()
  const alerts = useAlerts()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const urgent = (alerts.data ?? []).filter((a) => a.severity !== 'info')
  const errors = urgent.filter((a) => a.severity === 'error').length
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t('notifications')} aria-expanded={open}
        className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100">
        <Bell size={19} />
        {urgent.length > 0 && (
          <span className={cn('absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-white',
            errors ? 'bg-red-500' : 'bg-amber-500')}>{urgent.length}</span>
        )}
      </button>
      {open && (
        <div className="animate-fade absolute right-0 z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white shadow-lg">
          <p className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold">{t('needsAttention')}</p>
          {urgent.length === 0 ? <p className="px-4 py-6 text-center text-sm text-slate-500">{t('allClear')}</p> : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {urgent.slice(0, 40).map((a, i) => (
                <li key={i}>
                  <Link to={`/w/${ws.id}/tours/${a.tour_id}${a.link ? `?tab=${a.link}` : ''}`} onClick={() => setOpen(false)}
                    className="flex gap-2 px-4 py-2.5 text-sm hover:bg-slate-50">
                    {STYLE[a.severity].icon}
                    <span className="min-w-0">
                      <span className="font-mono text-xs font-semibold">{a.tour_code}</span>
                      <span className="ml-1 text-xs text-slate-500">{fmt(a.start_date, lang)}{a.day ? ` · ${t('day')} ${a.day}` : ''}</span>
                      <span className="block text-slate-700">{text(a)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Home: the most urgent things across tours. */
export function NeedsAttention() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const text = useAlertText()
  const alerts = useAlerts()
  const urgent = (alerts.data ?? []).filter((a) => a.severity !== 'info')
  if (!alerts.data) return null
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-5 py-3 font-semibold">{t('needsAttention')} · {urgent.length}</h2>
      {urgent.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">{t('allClear')}</p> : (
        <ul className="divide-y divide-slate-100">
          {urgent.slice(0, 8).map((a, i) => (
            <li key={i}>
              <Link to={`/w/${ws.id}/tours/${a.tour_id}${a.link ? `?tab=${a.link}` : ''}`} className="flex items-start gap-2 px-5 py-2.5 text-sm hover:bg-slate-50">
                {STYLE[a.severity].icon}
                <span className="font-mono text-xs font-semibold leading-5">{a.tour_code}</span>
                <span className="min-w-0 flex-1 text-slate-700">{text(a)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
