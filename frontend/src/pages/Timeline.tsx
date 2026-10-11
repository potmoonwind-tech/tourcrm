/**
 * The season at a glance: every group as a bar over its dates, split by the town where it sleeps
 * ("Tbilisi · Kazbegi · Kutaisi · Batumi"), so on any day you see where each group is. Groups on the road
 * first (with "now: Kazbegi · day 3/8"), then the coming ones; finished and cancelled ones on request. A small
 * amber dot marks a day with something missing (the night's hotel, a meal's place).
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { COLOR, CodeChip, EmptyState } from '../components/tour'
import { Button } from '../components/ui'
import { api, type TourSummary } from '../lib/api'
import { wsPath } from '../lib/data'
import { addDays, diffDays, fmt, parse, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'

const COL = 40 // px per day
const LABEL = 220 // px, sticky tour column
const SPAN = 56 // days on screen (8 weeks), starting a week before today

interface TlDay { date: string; city: string; todo: boolean }
interface TlRow { tour: TourSummary; days: TlDay[] }

export function TimelinePage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const now = today()
  const [from, setFrom] = useState(() => addDays(now, -7))
  const to = addDays(from, SPAN - 1)
  const days = Array.from({ length: SPAN }, (_, i) => addDays(from, i))
  const [showAll, setShowAll] = useState(false)       // finished and cancelled groups too
  const scroller = useRef<HTMLDivElement>(null)

  const q = useQuery({
    queryKey: ['timeline', ws.id, from],
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

  return (
    <>
      <PageHeader section="tours" title={t('tours')} subtitle={`${fmt(from, lang)} – ${fmt(to, lang)}`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setFrom(addDays(from, -28))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
            <Button variant="secondary" onClick={() => setFrom(addDays(now, -7))}>{t('today')}</Button>
            <Button variant="secondary" onClick={() => setFrom(addDays(from, 28))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
          </div>
        } />
      <div className="space-y-2 p-4 md:p-8">
        {/* What the marks mean, and the groups left out. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-sm bg-slate-400 [background-image:repeating-linear-gradient(45deg,transparent_0_4px,rgba(255,255,255,.45)_4px_8px)]" />{t('tlInquiry')}</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400 ring-2 ring-white" />{t('tlMissing')}</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-brand-600" />{t('today')}</span>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="ml-auto font-medium text-brand-700 hover:underline">
              {showAll ? t('tlHideFinished') : t('tlShowFinished', { n: hiddenCount })}
            </button>
          )}
        </div>
        {q.isSuccess && rows.length === 0 ? <EmptyState title={t('noToursInMonths')} hint={t('noToursInMonthsHint')} /> : (
          <div ref={scroller} className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <div style={{ width: LABEL + SPAN * COL }} className="relative">
              <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white">
                <div style={{ width: LABEL }} className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-white" />
                {days.map((d) => {
                  const dow = new Date(parse(d)).getUTCDay()
                  return (
                    <div key={d} style={{ width: COL }} className={cn('shrink-0 py-1 text-center text-[11px] leading-tight',
                      (dow === 0 || dow === 6) && 'bg-slate-50', d === now && 'bg-brand-600 font-bold text-white')}>
                      <div className={d === now ? '' : 'text-slate-400'}>{d.endsWith('-01') || d === from ? fmt(d, lang, { month: 'short' }) : fmt(d, lang, { weekday: 'narrow' })}</div>
                      <div>{Number(d.slice(8))}</div>
                    </div>
                  )
                })}
              </div>
              <div className="relative">
                <div className="pointer-events-none absolute inset-0 flex" style={{ paddingLeft: LABEL }}>
                  {days.map((d) => {
                    const dow = new Date(parse(d)).getUTCDay()
                    return <div key={d} style={{ width: COL }} className={cn('shrink-0 border-r border-slate-100', (dow === 0 || dow === 6) && 'bg-slate-50/70', d.endsWith('-01') && 'border-l border-l-slate-300')} />
                  })}
                </div>
                {todayIdx >= 0 && todayIdx < SPAN && (
                  <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-brand-600" style={{ left: LABEL + todayIdx * COL + COL / 2 }} />
                )}
                {rows.map((r) => <TlLine key={r.tour.id} row={r} from={from} now={now} onOpen={() => navigate(`/w/${ws.id}/tours/${r.tour.id}`)} />)}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/** One group: who (and where it is today), then its bar - one piece per town, a dot on days with a gap. */
function TlLine({ row, from, now, onOpen }: { row: TlRow; from: string; now: string; onOpen: () => void }) {
  const { t, lang } = useI18n()
  const r = row.tour
  const total = diffDays(r.start_date, r.end_date) + 1
  const here = row.days.find((d) => d.date === now)
  const n = diffDays(r.start_date, now) + 1
  // Consecutive days in one town: one piece ("Tbilisi" over 2 days), inside the visible window.
  const pieces: { city: string; s: number; e: number }[] = []
  for (const d of row.days) {
    const i = diffDays(from, d.date)
    if (i < 0 || i >= SPAN) continue
    const last = pieces[pieces.length - 1]
    if (last && last.city === d.city && last.e === i - 1) last.e = i
    else pieces.push({ city: d.city, s: i, e: i })
  }
  const cancelled = r.status === 'cancelled'
  return (
    <div className="relative flex h-12 items-center border-b border-slate-100">
      <button type="button" onClick={onOpen} style={{ width: LABEL }}
        className="sticky left-0 z-20 flex h-full shrink-0 flex-col justify-center gap-0.5 border-r border-slate-200 bg-white px-3 text-left hover:bg-slate-50">
        <span className="flex items-center gap-2">
          <CodeChip code={r.code} color={r.color} className="shrink-0 whitespace-nowrap" />
          <span className="text-xs tabular-nums text-slate-500">{paxText(r)}</span>
          <span className="min-w-0 truncate text-xs text-slate-500">{r.client_name}</span>
        </span>
        <span className="truncate text-[11px]">
          {here ? <><span className="font-semibold text-brand-700">{t('tlNow', { city: here.city || '—' })}</span><span className="text-slate-400"> · {t('day')} {n}/{total}</span></>
            : r.start_date > now ? <span className="text-slate-500">{t('tlStarts', { date: fmt(r.start_date, lang) })}</span>
            : <span className="text-slate-400">{cancelled ? t('status_cancelled') : t('tlEnded')}</span>}
        </span>
      </button>
      {pieces.map((p, k) => {
        const first = k === 0 && diffDays(from, r.start_date) >= 0
        const lastP = k === pieces.length - 1 && diffDays(from, r.end_date) < SPAN
        return (
          <button key={k} type="button" onClick={onOpen} title={`${r.code} · ${p.city}`}
            style={{ left: LABEL + p.s * COL + (first ? 2 : 0), width: (p.e - p.s + 1) * COL - (first ? 2 : 0) - (lastP ? 2 : 0) }}
            className={cn('absolute z-10 flex h-8 items-center overflow-hidden whitespace-nowrap px-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-85',
              COLOR[r.color].bar, k > 0 && 'border-l-2 border-l-white/70',
              first && 'rounded-l-md', lastP && 'rounded-r-md',
              r.status === 'inquiry' && 'opacity-70 [background-image:repeating-linear-gradient(45deg,transparent_0_6px,rgba(255,255,255,.3)_6px_12px)]',
              cancelled && 'bg-slate-300 text-slate-600 line-through')}>
            <span className="truncate">{p.city || '—'}</span>
          </button>
        )
      })}
      {/* Days with something missing: a dot on the day. */}
      {row.days.filter((d) => d.todo && !cancelled).map((d) => {
        const i = diffDays(from, d.date)
        if (i < 0 || i >= SPAN) return null
        return <span key={d.date} title={t('tlMissing')} className="pointer-events-none absolute z-10 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-white"
          style={{ left: LABEL + i * COL + COL - 9, top: 6 }} />
      })}
    </div>
  )
}
