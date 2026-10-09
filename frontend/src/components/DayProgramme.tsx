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
import { AlertTriangle, ArrowDownUp, BedDouble, Car, Coffee, Map as MapIcon, Pin, GripVertical, Landmark, MapPin, Plane, Smile, StickyNote, Truck, Utensils, X, ChevronDown, ChevronUp } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type DayExtra, type DayFields, type ScheduleItem, type ScheduleKind, type ServiceBrief, type TourDay, type Vendor } from '../lib/api'
import { airportName } from '../lib/airports'
import { fmt } from '../lib/dates'
import { catOf, type ActivityCat } from '../lib/activities'
import { wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { cn, slotId } from '../lib/utils'
import { useWorkspace } from '../lib/session'
import { Menu } from './overlay'
import { InfoTip, Tooltip } from './Tooltip'
import { PlaceInput, type OpeningHours, type PlaceSuggestion } from './PlaceInput'
import { TripMap, type MapStop } from './TripMap'
import { VendorSelect } from './VendorSelect'
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
  meal_dishes: d.meal_dishes ?? {}, seating: d.seating ?? {}, meal_tbd: d.meal_tbd ?? {},
})

/** What the day has, in a sensible order with usual times. */
/** "Gelati" and "Gelati Monastery": one name starts the other (as the catalogue matches stops). */
const samePlace = (a: string, b: string) => {
  const [short, long] = [a.trim().toLowerCase(), b.trim().toLowerCase()].sort((x, y) => x.length - y.length)
  return short.length >= 4 && (long === short || long.startsWith(`${short} `) || long.startsWith(`${short},`))
}

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
    else if (day.lunch_id || day.meal_tbd?.lunch) add({ kind: 'meal', time, end: '', title: '', ref: 'lunch', place: '', notes: '' })
    else return
    at = Math.max(13 * 60, at) + 90
  }
  const sights = day.extras.filter((x) => {
    const s = services.find((v) => v.id === x.service_id)
    return s && !['transport', 'guide', 'meal'].includes(s.category)
  })
  const placeOf = (x: DayExtra) => services.find((v) => v.id === x.service_id)?.vendor.id
  // A stop that is an activity's place (Gelati the stop, Gelati the ticket): one visit, in the stops' order.
  const atStop = new Set<string>()
  ;(day.stops ?? []).forEach((stop, i) => {
    at += driveTo(i)
    if (at >= (timed ? 12 * 60 + 30 : 13 * 60)) lunch()
    const hit = sights.find((x) => { const s = services.find((v) => v.id === x.service_id); return s && samePlace(s.vendor.name, stop) })
    if (hit && !atStop.has(placeOf(hit) ?? '')) {
      atStop.add(placeOf(hit) ?? '')
      add({ kind: 'visit', time: hm(at), end: '', title: '', ref: `extra:${hit.id}`, place: '', notes: '' })
    } else add({ kind: 'visit', time: hm(at), end: '', title: stop, ref: null, place: stop, notes: '' })
    at += 60
  })
  // One visit per place: KTW's wine tasting and bread baking are one stop.
  const firsts = sights.filter((x, i) => sights.findIndex((y) => placeOf(y) === placeOf(x)) === i && !atStop.has(placeOf(x) ?? ''))
  for (const x of firsts) add({ kind: 'visit', time: '', end: '', title: '', ref: `extra:${x.id}`, place: '', notes: '' })
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
  else if (day.dinner_id || day.meal_tbd?.dinner) add({ kind: 'meal', time: dinner, end: '', title: '', ref: 'dinner', place: '', notes: '' })
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

/** What the builder puts in a row of the day: the choice itself (hotel, restaurant...), its state, extras. */
export interface SlotRow {
  node: ReactNode; state?: 'done' | 'todo'; aside?: ReactNode; grip?: ReactNode
  summary?: ReactNode   // the row folded: one line of what's chosen ("Supra House · Set menu 2")
}
export type SlotRows = Partial<Record<'hotel' | 'breakfast' | 'lunch' | 'dinner', SlotRow>>

export function DayProgramme({ day, index, last, byId, services, disabled, from, fromHotel, onChange, onSetDay, date, slots, footer, bare, onAddMore, addAside, expandAll, templates }: {
  slots?: SlotRows          // the builder: these rows are where the hotel, breakfast, lunch and dinner are chosen
  footer?: ReactNode        // under the list (the day's activities, notes)
  bare?: boolean            // inside the day's card: no frame of its own
  onAddMore?: (what: 'flight' | 'note') => void   // "+ Flight", "+ Note" in the add line
  addAside?: ReactNode      // at the end of the add line ("What they do ›")
  templates?: ReactNode     // under the day's line: saved days for this town (one click fills the day)
  expandAll?: boolean       // "Show everything": every row open
  day: DayFields; index: number; last: boolean; byId: Map<string, Vendor>; services: ServiceBrief[]; disabled?: boolean; startOpen?: boolean
  date?: string      // the day's date (a tour): visits are checked against the places' opening hours
  from?: string      // where the group slept the night before
  fromHotel?: string | null   // ...and in which hotel: breakfast "at the hotel" is there, and the day's road starts from it
  onChange: (schedule: ScheduleItem[]) => void
  // Where the day itself can be changed (the builder): lunch and dinner are then picked right in the programme,
  // and the day's lunch/dinner follow — one change, with the programme.
  onSetDay?: (patch: Partial<DayFields>) => void
}) {
  const { t, lang } = useI18n()
  const saved = day.schedule ?? []
  const [mapOpen, setMapOpen] = useState(false)
  // The day reads as short lines; only the row being edited is open (one at a time).
  const [openRow, setOpenRow] = useState<string | null>(null)
  // Stable ids for the suggestion while the day stays the same (dragging needs them).
  const factor = useWorkspace()?.drive_factor ?? 1.25
  const suggested = useMemo(() => suggest(day, index, last, services, factor), [day, index, last, services, factor])
  // In the builder every day has its rows to fill: check-in, breakfast (after a night), lunch, dinner - one that
  // isn't there yet is added where it belongs (the times follow), so nothing is chosen anywhere else.
  const ensure = (xs: ScheduleItem[]): ScheduleItem[] => {
    if (!slots) return xs
    let out = [...xs]
    const has = (r: string) => out.some((x) => x.ref === r)
    const mk = (ref: string, kind: ScheduleKind): ScheduleItem => ({ id: `auto-${ref}`, kind, time: '', end: '', title: '', ref, place: '', notes: '' })
    const before = (refs: string[], step: ScheduleItem) => {
      const at = out.findIndex((x) => refs.includes(x.ref ?? ''))
      out = at < 0 ? [...out, step] : [...out.slice(0, at), step, ...out.slice(at)]
    }
    const bm = day.breakfast_mode ?? 'hotel'
    if (slots.breakfast && (index > 0 || bm !== 'hotel') && bm !== 'own' && !has('breakfast')) out = [mk('breakfast', 'breakfast'), ...out]
    if (slots.lunch && !has('lunch')) before(['hotel', 'dinner'], mk('lunch', day.lunch_mode === 'own' ? 'free' : 'meal'))
    if (slots.hotel && !last && !has('hotel')) before(['dinner'], mk('hotel', 'checkin'))
    if (slots.dinner && !has('dinner')) out.push(mk('dinner', day.dinner_mode === 'own' ? 'free' : 'meal'))
    return out
  }
  const raw = ensure(saved.length ? saved : suggested)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  // The name of a step that is the day's own content.
  const label = (x: ScheduleItem): { text: string; missing: boolean } => {
    const r = x.ref ?? ''
    if (!r) return { text: x.title, missing: false }
    if (r === 'breakfast') {
      const mode = day.breakfast_mode ?? 'hotel'
      if (mode === 'hotel') {
        const slept = byId.get(fromHotel ?? '')
        return { text: slept ? `${t('breakfast')}: ${slept.name}` : t('progBreakfast'), missing: false }
      }
      if (mode === 'own') return { text: `${t('breakfast')}: ${t('mealOwn')}`, missing: false }
      return { text: `${t('breakfast')}: ${byId.get(day.breakfast_id ?? '')?.name ?? '—'}${mode === 'tourists' ? ` (${t('mealTourists')})` : ''}`, missing: !day.breakfast_id }
    }
    if (r === 'hotel') return { text: `${t('progCheckin')}: ${byId.get(day.hotel_id ?? '')?.name ?? '—'}`, missing: !day.hotel_id }
    if (r === 'lunch' || r === 'dinner') {
      const mode = r === 'lunch' ? day.lunch_mode : day.dinner_mode
      const id = r === 'lunch' ? day.lunch_id : day.dinner_id
      const word = t(r)
      if (mode === 'own') return { text: `${word}: ${t('mealOwn')}${day.meal_tbd?.[r] ? ` · ${day.meal_tbd[r]}` : ''}`, missing: false }
      if (!id && day.meal_tbd?.[r]) return { text: `${word}: ${t('mealTbdShort', { town: day.meal_tbd[r]! })}`, missing: false }
      return { text: `${word}: ${byId.get(id ?? '')?.name ?? '—'}${mode === 'tourists' ? ` (${t('mealTourists')})` : ''}`, missing: !id }
    }
    if (r.startsWith('extra:')) {
      const slot = day.extras.find((e) => e.id === r.slice(6))
      const s = services.find((v) => v.id === slot?.service_id)
      if (!s || !slot) return { text: x.title || '—', missing: !s }
      // The place and what's done there: this activity and the place's others that have no step of their own.
      const own = new Set(raw.map((y) => y.ref).filter((y): y is string => !!y?.startsWith('extra:') && y !== r))
      const here = day.extras.filter((e) => e === slot || (!own.has(`extra:${e.id}`)
        && services.find((v) => v.id === e.service_id)?.vendor.id === s.vendor.id))
      const names = here.map((e) => {
        const n = services.find((v) => v.id === e.service_id)?.name ?? ''
        return e.optional ? `${n} (${t('activityOptional').toLowerCase()})` : n
      }).filter(Boolean)
      const vendor = s.vendor.name
      const text = names.every((n) => n.toLowerCase().includes(vendor.toLowerCase())) ? names.join(', ') : `${vendor}: ${names.join(', ')}`
      return { text, missing: false }
    }
    if (r.startsWith('flight:')) {
      const f = (day.flights ?? [])[Number(r.slice(7))]
      const where = f?.airport ? ` · ${airportName(f.airport, lang)}` : ''
      return { text: f ? `${t(f.direction === 'arrival' ? 'flightArrival' : 'flightDeparture')} ${f.number}${where}` : '—', missing: !f }
    }
    return { text: x.title, missing: false }
  }
  const save = (next: ScheduleItem[]) => onChange(next)
  // The day's road in the programme's own order: from last night's city to each visit, restaurant and
  // the hotel, asked from the map (kept on the server, so asking again is quick).
  const ws = useWorkspace()!
  // The catalogue's sights and activities (free ones too), suggested first when a visit is typed.
  const sights = useMemo(() => {
    const places = [...byId.values()].filter((v) => (v.type === 'activity' || v.type === 'other') && v.is_active)
    const ids = new Set(places.map((v) => v.id))
    const offered = services.filter((s) => ids.has(s.vendor.id) && s.category !== 'meal' && s.category !== 'hotel')
    // A place with priced activities: picked, its first one is on the day (the others are ticked in "what they do").
    const only = (vid: string) => offered.find((s) => s.vendor.id === vid)?.id
    return [
      ...places.map((v): PlaceSuggestion => ({ name: v.name, detail: [v.city, v.visit_minutes ? dur(v.visit_minutes) : ''].filter(Boolean).join(' · '), kind: '', lat: 0, lon: 0, own: true,
        service_id: only(v.id) })),
      // An activity happens at its place: picked, the step is there (no map search, no drive between them).
      ...offered.map((s): PlaceSuggestion => ({ name: s.name, detail: t('progAt', { place: s.vendor.name }), kind: '', at: s.vendor.name, lat: 0, lon: 0, own: true,
        service_id: s.id })),
    ]
  }, [byId, services, t])
  const start = index > 0 ? byId.get(fromHotel ?? '')?.address || from : from
  const path = pathOf(raw, day, byId, start, last)
  const road = useQuery({
    queryKey: ['day-road', ws.id, path.map((p) => p.place.toLowerCase())],
    queryFn: () => api<{ legs: MapLeg[] }>(wsPath(ws.id, '/distances'), { method: 'POST', body: { cities: path.map((p) => p.place) } }),
    staleTime: Infinity,
    meta: { silent: true },
    enabled: path.length > 1,
  })
  // Drives already known (this day or any other) are used at once; only new pairs of places wait for
  // the map — the times re-chain now and refine when it answers.
  const fresh = !!road.data && road.data.legs.length === path.length && !road.isFetching
  const { legs, complete } = legsFor(path, fresh ? road.data!.legs : undefined, road.isFetching)
  const { before, after } = drivesFrom(path, legs, factor)
  // The times keep themselves right: each step starts when the one before ends, plus the drive. Times
  // typed by hand (pinned) and flights stay; lunch and dinner wait for their usual time.
  const usual = (x: ScheduleItem) => stepUsual(x, day, byId, services)
  const laid = (xs: ScheduleItem[]) => flow(xs, 0, before, 'full', xs.find((x) => x.time)?.time, usual)
  const items = laid(raw)
  const sig = (xs: ScheduleItem[]) => xs.map((x) => `${x.time}-${x.end}`).join(',')
  // Kept into the day once the road is settled (or the map can't answer), not while it's still asked.
  const settled = path.length < 2 || complete || road.isError
  const drift = !disabled && saved.length > 0 && settled && sig(items) !== sig(saved) ? items : null
  useEffect(() => { if (drift) onChange(drift) }, [drift ? sig(drift) : ''])   // eslint-disable-line react-hooks/exhaustive-deps
  const set = (id: string, patch: Partial<ScheduleItem>) => save(laid(items.map((x) => (x.id === id ? { ...x, ...patch } : x))))
  // A drag puts the step where it was dropped: it takes that spot's time (when the step before it ends)
  // and follows the day from there — a pinned time or a meal's usual hour doesn't pull it back. The road
  // for the new order is asked, and the times refine when it answers.
  const onDragEnd = (e: DragEndEvent) => {
    const a = items.findIndex((x) => x.id === e.active.id)
    const b = items.findIndex((x) => x.id === e.over?.id)
    if (a < 0 || b < 0 || a === b) return
    const next = arrayMove(items, a, b)
    const moved = next[b]
    if (moved.kind !== 'flight') {
      const prev = next.slice(0, b).reverse().find((x) => x.time)
      const spot = prev ? hm(Math.min(toMin(prev.time) + lengthOf(prev, usual), LATEST))
        : next.slice(1).find((x) => x.time)?.time ?? moved.time      // to the top: the day's first time
      next[b] = { ...moved, time: spot, fixed: false, end: moved.end && moved.time ? shift(spot, minutesBetween(moved.time, moved.end)) : moved.end }
    }
    save(laid(next))
  }
  // The step before's place, by name ("KTW", not its address): an activity typed after it happens there.
  const prevPlaceName = (x: ScheduleItem) => {
    const i = items.findIndex((y) => y.id === x.id)
    for (let j = i - 1; j >= 0; j--) {
      const p = items[j]
      if (p.kind === 'visit' && !p.ref) return (p.place && byId.size && [...byId.values()].some((v) => v.name.toLowerCase() === p.place.toLowerCase()) ? p.place : '') || p.title || undefined
      if (p.ref === 'lunch' || p.ref === 'dinner') return byId.get((p.ref === 'lunch' ? day.lunch_id : day.dinner_id) ?? '')?.name
      if (p.ref === 'hotel') return byId.get(day.hotel_id ?? '')?.name
      if (p.ref?.startsWith('extra:')) return services.find((s) => s.id === day.extras.find((e) => e.id === p.ref!.slice(6))?.service_id)?.vendor.name
    }
    return undefined
  }
  // A catalogue activity picked in a visit becomes one of the day's services (priced, booked) and the step
  // points at it — so the programme and the day's services are one list.
  const linkActivity = (stepId: string, serviceId: string) => {
    const id = slotId()
    onSetDay!({
      extras: [...day.extras, { id, service_id: serviceId, quantity: null, notes: '' }],
      schedule: laid(items.map((y) => (y.id === stepId ? { ...y, ref: `extra:${id}`, title: '', place: '', fixed: y.fixed } : y))),
    })
  }
  // Removing an activity's step takes it off the day too (with the place's other activities it stood for).
  const removeStep = (x: ScheduleItem) => {
    const next = items.filter((y) => y.id !== x.id)
    if (!onSetDay || !x.ref?.startsWith('extra:')) { save(next); return }
    const slot = day.extras.find((e) => e.id === x.ref!.slice(6))
    const vendor = services.find((s) => s.id === slot?.service_id)?.vendor.id
    const own = new Set(next.map((y) => y.ref).filter((r): r is string => !!r?.startsWith('extra:')).map((r) => r.slice(6)))
    const gone = new Set(day.extras.filter((e) => e === slot || (!own.has(e.id ?? '') && vendor
      && services.find((s) => s.id === e.service_id)?.vendor.id === vendor && !['transport', 'guide', 'meal'].includes(services.find((s) => s.id === e.service_id)?.category ?? ''))).map((e) => e.id))
    onSetDay({ schedule: next, extras: day.extras.filter((e) => !gone.has(e.id)) })
  }
  // A meal added from the programme is the day's breakfast, lunch or dinner (included, unless the day says
  // otherwise). Breakfast goes first in the morning; taken out earlier, it can come back the same way.
  const addMeal = (m: 'breakfast' | 'lunch' | 'dinner') => {
    if (m === 'breakfast') {
      const next = laid([{ id: newId(), kind: 'breakfast' as ScheduleKind, time: '08:00', end: '', title: '', ref: 'breakfast', place: '', notes: '' }, ...items])
      onSetDay!({ schedule: next, ...(day.breakfast_mode === 'own' ? { breakfast_mode: 'hotel' as const } : {}) })
      return
    }
    const next = laid([...items, { id: newId(), kind: 'meal' as ScheduleKind, time: '', end: '', title: '', ref: m, place: '', notes: '' }])
    const mode = m === 'lunch' ? day.lunch_mode : day.dinner_mode
    onSetDay!({ schedule: next, ...(mode === 'own' ? (m === 'lunch' ? { lunch_mode: 'included' as const } : { dinner_mode: 'included' as const }) : {}) })
  }
  const serving = useMemo(() => new Set(services.filter((s) => s.category === 'meal' || s.code === 'lunch' || s.code === 'dinner').map((s) => s.vendor.id)), [services])
  const vendorList = useMemo(() => [...byId.values()], [byId])
  const mealPicker = (x: ScheduleItem) => {
    if (!onSetDay || (x.ref !== 'lunch' && x.ref !== 'dinner')) return undefined
    const m = x.ref
    if ((m === 'lunch' ? day.lunch_mode : day.dinner_mode) === 'own') return undefined
    return (
      <span className="block min-w-0">
        <span className="block px-1 text-sm font-medium text-slate-800">{t(m)}</span>
        <span className="block min-w-0">
          <VendorSelect className="h-7 w-auto max-w-full border-transparent bg-transparent px-1 text-xs text-slate-600 hover:border-slate-200" vendors={vendorList} types={['restaurant', 'hotel']} note={(v) => (v.type === 'hotel' && !serving.has(v.id) ? ` · ${t('noMealPrice')}` : '')}
            value={(m === 'lunch' ? day.lunch_id : day.dinner_id) ?? null} cities={[...(day.stops ?? []), day.city]}
            onChange={(v) => onSetDay(m === 'lunch' ? { lunch_id: v, lunch_menu_id: null, meal_tbd: withoutTbd(day, 'lunch') } : { dinner_id: v, dinner_menu_id: null, meal_tbd: withoutTbd(day, 'dinner') })}
            placeholder={day.meal_tbd?.[m] ? t('mealTbdShort', { town: day.meal_tbd[m]! }) : t('chooseRestaurant')} />
        </span>
      </span>
    )
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
  // Opening hours (of places picked from the map): a visit on a day it's closed, or outside its hours, is flagged.
  const placeName = (x: ScheduleItem) => {
    if (x.ref?.startsWith('extra:')) return services.find((v) => v.id === day.extras.find((e) => e.id === x.ref!.slice(6))?.service_id)?.vendor.name
    if (x.ref === 'lunch' || x.ref === 'dinner') return byId.get((x.ref === 'lunch' ? day.lunch_id : day.dinner_id) ?? '')?.name
    return !x.ref && x.kind === 'visit' ? x.title.trim() : undefined
  }
  const names = [...new Set(items.map(placeName).filter((n): n is string => !!n))]
  const hoursQ = useQuery({
    queryKey: ['place-hours', ws.id, names.join('|')],
    queryFn: () => api<Record<string, OpeningHours>>(wsPath(ws.id, '/places/hours'), { method: 'POST', body: { names } }),
    enabled: !!date && names.length > 0, staleTime: 5 * 60_000, meta: { silent: true },
  })
  if (date && hoursQ.data) {
    const wd = new Date(`${date}T00:00:00`).getDay()
    for (const x of items) {
      const h = hoursQ.data[placeName(x) ?? '']
      if (!h || !x.time || issues.has(x.id) || !h.periods.length) continue
      const today = h.periods.filter((p) => p.day === wd)
      if (!today.length) { issues.set(x.id, { text: t('progClosedThatDay', { day: fmt(date, lang, { weekday: 'long' }) }) }); continue }
      const from = toMin(x.time), to = from + lengthOf(x, usual)
      if (!today.some((p) => toMin(p.open) <= from && to <= toMin(p.close))) {
        issues.set(x.id, { text: t('progOpenHours', { hours: today.map((p) => `${p.open}–${p.close}`).join(', ') }) })
      }
    }
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

  // A new step at a spot in the day (a free gap, or the end): it follows the step before.
  const insertAt = (i: number, k: ScheduleKind) =>
    save(laid([...items.slice(0, i), { id: newId(), kind: k, time: '', end: '', title: '', ref: null, place: '', notes: '' }, ...items.slice(i)]))
  // The road of the day in one chip, and the day's span.
  const drives = [...before.values(), ...after].filter((l) => (l.km ?? 0) > 0 || (l.minutes ?? 0) > 0)
  const roadKm = drives.reduce((n, l) => n + (l.km ?? 0), 0)
  const roadMin = drives.reduce((n, l) => n + (l.minutes ?? 0), 0)
  const span = first ? `${first}${lastTime && lastTime !== first ? ` – ${lastTime}` : ''}` : ''
  const addChip = (k: ScheduleKind, onClick: () => void, text?: string) => (
    <button key={k + (text ?? '')} type="button" onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-2.5 text-xs text-slate-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-800">
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{ICON[k]}</span>{text ?? t(`prog_${k}` as TKey)}
    </button>
  )

  return (
    <section className={cn('col-span-full min-w-0', !bare && 'rounded-xl border border-slate-200 bg-white p-3 sm:p-4')} aria-label={t('dayProgramme')}>
      {/* One line: what this is, the road, the day's span - then the map. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold text-slate-800">{t('dayProgramme')}</h4>
        {roadKm > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700">
            <Car size={13} aria-hidden />{t('progOnRoad', { km: roadKm, time: dur(roadMin) })}
          </span>
        )}
        {issues.size > 0 && <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800"><AlertTriangle size={14} aria-hidden />{t('progIssues', { n: issues.size })}</span>}
        <span className="ml-auto flex items-center gap-1">
          {span && <span className="mr-1 text-sm tabular-nums text-slate-500">{span}</span>}
          {path.length > 1 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setMapOpen(true)} aria-label={t('mapDayOf', { n: index + 1 })}>
              <MapIcon size={16} aria-hidden />{t('mapOpen')}
            </Button>
          )}
          <InfoTip label={`${t('progHelpTip')} ${t('progAutoTimesTip')}`} />
        </span>
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

      {templates}
      {drives.length === 0 && path.length > 1 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500" role="status">
          <Car size={14} aria-hidden className="shrink-0" />{road.isFetching ? t('progRoadAsking') : road.isError ? t('mapUnavailable') : t('progRoadNone')}
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
        accessibility={{ screenReaderInstructions: { draggable: t('progDragInstructions') } }}>
        <SortableContext items={items.map((x) => x.id)} strategy={verticalListSortingStrategy}>
          <ol className="mt-3" aria-label={t('dayProgramme')}>
            {items.map((x, i) => {
              const leg = before.get(x.id)
              const dep = departs.get(x.id)
              const arrive = dep != null ? dep + Math.round((leg?.minutes ?? 0) / 5) * 5 : null
              const gap = x.time && arrive != null ? toMin(x.time) - arrive : 0
              return (
                <Fragment key={x.id}>
                  {leg && <DriveRow leg={leg} depart={dep ?? null}
                    samePlace={!disabled && x.kind === 'visit' && !x.ref ? prevPlaceName(x) : undefined}
                    onSamePlace={(place) => set(x.id, { place })} />}
                  {gap >= 60 && (
                    <li className="flex gap-3">
                      <span className="w-20 shrink-0 pt-1.5 text-right text-xs tabular-nums text-slate-400">{hm(arrive!)}</span>
                      <span className="flex w-8 shrink-0 justify-center" aria-hidden><span className="border-l-2 border-dotted border-slate-300" /></span>
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5">
                        <span className="text-sm text-slate-500">{t('progFree', { time: dur(gap) })}</span>
                        {!disabled && (['visit', 'free', 'other'] as const).map((k) => addChip(k, () => insertAt(i, k)))}
                      </span>
                    </li>
                  )}
                  <Step x={x} label={label(x)} picker={disabled ? undefined : mealPicker(x)} disabled={disabled} issue={issues.get(x.id)} onFix={(time) => fixTime(x, time)}
                    slot={slots?.[(x.ref ?? '') as keyof SlotRows]}
                    open={expandAll || openRow === x.id} onToggle={() => setOpenRow(openRow === x.id ? null : x.id)}
                    length={lengthOf(x, usual)} sights={sights} sight={sightOf(x, byId)} end={i === items.length - 1 && !after.length}
                    cat={x.kind === 'visit' ? catOf((x.ref?.startsWith('extra:')
                      ? byId.get(services.find((s) => s.id === day.extras.find((e) => e.id === x.ref!.slice(6))?.service_id)?.vendor.id ?? '')
                      : sightOf(x, byId))?.category) : null}
                    onSet={(patch) => set(x.id, patch)} onRemove={() => removeStep(x)}
                    onLink={onSetDay ? (serviceId) => linkActivity(x.id, serviceId) : undefined} />
                </Fragment>
              )
            })}
            {after.map((leg) => <DriveRow key={leg.to} leg={leg} depart={lastEnd} />)}
          </ol>
        </SortableContext>
      </DndContext>
      {items.length === 0 && <p className="mt-2 text-sm text-slate-500">{t('progEmpty')}</p>}
      {footer}

      {/* Adding: one tap on what to add (it goes at the end and follows the day). */}
      {!disabled && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
          <span className="mr-1 text-xs font-medium text-slate-500">{t('progAddShort')}</span>
          {onSetDay && (['breakfast', 'lunch', 'dinner'] as const).filter((m) => !items.some((x) => x.ref === m))
            .map((m) => addChip(m === 'breakfast' ? 'breakfast' : 'meal', () => addMeal(m), t(m)))}
          {ADDABLE.map((k) => addChip(k, () => insertAt(items.length, k)))}
          {onAddMore && addChip('flight', () => onAddMore('flight'), t('progAddFlight'))}
          {onAddMore && addChip('other', () => onAddMore('note'), t('progAddNote'))}
          {addAside && <span className="ml-auto">{addAside}</span>}
          {outOfOrder && (
            <Button type="button" size="sm" variant="secondary" onClick={byTime} className="ml-auto border-amber-400 text-amber-900">
              <ArrowDownUp size={16} aria-hidden />{t('progSortByTime')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

/** The day's to-be-decided meals without this one (a place was picked). */
export const withoutTbd = (day: DayFields, meal: 'breakfast' | 'lunch' | 'dinner') => {
  const next = { ...(day.meal_tbd ?? {}) }
  delete next[meal]
  return next
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
        className="h-7 w-16 shrink-0 cursor-pointer appearance-none rounded-md bg-transparent px-1 text-right text-[15px] font-medium tabular-nums text-slate-800 hover:bg-slate-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100 [&>option]:bg-white [&>option]:text-slate-800">
        <option value="">--:--</option>
        {value && !QUARTERS.includes(value) && <option value={value}>{value}</option>}
        {QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
      </select>
    </Tooltip>
  )
}

function Step({ x, label, picker, disabled, issue, onFix, length, sights, sight, end, cat, onSet, onRemove, onLink, slot, open, onToggle }: {
  slot?: SlotRow     // the builder's row for the hotel / breakfast / lunch / dinner: chosen right here
  open?: boolean; onToggle?: () => void   // a builder row: folded to one line, or open to edit
  cat?: ActivityCat | null   // a visit at a catalogue place: its kind (museum, cable car...) as the bubble
  x: ScheduleItem; label: { text: string; missing: boolean }; picker?: ReactNode; disabled?: boolean; issue?: StepIssue; onFix: (time: string) => void
  length: number; sights: PlaceSuggestion[]; sight?: Vendor
  end?: boolean   // the day's last step: the line stops here
  onSet: (p: Partial<ScheduleItem>) => void; onRemove: () => void
  onLink?: (serviceId: string) => void   // a catalogue activity picked: it becomes the day's service
}) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: x.id, disabled })
  const typed = !x.ref
  // An activity at a place ("Shoti bread masterclass" at KTW): its place shown under the name.
  const atPlace = x.kind === 'visit' && !!x.place && x.place.trim().toLowerCase() !== x.title.trim().toLowerCase()
  const kind = t(`prog_${x.kind}` as TKey)
  const name = (typed ? x.title : label.text) || kind
  // "Breakfast: Old Town Hotel" → the what, and the where under it.
  const cut = label.text.indexOf(': ')
  const head = cut > 0 ? label.text.slice(0, cut) : label.text
  const where = cut > 0 ? label.text.slice(cut + 2) : ''
  // The step's note ("Bring swimsuits"): shown when it has one, or after "Add a note"; it goes into what's shared.
  const [noting, setNoting] = useState(false)
  const field = 'h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-sm font-medium text-slate-800 placeholder:font-normal placeholder:text-slate-400 hover:border-slate-200 focus:border-brand-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100'
  return (
    <li ref={setNodeRef} id={`step-${x.id}`} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('group flex scroll-mt-48 gap-3', isDragging && 'relative z-10')}>
      {/* The time column: when it starts, and how long. */}
      <div className="flex w-20 shrink-0 flex-col items-end pt-2">
        {disabled ? <span className="text-[15px] font-medium tabular-nums text-slate-800">{x.time || '—'}</span>
          : <TimeSelect value={x.time} label={t('progStartOf', { name })}
            onChange={(v) => onSet(x.time && x.end && v ? { time: v, fixed: true, end: shift(v, minutesBetween(x.time, x.end)) } : { time: v, fixed: !!v })} />}
        {x.kind !== 'flight' && (disabled
          ? x.time && length > 0 && <span className="block pr-1 text-xs tabular-nums text-slate-500">{dur(length)}</span>
          : <DurationPick start={x.time} end={x.end} name={name} usual={length} usualFrom={x.end ? undefined : sight?.name}
            onChange={(e) => onSet({ end: e })} />)}
      </div>
      {/* The line of the day, with the step's icon in its colour. */}
      <div className="flex w-8 shrink-0 flex-col items-center">
        <Tooltip label={kind}>
          <span className={cn('mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', label.missing ? 'bg-amber-100 text-amber-800' : cat ? cat.tone : KIND_STYLE[x.kind])}
            role="img" aria-label={kind}>{cat ? <cat.icon size={16} aria-hidden /> : ICON[x.kind]}</span>
        </Tooltip>
        {!end && <span className="w-0.5 flex-1 bg-slate-200" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 pb-2">
        <div className={cn('flex min-h-12 gap-2 rounded-xl border py-1.5 pl-1.5 pr-1 transition-colors', slot && (open || !slot.summary) ? 'items-start' : 'items-center',
          isDragging ? 'border-brand-300 bg-white shadow-lg' : slot?.state === 'todo' ? 'border-amber-300 bg-amber-50/50'
            : label.missing && !slot ? 'border-amber-300 bg-amber-50' : issue ? 'border-amber-300 bg-white' : 'border-slate-200 bg-white')}>
          {!disabled ? (
            <Tooltip label={t('progDragTip')}>
              <button type="button" {...attributes} {...listeners} aria-label={t('progDragLabel', { name })}
                className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-slate-300 opacity-0 hover:text-slate-700 focus:opacity-100 active:cursor-grabbing group-hover:opacity-100">
                <GripVertical size={16} aria-hidden />
              </button>
            </Tooltip>
          ) : <span className="w-1" />}
          <div className="min-w-0 flex-1">
            {slot && slot.summary && !open ? (
              // Folded: "Lunch  Supra House · Set menu 2" - a click opens it (and folds the one open before).
              <button type="button" onClick={onToggle} aria-expanded={false}
                className="animate-reveal flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-slate-50">
                <span className="w-20 shrink-0 text-sm font-medium text-slate-800">{slotTitle(x, t)}</span>
                <span className={cn('min-w-0 flex-1 truncate text-sm', slot.state === 'todo' ? 'font-medium text-amber-800' : 'text-slate-600')}>{slot.summary}</span>
                <ChevronDown size={15} aria-hidden className="shrink-0 text-slate-400" />
              </button>
            ) : slot ? (
              <div className="px-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {slot.summary ? (
                    <button type="button" onClick={onToggle} aria-expanded className="flex items-center gap-1 text-sm font-medium text-slate-800 hover:text-brand-700">
                      {slotTitle(x, t)}<ChevronUp size={14} aria-hidden className="text-slate-400" />
                    </button>
                  ) : <span className="text-sm font-medium text-slate-800">{slotTitle(x, t)}</span>}
                  {slot.state === 'todo' && <span className="text-[11px] font-semibold text-amber-700">{t('slotTodo')}</span>}
                  {slot.grip}
                  {slot.aside && <span className="ml-auto">{slot.aside}</span>}
                </div>
                <div className="animate-reveal mt-1">{slot.node}</div>
              </div>
            ) : typed && x.kind === 'visit' && !disabled ? (
              // A visit is a real place: suggested from the map, and picking one keeps where it is.
              <span className="block [&>span]:w-full">
                <PlaceInput value={x.title} own={sights} onChange={(title) => onSet({ title, place: atPlace ? x.place : '' })} maxLength={200}
                  onPicked={(p) => (p.service_id && onLink ? onLink(p.service_id) : onSet({ title: p.name, place: p.at ? p.at : p.own ? '' : p.name }))}
                  aria-label={t('progStepName', { kind })} placeholder={t('progNamePh', { kind })} className={field} />
              </span>
            ) : typed ? (
              <input value={x.title} disabled={disabled} onChange={(e) => onSet({ title: e.target.value })} maxLength={200}
                aria-label={t('progStepName', { kind })} placeholder={t('progNamePh', { kind })} className={field} />
            ) : picker ? picker : (
              <span className="block px-1">
                <span className="block break-words text-sm font-medium text-slate-800">{head}</span>
                {where && <span className="block break-words text-xs text-slate-500">{where}</span>}
                {label.missing && <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800"><AlertTriangle size={12} aria-hidden />{t('progMissing')}</span>}
              </span>
            )}
            {(noting || x.notes) && (
              <input value={x.notes} disabled={disabled} autoFocus={noting && !x.notes} maxLength={300}
                onChange={(e) => onSet({ notes: e.target.value })} onBlur={() => setNoting(false)}
                placeholder={t('progNotePh')} aria-label={t('progNoteOf', { name })}
                className="mt-0.5 h-7 w-full min-w-0 rounded-md border border-transparent bg-amber-50/60 px-1.5 text-xs text-amber-900 placeholder:text-amber-700/60 hover:border-amber-200 focus:border-amber-400 focus:bg-white focus:outline-none" />
            )}
            {atPlace && (
              <span className="mt-0.5 flex px-1"><span className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 py-0.5 pl-2 pr-1 text-xs text-blue-800">
                <MapPin size={12} className="shrink-0" aria-hidden /><span className="truncate">{t('progAt', { place: x.place })}</span>
                {!disabled && (
                  <Tooltip label={t('progAtClear')}>
                    <button type="button" onClick={() => onSet({ place: '' })} aria-label={t('progAtClear')}
                      className="rounded-full p-0.5 hover:bg-white"><X size={12} /></button>
                  </Tooltip>
                )}
              </span></span>
            )}
          </div>
          {/* Narrow screens: a pinned time shows its pin; the rest is in "⋯". */}
          {!disabled && x.fixed && x.kind !== 'flight' && (
            <span className="lg:hidden">
              <Tooltip label={t('progPinnedTip')}>
                <button type="button" aria-pressed onClick={() => onSet({ fixed: false })} aria-label={t('progUnpin', { name })}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-brand-700 hover:bg-brand-50">
                  <Pin size={14} aria-hidden className="fill-current" />
                </button>
              </Tooltip>
            </span>
          )}
          {!disabled && (
            <span className="lg:hidden">
              <Menu kind="icon" label={t('progStepMenu', { name })} items={[
                { label: t('progAddNote'), icon: <StickyNote size={16} />, onClick: () => setNoting(true), hidden: !!x.notes },
                { label: t(x.fixed ? 'progUnpin' : 'progPin', { name }), icon: <Pin size={16} />, onClick: () => onSet({ fixed: !x.fixed }), hidden: x.kind === 'flight' || !x.time },
                { label: t('progRemove', { name }), icon: <X size={16} />, onClick: onRemove, danger: true },
              ]} />
            </span>
          )}
          {/* Wide screens: there is room - note, pin and remove right on the step. */}
          {!disabled && (
            <span className="hidden shrink-0 items-center gap-0.5 lg:flex">
              {!x.notes && (
                <Tooltip label={t('progAddNote')}>
                  <button type="button" onClick={() => setNoting(true)} aria-label={t('progNoteOf', { name })}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                    <StickyNote size={15} aria-hidden />
                  </button>
                </Tooltip>
              )}
              {x.kind !== 'flight' && x.time && (
                <Tooltip label={x.fixed ? t('progPinnedTip') : t('progFollowsTip')}>
                  <button type="button" aria-pressed={!!x.fixed} onClick={() => onSet({ fixed: !x.fixed })} aria-label={t(x.fixed ? 'progUnpin' : 'progPin', { name })}
                    className={cn('flex h-7 w-7 items-center justify-center rounded-full',
                      x.fixed ? 'text-brand-700 hover:bg-brand-50' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700')}>
                    <Pin size={15} aria-hidden className={x.fixed ? 'fill-current' : ''} />
                  </button>
                </Tooltip>
              )}
              <Tooltip label={t('progRemoveTip')}>
                <button type="button" onClick={onRemove} aria-label={t('progRemove', { name })}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-700">
                  <X size={16} aria-hidden />
                </button>
              </Tooltip>
            </span>
          )}
        </div>
        {issue && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs font-medium text-amber-900">
            <span className="inline-flex items-center gap-1"><AlertTriangle size={13} aria-hidden />{issue.text}</span>
            {issue.fix && !disabled && (
              <button type="button" onClick={() => onFix(issue.fix!)}
                className="rounded-full border border-amber-400 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100">
                {t('progMoveTo', { time: issue.fix })}
              </button>
            )}
          </p>
        )}
      </div>
    </li>
  )
}

// --- the day in time: steps and the drives between them -------------------------------------------

interface StepIssue { text: string; fix?: string }   // fix: the start time that solves it
export type DriveLeg = { from: string; to: string; km: number | null; minutes: number | null; via: string[]; skipped?: MapLeg['skipped'] }
// The usual lengths: breakfast 30 min, lunch and dinner 45 (each step's own length can be chosen).
const DEFAULT_LEN: Record<ScheduleKind, number> = {
  breakfast: 30, meal: 45, visit: 60, transfer: 30, free: 60, checkin: 30, checkout: 15, flight: 0, other: 30,
}
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
const hm = (n: number) => {
  const m = Math.max(0, Math.min(Math.round(n), 23 * 60 + 55))   // a day that runs past midnight is flagged, not wrapped
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
/**
 * A saved day programme laid out again, as opening it would: the road for its order asked from the map
 * (starting at last night's hotel), each step after the one before plus the drive. Pinned times stay —
 * unless `release`, then they follow the day too (flights always keep theirs). null: nothing to change.
 */
export async function relayDay(wsId: string, day: DayFields, index: number, last: boolean, byId: Map<string, Vendor>,
  from: string | undefined, fromHotel: string | null | undefined, factor: number, release: boolean, services: ServiceBrief[] = []): Promise<ScheduleItem[] | null> {
  const saved = day.schedule ?? []
  if (!saved.length) return null                     // never arranged: always worked out fresh
  const items = release ? saved.map((x) => (x.kind === 'flight' || !x.fixed ? x : { ...x, fixed: false })) : saved
  const start = index > 0 ? byId.get(fromHotel ?? '')?.address || from : from
  const path = pathOf(items, day, byId, start, last)
  let answer: MapLeg[] | undefined
  if (path.length > 1) {
    try {
      answer = (await api<{ legs: MapLeg[] }>(wsPath(wsId, '/distances'), { method: 'POST', body: { cities: path.map((p) => p.place) } })).legs
    } catch { /* the map can't answer: drives already known are used */ }
  }
  const { legs } = legsFor(path, answer, false)
  const { before } = drivesFrom(path, legs, factor)
  const out = flow(items, 0, before, 'full', items.find((x) => x.time)?.time, (x) => stepUsual(x, day, byId, services))
  const sig = (xs: ScheduleItem[]) => xs.map((x) => `${x.time}-${x.end}-${x.fixed ? 1 : 0}`).join(',')
  return sig(out) === sig(saved) ? null : out
}

/** How long a step takes: its own end, else the usual for it (the activity's or place's), else its kind's. */
export const lengthOf = (x: ScheduleItem, usual?: (x: ScheduleItem) => number | null | undefined) => {
  const own = x.time && x.end ? minutesBetween(x.time, x.end) : 0
  return own > 0 ? own : usual?.(x) || DEFAULT_LEN[x.kind]
}
/** The usual length of a step: an activity of the day takes what the catalogue says it takes (else its
 * place's usual visit); a visit to a catalogue sight, that sight's. */
export const stepUsual = (x: ScheduleItem, day: DayFields, byId: Map<string, Vendor> | undefined, services: ServiceBrief[]) => {
  if (x.ref?.startsWith('extra:')) {
    const slot = day.extras.find((e) => e.id === x.ref!.slice(6))
    const s = services.find((v) => v.id === slot?.service_id)
    return s?.minutes || (s ? byId?.get(s.vendor.id)?.visit_minutes : undefined) || undefined
  }
  return sightOf(x, byId)?.visit_minutes
}
/** The day's steps with an end time each (time + its length), for printing: what the day plan shows. */
export const withEnds = (items: ScheduleItem[], usual: (x: ScheduleItem) => number | null | undefined) =>
  items.map((x) => (x.time && !x.end && ['breakfast', 'meal', 'visit', 'free', 'other'].includes(x.kind)
    ? { ...x, end: hm(toMin(x.time) + lengthOf(x, usual)) } : x))
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
  // A flight: the airport (by its full name, so the map finds it) - arriving, the day starts there;
  // leaving, it is the day's last destination.
  if (x.ref?.startsWith('flight:')) return airportName((day.flights ?? [])[Number(x.ref.slice(7))]?.airport)
  if (x.ref === 'hotel') return byId?.get(day.hotel_id ?? '')?.address || day.city
  if (x.ref === 'breakfast') {
    // At the hotel: where the group slept (no drive). At a café: its address or town.
    if (!['included', 'tourists'].includes(day.breakfast_mode ?? 'hotel')) return ''
    const v = byId?.get(day.breakfast_id ?? '')
    return v?.address || v?.city || ''
  }
  if (x.ref === 'lunch' || x.ref === 'dinner') {
    // On their own: where they'll be, if given (the road goes there).
    if ((x.ref === 'lunch' ? day.lunch_mode : day.dinner_mode) === 'own') return day.meal_tbd?.[x.ref] ?? ''
    const v = byId?.get((x.ref === 'lunch' ? day.lunch_id : day.dinner_id) ?? '')
    // No restaurant yet: the town or place given for it ("TBD · Ananuri") is where the road goes.
    return v ? v.address || v.city || '' : day.meal_tbd?.[x.ref] ?? ''
  }
  if (x.ref || x.kind !== 'visit') return ''
  // A sight from the catalogue goes to its exact spot (its address, fixed from the map); an activity
  // "at KTW" goes where KTW is.
  const at = x.place && x.place.trim().toLowerCase() !== x.title.trim().toLowerCase()
    ? [...(byId?.values() ?? [])].find((v) => v.name.trim().toLowerCase() === x.place.trim().toLowerCase()) : undefined
  if (at) return at.address || at.name
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
  // Where the day ends, when the programme has no check-in: the night's hotel (no drive when they're
  // already there - dinner at the hotel), else the day's town (the airport, home) - unless the last
  // place is already in that town.
  // Ending with a departure: the airport is the last destination.
  const lastStep = items.find((x) => x.id === pts[pts.length - 1]?.id)
  if (lastStep?.ref?.startsWith('flight:') && (day.flights ?? [])[Number(lastStep.ref.slice(7))]?.direction === 'departure') return pts
  if (!items.some((x) => x.ref === 'hotel')) {
    const hotel = last ? undefined : byId?.get(day.hotel_id ?? '')
    const end = pts[pts.length - 1]?.place.toLowerCase() ?? ''
    if (hotel) push(hotel.address || hotel.name, null)
    else if (!(day.city && end.includes(day.city.trim().toLowerCase()))) push(day.city, null)
  } else if (last) push(day.city, null)
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
        className={cn('select-chevron h-6 cursor-pointer rounded-md border-0 bg-transparent pl-1 pr-5 text-right text-xs tabular-nums [background-position:right_4px_center] [background-size:12px]',
          'hover:bg-slate-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50',
          // The open list is the browser's own: always white, whatever the field looks like.
          '[&>option]:bg-white [&>option]:text-slate-800',
          current === null ? 'text-slate-500' : 'text-slate-700')}>
        <option value="">{usual ? `≈ ${dur(usual)}` : t('progDurationPh')}</option>
        {custom && <option value={String(current)}>{dur(current!)}</option>}
        {DURATIONS.map((m) => <option key={m} value={String(m)}>{dur(m)}</option>)}
      </select>
    </Tooltip>
  )
}

/** A drive between two steps, on the line of the day: how long, how far, when - and where to. */
function DriveRow({ leg, depart, samePlace, onSamePlace }: {
  leg: DriveLeg; depart: number | null
  samePlace?: string; onSamePlace?: (place: string) => void   // not on the map: "it's at the place before"
}) {
  const { t } = useI18n()
  const what = [leg.minutes != null ? dur(leg.minutes) : '', leg.km != null ? `${leg.km} km` : ''].filter(Boolean).join(' · ')
  const to = leg.to.split(',')[0]
  return (
    <li className="flex gap-3">
      <span className="w-20 shrink-0" />
      <span className="flex w-8 shrink-0 justify-center" aria-hidden><span className="border-l-2 border-dashed border-slate-300" /></span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-sm text-slate-600">
        <Car size={15} aria-hidden className="shrink-0 text-slate-500" />
        {leg.skipped === 'asking' ? <span className="text-slate-500">{t('progRoadAsking')}</span>
          : leg.skipped ? <span className="text-amber-800">{t(leg.skipped === 'pending' ? 'progDrivePending' : 'progDriveUnknown')}</span>
          : what && <span className="font-medium tabular-nums text-slate-700">{what}</span>}
        {depart !== null && leg.minutes != null && (
          <span className="tabular-nums text-slate-500">{t('progDriveTimes', { from: hm(depart), to: hm(depart + Math.round(leg.minutes / 5) * 5) })}</span>
        )}
        <span className="min-w-0 max-w-full truncate text-slate-500" title={leg.to}>
          → {to}{leg.via.length > 0 && ` (${t('via')} ${leg.via.join(', ')})`}
        </span>
        {samePlace && onSamePlace && (leg.skipped === 'not_found' || leg.skipped === 'far' || (!leg.skipped && leg.km == null)) && (
          <Tooltip label={t('progSamePlaceTip')}>
            <button type="button" onClick={() => onSamePlace(samePlace)}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-slate-100 px-2.5 text-xs text-slate-700 hover:bg-slate-200">
              <MapPin size={13} aria-hidden />{t('progSamePlace', { place: samePlace })}
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  )
}

/** The title of a row the builder fills: "Check-in", "Breakfast", "Lunch", "Dinner". */
const slotTitle = (x: ScheduleItem, t: (k: TKey) => string) =>
  x.ref === 'hotel' ? t('progCheckin') : x.ref === 'breakfast' ? t('breakfast') : x.ref === 'lunch' ? t('lunch') : t('dinner')
