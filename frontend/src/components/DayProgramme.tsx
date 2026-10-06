/**
 * A day's programme in order, with times: breakfast 08:00 → museum 10:00 → lunch 13:00 → free time
 * → dinner 19:30. Dragged into order; each step can have a time (and an end time).
 *
 * Steps that are the day's own content (the hotel, lunch, dinner, a ticket, a flight) point at it
 * (`ref`), so their name follows the day; other steps (free time, a walk, a transfer) are typed in.
 * Until someone arranges the day, a suggested order is shown from what the day has.
 */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, ArrowDownUp, BedDouble, Car, ChevronDown, Coffee, Map as MapIcon, Pin, GripVertical, Landmark, MapPin, Plane, Plus, Smile, Truck, Utensils, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { api, type DayFields, type ScheduleItem, type ScheduleKind, type ServiceBrief, type TourDay, type Vendor } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { cn } from '../lib/utils'
import { useWorkspace } from '../lib/session'
import { Label } from './overlay'
import { InfoTip, Tooltip } from './Tooltip'
import { PlaceInput, type PlaceSuggestion } from './PlaceInput'
import { TripMap, type MapStop } from './TripMap'
import { Button } from './ui'

const ICON: Record<ScheduleKind, ReactNode> = {
  breakfast: <Coffee size={16} aria-hidden />, meal: <Utensils size={16} aria-hidden />, visit: <Landmark size={16} aria-hidden />,
  transfer: <Truck size={16} aria-hidden />, free: <Smile size={16} aria-hidden />, checkin: <BedDouble size={16} aria-hidden />,
  checkout: <BedDouble size={16} aria-hidden />, flight: <Plane size={16} aria-hidden />, other: <MapPin size={16} aria-hidden />,
}
// Each kind of step has its colour (with its icon and name, never colour alone).
const KIND_STYLE: Record<ScheduleKind, string> = {
  breakfast: 'bg-orange-100 text-orange-800', meal: 'bg-orange-100 text-orange-800', visit: 'bg-blue-100 text-blue-800',
  transfer: 'bg-slate-100 text-slate-700', free: 'bg-green-100 text-green-800', checkin: 'bg-violet-100 text-violet-800',
  checkout: 'bg-violet-100 text-violet-800', flight: 'bg-cyan-100 text-cyan-800', other: 'bg-slate-100 text-slate-700',
}
const ADDABLE: ScheduleKind[] = ['visit', 'free', 'transfer', 'other']
let seq = 0
const newId = () => `s${Date.now().toString(36)}${(++seq).toString(36)}`

/** A tour's saved day as the builder's fields. */
export const toFields = (d: TourDay): DayFields => ({
  city: d.city, hotel_id: d.hotel?.id ?? null, lunch_id: d.lunch?.id ?? null, dinner_id: d.dinner?.id ?? null,
  lunch_menu_id: d.lunch_menu_id, dinner_menu_id: d.dinner_menu_id,
  breakfast_id: d.breakfast?.id ?? null, breakfast_menu_id: d.breakfast_menu_id ?? null, breakfast_mode: d.breakfast_mode ?? 'hotel',
  border_crossing: d.border_crossing, notes: d.notes, extras: d.extras, km: d.km ?? null, drive_minutes: d.drive_minutes ?? [], drive_km: d.drive_km ?? [],
  stops: d.stops ?? [], lunch_mode: d.lunch_mode ?? 'included', dinner_mode: d.dinner_mode ?? 'included',
  flights: d.flights ?? [], schedule: d.schedule ?? [],
  staff_stay: d.staff_stay ?? 'none', staff_hotel_id: d.staff_hotel?.id ?? null, staff_twin: !!d.staff_twin,
})

/** What the day has, in a sensible order with usual times. */
export function suggest(day: DayFields, index: number, last: boolean, services: ServiceBrief[], factor = 1.25): ScheduleItem[] {
  const out: ScheduleItem[] = []
  const add = (x: Omit<ScheduleItem, 'id'>) => out.push({ id: newId(), ...x })
  const flights = day.flights ?? []
  flights.forEach((f, i) => f.direction === 'arrival' && add({ kind: 'flight', time: f.time, end: '', title: '', ref: `flight:${i}`, place: f.airport, notes: '' }))
  // Breakfast every morning after a night (at the hotel, or where the day says); the first day only if planned.
  const bMode = day.breakfast_mode ?? 'hotel'
  if (bMode !== 'own' && (index > 0 || (bMode !== 'hotel' && day.breakfast_id)))
    add({ kind: 'breakfast', time: '08:00', end: '', title: '', ref: 'breakfast', place: '', notes: '' })
  // With the map's driving times: leave at 09:00, drive to each stop (car time × the coach factor,
  // to the quarter hour), an hour at each, lunch when it's past 12:30, then on to the night's city.
  // Without them: stops an hour apart from 09:30, lunch at 13:00. Times only grow either way.
  // Never past 23:45: a day that runs over midnight is flagged as a long day on the road instead.
  const hm = (t: number) => { const m = Math.min(t, 23 * 60 + 45); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }
  const places = [...(day.stops ?? []), day.city]
  const legs = day.drive_minutes ?? []
  const timed = legs.length > 0 && legs.length <= places.length
  // The legs end at the last places (the first day may start at its first stop: no leg to it).
  const driveTo = (p: number) => {
    const k = p - (places.length - legs.length)
    return timed && k >= 0 ? Math.round((legs[k] * factor) / 15) * 15 : 0
  }
  let at = timed ? 9 * 60 : 9 * 60 + 30
  let lunched = false
  const lunch = () => {
    if (lunched) return
    lunched = true
    const time = hm(Math.max(13 * 60, at))
    if (day.lunch_mode === 'own') add({ kind: 'free', time, end: '', title: '', ref: 'lunch', place: '', notes: '' })
    else if (day.lunch_id) add({ kind: 'meal', time, end: '', title: '', ref: 'lunch', place: '', notes: '' })
    else return
    at = Math.max(13 * 60, at) + 90
  }
  ;(day.stops ?? []).forEach((stop, i) => {
    at += driveTo(i)
    if (at >= (timed ? 12 * 60 + 30 : 13 * 60)) lunch()
    add({ kind: 'visit', time: hm(at), end: '', title: stop, ref: null, place: stop, notes: '' })
    at += 60
  })
  const sights = day.extras.filter((x) => {
    const s = services.find((v) => v.id === x.service_id)
    return s && !['transport', 'guide', 'meal'].includes(s.category)
  })
  for (const x of sights) add({ kind: 'visit', time: '', end: '', title: '', ref: `extra:${x.id}`, place: '', notes: '' })
  if (timed) {
    if (at >= 12 * 60) lunch()           // on the way, before the last drive
    at += driveTo(places.length - 1)
  }
  lunch()
  // Check-in on arrival (not before 14:00) when the drive is known; else the usual 18:00.
  const checkin = timed ? Math.max(14 * 60, Math.ceil(at / 15) * 15) : Math.max(18 * 60, at)
  if (day.hotel_id && !last) add({ kind: 'checkin', time: hm(checkin), end: '', title: '', ref: 'hotel', place: '', notes: '' })
  const dinner = hm(Math.max(19 * 60 + 30, checkin + 90))
  if (day.dinner_mode === 'own') add({ kind: 'free', time: dinner, end: '', title: '', ref: 'dinner', place: '', notes: '' })
  else if (day.dinner_id) add({ kind: 'meal', time: dinner, end: '', title: '', ref: 'dinner', place: '', notes: '' })
  flights.forEach((f, i) => f.direction === 'departure' && add({ kind: 'flight', time: f.time, end: '', title: '', ref: `flight:${i}`, place: f.airport, notes: '' }))
  return out
}

/** 250 → "4 h 10", 45 → "45 min". */
const dur = (min: number) => {
  const m = Math.round(min / 5) * 5
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`
}

/** The day's drives, place to place: from the night before (or the first stop) to each stop, then the
 * night's city — km and coach time per leg from the map (legs line up with the last places). */
export function dayLegs(day: DayFields, from: string | undefined, factor: number): { from: string; to: string; km: number | null; minutes: number | null }[] {
  const places = [...(day.stops ?? []), day.city].filter((p) => p?.trim())
  const mins = day.drive_minutes ?? []
  const kms = day.drive_km ?? []
  const n = Math.max(mins.length, kms.length)
  if (!n || n > places.length) return []
  const start = places.length - n            // the first leg ends at places[start]
  return Array.from({ length: n }, (_, k) => ({
    from: start + k === 0 ? (from ?? '') : places[start + k - 1],
    to: places[start + k],
    km: kms[k] ?? null,
    minutes: mins[k] != null ? Math.round(mins[k] * factor) : null,
  }))
}

export function DayProgramme({ day, index, last, byId, services, disabled, startOpen, from, onChange }: {
  day: DayFields; index: number; last: boolean; byId: Map<string, Vendor>; services: ServiceBrief[]; disabled?: boolean; startOpen?: boolean
  from?: string      // where the group slept the night before
  onChange: (schedule: ScheduleItem[]) => void
}) {
  const { t } = useI18n()
  const saved = day.schedule ?? []
  const [open, setOpen] = useState(startOpen ?? saved.length > 0)
  const [adding, setAdding] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const bodyId = useId()
  // Stable ids for the suggestion while the day stays the same (dragging needs them).
  const factor = useWorkspace()?.drive_factor ?? 1.25
  const suggested = useMemo(() => suggest(day, index, last, services, factor), [day, index, last, services, factor])
  const raw = saved.length ? saved : suggested
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  // The name of a step that is the day's own content.
  const label = (x: ScheduleItem): { text: string; missing: boolean } => {
    const r = x.ref ?? ''
    if (!r) return { text: x.title, missing: false }
    if (r === 'breakfast') {
      const mode = day.breakfast_mode ?? 'hotel'
      if (mode === 'hotel') return { text: t('progBreakfast'), missing: false }
      if (mode === 'own') return { text: `${t('breakfast')}: ${t('mealOwn')}`, missing: false }
      return { text: `${t('breakfast')}: ${byId.get(day.breakfast_id ?? '')?.name ?? '—'}${mode === 'tourists' ? ` (${t('mealTourists')})` : ''}`, missing: !day.breakfast_id }
    }
    if (r === 'hotel') return { text: `${t('progCheckin')}: ${byId.get(day.hotel_id ?? '')?.name ?? '—'}`, missing: !day.hotel_id }
    if (r === 'lunch' || r === 'dinner') {
      const mode = r === 'lunch' ? day.lunch_mode : day.dinner_mode
      const id = r === 'lunch' ? day.lunch_id : day.dinner_id
      const word = t(r)
      if (mode === 'own') return { text: `${word}: ${t('mealOwn')}`, missing: false }
      return { text: `${word}: ${byId.get(id ?? '')?.name ?? '—'}${mode === 'tourists' ? ` (${t('mealTourists')})` : ''}`, missing: !id }
    }
    if (r.startsWith('extra:')) {
      const slot = day.extras.find((e) => e.id === r.slice(6))
      const s = services.find((v) => v.id === slot?.service_id)
      return { text: s ? s.name : x.title || '—', missing: !s }
    }
    if (r.startsWith('flight:')) {
      const f = (day.flights ?? [])[Number(r.slice(7))]
      return { text: f ? `${t(f.direction === 'arrival' ? 'flightArrival' : 'flightDeparture')} ${f.number}` : '—', missing: !f }
    }
    return { text: x.title, missing: false }
  }
  const save = (next: ScheduleItem[]) => onChange(next)
  // The day's road in the programme's own order: from last night's city to each visit, restaurant and
  // the hotel, asked from the map (kept on the server, so asking again is quick).
  const ws = useWorkspace()!
  // The catalogue's sights and activities (free ones too), suggested first when a visit is typed.
  const sights = useMemo(() => [...byId.values()].filter((v) => (v.type === 'activity' || v.type === 'other') && v.is_active)
    .map((v): PlaceSuggestion => ({ name: v.name, detail: [v.city, v.visit_minutes ? dur(v.visit_minutes) : ''].filter(Boolean).join(' · '), kind: '', lat: 0, lon: 0, own: true })), [byId])
  const path = pathOf(raw, day, byId, from, last)
  const road = useQuery({
    queryKey: ['day-road', ws.id, path.map((p) => p.place.toLowerCase())],
    queryFn: () => api<{ legs: MapLeg[] }>(wsPath(ws.id, '/distances'), { method: 'POST', body: { cities: path.map((p) => p.place) } }),
    staleTime: Infinity,
    meta: { silent: true },
    enabled: open && path.length > 1,
  })
  // Drives already known (this day or any other) are used at once; only new pairs of places wait for
  // the map — the times re-chain now and refine when it answers.
  const fresh = !!road.data && road.data.legs.length === path.length && !road.isFetching
  const { legs, complete } = legsFor(path, fresh ? road.data!.legs : undefined, road.isFetching)
  const { before, after } = drivesFrom(path, legs, factor)
  // The times keep themselves right: each step starts when the one before ends, plus the drive. Times
  // typed by hand (pinned) and flights stay; lunch and dinner wait for their usual time.
  const usual = (x: ScheduleItem) => sightOf(x, byId)?.visit_minutes
  const laid = (xs: ScheduleItem[]) => flow(xs, 0, before, 'full', xs.find((x) => x.time)?.time, usual)
  const items = laid(raw)
  const sig = (xs: ScheduleItem[]) => xs.map((x) => `${x.time}-${x.end}`).join(',')
  // Kept into the day once the road is settled (or the map can't answer), not while it's still asked.
  const settled = path.length < 2 || complete || road.isError
  const drift = !disabled && saved.length > 0 && settled && sig(items) !== sig(saved) ? items : null
  useEffect(() => { if (drift) onChange(drift) }, [drift ? sig(drift) : ''])   // eslint-disable-line react-hooks/exhaustive-deps
  const set = (id: string, patch: Partial<ScheduleItem>) => save(laid(items.map((x) => (x.id === id ? { ...x, ...patch } : x))))
  // A drag only changes the order: the road for the new order is asked, and the times follow.
  const onDragEnd = (e: DragEndEvent) => {
    const a = items.findIndex((x) => x.id === e.active.id)
    const b = items.findIndex((x) => x.id === e.over?.id)
    if (a >= 0 && b >= 0 && a !== b) save(arrayMove(items, a, b))
  }
  const byTime = () => save([...items].sort((a, b) => (a.time || '99').localeCompare(b.time || '99')))
  const timed = items.filter((x) => x.time)
  const first = timed[0]?.time
  const lastTime = timed[timed.length - 1]?.end || timed[timed.length - 1]?.time
  // What's off about a step compared with the timed step before it (and the drive in between); where the
  // right time is clear, the warning offers it ("Move to 13:00"), and everything after follows.
  const issues = new Map<string, StepIssue>()
  let prev: ScheduleItem | undefined
  let outOfOrder = false
  for (const x of items) {
    if (!x.time) continue
    const drive = Math.round((before.get(x.id)?.minutes ?? 0) / 5) * 5
    // Same as the drive rows: the step before ends at its end time, else after its usual length.
    const prevEnd = prev ? toMin(prev.time) + lengthOf(prev, usual) : null
    const arrive = prevEnd !== null ? prevEnd + drive : null
    // When it should start: on arrival, but lunch and dinner not before their usual time.
    const meal = x.ref === 'lunch' || x.ref === 'dinner' ? Math.min(toMin(x.time), MEAL_FROM[x.ref]) : 0
    const best = arrive !== null ? hm(Math.max(arrive, meal)) : null
    if (prev && x.time < prev.time) { issues.set(x.id, { text: t('progOrder', { time: prev.time }) }); outOfOrder = true }
    else if (arrive !== null && drive > 0 && toMin(x.time) < arrive) issues.set(x.id, { text: t('progDriveShort', { need: dur(drive), at: hm(arrive) }), fix: best! })
    else if (prev?.end && x.time < prev.end) issues.set(x.id, { text: t('progOverlap', { end: prev.end }), fix: best ?? undefined })
    else if (arrive !== null && drive > 0 && best && toMin(x.time) - toMin(best) > 60)
      issues.set(x.id, { text: t('progWait', { at: hm(arrive), wait: dur(toMin(x.time) - arrive) }), fix: best })
    else if (x.end && x.end <= x.time) issues.set(x.id, { text: t('progEndBefore') })
    prev = x
  }
  // "Move to": the step follows the day again (not pinned) from that time.
  const fixTime = (x: ScheduleItem, time: string) => set(x.id, { time, fixed: false, end: x.end ? shift(time, minutesBetween(x.time, x.end)) : '' })
  // When each drive leaves: the end of the timed step before it (its usual length when no end is set).
  const departs = new Map<string, number | null>()
  let lastEnd: number | null = null
  for (const x of items) {
    departs.set(x.id, lastEnd)
    if (x.time) lastEnd = toMin(x.time) + lengthOf(x, usual)
  }

  return (
    <div className="col-span-full rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}
          className="flex min-h-9 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 text-left text-sm font-semibold text-slate-800 hover:bg-slate-50">
          <ChevronDown size={16} aria-hidden className={cn('shrink-0 text-slate-500 transition-transform', open && 'rotate-180')} />
          {t('dayProgramme')}
          {saved.length ? (
            <span className="font-normal text-slate-600">
              {t('progSteps', { n: items.length })}{first && ` · ${first}${lastTime && lastTime !== first ? `–${lastTime}` : ''}`}
            </span>
          ) : <Label tone="light" wide={false}>{t('progSuggestedShort')}</Label>}
          {issues.size > 0 && <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800"><AlertTriangle size={14} aria-hidden />{t('progIssues', { n: issues.size })}</span>}
        </button>
        {path.length > 1 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setMapOpen(true)} aria-label={t('mapDayOf', { n: index + 1 })}>
            <MapIcon size={16} aria-hidden />{t('mapOpen')}
          </Button>
        )}
        <InfoTip label={t('progHelpTip')} />
      </div>
      {mapOpen && (
        <TripMap title={t('mapDayOf', { n: index + 1 })} subtitle={[from, ...(day.stops ?? []), day.city].filter(Boolean).join(' → ')}
          onClose={() => setMapOpen(false)}
          stops={path.map((p, i): MapStop => {
            if (p.id) {
              const x = items.find((y) => y.id === p.id)
              return { place: p.place, label: x ? `${x.time ? `${x.time} · ` : ''}${label(x).text || x.title}` : p.place, kind: 'step' }
            }
            return i === 0 ? { place: p.place, label: p.place, kind: 'start' } : { place: p.place, label: p.place, kind: 'night' }
          })} />
      )}
      {open && (
        <div id={bodyId} className="space-y-2 border-t border-slate-100 p-2 sm:p-3">
          <DayRoadSummary drives={[...before.values(), ...after]} factor={factor} loading={road.isFetching} failed={road.isError}
            hasPlaces={path.length > 1} />
          {!saved.length && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-slate-700">
              <span className="min-w-48 flex-1">{t('progSuggestedHelp')}</span>
              {!disabled && <Button type="button" size="sm" variant="secondary" onClick={() => save(items)}>{t('progKeep')}</Button>}
            </div>
          )}
          {items.length > 0 && (
            <div className="hidden items-center gap-2 px-1.5 text-xs font-medium text-slate-500 sm:flex" aria-hidden>
              {!disabled && <span className="w-7" />}
              <span className="w-[4.5rem] text-center">{t('progColStart')}</span>
              <span className="w-2" />
              <span className="w-[3.5rem] text-center">{t('progColEnd')}</span>
              <span className="pl-1">{t('progColStep')}</span>
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
            accessibility={{ screenReaderInstructions: { draggable: t('progDragInstructions') } }}>
            <SortableContext items={items.map((x) => x.id)} strategy={verticalListSortingStrategy}>
              <ol className="divide-y divide-slate-100 sm:space-y-1 sm:divide-y-0" aria-label={t('dayProgramme')}>
                {items.map((x) => (
                  <Fragment key={x.id}>
                    {before.has(x.id) && <DriveRow leg={before.get(x.id)!} depart={departs.get(x.id) ?? null} />}
                    <Step x={x} label={label(x)} disabled={disabled} issue={issues.get(x.id)} onFix={(time) => fixTime(x, time)}
                      length={lengthOf(x, usual)} sights={sights} sight={sightOf(x, byId)}
                      onSet={(patch) => set(x.id, patch)} onRemove={() => save(items.filter((y) => y.id !== x.id))} />
                  </Fragment>
                ))}
                {after.map((leg) => <DriveRow key={leg.to} leg={leg} depart={lastEnd} />)}
              </ol>
            </SortableContext>
          </DndContext>
          {items.length === 0 && <p className="px-1 text-sm text-slate-500">{t('progEmpty')}</p>}
          {!disabled && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {adding ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('progAdd')}>
                  {ADDABLE.map((k) => (
                    <Button type="button" key={k} size="sm" variant="secondary" onClick={() => { save([...items, { id: newId(), kind: k, time: '', end: '', title: '', ref: null, place: '', notes: '' }]); setAdding(false) }}>
                      <span className={cn('flex h-5 w-5 items-center justify-center rounded', KIND_STYLE[k])}>{ICON[k]}</span>{t(`prog_${k}` as TKey)}
                    </Button>
                  ))}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('cancel')}</Button>
                </div>
              ) : (
                <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />{t('progAdd')}</Button>
              )}
              {timed.length > 1 && (
                <Button type="button" size="sm" variant={outOfOrder ? 'secondary' : 'ghost'} onClick={byTime} className={cn('ml-auto', outOfOrder && 'border-amber-400 text-amber-900')}>
                  <ArrowDownUp size={16} aria-hidden />{t('progSortByTime')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const shift = (s: string, by: number) => {
  const [h, m] = (s || '09:00').split(':').map(Number)
  const n = (((h * 60 + m + by) % 1440) + 1440) % 1440
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

// Start times to pick from: every 15 minutes, the day first (06:00 → 23:45), the night after.
const QUARTERS = Array.from({ length: 96 }, (_, i) => {
  const m = ((i + 24) % 96) * 15
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
})

/** The start time, picked from a list (type "13" on the open list to jump there). Picking one pins it. */
function TimeSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { t } = useI18n()
  return (
    <Tooltip label={t('progTimePickTip')}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className="h-9 w-[5.5rem] shrink-0 rounded-md border border-slate-300 bg-white px-1 text-sm font-medium tabular-nums text-slate-800 hover:border-slate-500 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100">
        <option value="">--:--</option>
        {value && !QUARTERS.includes(value) && <option value={value}>{value}</option>}
        {QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
      </select>
    </Tooltip>
  )
}

function Step({ x, label, disabled, issue, onFix, length, sights, sight, onSet, onRemove }: {
  x: ScheduleItem; label: { text: string; missing: boolean }; disabled?: boolean; issue?: StepIssue; onFix: (time: string) => void
  length: number; sights: PlaceSuggestion[]; sight?: Vendor
  onSet: (p: Partial<ScheduleItem>) => void; onRemove: () => void
}) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: x.id, disabled })
  const typed = !x.ref
  const kind = t(`prog_${x.kind}` as TKey)
  const name = (typed ? x.title : label.text) || kind
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('rounded-lg border bg-white px-1.5 py-1', isDragging ? 'z-10 border-brand-300 shadow-lg' : issue ? 'border-amber-300 bg-amber-50/40' : 'border-transparent hover:border-slate-200')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex shrink-0 items-center gap-2">
          {!disabled && (
            <Tooltip label={t('progDragTip')}>
              <button type="button" {...attributes} {...listeners} aria-label={t('progDragLabel', { name })}
                className="flex h-9 w-7 cursor-grab touch-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 active:cursor-grabbing">
                <GripVertical size={18} aria-hidden />
              </button>
            </Tooltip>
          )}
          {disabled ? (
            <span className="w-[4.5rem] text-center text-sm font-medium tabular-nums text-slate-800">{x.time || '—'}{x.end && <span className="block text-xs font-normal text-slate-500">{x.end}{x.time && ` · ${dur(minutesBetween(x.time, x.end))}`}</span>}</span>
          ) : (
            <>
              <TimeSelect value={x.time} label={t('progStartOf', { name })}
                onChange={(v) => onSet(x.time && x.end && v ? { time: v, fixed: true, end: shift(v, minutesBetween(x.time, x.end)) } : { time: v, fixed: !!v })} />
              <span className="w-2 text-center text-slate-500" aria-hidden>–</span>
              <span className="w-[3.5rem] text-center text-sm tabular-nums text-slate-600" aria-label={t('progEndOf', { name })}>
                {x.end || (x.time && length ? `≈${hm(toMin(x.time) + length)}` : '—')}
              </span>
              <DurationPick start={x.time} end={x.end} name={name} usual={length} usualFrom={x.end ? undefined : sight?.name}
                onChange={(end) => onSet({ end })} />
              {x.kind !== 'flight' && x.time && (
                <Tooltip label={x.fixed ? t('progPinnedTip') : t('progFollowsTip')}>
                  <button type="button" aria-pressed={!!x.fixed} onClick={() => onSet({ fixed: !x.fixed })}
                    aria-label={t(x.fixed ? 'progUnpin' : 'progPin', { name })}
                    className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
                      x.fixed ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-700')}>
                    <Pin size={16} aria-hidden className={x.fixed ? 'fill-current' : ''} />
                  </button>
                </Tooltip>
              )}
            </>
          )}
        </div>
        <div className="flex min-w-[12rem] flex-1 items-center gap-2">
          <Tooltip label={kind}>
            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', KIND_STYLE[x.kind])} role="img" aria-label={kind}>{ICON[x.kind]}</span>
          </Tooltip>
          {typed && x.kind === 'visit' && !disabled ? (
            // A visit is a real place: suggested from the map, and picking one keeps where it is.
            <span className="min-w-0 flex-1 [&>span]:w-full">
              <PlaceInput value={x.title} own={sights} onChange={(title) => onSet({ title, place: '' })} maxLength={200}
                onPicked={(p) => onSet({ title: p.name, place: p.own ? '' : p.name })}
                aria-label={t('progStepName', { kind })} placeholder={t('progNamePh', { kind })}
                className="h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 placeholder:text-slate-400 hover:border-slate-500 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
            </span>
          ) : typed ? (
            <input value={x.title} disabled={disabled} onChange={(e) => onSet({ title: e.target.value })} maxLength={200}
              aria-label={t('progStepName', { kind })} placeholder={t('progNamePh', { kind })}
              className="h-9 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 placeholder:text-slate-400 hover:border-slate-500 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:border-transparent disabled:bg-transparent" />
          ) : (
            <span className="min-w-0 flex-1 text-sm text-slate-800">
              <span className="break-words">{label.text}</span>
              {label.missing && <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-red-700"><AlertTriangle size={13} aria-hidden />{t('progMissing')}</span>}
            </span>
          )}
          {!disabled && (
            <Tooltip label={t('progRemoveTip')}>
              <button type="button" onClick={onRemove} aria-label={t('progRemove', { name })}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-red-50 hover:text-red-700">
                <X size={18} aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {issue && (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-9 text-xs font-medium text-amber-900">
          <span className="inline-flex items-center gap-1"><AlertTriangle size={13} aria-hidden />{issue.text}</span>
          {issue.fix && !disabled && (
            <button type="button" onClick={() => onFix(issue.fix!)}
              className="rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100">
              {t('progMoveTo', { time: issue.fix })}
            </button>
          )}
        </p>
      )}
    </li>
  )
}

// --- the day in time: steps and the drives between them -------------------------------------------

interface StepIssue { text: string; fix?: string }   // fix: the start time that solves it
export type DriveLeg = { from: string; to: string; km: number | null; minutes: number | null; via: string[]; skipped?: MapLeg['skipped'] }
const DEFAULT_LEN: Record<ScheduleKind, number> = {
  breakfast: 45, meal: 60, visit: 60, transfer: 30, free: 60, checkin: 30, checkout: 15, flight: 0, other: 30,
}
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
const hm = (n: number) => {
  const m = Math.max(0, Math.min(Math.round(n), 23 * 60 + 55))   // a day that runs past midnight is flagged, not wrapped
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
/** How long a step takes: its own end, else the usual for its kind (dinner 1 h 30). */
export const lengthOf = (x: ScheduleItem, usual?: (x: ScheduleItem) => number | null | undefined) => {
  const own = x.time && x.end ? minutesBetween(x.time, x.end) : 0
  return own > 0 ? own : usual?.(x) || (x.ref === 'dinner' ? 90 : DEFAULT_LEN[x.kind])
}
/** The catalogue's sight (an activity, priced or free like Bodbe) a visit is at, by its name. */
export const sightOf = (x: ScheduleItem, byId?: Map<string, Vendor>) => {
  if (x.ref || x.kind !== 'visit' || !x.title.trim() || !byId) return undefined
  const n = x.title.trim().toLowerCase()
  const places = [...byId.values()].filter((v) => v.type === 'activity' || v.type === 'other')
  const exact = places.find((v) => v.name.trim().toLowerCase() === n)
  if (exact) return exact
  // "Garni" is the "Garni temple" supplier when it's the only one whose name starts like that.
  const starts = places.filter((v) => {
    const m = v.name.trim().toLowerCase()
    const [short, long] = m.length < n.length ? [m, n] : [n, m]
    return short.length >= 4 && (long.startsWith(`${short} `) || long.startsWith(`${short},`))
  })
  return starts.length === 1 ? starts[0] : undefined
}
const LATEST = 23 * 60 + 55
/** Where a step happens on the map: the hotel's address (else the night's city) for the check-in, the
 * restaurant's address or town for lunch and dinner, the place picked or typed for a visit. */
const placeOf = (x: ScheduleItem, day: DayFields, byId?: Map<string, Vendor>) => {
  if (x.ref === 'hotel') return byId?.get(day.hotel_id ?? '')?.address || day.city
  if (x.ref === 'breakfast') {
    // At the hotel: where the group slept (no drive). At a café: its address or town.
    if (!['included', 'tourists'].includes(day.breakfast_mode ?? 'hotel')) return ''
    const v = byId?.get(day.breakfast_id ?? '')
    return v?.address || v?.city || ''
  }
  if (x.ref === 'lunch' || x.ref === 'dinner') {
    if ((x.ref === 'lunch' ? day.lunch_mode : day.dinner_mode) === 'own') return ''
    const v = byId?.get((x.ref === 'lunch' ? day.lunch_id : day.dinner_id) ?? '')
    return v?.address || v?.city || ''
  }
  if (x.ref || x.kind !== 'visit') return ''
  // A sight from the catalogue goes to its exact spot (its address, fixed from the map).
  return sightOf(x, byId)?.address || x.place || x.title
}

/** One place on the day's road: last night's city (no step), a step's place, or where the day ends. */
export interface PathPoint { place: string; id: string | null }
interface MapLeg { from_city: string | null; to_city: string; km: number | null; minutes: number | null; skipped: 'not_found' | 'far' | 'pending' | 'asking' | null }

/** The places of the day in the programme's order; the same place twice in a row is one stop. */
export function pathOf(items: ScheduleItem[], day: DayFields, byId: Map<string, Vendor> | undefined, from: string | undefined, last: boolean): PathPoint[] {
  const pts: PathPoint[] = from?.trim() ? [{ place: from.trim(), id: null }] : []
  const push = (place: string, id: string | null) => {
    const p = place.trim()
    if (p && pts[pts.length - 1]?.place.toLowerCase() !== p.toLowerCase()) pts.push({ place: p, id })
  }
  for (const x of items) push(placeOf(x, day, byId), x.id)
  // The last day has no check-in: the group still ends in the day's city (the airport, home).
  if (last || !items.some((x) => x.ref === 'hotel')) push(day.city, null)
  return pts
}

/** The map's legs as drives before the steps they end at; a drive to where the day ends comes after. */
// Every drive the map answered this session, by place pair ("tbilisi→mtskheta"), for all days.
const legCache = new Map<string, MapLeg>()
const pairKey = (a: string, b: string) => `${a.trim().toLowerCase()}→${b.trim().toLowerCase()}`

/** The legs of a path: the map's answer for it when there is one (kept for later), else every pair
 * already known, and the rest "asking" (while the map is asked) or unknown. */
export function legsFor(path: PathPoint[], answer: MapLeg[] | undefined, asking: boolean): { legs: MapLeg[]; complete: boolean } {
  if (answer && answer.length === path.length) {
    answer.forEach((l, i) => {
      if (i > 0 && !l.skipped && (l.from_city ?? '').toLowerCase() === path[i - 1].place.toLowerCase()) legCache.set(pairKey(path[i - 1].place, path[i].place), l)
    })
    return { legs: answer, complete: true }
  }
  let complete = true
  const legs = path.map((pt, i): MapLeg => {
    if (i === 0) return { from_city: null, to_city: pt.place, km: 0, minutes: 0, skipped: null }
    if (pt.place.toLowerCase() === path[i - 1].place.toLowerCase()) return { from_city: path[i - 1].place, to_city: pt.place, km: 0, minutes: 0, skipped: null }
    const hit = legCache.get(pairKey(path[i - 1].place, pt.place))
    if (hit) return hit
    complete = false
    return { from_city: path[i - 1].place, to_city: pt.place, km: null, minutes: null, skipped: asking ? 'asking' : null }
  })
  return { legs, complete }
}

export function drivesFrom(path: PathPoint[], legs: MapLeg[], factor: number) {
  const before = new Map<string, DriveLeg>()
  const after: DriveLeg[] = []
  if (legs.length !== path.length) return { before, after }
  for (let i = 1; i < path.length; i++) {
    const l = legs[i]
    if (!l.skipped && !l.km && !l.minutes) continue          // the same place by another name
    const d: DriveLeg = {
      from: l.from_city ?? path[i - 1].place, to: path[i].place, km: l.skipped ? null : l.km,
      minutes: !l.skipped && l.minutes != null ? Math.round(l.minutes * factor) : null, via: [], skipped: l.skipped,
    }
    const id = path[i].id
    if (id) before.set(id, d)
    else after.push(d)
  }
  return { before, after }
}

// Lunch and dinner follow the arrival, but not before a normal meal time (or the time planned, if earlier).
const MEAL_FROM: Record<string, number> = { lunch: 13 * 60, dinner: 19 * 60 + 30 }

/** Lay the day out in time from step `start` on: each step begins when the one before ends plus the
 * drive to it, so changing a step (its time, its length, its place in the order) moves everything after
 * it, earlier or later. The step just edited ("edit") keeps the time typed; after a drag or "Re-time with
 * the road" ("full") the first step takes `anchor` (the day's first time). Flights keep their times. */
export function flow(items: ScheduleItem[], start: number, before: Map<string, DriveLeg>, mode: 'full' | 'edit', anchor?: string,
  usual?: (x: ScheduleItem) => number | null | undefined): ScheduleItem[] {
  const out = items.map((x) => ({ ...x }))
  let at: number | null = null
  for (let i = 0; i < start; i++) if (out[i].time) at = toMin(out[i].time) + lengthOf(out[i], usual)
  for (let i = start; i < out.length; i++) {
    const x = out[i]
    const own = items[i].time
    const len = lengthOf(items[i], usual)
    if (x.kind === 'flight') { if (own) at = toMin(own); continue }
    if (items[i].fixed && own) {            // typed by hand: stays, and the day goes on from it
      const t = toMin(own)
      if (items[i].end && len > 0) x.end = t + len <= LATEST ? hm(t + len) : ''
      at = t + len
      continue
    }
    let t0: number | null
    if (i === start && mode === 'edit') t0 = own ? toMin(own) : at
    else if (at === null) t0 = i === start && anchor ? toMin(anchor) : own ? toMin(own) : null
    else t0 = at + Math.round((before.get(x.id)?.minutes ?? 0) / 5) * 5
    if (t0 === null) continue
    const meal = x.ref === 'lunch' || x.ref === 'dinner' ? MEAL_FROM[x.ref] : undefined
    if (meal !== undefined && !(i === start && mode === 'edit')) t0 = Math.max(t0, own ? Math.min(toMin(own), meal) : meal)
    x.time = hm(t0)
    // Past midnight the times stop at 23:55 (the day is flagged): no end then, so the length isn't lost.
    // Only a length someone chose is kept (as an end that moves with the start); the others stay
    // "usual" and follow the sight's visit length if it changes.
    x.end = items[i].end && len > 0 ? (t0 + len <= LATEST ? hm(t0 + len) : '') : ''
    at = t0 + len
  }
  return out
}

const minutesBetween = (a: string, b: string) => {
  const [ah, am] = a.split(':').map(Number)
  const [bh, bm] = b.split(':').map(Number)
  return ((bh * 60 + bm - (ah * 60 + am)) % 1440 + 1440) % 1440
}

const DURATIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480]

/** How long it takes: picking "1 h 30" sets the end time from the start. Needs a start time. */
function DurationPick({ start, end, name, usual, usualFrom, onChange }: {
  start: string; end: string; name: string; usual: number; usualFrom?: string; onChange: (end: string) => void
}) {
  const { t } = useI18n()
  const current = start && end ? minutesBetween(start, end) : null
  const custom = current !== null && !DURATIONS.includes(current)
  return (
    <Tooltip label={!start ? t('progDurationNeedsStart') : usualFrom ? t('progDurationSight', { place: usualFrom }) : t('progDurationTip')}>
      <select value={current === null ? '' : String(current)} disabled={!start} aria-label={t('progDurationOf', { name })}
        onChange={(e) => onChange(e.target.value === '' ? '' : shift(start, Number(e.target.value)))}
        className={cn('h-9 w-[5.5rem] shrink-0 rounded-md border border-slate-300 bg-white px-1 text-sm tabular-nums',
          'hover:border-slate-500 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50',
          current === null ? 'text-slate-500' : 'text-slate-800')}>
        <option value="">{usual ? `≈ ${dur(usual)}` : t('progDurationPh')}</option>
        {custom && <option value={String(current)}>{dur(current!)}</option>}
        {DURATIONS.map((m) => <option key={m} value={String(m)}>{dur(m)}</option>)}
      </select>
    </Tooltip>
  )
}

/** A drive between two steps, in the timeline: when it leaves and arrives, where to, km and time. */
function DriveRow({ leg, depart }: { leg: DriveLeg; depart: number | null }) {
  const { t } = useI18n()
  const what = [leg.km != null ? `${leg.km} km` : '', leg.minutes != null ? `≈ ${dur(leg.minutes)}` : ''].filter(Boolean).join(' · ')
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 pl-1.5 text-sm text-slate-600 sm:pl-9">
      <span className="flex w-[4.5rem] shrink-0 justify-center" aria-hidden>
        <span className="h-6 border-l-2 border-dashed border-slate-300" />
      </span>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700" aria-hidden><Car size={16} /></span>
      <span className="font-medium text-slate-700">
        {t('progDriveTo', { place: leg.to })}{leg.via.length > 0 && <span className="font-normal"> ({t('via')} {leg.via.join(', ')})</span>}
      </span>
      {leg.skipped === 'asking' ? <span className="text-slate-500">{t('progRoadAsking')}</span>
        : leg.skipped ? <span className="text-amber-800">{t(leg.skipped === 'pending' ? 'progDrivePending' : 'progDriveUnknown')}</span>
        : what && <span className="tabular-nums">{what}</span>}
      {depart !== null && leg.minutes != null && (
        <span className="tabular-nums text-slate-500">{t('progDriveTimes', { from: hm(depart), to: hm(depart + Math.round(leg.minutes / 5) * 5) })}</span>
      )}
    </li>
  )
}

/** The day's road in one line, and "Re-time with the road" when the drives are known. */
function DayRoadSummary({ drives, hasPlaces, loading, failed, factor }: {
  drives: DriveLeg[]; hasPlaces: boolean; loading: boolean; failed: boolean; factor: number
}) {
  const { t } = useI18n()
  const known = drives.filter((l) => (l.km ?? 0) > 0 || (l.minutes ?? 0) > 0)
  if (!known.length) {
    if (!hasPlaces) return null
    return (
      <p className="flex items-center gap-1.5 px-1 text-sm text-slate-600" role="status">
        <Car size={15} aria-hidden className="shrink-0" />{loading ? t('progRoadAsking') : failed ? t('mapUnavailable') : t('progRoadNone')}
      </p>
    )
  }
  const km = known.reduce((s, l) => s + (l.km ?? 0), 0)
  const min = known.reduce((s, l) => s + (l.minutes ?? 0), 0)
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
      <Car size={16} aria-hidden className="shrink-0 text-slate-600" />
      <span className="min-w-48 flex-1 text-slate-700" role="status">
        {t('progRouteTotal', { km, time: dur(min), pct: Math.round((factor - 1) * 100) })}{loading && ` · ${t('progRoadAsking')}`}
      </span>
      <InfoTip label={t('progAutoTimesTip')} />
    </div>
  )
}
