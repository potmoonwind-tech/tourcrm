/**
 * The season at a glance: every group as a bar over its dates, split by the town where it sleeps
 * ("Tbilisi · Kazbegi · Kutaisi · Batumi"), so on any day you see where each group is. Groups on the road
 * first (with "now: Kazbegi · day 3/8"), then the coming ones; finished and cancelled ones on request. A small
 * amber dot marks a day with something missing (the night's hotel, a meal's place).
 *
 * Zoom: Week (wide days: town and hotel), Month (8 weeks), Season (3 months, compact). Or the same weeks by
 * guide and driver: a row per person, a bar per tour they work (double bookings outlined in red).
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { COLOR, CodeChip, EmptyState } from '../components/tour'
import { Button, SegmentedControl } from '../components/ui'
import { api, type TourSummary } from '../lib/api'
import { wsPath } from '../lib/data'
import { addDays, diffDays, fmt, parse, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'

type Zoom = 'week' | 'month' | 'season'
type Group = 'tours' | 'staff'
// px per day, days on screen, days before today, days per arrow click
const ZOOM: Record<Zoom, { col: number; span: number; back: number; step: number }> = {
  week: { col: 120, span: 14, back: 1, step: 7 },
  month: { col: 40, span: 56, back: 7, step: 28 },
  season: { col: 14, span: 91, back: 7, step: 28 },
}
const LABEL = 200 // px, sticky name column

interface TlDay { date: string; city: string; hotel: string; todo: boolean }
interface TlStaff { vendor_id: string; name: string; role: string; start: string; end: string }
interface TlRow { tour: TourSummary; days: TlDay[]; staff: TlStaff[] }

function stored<T extends string>(key: string, ok: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T; return ok.includes(v) ? v : fallback } catch { return fallback }
}
function keep(key: string, v: string) { try { localStorage.setItem(key, v) } catch { /* private window */ } }

export function TimelinePage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const now = today()
  const [zoom, setZoomRaw] = useState<Zoom>(() => stored('timelineZoom', ['week', 'month', 'season'] as const, 'month'))
  const [group, setGroupRaw] = useState<Group>(() => stored('timelineGroup', ['tours', 'staff'] as const, 'tours'))
  const z = ZOOM[zoom]
  const [from, setFrom] = useState(() => addDays(now, -z.back))
  const setZoom = (v: Zoom) => { setZoomRaw(v); keep('timelineZoom', v); setFrom(addDays(now, -ZOOM[v].back)) }
  const setGroup = (v: Group) => { setGroupRaw(v); keep('timelineGroup', v) }
  const to = addDays(from, z.span - 1)
  const days = Array.from({ length: z.span }, (_, i) => addDays(from, i))
  const [showAll, setShowAll] = useState(false)       // finished and cancelled groups too
  const scroller = useRef<HTMLDivElement>(null)

  const q = useQuery({
    queryKey: ['timeline', ws.id, from, to],
    queryFn: () => api<TlRow[]>(wsPath(ws.id, `/timeline?date_from=${from}&date_to=${to}`)),
    placeholderData: (prev) => prev,
  })
  const todayIdx = diffDays(from, now)
  useEffect(() => { if (scroller.current) scroller.current.scrollLeft = 0 }, [from])

  // On the road first, then coming (by start), then - on request - finished and cancelled.
  const all = q.data ?? []
  const onRoad = (r: TlRow) => r.tour.start_date <= now && now <= r.tour.end_date && r.tour.status !== 'cancelled'
  const coming = (r: TlRow) => r.tour.start_date > now && r.tour.status !== 'cancelled'
  const hiddenCount = all.filter((r) => !onRoad(r) && !coming(r)).length
  const rows = [...all.filter(onRoad), ...all.filter(coming), ...(showAll ? all.filter((r) => !onRoad(r) && !coming(r)) : [])]
  const people = staffRows(all.filter((r) => r.tour.status !== 'cancelled'))
  const empty = q.isSuccess && (group === 'tours' ? rows.length === 0 : people.length === 0)

  return (
    <>
      <PageHeader section="tours" title={t('tours')} subtitle={`${fmt(from, lang)} – ${fmt(to, lang)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl size="sm" label={t('tlGroupBy')} value={group} onChange={setGroup}
              options={[['tours', t('tlByTours')], ['staff', t('tlByStaff')]]} />
            <SegmentedControl size="sm" label={t('tlZoom')} value={zoom} onChange={setZoom}
              options={[['week', t('tlWeek')], ['month', t('tlMonth')], ['season', t('tlSeason')]]} />
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => setFrom(addDays(from, -z.step))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
              <Button variant="secondary" size="sm" onClick={() => setFrom(addDays(now, -z.back))}>{t('today')}</Button>
              <Button variant="secondary" size="sm" onClick={() => setFrom(addDays(from, z.step))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
            </div>
          </div>
        } />
      <div className="space-y-2 p-4 md:p-8">
        {/* What the marks mean, and the groups left out. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          {group === 'tours' ? <>
            <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm bg-slate-400 [background-image:repeating-linear-gradient(45deg,transparent_0_4px,rgba(255,255,255,.45)_4px_8px)]" />{t('tlInquiry')}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400 ring-2 ring-white" />{t('tlMissing')}</span>
          </> : <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm bg-slate-400 ring-2 ring-red-500" />{t('tlDoubleBooked')}</span>}
          <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-brand-600" />{t('today')}</span>
          {group === 'tours' && hiddenCount > 0 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="ml-auto font-medium text-brand-700 hover:underline">
              {showAll ? t('tlHideFinished') : t('tlShowFinished', { n: hiddenCount })}
            </button>
          )}
        </div>
        {empty ? <EmptyState title={group === 'tours' ? t('noToursInMonths') : t('tlNoStaff')} hint={group === 'tours' ? t('noToursInMonthsHint') : t('tlNoStaffHint')} /> : (
          <div ref={scroller} className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <div style={{ width: LABEL + z.span * z.col }} className="relative">
              <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white">
                <div style={{ width: LABEL }} className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-white" />
                {days.map((d) => <DayHead key={d} d={d} first={d === from} now={now} zoom={zoom} />)}
              </div>
              <div className="relative">
                <div className="pointer-events-none absolute inset-0 flex" style={{ paddingLeft: LABEL }}>
                  {days.map((d) => {
                    const dow = new Date(parse(d)).getUTCDay()
                    return <div key={d} style={{ width: z.col }} className={cn('shrink-0', zoom !== 'season' && 'border-r border-slate-100',
                      (dow === 0 || dow === 6) && 'bg-slate-50/70', zoom === 'season' && dow === 1 && 'border-l border-l-slate-100',
                      d.endsWith('-01') && 'border-l border-l-slate-300')} />
                  })}
                </div>
                {todayIdx >= 0 && todayIdx < z.span && (
                  <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-brand-600" style={{ left: LABEL + todayIdx * z.col + z.col / 2 }} />
                )}
                {group === 'tours'
                  ? rows.map((r) => <TlLine key={r.tour.id} row={r} from={from} now={now} zoom={zoom} onOpen={() => navigate(`/w/${ws.id}/tours/${r.tour.id}`)} />)
                  : people.map((p) => <StaffLine key={p.id} person={p} from={from} now={now} zoom={zoom} onOpen={(id) => navigate(`/w/${ws.id}/tours/${id}`)} />)}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/** A day's column head: week shows "Mon 12 Oct", month "M 12", season only month starts and Mondays. */
function DayHead({ d, first, now, zoom }: { d: string; first: boolean; now: string; zoom: Zoom }) {
  const { lang } = useI18n()
  const z = ZOOM[zoom]
  const dow = new Date(parse(d)).getUTCDay()
  const isNow = d === now
  const monthStart = d.endsWith('-01') || first
  return (
    <div style={{ width: z.col }} className={cn('shrink-0 py-1 text-center text-[11px] leading-tight',
      (dow === 0 || dow === 6) && 'bg-slate-50', isNow && 'bg-brand-600 font-bold text-white', zoom === 'season' && 'overflow-visible whitespace-nowrap')}>
      {zoom === 'week' ? <>
        <div className={isNow ? '' : 'text-slate-400'}>{fmt(d, lang, { weekday: 'short' })}</div>
        <div className="font-medium">{fmt(d, lang, { day: 'numeric', month: 'short' })}</div>
      </> : zoom === 'month' ? <>
        <div className={isNow ? '' : 'text-slate-400'}>{monthStart ? fmt(d, lang, { month: 'short' }) : fmt(d, lang, { weekday: 'narrow' })}</div>
        <div>{Number(d.slice(8))}</div>
      </> : <>
        {/* Season: too narrow for every day - the month at its start, the date on Mondays. */}
        <div className={cn('relative h-3.5', isNow ? '' : 'text-slate-500')}>{monthStart && <span className="absolute left-0 font-semibold">{fmt(d, lang, { month: 'short' })}</span>}</div>
        <div className={cn('relative h-3.5', isNow ? '' : 'text-slate-400')}>{((dow === 1 && diffDays(now, d) !== 1) || isNow) && <span className="absolute left-0">{Number(d.slice(8))}</span>}</div>
      </>}
    </div>
  )
}

/** One group: who (and where it is today), then its bar - one piece per town, a dot on days with a gap. */
function TlLine({ row, from, now, zoom, onOpen }: { row: TlRow; from: string; now: string; zoom: Zoom; onOpen: () => void }) {
  const { t, lang } = useI18n()
  const { col, span } = ZOOM[zoom]
  const r = row.tour
  const total = diffDays(r.start_date, r.end_date) + 1
  const here = row.days.find((d) => d.date === now)
  const n = diffDays(r.start_date, now) + 1
  // Consecutive days in one town: one piece ("Tbilisi" over 2 days), inside the visible window.
  // The week view also shows the hotel, so there a hotel change starts a new piece; the season view is
  // too narrow for towns - one plain bar with the group's code.
  const season = zoom === 'season'
  const pieces: { city: string; hotel: string; s: number; e: number }[] = []
  for (const d of row.days) {
    const i = diffDays(from, d.date)
    if (i < 0 || i >= span) continue
    const last = pieces[pieces.length - 1]
    if (last && (season || last.city === d.city) && (zoom !== 'week' || last.hotel === d.hotel) && last.e === i - 1) last.e = i
    else pieces.push({ city: d.city, hotel: d.hotel, s: i, e: i })
  }
  const cancelled = r.status === 'cancelled'
  const tall = zoom === 'week'
  return (
    <div className={cn('relative flex items-center border-b border-slate-100', tall ? 'h-14' : 'h-12')}>
      <button type="button" onClick={onOpen} style={{ width: LABEL }} title={r.client_name || undefined}
        className="sticky left-0 z-20 flex h-full shrink-0 flex-col justify-center gap-0.5 border-r border-slate-200 bg-white px-3 text-left hover:bg-slate-50">
        <span className="flex items-center gap-2">
          <CodeChip code={r.code} color={r.color} className="shrink-0 whitespace-nowrap" />
          <span className="text-xs tabular-nums text-slate-500">{paxText(r)}</span>
        </span>
        <span className="truncate text-[11px]">
          {here ? <><span className="font-semibold text-brand-700">{t('tlNow', { city: here.city || '—' })}</span><span className="text-slate-400"> · {t('day')} {n}/{total}</span></>
            : r.start_date > now ? <span className="text-slate-500">{t('tlStarts', { date: fmt(r.start_date, lang) })}</span>
            : <span className="text-slate-400">{cancelled ? t('status_cancelled') : t('tlEnded')}</span>}
        </span>
      </button>
      {pieces.map((p, k) => {
        const first = k === 0 && diffDays(from, r.start_date) >= 0
        const lastP = k === pieces.length - 1 && diffDays(from, r.end_date) < span
        const width = (p.e - p.s + 1) * col - (first ? 2 : 0) - (lastP ? 2 : 0)
        return (
          <button key={k} type="button" onClick={onOpen} title={[r.code, !season && p.city, p.hotel].filter(Boolean).join(' · ')}
            style={{ left: LABEL + p.s * col + (first ? 2 : 0), width }}
            className={cn('absolute z-10 flex flex-col justify-center overflow-hidden whitespace-nowrap px-1.5 text-left text-[11px] font-semibold leading-tight text-white transition-opacity hover:opacity-85',
              COLOR[r.color].bar, tall ? 'h-10' : 'h-8', k > 0 && 'border-l-2 border-l-white/70',
              first && 'rounded-l-md', lastP && 'rounded-r-md',
              r.status === 'inquiry' && 'opacity-70 [background-image:repeating-linear-gradient(45deg,transparent_0_6px,rgba(255,255,255,.3)_6px_12px)]',
              cancelled && 'bg-slate-300 text-slate-600 line-through')}>
            {width >= 36 && <span className="truncate">{season ? r.code : p.city || '—'}</span>}
            {tall && <span className="truncate text-[10px] font-normal opacity-90">{p.hotel || (addDays(from, p.e) === r.end_date ? '' : t('tlNoHotel'))}</span>}
          </button>
        )
      })}
      {/* Days with something missing: a dot on the day (the season view: one dot, on the first such day). */}
      {row.days.filter((d) => d.todo && !cancelled).slice(0, season ? 1 : undefined).map((d) => {
        const i = diffDays(from, d.date)
        if (i < 0 || i >= span) return null
        return <span key={d.date} title={t('tlMissing')} className="pointer-events-none absolute z-10 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-white"
          style={{ left: LABEL + i * col + col - (zoom === 'season' ? 8 : 9), top: tall ? 4 : 6 }} />
      })}
    </div>
  )
}

interface Job { tour: TourSummary; start: string; end: string; city: (date: string) => string; clash: boolean; lane: number }
interface Person { id: string; name: string; role: string; jobs: Job[]; lanes: number }
const LANE = 36 // px per line of bars in a person's row

/** Guides and drivers: one row per person, a job per tour they work (by name, then role). */
function staffRows(rows: TlRow[]): Person[] {
  const by = new Map<string, Person>()
  for (const r of rows) {
    const towns = new Map(r.days.map((d) => [d.date, d.city]))
    for (const s of r.staff) {
      const p = by.get(s.vendor_id) ?? { id: s.vendor_id, name: s.name, role: s.role, jobs: [], lanes: 1 }
      p.jobs.push({ tour: r.tour, start: s.start, end: s.end, city: (d) => towns.get(d) ?? '', clash: false, lane: 0 })
      by.set(s.vendor_id, p)
    }
  }
  for (const p of by.values()) {
    p.jobs.sort((a, b) => a.start.localeCompare(b.start))
    // Tours at the same time go on separate lines, so none hides another. A person can't be in two
    // places (red outline); a bus company with several buses can.
    const ends: string[] = []
    for (const a of p.jobs) {
      let lane = ends.findIndex((e) => e < a.start)
      if (lane < 0) lane = ends.length
      ends[lane] = a.end
      a.lane = lane
      a.clash = p.role !== 'transport' && p.jobs.some((b) => b !== a && a.start <= b.end && b.start <= a.end)
    }
    p.lanes = Math.max(ends.length, 1)
  }
  return [...by.values()].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
}

/** One person: name and role (and where they are today), then a bar per tour, labelled with its code. */
function StaffLine({ person, from, now, zoom, onOpen }: { person: Person; from: string; now: string; zoom: Zoom; onOpen: (tourId: string) => void }) {
  const { t } = useI18n()
  const { col, span } = ZOOM[zoom]
  const busy = person.jobs.filter((j) => j.start <= now && now <= j.end)
  const today = busy[0]
  return (
    <div className="relative flex items-center border-b border-slate-100" style={{ height: person.lanes * LANE + 12 }}>
      <div style={{ width: LABEL }} className="sticky left-0 z-20 flex h-full shrink-0 flex-col justify-center gap-0.5 border-r border-slate-200 bg-white px-3">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-900">{person.name}</span>
          <span className="shrink-0 text-[11px] text-slate-500">{t(`role_${person.role}` as TKey)}</span>
        </span>
        <span className="truncate text-[11px]">
          {today ? <span className="font-semibold text-brand-700">{t('tlNowWith', { code: today.tour.code, city: today.city(now) || '—' })}{busy.length > 1 && ` +${busy.length - 1}`}</span>
            : <span className="text-slate-400">{t('tlFreeToday')}</span>}
        </span>
      </div>
      {person.jobs.map((j) => {
        const s = Math.max(diffDays(from, j.start), 0)
        const e = Math.min(diffDays(from, j.end), span - 1)
        if (e < 0 || s >= span) return null
        const width = (e - s + 1) * col - 4
        return (
          <button key={`${j.tour.id}-${j.start}`} type="button" onClick={() => onOpen(j.tour.id)}
            title={`${j.tour.code}${j.clash ? ` · ${t('tlDoubleBooked')}` : ''}`}
            style={{ left: LABEL + s * col + 2, width, top: 6 + j.lane * LANE }}
            className={cn('absolute z-10 flex h-8 items-center overflow-hidden whitespace-nowrap rounded-md px-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-85',
              COLOR[j.tour.color].bar, j.tour.status === 'inquiry' && 'opacity-70', j.clash && 'ring-2 ring-red-500 ring-offset-1')}>
            {width >= 28 && <span className="truncate">{j.tour.code}</span>}
          </button>
        )
      })}
    </div>
  )
}
