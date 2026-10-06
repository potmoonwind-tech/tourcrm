/**
 * "Read the partner's Excel": the departure plan they send (codes across, one row per night down)
 * becomes the list of departures — code and group date per line — for the departures form.
 * Also finds where our part starts (the night at the route's first hotel) and points out dates
 * that look wrong. Server: app/date_grid.py.
 */
import { AlertTriangle, FileSpreadsheet } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { InfoTip } from '../components/Tooltip'
import { Button, ErrorText } from '../components/ui'
import { api, apiUpload, SERIES_COLORS, type Series, type Vendor } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'

interface GridDeparture { code: string; start: string; end: string; places: string[]; warnings: string[]; suggested_start: string | null }
interface GridSeries { prefix: string; note: string; places: string[]; warnings: string[]; departures: GridDeparture[] }

/** 06.01.2026 — with the year: it's what a wrong-year warning is about. */
const dmy = (iso: string) => iso.split('-').reverse().join('.')
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** The group day (1-based) on which the route's first night is, from the hotel names. */
function ourStart(places: string[], route: Series | undefined, vendors: Vendor[]): number | null {
  const first = route?.days.find((d) => d.hotel_id)
  const name = first && vendors.find((v) => v.id === first.hotel_id)?.name
  if (!name || !first) return null
  const key = norm(name)
  const at = places.findIndex((p) => p && (norm(p).includes(key) || key.includes(norm(p))))
  return at < 0 ? null : at + 1 - (first.day_number - 1)
}

/** Our part of the group's nights: from the first night at one of our hotels to the day after the
 * last one (the flight or train out). Each night's hotel is matched to a supplier by name. */
function routeFromNights(places: string[], vendors: Vendor[]) {
  const hotels = vendors.filter((v) => v.type === 'hotel' && v.is_active !== false)
  const match = (p: string) => p ? hotels.find((v) => norm(v.name).includes(norm(p)) || norm(p).includes(norm(v.name))) : undefined
  const matched = places.map(match)
  const first = matched.findIndex(Boolean)
  if (first < 0) return null
  const last = matched.length - 1 - [...matched].reverse().findIndex(Boolean)
  const nights = places.slice(first, last + 1).map((p, i) => ({ place: p, hotel: matched[first + i] }))
  const out = places[last + 1]       // the flight / train / next country
  return { first: first + 1, nights, out, unknown: nights.filter((n) => !n.hotel).map((n) => n.place) }
}

export function DepartureGrid({ route, routes, vendors, onUse, onRoute }: {
  route: Series | undefined; routes: Series[]; vendors: Vendor[]
  onUse: (lines: string, offset: number | null) => void
  onRoute: (id: string) => void      // the series' route (made from the file, or found by code); '' = none yet
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [grid, setGrid] = useState<GridSeries[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [fixYears, setFixYears] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const read = async (file: File) => {
    setBusy(true); setError(null)
    try {
      const g = await apiUpload<GridSeries[]>(wsPath(ws.id, '/import/departure-grid'), file)
      setGrid(g)
      const match = g.find((s) => s.prefix === route?.code) ?? (g.length === 1 ? g[0] : null)
      if (match) choose(match, fixYears)
    } catch (e) { setError(e) }
    setBusy(false)
  }
  const choose = (s: GridSeries, fix: boolean) => {
    setPicked(s.prefix)
    // The series' own route (same code), or none yet — never another series' route.
    const own = routes.find((x) => x.code === s.prefix)
    onRoute(own?.id ?? '')
    const lines = s.departures.map((d) => `${d.code}  ${fix && d.suggested_start ? d.suggested_start : d.start}`).join('\n')
    onUse(lines, ourStart(s.places, own, vendors))
  }
  const series = grid?.find((s) => s.prefix === picked)
  const offset = series ? ourStart(series.places, route, vendors) : null
  const wrong = series?.departures.filter((d) => d.suggested_start) ?? []
  const other = series?.departures.filter((d) => !d.suggested_start && d.warnings.length) ?? []
  const ourDays = series && offset ? series.places.length - offset + 1 : null
  // No route for this series yet: make one from the file's nights.
  const qc = useQueryClient()
  const noRoute = series && !routes.some((x) => x.code === series.prefix)
  const plan = noRoute ? routeFromNights(series.places, vendors) : null
  const make = useMutation({
    mutationFn: () => {
      const days = plan!.nights.map((n) => ({ city: n.hotel?.city ?? '', hotel_id: n.hotel?.id ?? null, notes: n.hotel ? '' : n.place }))
      const lastCity = days[days.length - 1]?.city ?? ''
      if (plan!.out) days.push({ city: lastCity, hotel_id: null, notes: t('gridOutDay', { what: plan!.out }) })
      return api<Series>(wsPath(ws.id, '/series'), { method: 'POST', body: {
        code: series!.prefix, name: t('gridRouteName', { code: series!.prefix }), color: SERIES_COLORS[routes.length % SERIES_COLORS.length], notes: series!.note, days,
      } })
    },
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: ['series', ws.id] })
      onRoute(s.id)
      onUse(series!.departures.map((d) => `${d.code}  ${fixYears && d.suggested_start ? d.suggested_start : d.start}`).join('\n'), plan!.first)
    },
  })

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".xlsx,.xlsm,.csv" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = '' }} />
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          <FileSpreadsheet size={16} aria-hidden />{t('gridRead')}
        </Button>
        <span className="min-w-48 flex-1 text-slate-600">{t('gridHelp')}</span>
        <InfoTip label={t('gridTip')} />
      </div>
      <ErrorText error={error} />
      {grid && grid.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('gridWhich')}>
          <span className="font-medium text-slate-700">{t('gridWhich')}</span>
          {grid.map((s) => (
            <button key={s.prefix} type="button" onClick={() => choose(s, fixYears)} aria-pressed={picked === s.prefix}
              className={cn('min-h-9 rounded-lg border px-3 font-medium', picked === s.prefix ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white hover:border-slate-500')}>
              {s.prefix} · {t('gridCount', { n: s.departures.length })}
            </button>
          ))}
        </div>
      )}
      {series && (
        <>
          <div>
            <p className="font-medium text-slate-700">{t('gridNights', { note: series.note || '—' })}</p>
            <ol className="mt-1 flex flex-wrap gap-1.5">
              {series.places.map((p, i) => {
                const ours = offset !== null && i + 1 >= offset
                return (
                  <li key={i} className={cn('rounded-md border px-2 py-0.5', ours ? 'border-brand-300 bg-white text-slate-900' : 'border-transparent text-slate-500')}>
                    <span className="font-semibold tabular-nums">{i + 1}</span> {p || '—'}
                  </li>
                )
              })}
            </ol>
            <p className="mt-1 text-slate-600">
              {offset ? t('gridOurStart', { day: offset, place: series.places[offset - 1] }) : !noRoute && route && t('gridNoStart')}
              {ourDays !== null && route && ourDays !== route.days.length && (
                <span className="ml-1 font-medium text-amber-900">{t('gridDaysDiffer', { file: ourDays, route: route.days.length })}</span>
              )}
            </p>
          </div>
          {plan && (
            <div className="rounded-lg border border-brand-200 bg-white p-2.5">
              <p className="font-medium text-slate-800">{t('gridNoRoute', { code: series.prefix })}</p>
              <p className="mt-0.5 text-slate-600">
                {t('gridRoutePlan', { n: plan.nights.length + (plan.out ? 1 : 0), from: plan.first })}{' '}
                {plan.nights.map((n) => n.hotel ? `${n.hotel.city} (${n.hotel.name})` : `${n.place} ?`).join(' → ')}{plan.out && ` → ${plan.out}`}
              </p>
              {plan.unknown.length > 0 && <p className="mt-0.5 font-medium text-amber-900">{t('gridUnknownHotels', { names: plan.unknown.join(', ') })}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" disabled={make.isPending} onClick={() => make.mutate()}>{t('gridMakeRoute', { code: series.prefix })}</Button>
                <span className="text-xs text-slate-600">{t('gridMakeRouteHint')}</span>
              </div>
              <ErrorText error={make.error} />
            </div>
          )}
          {!plan && noRoute && <p className="font-medium text-amber-900">{t('gridNoHotels', { code: series.prefix })}</p>}
          {wrong.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-amber-950">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={15} aria-hidden />{t('gridWrongYear', { n: wrong.length })}</p>
              <ul className="mt-1 list-inside list-disc">
                {wrong.map((d) => <li key={d.code}>{d.code}: <span className="tabular-nums">{dmy(d.start)} → <b>{dmy(d.suggested_start!)}</b></span></li>)}
              </ul>
              <label className="mt-1.5 flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={fixYears}
                  onChange={(e) => { setFixYears(e.target.checked); choose(series, e.target.checked) }} />
                {t('gridUseSuggested')}
              </label>
            </div>
          )}
          {other.length > 0 && (
            <ul className="list-inside list-disc text-amber-900">
              {other.map((d) => <li key={d.code}><b>{d.code}</b>: {d.warnings.join('; ')}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
