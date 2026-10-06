import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { COLOR, CodeChip, EmptyState } from '../components/tour'
import { Button } from '../components/ui'
import { api, type TourSummary } from '../lib/api'
import { wsPath } from '../lib/data'
import { addDays, diffDays, fmt, monthName, parse, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'

const COL = 34 // px per day
const LABEL = 176 // px, sticky tour column

const firstOfMonth = (s: string) => s.slice(0, 8) + '01'
const shiftMonth = (s: string, n: number) => {
  const d = new Date(parse(s))
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

export function TimelinePage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [from, setFrom] = useState(() => firstOfMonth(today()))
  const to = addDays(shiftMonth(from, 2), -1) // two months visible
  const span = diffDays(from, to) + 1
  const days = Array.from({ length: span }, (_, i) => addDays(from, i))
  const scroller = useRef<HTMLDivElement>(null)

  const tours = useQuery({
    queryKey: ['tours', ws.id, 'timeline', from],
    queryFn: () => api<TourSummary[]>(wsPath(ws.id, `/tours?date_from=${from}&date_to=${to}`)),
    placeholderData: (prev) => prev,
  })

  const now = today()
  const todayIdx = diffDays(from, now)
  // Bring today into view whenever the visible window contains it.
  useEffect(() => {
    if (scroller.current && todayIdx >= 0 && todayIdx < span) {
      scroller.current.scrollLeft = Math.max(0, todayIdx * COL - 3 * COL)
    }
  }, [from, todayIdx, span])

  const rows = tours.data ?? []

  return (
    <>
      <PageHeader section="tours" title={t('tours')} subtitle={`${monthName(from, lang)} – ${monthName(to, lang)}`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setFrom(shiftMonth(from, -1))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
            <Button variant="secondary" onClick={() => setFrom(firstOfMonth(today()))}>{t('today')}</Button>
            <Button variant="secondary" onClick={() => setFrom(shiftMonth(from, 1))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
          </div>
        } />
      <div className="p-4 md:p-8">
        {tours.isSuccess && rows.length === 0 ? <EmptyState title={t('noToursInMonths')} hint={t('noToursInMonthsHint')} /> : (
          <div ref={scroller} className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <div style={{ width: LABEL + span * COL }} className="relative">
              {/* header */}
              <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white">
                <div style={{ width: LABEL }} className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-white" />
                {days.map((d) => {
                  const dow = new Date(parse(d)).getUTCDay()
                  return (
                    <div key={d} style={{ width: COL }} className={cn('shrink-0 py-1 text-center text-[11px] leading-tight',
                      (dow === 0 || dow === 6) && 'bg-slate-50', d === now && 'bg-brand-600 font-bold text-white')}>
                      {d.endsWith('-01') && <div className="font-semibold text-slate-700">{fmt(d, lang, { month: 'short' })}</div>}
                      {!d.endsWith('-01') && <div className="text-slate-400">{fmt(d, lang, { weekday: 'narrow' })}</div>}
                      <div>{Number(d.slice(8))}</div>
                    </div>
                  )
                })}
              </div>

              {/* rows */}
              <div className="relative">
                {/* weekend shading + today line */}
                <div className="pointer-events-none absolute inset-0 flex" style={{ paddingLeft: LABEL }}>
                  {days.map((d) => {
                    const dow = new Date(parse(d)).getUTCDay()
                    return <div key={d} style={{ width: COL }} className={cn('shrink-0 border-r border-slate-100',
                      (dow === 0 || dow === 6) && 'bg-slate-50/70', d.endsWith('-01') && 'border-l border-l-slate-300')} />
                  })}
                </div>
                {todayIdx >= 0 && todayIdx < span && (
                  <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-brand-600"
                    style={{ left: LABEL + todayIdx * COL + COL / 2 }} />
                )}
                {rows.map((r) => {
                  const s = Math.max(0, diffDays(from, r.start_date))
                  const e = Math.min(span - 1, diffDays(from, r.end_date))
                  const cut = { left: diffDays(from, r.start_date) < 0, right: diffDays(from, r.end_date) > span - 1 }
                  return (
                    <div key={r.id} className="relative flex h-10 items-center border-b border-slate-100">
                      <div style={{ width: LABEL }}
                        className="sticky left-0 z-20 flex h-full shrink-0 items-center gap-2 border-r border-slate-200 bg-white px-3">
                        <CodeChip code={r.code} color={r.color} />
                        <span className="text-xs tabular-nums text-slate-500">{paxText(r)}</span>
                      </div>
                      <button type="button" onClick={() => navigate(`/w/${ws.id}/tours/${r.id}`)}
                        title={`${r.code} · ${r.client_name ?? ''} · ${paxText(r)} ${t('pax').toLowerCase()}`}
                        style={{ left: LABEL + s * COL + 2, width: (e - s + 1) * COL - 4 }}
                        className={cn('absolute z-10 flex h-7 items-center overflow-hidden whitespace-nowrap px-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-85',
                          COLOR[r.color].bar,
                          cut.left ? 'rounded-r-md' : cut.right ? 'rounded-l-md' : 'rounded-md',
                          r.status === 'inquiry' && 'opacity-60 ring-2 ring-inset ring-white/60 [background-image:repeating-linear-gradient(45deg,transparent_0_6px,rgba(255,255,255,.25)_6px_12px)]',
                          r.status === 'cancelled' && 'bg-slate-300 text-slate-600 line-through')}>
                        {r.code}{r.client_name ? ` · ${r.client_name}` : ''}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
