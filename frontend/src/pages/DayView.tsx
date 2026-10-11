/**
 * "Today": every group on the road on one date, for the operator at 9 am - where each group is, what it does
 * hour by hour (now and next stand out), and what needs attention (a place not chosen, a booking not
 * confirmed, an open incident). One compact block per group; the team's phones one tap away.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertOctagon, AlertTriangle, BedDouble, Bus, Car, Check, ChevronLeft, ChevronRight, Coffee, Flag, MapPin, Plane, Smile, Ticket, User, Utensils } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CityDay } from '../components/CityDay'
import { CodeChip, EmptyState } from '../components/tour'
import { Button, Input } from '../components/ui'
import { api, type DayViewRow, type Incident } from '../lib/api'
import { useServiceList, wsPath } from '../lib/data'
import { addDays, diffDays, fmtLong, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'
import { useIncidents } from './Incidents'
import type { PDay, PStep } from './ProgrammePrint'

type Row = DayViewRow & { programme?: PDay | null; bookings?: Record<string, string> }
interface Flag { text: string; tone: 'amber' | 'red'; to?: string }

export function DayViewPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const [params, setParams] = useSearchParams()
  const day = params.get('date') || today()
  const byCity = params.get('view') === 'city'
  const go = (d: string, city = byCity) => setParams({ ...(d === today() ? {} : { date: d }), ...(city ? { view: 'city' } : {}) }, { replace: true })
  const [onlyFlagged, setOnlyFlagged] = useState(false)

  const rows = useQuery({
    queryKey: ['day', ws.id, day, lang],
    queryFn: () => api<Row[]>(wsPath(ws.id, `/day/${day}?lang=${lang}`)),   // the programme in the person's language
    placeholderData: (prev) => prev,
  })
  const services = useServiceList()
  const incidents = useIncidents('status=open')
  const data = rows.data ?? []
  const people = data.reduce((s, r) => s + r.tour.pax, 0)
  const flagsOf = (r: Row) => attention(r, t, services.data ?? [], (incidents.data ?? []).filter((i) => i.tour_id === r.tour.id && (i.day === null || i.day === r.day.day_number)), ws.id)
  const flagged = data.filter((r) => flagsOf(r).length > 0)
  const crossings = data.filter((r) => r.day.border_crossing)
  const shown = onlyFlagged ? flagged : data

  return (
    <>
      <PageHeader section="tours" title={t('tours')}
        subtitle={<span className="capitalize">{fmtLong(day, lang)}</span>}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => go(addDays(day, -1))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
            <Input type="date" value={day} onChange={(e) => e.target.value && go(e.target.value)} className="w-40" />
            <Button variant="secondary" onClick={() => go(addDays(day, 1))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
            {day !== today() && <Button variant="secondary" onClick={() => go(today())}>{t('today')}</Button>}
          </div>
        } />
      <div className="space-y-3 p-4 md:p-8">
        {/* The day in one line: groups, people, what needs attention, borders. */}
        {data.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
            <span className="font-semibold text-slate-900">{t('todayGroups', { n: data.length })}</span>
            <span className="text-slate-500">{t('todayPeople', { n: people })}</span>
            {flagged.length > 0 ? (
              <button type="button" onClick={() => setOnlyFlagged(!onlyFlagged)} aria-pressed={onlyFlagged}
                className={cn('flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', onlyFlagged ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-800 hover:bg-amber-100')}>
                <AlertTriangle size={12} aria-hidden />{t('todayNeedAttention', { n: flagged.length })}
              </button>
            ) : <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><Check size={13} aria-hidden />{t('todayAllGood')}</span>}
            {crossings.map((r) => (
              <span key={r.tour.id} className="flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-0.5 text-xs text-sky-800">
                <Flag size={12} aria-hidden /><b>{r.tour.code}</b> → {r.day.border_crossing}
              </span>
            ))}
            <span className="ml-auto inline-flex rounded-lg bg-slate-100 p-0.5 text-xs" role="tablist">
              {([false, true] as const).map((c) => (
                <button key={String(c)} type="button" role="tab" aria-selected={byCity === c} onClick={() => go(day, c)}
                  className={cn('rounded-md px-2.5 py-1 font-medium', byCity === c ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                  {t(c ? 'dayByCity' : 'dayByGroup')}
                </button>
              ))}
            </span>
          </div>
        )}
        {rows.isSuccess && data.length === 0 && <EmptyState title={t('noGroupsDay')} />}
        {byCity ? <CityDay date={day} rows={data} /> : (
          <div className="space-y-3">
            {shown.map((r) => <Group key={r.tour.id} row={r} flags={flagsOf(r)} isToday={day === today()} />)}
          </div>
        )}
      </div>
    </>
  )
}

/** What needs the operator: a night or meal without a place, a supplier not confirmed, an open incident. */
function attention(r: Row, t: (k: TKey, p?: Record<string, string | number>) => string, services: { id: string; vendor: { id: string; name: string } }[],
  incidents: Incident[], wsId: string): Flag[] {
  const d = r.day
  const out: Flag[] = []
  const to = `/w/${wsId}/tours/${r.tour.id}`
  if (!r.is_last_day && !d.hotel) out.push({ text: t('todayNoHotel'), tone: 'amber', to })
  for (const m of ['lunch', 'dinner'] as const) {
    const mode = m === 'lunch' ? d.lunch_mode : d.dinner_mode
    if (mode !== 'own' && !(m === 'lunch' ? d.lunch : d.dinner) && !d.meal_tbd?.[m]) out.push({ text: t('todayNoMeal', { meal: t(m) }), tone: 'amber', to })
  }
  // Today's suppliers not confirmed yet.
  const today = new Map<string, string>()
  for (const v of [d.hotel, d.breakfast, d.lunch, d.dinner]) if (v) today.set(v.id, v.name)
  for (const x of d.extras) { const s = services.find((y) => y.id === x.service_id); if (s) today.set(s.vendor.id, s.vendor.name) }
  for (const a of r.staff_today) today.set(a.vendor.id, a.vendor.name)
  for (const [id, name] of today) {
    const st = r.bookings?.[id]
    if (st && st !== 'confirmed' && st !== 'cancelled') out.push({ text: `${name}: ${t(`bstatus_${st}` as TKey)}`, tone: st === 'problem' ? 'red' : 'amber', to: `${to}?tab=bookings` })
  }
  for (const i of incidents) out.push({ text: i.title, tone: 'red', to: `${to}?tab=incidents` })
  return out
}

const STEP_ICON: Record<string, ReactNode> = {
  breakfast: <Coffee size={13} />, meal: <Utensils size={13} />, checkin: <BedDouble size={13} />, visit: <Ticket size={13} />,
  flight: <Plane size={13} />, free: <Smile size={13} />, transfer: <Bus size={13} />, arrive: <MapPin size={13} />,
}
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

function Group({ row: r, flags, isToday }: { row: Row; flags: Flag[]; isToday: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const total = diffDays(r.tour.start_date, r.tour.end_date) + 1
  const p = r.programme
  const steps = (p?.steps ?? []).filter((s) => s.text || s.drive)
  // Now and next (today only): the last step that has started, and the one after it.
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const started = isToday ? steps.reduce((k, s, i) => (s.time && toMin(s.time) <= nowMin ? i : k), -1) : -1
  const route = p?.route?.length ? p.route : [r.day.city]
  return (
    <section className={cn('rounded-xl border bg-white', flags.length ? 'border-amber-300' : 'border-slate-200')}>
      {/* Who and where: code, client, people, day N of M, the road. */}
      <Link to={`/w/${ws.id}/tours/${r.tour.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-xl border-b border-slate-100 px-4 py-2.5 hover:bg-slate-50">
        <CodeChip code={r.tour.code} color={r.tour.color} className="text-sm" />
        <span className="min-w-0 max-w-[14rem] truncate text-sm font-medium text-slate-800">{r.tour.client_name || '—'}</span>
        <span className="text-sm tabular-nums text-slate-600">{paxText(r.tour)}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{t('day')} {r.day.day_number}/{total}</span>
        {r.is_first_day && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">{t('arrival')}</span>}
        {r.is_last_day && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-800">{t('departure')}</span>}
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-900">
          {route.map((x, i) => <span key={i} className="flex items-center gap-1.5">{i > 0 && <span className="text-slate-400" aria-hidden>→</span>}{x}</span>)}
        </span>
        {(p?.km || p?.drive) && <span className="flex items-center gap-1 text-xs text-slate-500"><Car size={12} aria-hidden />{[p?.km ? `${p.km} km` : '', p?.drive].filter(Boolean).join(' · ')}</span>}
      </Link>
      {/* What needs attention, first. */}
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2">
          {flags.map((f, i) => (
            <Link key={i} to={f.to ?? '#'} className={cn('flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
              f.tone === 'red' ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-amber-50 text-amber-800 hover:bg-amber-100')}>
              {f.tone === 'red' ? <AlertOctagon size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}{f.text}
            </Link>
          ))}
        </div>
      )}
      {/* The day hour by hour: done steps quiet, the current one marked, the rest as planned. */}
      {steps.length > 0 && (
        <ol className="grid gap-x-6 px-4 py-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
          {steps.map((s, i) => <StepLine key={i} s={s} state={started < 0 ? 'plan' : i < started ? 'done' : i === started ? 'now' : i === started + 1 ? 'next' : 'plan'} />)}
        </ol>
      )}
      {/* The team: one tap to call. */}
      {r.staff_today.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 px-4 py-2 text-xs">
          {r.staff_today.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5 text-slate-600">
              {a.role === 'transport' || a.role === 'driver' ? <Bus size={13} aria-hidden /> : <User size={13} aria-hidden />}
              <span className="text-slate-500">{t(`staffRole_${a.role}` as TKey)}</span>
              <span className="font-medium text-slate-800">{a.vendor.name}</span>
              {a.vendor.phone && <a href={`tel:${a.vendor.phone.replace(/\s/g, '')}`} className="text-brand-700 hover:underline">{a.vendor.phone}</a>}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function StepLine({ s, state }: { s: PStep; state: 'done' | 'now' | 'next' | 'plan' }) {
  const { t } = useI18n()
  return (
    <li className={cn('flex items-start gap-2 border-b border-slate-50 py-1', state === 'done' && 'opacity-50')}>
      <span className={cn('w-11 shrink-0 pt-px text-right font-medium tabular-nums', state === 'now' ? 'text-brand-700' : 'text-slate-700')}>{s.time || ''}</span>
      <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', state === 'now' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')} aria-hidden>
        {s.drive && !s.text ? <Car size={13} /> : STEP_ICON[s.kind ?? ''] ?? <MapPin size={13} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block', state === 'now' ? 'font-semibold text-slate-900' : 'text-slate-800')}>
          {s.text || (s.drive ? `${s.drive.start} → ${s.drive.end}` : '')}
          {state === 'now' && <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 text-[10px] font-semibold uppercase text-brand-700">{t('todayNow')}</span>}
          {state === 'next' && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold uppercase text-slate-600">{t('todayNext')}</span>}
        </span>
        {(s.drive || s.phone) && (
          <span className="block text-xs text-slate-500">
            {s.drive && s.text && <span>{[s.drive.km ? `${s.drive.km} km` : '', s.drive.drive].filter(Boolean).join(' · ')}{s.phone ? ' · ' : ''}</span>}
            {s.phone && <a href={`tel:${s.phone.replace(/\s/g, '')}`} className="text-brand-700 hover:underline">{s.phone}</a>}
          </span>
        )}
      </span>
    </li>
  )
}
