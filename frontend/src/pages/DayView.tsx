/**
 * "Today": every group on the road on one date, for the operator at 9 am - where each group is, what it does
 * hour by hour (now and next stand out), and what needs attention (a place not chosen, a booking not
 * confirmed, an open incident). One compact block per group; the team's phones one tap away.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertOctagon, AlertTriangle, BedDouble, Bus, Car, Check, ChevronLeft, ChevronRight, Clock, Coffee, Flag, List, Map as MapIcon, MapPin, Plane, Smile, Ticket, User, Utensils } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Drawer } from '../components/overlay'
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
  const raw = params.get('view')
  const view: View = raw === 'list' || raw === 'map' ? raw : 'board'      // (an old "by city" link opens the board)
  const go = (d: string, v: View = view) => setParams({ ...(d === today() ? {} : { date: d }), ...(v === 'board' ? {} : { view: v }) }, { replace: true })
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [open, setOpen] = useState<string | null>(null)       // a group's whole day, in the side panel
  const now = useNow()

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
  const isToday = day === today()
  const opened = data.find((r) => r.tour.id === open)

  return (
    <>
      <PageHeader section="tours" title={t('tours')}
        subtitle={<span className="capitalize">{fmtLong(day, lang)}{isToday && ` · ${hm(now)}`}</span>}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => go(addDays(day, -1))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
            <Input type="date" value={day} onChange={(e) => e.target.value && go(e.target.value)} className="w-40" />
            <Button variant="secondary" onClick={() => go(addDays(day, 1))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
            {!isToday && <Button variant="secondary" onClick={() => go(today())}>{t('today')}</Button>}
          </div>
        } />
      <div className="space-y-3 p-4 md:p-8">
        {/* The day in one line: groups, people, what needs attention, borders; Board · List · Map. */}
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
            <span className="ml-auto inline-flex rounded-lg bg-slate-100 p-0.5 text-xs" role="tablist" aria-label={t('itineraryView')}>
              {(['board', 'list', 'map'] as View[]).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => go(day, v)}
                  className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 font-medium', view === v ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                  {v === 'board' ? <Clock size={13} aria-hidden /> : v === 'list' ? <List size={13} aria-hidden /> : <MapIcon size={13} aria-hidden />}{t(`todayView_${v}`)}
                </button>
              ))}
            </span>
          </div>
        )}
        {rows.isSuccess && data.length === 0 && <EmptyState title={t('noGroupsDay')} />}
        {data.length > 0 && view === 'board' && <Board rows={shown} flagsOf={flagsOf} now={isToday ? now : null} onOpen={setOpen} />}
        {view === 'list' && (
          <div className="space-y-3">
            {shown.map((r) => <Group key={r.tour.id} row={r} flags={flagsOf(r)} isToday={isToday} />)}
          </div>
        )}
        {data.length > 0 && view === 'map' && <GroupsMap rows={shown} now={isToday ? now : null} onOpen={setOpen} />}
      </div>
      {opened && (
        <Drawer size="lg" title={`${opened.tour.code}${opened.tour.client_name ? ` · ${opened.tour.client_name}` : ''}`} onClose={() => setOpen(null)}>
          <Group row={opened} flags={flagsOf(opened)} isToday={isToday} />
        </Drawer>
      )}
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

type View = 'board' | 'list' | 'map'
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const LEN: Record<string, number> = { breakfast: 30, meal: 60, checkin: 30, visit: 90, free: 60, flight: 30, transfer: 45, other: 45 }

/** Minutes since midnight now, kept fresh each minute (the board's "now" line moves). */
function useNow() {
  const at = () => new Date().getHours() * 60 + new Date().getMinutes()
  const [now, setNow] = useState(at)
  useEffect(() => { const id = setInterval(() => setNow(at()), 60_000); return () => clearInterval(id) }, [])
  return now
}

interface Block { from: number; to: number; kind: string; label: string; road?: boolean; missing?: boolean; step: PStep }

/** A group's day as blocks on the hours: each step (its time to its end) and each drive (leaves → arrives). */
function blocksOf(r: Row): Block[] {
  const out: Block[] = []
  for (const s of r.programme?.steps ?? []) {
    if (s.drive?.depart && s.drive.arrive) {
      out.push({ from: toMin(s.drive.depart), to: Math.max(toMin(s.drive.arrive), toMin(s.drive.depart) + 15), kind: 'road', label: `→ ${s.drive.end}`, road: true, step: s })
    }
    if (s.time && (s.text || s.place)) {
      const from = toMin(s.time)
      const meal = s.meal === 'lunch' || s.meal === 'dinner'
      const mode = s.meal === 'lunch' ? r.day.lunch_mode : s.meal === 'dinner' ? r.day.dinner_mode : undefined
      const missing = meal && mode !== 'own' && !(s.meal === 'lunch' ? r.day.lunch : r.day.dinner)
      out.push({ from, to: s.end ? Math.max(toMin(s.end), from + 15) : from + (LEN[s.kind ?? ''] ?? 45), kind: s.kind ?? '', label: s.place || s.text, missing, step: s })
    }
  }
  return out.sort((a, b) => a.from - b.from)
}

/** Where the group is and what it does now: on the road to X (arrives …), at lunch at Y, next: …, or done. */
function statusOf(r: Row, now: number | null, t: (k: TKey, p?: Record<string, string | number>) => string): { icon: ReactNode; text: string } {
  const bl = blocksOf(r)
  const route = r.programme?.route?.length ? r.programme.route : [r.day.city]
  if (now == null) return { icon: <MapPin size={12} />, text: route.join(' → ') }
  const cur = bl.find((b) => b.road && b.from <= now && now < b.to) ?? bl.find((b) => b.from <= now && now < b.to)
  if (cur?.road) return { icon: <Bus size={12} />, text: t('boardDriving', { to: cur.step.drive!.end, time: hm(cur.to) }) }
  if (cur) return { icon: STEP_ICON[cur.kind] ?? <MapPin size={12} />, text: cur.missing ? t('todayNoMeal', { meal: t(cur.step.meal as TKey) }) : cur.step.text || cur.label }
  const next = bl.find((b) => b.from > now)
  if (next) return { icon: <Clock size={12} />, text: t('boardNext', { what: next.road ? next.label : next.step.text || next.label, time: hm(next.from) }) }
  return { icon: <BedDouble size={12} />, text: t('boardDone', { place: r.day.hotel?.name ?? r.day.city }) }
}

const BLOCK_TONE: Record<string, string> = {
  road: 'bg-slate-200 text-slate-600', breakfast: 'bg-amber-100 text-amber-900', meal: 'bg-orange-100 text-orange-900',
  checkin: 'bg-violet-100 text-violet-900', visit: 'bg-teal-100 text-teal-900', free: 'bg-green-100 text-green-900',
  flight: 'bg-sky-100 text-sky-900',
}

/** The live board: one lane per group across the day's hours, a "now" line, each group's status at the left. */
function Board({ rows, flagsOf, now, onOpen }: { rows: Row[]; flagsOf: (r: Row) => Flag[]; now: number | null; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  const all = rows.flatMap(blocksOf)
  const start = Math.min(7 * 60, ...all.map((b) => Math.floor(b.from / 60) * 60))
  const end = Math.max(22 * 60, ...all.map((b) => Math.ceil(b.to / 60) * 60))
  const pct = (m: number) => `${((m - start) / (end - start)) * 100}%`
  const hours = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60)
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[15rem_minmax(0,1fr)] border-b border-slate-200 text-[11px] text-slate-500">
          <span className="px-3 py-1.5">{t('boardGroupNow')}</span>
          <span className="relative h-7">
            {hours.map((h, i) => i % 2 === 0 && <span key={h} className="absolute top-1.5 -translate-x-1/2 tabular-nums" style={{ left: pct(h) }}>{String(h / 60).padStart(2, '0')}</span>)}
          </span>
        </div>
        {rows.map((r) => {
          const st = statusOf(r, now, t)
          const flags = flagsOf(r)
          return (
            <div key={r.tour.id} className="grid grid-cols-[15rem_minmax(0,1fr)] border-b border-slate-100 last:border-0">
              <button type="button" onClick={() => onOpen(r.tour.id)} className="flex min-w-0 flex-col gap-0.5 px-3 py-2 text-left hover:bg-slate-50">
                <span className="flex items-center gap-2">
                  <CodeChip code={r.tour.code} color={r.tour.color} className="shrink-0 whitespace-nowrap" />
                  <span className="text-xs tabular-nums text-slate-500">{paxText(r.tour)}</span>
                  {flags.length > 0 && <span title={flags.map((f) => f.text).join('\n')} className="flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-800"><AlertTriangle size={11} aria-hidden />{flags.length}</span>}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-xs text-slate-700"><span className="shrink-0 text-slate-400">{st.icon}</span><span className="truncate">{st.text}</span></span>
              </button>
              <div className="relative h-14">
                {hours.map((h) => <span key={h} className="absolute inset-y-0 border-l border-slate-100" style={{ left: pct(h) }} />)}
                {blocksOf(r).map((b, i) => (
                  <button key={i} type="button" onClick={() => onOpen(r.tour.id)} title={`${hm(b.from)}–${hm(b.to)} · ${b.road ? b.label : b.step.text || b.label}`}
                    style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)} - 2px)` }}
                    className={cn('absolute top-3.5 flex h-7 items-center overflow-hidden rounded-md px-1.5 text-[11px] font-medium',
                      b.missing ? 'border-[1.5px] border-dashed border-amber-500 bg-amber-50 text-amber-800' : BLOCK_TONE[b.road ? 'road' : b.kind] ?? 'bg-slate-100 text-slate-700',
                      now != null && b.to <= now && 'opacity-50')}>
                    <span className="truncate">{b.missing ? `${t(b.step.meal as TKey)} ?` : b.road ? b.label : b.label}</span>
                  </button>
                ))}
                {now != null && now >= start && now <= end && <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500" style={{ left: pct(now) }} />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Where every group is now, on a map: a pin per town with the groups there (on the road: where it's heading). */
function GroupsMap({ rows, now, onOpen }: { rows: Row[]; now: number | null; onOpen: (id: string) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  // Each group's place now: the town of the last drive it finished (or where it's driving to), else where the day starts.
  const where = rows.map((r) => {
    const route = r.programme?.route?.length ? r.programme.route : [r.day.city]
    let town = route[0] ?? r.day.city
    let moving = false
    for (const b of blocksOf(r).filter((x) => x.road)) {
      if (now == null) { town = r.day.city; break }
      if (b.to <= now) town = b.step.drive!.end
      else if (b.from <= now) { town = b.step.drive!.end; moving = true }
    }
    return { r, town: (town || r.day.city).trim(), moving }
  })
  const towns = [...new Set(where.map((w) => w.town).filter(Boolean))]
  const pts = useQuery({
    queryKey: ['groups-map', ws.id, towns.join('|')],
    queryFn: () => api<{ points: { name: string; lat: number | null; lon: number | null }[] }>(wsPath(ws.id, '/map'), { method: 'POST', body: { places: towns, roads: false } }),
    enabled: towns.length > 0, staleTime: Infinity, meta: { silent: true },
  })
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!el.current || !pts.data) return
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: true })
    m.attributionControl.setPrefix(false)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18, className: 'tm-tiles' }).addTo(m)
    const shown: L.LatLngExpression[] = []
    pts.data.points.forEach((p) => {
      if (p.lat == null || p.lon == null) return
      const here = where.filter((w) => w.town === p.name)
      const html = `<div class="tm-groups"><b>${p.name}</b>${here.map((w) => `<span data-tour="${w.r.tour.id}">${w.moving ? '→ ' : ''}${w.r.tour.code} · ${paxText(w.r.tour)}</span>`).join('')}</div>`
      const mk = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html, iconSize: undefined, iconAnchor: [0, 0] }) }).addTo(m)
      mk.on('click', (e) => { const id = ((e as L.LeafletMouseEvent).originalEvent.target as HTMLElement)?.dataset?.tour ?? here[0]?.r.tour.id; if (id) onOpen(id) })
      shown.push([p.lat, p.lon])
    })
    // Once the box has its size: every group in view.
    const fit = () => { m.invalidateSize(); if (shown.length) m.fitBounds(L.latLngBounds(shown), { padding: [70, 70], maxZoom: 10 }); else m.setView([41.9, 44.6], 7) }
    fit()
    const id = setTimeout(fit, 150)
    return () => { clearTimeout(id); m.remove() }
  }, [pts.data])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-2">
      <div ref={el} className="h-[60vh] min-h-[360px] overflow-hidden rounded-xl border border-slate-200" aria-label={t('todayView_map')} />
      <p className="text-xs text-slate-500">{t('todayMapHelp')}</p>
    </div>
  )
}
