/**
 * The itinerary builder (routes and tours): day cards you reorder by dragging, and a
 * palette of hotels, restaurants and catalog services you drag onto a day's slots.
 * Every slot is also a normal dropdown, and on phones you tap a palette item and then
 * the slot ("tap to place"), so nothing depends on dragging.
 */
import { DayGrid } from './DayGrid'
import { MealPlan, type Crew } from './MealPlan'
import {
  closestCenter, DndContext, DragOverlay, KeyboardSensor, pointerWithin, PointerSensor, rectIntersection, TouchSensor,
  useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, BedDouble, Bus, Car, Clock, Coffee, PanelLeft, CopyPlus, GripVertical, Hand, Map as MapIcon, MapPinned, Plane, Plus, Search, Ticket, Trash2, Utensils, X, ArrowRight, Check, ChevronDown, ChevronRight, Download, ListChecks } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type BreakfastMode, type BusReturn, type DayFields, type Flight, type MealMode, type Service, type ServiceBrief, type DayStaffStay, type TourAlert, type Vendor, type VendorType, can } from '../lib/api'
import { useServiceList, useVendors, wsPath } from '../lib/data'
import { fmt, weekday } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { cn, slotId } from '../lib/utils'
import { DayServices } from './DayServices'
import { DayProgramme, relayDay } from './DayProgramme'
import { Dialog, toast, Menu } from './overlay'
import { InfoTip, Tooltip } from './Tooltip'
import { VendorSelect } from './tour'
import { QuickServiceDialog, QuickVendorDialog } from './QuickAdd'
import { Button, field, IconButton, Input, SegmentedControl, Select } from './ui'
import { PlaceInput, type PlaceSuggestion } from './PlaceInput'
import { TripMap, type MapStop } from './TripMap'
import { useWorkspace } from '../lib/session'

type Slot = 'hotel' | 'breakfast' | 'lunch' | 'dinner' | 'extras'
type Item = { kind: 'vendor'; vendor: Vendor } | { kind: 'service'; service: ServiceBrief }

const SLOT_FIELD = { hotel: 'hotel_id', breakfast: 'breakfast_id', lunch: 'lunch_id', dinner: 'dinner_id' } as const

function accepts(slot: Slot, item: Item): boolean {
  if (slot === 'extras') return item.kind === 'service'
  if (item.kind !== 'vendor') return false
  return slot === 'hotel' ? item.vendor.type === 'hotel' : ['restaurant', 'hotel'].includes(item.vendor.type)
}

let seq = 0
const newKey = () => `d${++seq}`

/** A day only lands between days; a palette item only on the slot under the pointer. */
const collision: CollisionDetection = (args) => {
  const isItem = !!args.active.data.current?.item
  const droppableContainers = args.droppableContainers.filter((c) =>
    isItem ? !!c.data.current?.slot : !c.data.current?.slot && !String(c.id).startsWith('p-'))
  const scoped = { ...args, droppableContainers }
  if (!isItem) return closestCenter(scoped)
  const hits = pointerWithin(scoped)
  return hits.length ? hits : rectIntersection(scoped)
}

export const blankDay = (city = ''): DayFields =>
  ({ city, hotel_id: null, lunch_id: null, dinner_id: null, border_crossing: '', notes: '', extras: [], km: null, stops: [],
     lunch_mode: 'included', dinner_mode: 'included', flights: [], schedule: [] })

export function ItineraryBuilder({ days, onChange, dates, fixedLength, disabled, alerts = [], busReturn, onBusReturn, crew, onDownload }: {
  days: DayFields[]; onChange: (days: DayFields[]) => void
  onDownload?: () => void     // "Download programme", in the builder's "⋯"
  crew?: Crew                 // a tour's group and staff: each meal's tables and plates
  busReturn?: BusReturn | null; onBusReturn?: (b: BusReturn | null) => void   // the bus back to its garage
  dates?: string[]            // a tour's dates; a route has none
  fixedLength?: boolean       // a tour: days come from its dates (reorder only)
  disabled?: boolean
  alerts?: TourAlert[]        // shown on their day
}) {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const canCreate = !disabled && can(ws, 'operations')
  // Quick-add dialogs; `then` puts the new thing where it was asked for.
  const [newVendor, setNewVendor] = useState<{ type: VendorType; city?: string; then?: (v: Vendor) => void } | null>(null)
  const [newService, setNewService] = useState<{ vendorId?: string; menu?: boolean; then?: (s: Service) => void; meal?: 'breakfast' | 'lunch' | 'dinner' } | null>(null)
  const vendors = useVendors()
  const services = useServiceList()
  // Stable keys for dragging, kept in step with every change made here.
  const keys = useRef<string[]>(days.map(newKey))
  if (keys.current.length !== days.length) keys.current = days.map(newKey)
  const [dragging, setDragging] = useState<Item | null>(null)
  const [picked, setPicked] = useState<Item | null>(null)   // tap-to-place
  // The whole trip as rows (the quick way), or each day in full; remembered per browser.
  const [view, setViewState] = useState<'overview' | 'days' | 'check'>(() => {
    try { const v = localStorage.getItem('itineraryView'); return v === 'days' || v === 'check' ? v : 'overview' } catch { return 'overview' }
  })
  const setView = (v: 'overview' | 'days' | 'check') => { setViewState(v); try { localStorage.setItem('itineraryView', v) } catch { /* private window */ } }
  const [listOpen, setListOpen] = useState(false)   // the drag-and-drop list: on demand, so the days get the width
  // Simple day cards (the four questions; the rest under "More for this day") unless "Show everything" is on.
  const [full, setFullState] = useState(() => { try { return localStorage.getItem('builderFull') === '1' } catch { return false } })
  const setFull = (v: boolean) => { setFullState(v); try { localStorage.setItem('builderFull', v ? '1' : '0') } catch { /* private window */ } }
  // The map, "Suggest km" and "Recalculate times" keep their own dialogs; the "⋯" opens them.
  const tools = useRef<Tools>({})
  const canMap = days.flatMap((d) => [...(d.stops ?? []), d.city]).filter((x) => x?.trim()).length > 1
  const nextGap = nextGapOf(days)
  const openDay = (i: number) => {
    setView('days')
    setTimeout(() => document.getElementById(`day-card-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const set = (i: number, patch: Partial<DayFields>) => onChange(days.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const place = (i: number, slot: Slot, item: Item) => {
    if (!accepts(slot, item)) return
    if (slot === 'extras' && item.kind === 'service') set(i, { extras: [...days[i].extras, { id: slotId(), service_id: item.service.id, quantity: null, notes: '' }] })
    else if (item.kind === 'vendor' && slot !== 'extras') {
      const patch: Partial<DayFields> = { [SLOT_FIELD[slot]]: item.vendor.id }
      if (slot === 'hotel' && !days[i].city && item.vendor.city) patch.city = item.vendor.city
      // A restaurant dropped on breakfast: breakfast is there, not at the hotel any more.
      if (slot === 'breakfast' && ['hotel', 'own'].includes(days[i].breakfast_mode ?? 'hotel')) patch.breakfast_mode = 'included'
      set(i, patch)
    }
    // A picked service stays picked (a bus is needed most days); hotels and restaurants are one place.
    if (item.kind === 'vendor') setPicked(null)
  }
  const placeEveryDay = (item: Item) => {
    if (item.kind !== 'service') return
    onChange(days.map((d) => (d.extras.some((x) => x.service_id === item.service.id) ? d
      : { ...d, extras: [...d.extras, { id: slotId(), service_id: item.service.id, quantity: null, notes: '' }] })))
    setPicked(null)
  }
  const insert = (i: number, day: DayFields) => {
    keys.current = [...keys.current.slice(0, i), newKey(), ...keys.current.slice(i)]
    onChange([...days.slice(0, i), day, ...days.slice(i)])
  }
  const remove = (i: number) => {
    keys.current = keys.current.filter((_, j) => j !== i)
    onChange(days.filter((_, j) => j !== i))
  }

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current?.item as Item) ?? null)
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const { active, over } = e
    if (!over) return
    const item = active.data.current?.item as Item | undefined
    if (item) {   // palette → slot
      const target = over.data.current as { day: number; slot: Slot } | undefined
      if (target) place(target.day, target.slot, item)
      return
    }
    const from = keys.current.indexOf(String(active.id))
    const to = keys.current.indexOf(String(over.id))
    if (from >= 0 && to >= 0 && from !== to) {
      keys.current = arrayMove(keys.current, from, to)
      onChange(arrayMove(days, from, to))
    }
  }

  const vs = vendors.data ?? []
  const byId = useMemo(() => new Map(vs.map((v) => [v.id, v])), [vs])
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}>
      <div className={cn('grid gap-4', view === 'days' && listOpen && !disabled && 'lg:grid-cols-[18rem_1fr]')}>
        {view === 'days' && listOpen && !disabled && <Palette vendors={vs} services={services.data ?? []} picked={picked} onPick={setPicked}
          onClose={() => { setListOpen(false); setPicked(null) }}
          onAdd={canCreate ? (tab) => (tab === 'services' ? setNewService({}) : setNewVendor({ type: tab === 'hotels' ? 'hotel' : 'restaurant' })) : undefined} />}
        <div className="stagger min-w-0 space-y-3">
          {picked && (
            <p className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
              <Hand size={16} className="shrink-0" />
              <span className="min-w-0">{t('tapToPlace', { name: picked.kind === 'vendor' ? picked.vendor.name : `${picked.service.vendor.name} · ${picked.service.name}` })}</span>
              {picked.kind === 'service' && (
                <Button type="button" size="sm" variant="secondary" className="ml-auto shrink-0" onClick={() => placeEveryDay(picked)}>{t('addEveryDay')}</Button>
              )}
              <button type="button" className={cn('rounded p-1 hover:bg-brand-100', picked.kind !== 'service' && 'ml-auto')} onClick={() => setPicked(null)} aria-label={t('done')} title={t('done')}><X size={14} /></button>
            </p>
          )}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl size="sm" label={t('itineraryView')} value={view} onChange={setView}
                options={[['check', t('viewCheck')], ['overview', t('viewOverview')], ['days', t('viewDays')]]} />
              <div className="flex-1" />
              {/* The one main action: the next thing to fill in. Everything occasional sits in "⋯". */}
              {!disabled && nextGap >= 0 && (
                <Button type="button" onClick={() => openDay(nextGap)}>{t('nextMissing', { n: nextGap + 1 })}<ArrowRight size={16} aria-hidden /></Button>
              )}
              <Menu kind="more" label={t('moreActions')} items={[
                { label: t('programmeDownload'), icon: <Download size={16} />, onClick: () => onDownload?.(), hidden: !onDownload },
                { label: listOpen ? t('hideList') : t('addFromList'), icon: <PanelLeft size={16} />, hidden: disabled,
                  onClick: () => { setView('days'); setListOpen(!listOpen); setPicked(null) } },
                { label: full ? t('simpleView') : t('showEverything'), icon: <ListChecks size={16} />,
                  onClick: () => { setView('days'); setFull(!full) } },
                { label: t('mapOpen'), icon: <MapIcon size={16} />, onClick: () => tools.current.openMap?.(), hidden: !canMap },
                { label: t('suggestKm'), icon: <MapPinned size={16} />, onClick: () => tools.current.suggestKm?.(), hidden: disabled || !days.some((d) => d.city.trim()) },
                { label: t('recalcTimes'), icon: <Clock size={16} />, onClick: () => tools.current.recalc?.(), hidden: disabled || !days.some((d) => (d.schedule ?? []).length) },
              ]} />
            </div>
            {/* Where the tour stands: plain text, nothing to press. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2">
              <DistanceBar days={days} disabled={disabled} onChange={onChange} byId={byId} back={busReturn?.km ?? 0} tools={tools} />
              <BuildSteps days={days} />
            </div>
          </div>
          {view === 'days' && <DayStrip days={days} dates={dates} />}
          {view === 'check' && (
            // Every day on one screen: what is done, what is missing, days side by side.
            <DayGrid days={days} dates={dates} byId={byId} menus={services.data ?? []} alerts={alerts} crew={crew} onOpen={openDay} />
          )}
          {view === 'overview' && (
            <Overview days={days} dates={dates} vendors={vs} menus={services.data ?? []} disabled={disabled} alerts={alerts}
              onSet={set} onSetMany={(patches) => onChange(days.map((d, j) => (patches[j] ? { ...d, ...patches[j] } : d)))} onOpen={openDay}
              onNewVendor={canCreate ? (type, then) => setNewVendor({ type, then }) : undefined} />
          )}
          {view === 'days' && <SortableContext items={keys.current} strategy={verticalListSortingStrategy}>
            {days.map((d, i) => (
              <DayCard key={keys.current[i]} id={keys.current[i]} index={i} day={d} date={dates?.[i]} last={i === days.length - 1}
                prevCity={i > 0 ? days[i - 1].city : undefined} prevHotel={i > 0 ? days[i - 1].hotel_id : null}
                vendors={vs} byId={byId} disabled={disabled} fixedLength={fixedLength} dragging={dragging} picked={picked}
                menus={services.data ?? []} canCreate={canCreate} crew={crew} simple={!full}
                onNewVendor={(type, then) => setNewVendor({ type, city: d.city, then })}
                onNewService={(vendorId, menu, then, meal) => setNewService({ vendorId, menu, then, meal })}
                alerts={alerts.filter((a) => a.day === i + 1)}
                onSet={(patch) => set(i, patch)} onPlace={(slot, item) => place(i, slot, item)}
                onDuplicate={() => insert(i + 1, structuredClone(d))} onInsert={() => insert(i + 1, blankDay(d.city))}
                onRemove={() => remove(i)}
                onHotelNext={() => i + 1 < days.length && set(i + 1, { hotel_id: d.hotel_id, city: days[i + 1].city || d.city })} />
            ))}
          </SortableContext>}
          {onBusReturn && days.length > 0 && <BusBack days={days} value={busReturn ?? null} onChange={onBusReturn} disabled={disabled} />}
          {!disabled && !fixedLength && (
            <button type="button" onClick={() => insert(days.length, blankDay(days.at(-1)?.city))}
              className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 py-3 text-sm font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700">
              <Plus size={16} />{t('addDay')}
            </button>
          )}
        </div>
      </div>
      <DragOverlay>{dragging && <Chip item={dragging} lifted />}</DragOverlay>
      {newVendor && <QuickVendorDialog type={newVendor.type} city={newVendor.city} onClose={() => setNewVendor(null)}
        onCreated={(v) => newVendor.then?.(v)} />}
      {newService && <QuickServiceDialog vendorId={newService.vendorId} menu={newService.menu} meal={newService.meal} onClose={() => setNewService(null)}
        onCreated={(sv) => newService.then?.(sv)} />}
    </DndContext>
  )
}

/**
 * The whole trip as rows — date, town, hotel, lunch, dinner, places, km — each picked right here. A stay
 * of several nights in one hotel is one cell across those nights; changing it changes the whole stay.
 * A day's details (menus, programme, driver and guide) open with its number.
 */
function Overview({ days, dates, vendors, menus, disabled, alerts, onSet, onSetMany, onOpen, onNewVendor }: {
  days: DayFields[]; dates?: string[]; vendors: Vendor[]; menus: ServiceBrief[]; disabled?: boolean; alerts: TourAlert[]
  onSet: (i: number, p: Partial<DayFields>) => void; onSetMany: (patches: Record<number, Partial<DayFields>>) => void
  onOpen: (i: number) => void
  onNewVendor?: (type: VendorType, then: (v: Vendor) => void) => void
}) {
  const { t, lang } = useI18n()
  const serving = useMemo(() => new Set(menus.filter((s) => s.category === 'meal' || s.code === 'lunch' || s.code === 'dinner').map((s) => s.vendor.id)), [menus])
  const eats = (v: Vendor) => v.type !== 'hotel' || serving.has(v.id)
  const extrasOf = (d: DayFields) => [...new Set(d.extras.map((x) => menus.find((s) => s.id === x.service_id)?.vendor.name).filter(Boolean))].join(', ')
  // Stays: runs of nights in the same hotel (the last day has no night).
  const stays: { from: number; to: number }[] = []
  days.forEach((d, i) => {
    if (i === days.length - 1) return
    const prev = stays[stays.length - 1]
    if (prev && prev.to === i - 1 && d.hotel_id && days[i - 1].hotel_id === d.hotel_id) prev.to = i
    else stays.push({ from: i, to: i })
  })
  const stayAt = new Map(stays.map((s) => [s.from, s]))
  const covered = new Set(stays.flatMap((s) => Array.from({ length: s.to - s.from }, (_, k) => s.from + k + 1)))
  const meal = (i: number, which: 'lunch' | 'dinner') => {
    const d = days[i]
    const mode = which === 'lunch' ? d.lunch_mode : d.dinner_mode
    if (mode === 'own') return <span className="text-xs text-slate-500">{t('mealOwn')}</span>
    const id = which === 'lunch' ? d.lunch_id : d.dinner_id
    return (
      <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} only={eats} value={id}
        cities={which === 'lunch' ? [...(d.stops ?? []), d.city] : [d.city, ...(d.stops ?? [])]}
        onChange={(v) => onSet(i, which === 'lunch' ? { lunch_id: v, lunch_menu_id: null } : { dinner_id: v, dinner_menu_id: null })}
        onAddNew={onNewVendor && (() => onNewVendor('restaurant', (v) => onSet(i, which === 'lunch' ? { lunch_id: v.id, lunch_menu_id: null } : { dinner_id: v.id, dinner_menu_id: null })))} />
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[920px] text-sm">
        <caption className="sr-only">{t('viewOverview')}</caption>
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr>
            <th scope="col" className="w-16 px-3 py-2">{t('day')}</th>
            <th scope="col" className="w-40 px-2 py-2">{t('city')}</th>
            <th scope="col" className="px-2 py-2">{t('hotel')}</th>
            <th scope="col" className="px-2 py-2">{t('lunch')}</th>
            <th scope="col" className="px-2 py-2">{t('dinner')}</th>
            <th scope="col" className="px-2 py-2">{t('dayServices')}</th>
            <th scope="col" className="w-16 px-3 py-2 text-right">km</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {days.map((d, i) => {
            const stay = stayAt.get(i)
            const last = i === days.length - 1
            const warn = alerts.filter((a) => a.day === i + 1)
            return (
              <tr key={i} className="align-top">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <button type="button" onClick={() => onOpen(i)} title={t('openDay', { n: i + 1 })}
                    className="flex items-center gap-1.5 rounded text-left hover:text-brand-700">
                    <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white', warn.length ? 'bg-amber-500' : 'bg-slate-800')}>{i + 1}</span>
                  </button>
                  {dates?.[i] && <span className="mt-0.5 block whitespace-nowrap text-xs text-slate-500">{fmt(dates[i], lang)}</span>}
                </th>
                <td className="px-2 py-2">
                  <PlaceInput disabled={disabled} value={d.city} onChange={(city) => onSet(i, { city })} placeholder={t('cityNight')}
                    className={cn(field, 'h-9 font-medium')} aria-label={`${t('day')} ${i + 1} · ${t('city')}`} />
                  {warn.map((a, k) => <p key={k} className="mt-1 flex items-start gap-1 text-xs text-amber-800"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{t(`alert_${a.code}` as TKey, a.params)}</p>)}
                </td>
                {last ? (
                  <td className="px-2 py-2 text-xs text-slate-500">{t('departureDay')}</td>
                ) : covered.has(i) ? null : (
                  <td className="px-2 py-2" rowSpan={stay ? stay.to - stay.from + 1 : 1}>
                    <div className={cn(stay && stay.to > stay.from && 'rounded-lg border border-brand-200 bg-brand-50/40 p-1.5')}>
                      <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['hotel']} value={d.hotel_id} cities={[d.city]}
                        onChange={(v) => {
                          // The whole stay moves to the new hotel.
                          const patches: Record<number, Partial<DayFields>> = {}
                          for (let j = stay!.from; j <= stay!.to; j++) patches[j] = { hotel_id: v }
                          onSetMany(patches)
                        }}
                        onAddNew={onNewVendor && (() => onNewVendor('hotel', (v) => onSet(i, { hotel_id: v.id })))} />
                      {stay && stay.to > stay.from && (
                        <p className="mt-1 text-xs font-medium text-brand-800">{t('stayNights', { n: stay.to - stay.from + 1, from: stay.from + 1, to: stay.to + 1 })}</p>
                      )}
                      {!disabled && d.hotel_id && stay && stay.to + 1 < days.length - 1 && !days[stay.to + 1].hotel_id && (
                        <button type="button" onClick={() => onSet(stay.to + 1, { hotel_id: d.hotel_id, city: days[stay.to + 1].city || d.city })}
                          className="mt-1 text-xs font-medium text-brand-700 hover:underline">{t('stayOneMoreNight')}</button>
                      )}
                    </div>
                  </td>
                )}
                <td className="px-2 py-2">{meal(i, 'lunch')}</td>
                <td className="px-2 py-2">{meal(i, 'dinner')}</td>
                <td className="px-2 py-2">
                  <button type="button" onClick={() => onOpen(i)} className="max-w-56 text-left text-xs text-slate-600 hover:text-brand-700">
                    {extrasOf(d) || [...(d.stops ?? [])].join(', ') || <span className="text-slate-400">+ {t('placeAdd')}</span>}
                  </button>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{i > 0 ? d.km ?? '—' : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The whole trip at a glance: one chip per day (city + what is still missing); a click jumps there. */
function DayStrip({ days, dates }: { days: DayFields[]; dates?: string[] }) {
  const { t, lang } = useI18n()
  if (days.length < 2) return null
  const jump = (i: number) => document.getElementById(`day-card-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const dot = (on: boolean, need = true) => cn('h-3 w-3', on ? 'text-emerald-600' : need ? 'text-amber-500' : 'text-slate-300')
  return (
    <nav aria-label={t('itinerary')} className="flex gap-1.5 overflow-x-auto pb-1">
      {days.map((d, i) => {
        const last = i === days.length - 1
        return (
          <button type="button" key={i} onClick={() => jump(i)}
            title={[`${t('day')} ${i + 1}`, [...(d.stops ?? []), d.city].filter(Boolean).join(' → '), dates?.[i] && fmt(dates[i], lang)].filter(Boolean).join(' · ')}
            className="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-white hover:shadow-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">{i + 1}</span>
            <span className="max-w-[8rem] truncate font-medium text-slate-700">{d.city || '—'}</span>
            {(d.stops?.length ?? 0) > 0 && <span className="text-[11px] text-slate-500">+{d.stops!.length}</span>}
            {(d.flights?.length ?? 0) > 0 && <Plane className="h-3 w-3 text-sky-600" />}
            <span className="flex items-center gap-0.5">
              {!last && <BedDouble className={dot(!!d.hotel_id)} />}
              <Utensils className={dot(!!d.lunch_id || !!d.dinner_id, false)} />
              {d.extras.length > 0 && <Ticket className={dot(true)} />}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

// --- palette ---------------------------------------------------------------------------------

type Tab = 'hotels' | 'food' | 'services'

/** Prices the day slots already cover (hotel nights, lunch, dinner): not offered again as extras. */
const SLOT_CODES = new Set(['room_SGL', 'room_DBL', 'room_TWN', 'room_TRP', 'room_QUAD', 'lunch', 'dinner'])

function Palette({ vendors, services, picked, onPick, onAdd, onClose }: {
  vendors: Vendor[]; services: ServiceBrief[]; picked: Item | null; onPick: (i: Item | null) => void
  onAdd?: (tab: Tab) => void; onClose: () => void
}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('hotels')
  const [q, setQ] = useState('')
  const match = (...xs: (string | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q.toLowerCase()))
  const people = new Set(vendors.filter((v) => v.type === 'guide' || v.type === 'driver').map((v) => v.id))
  const items: Item[] = tab === 'services'
    // Meals (lunch, dinner, set menus) are chosen in the day's lunch/dinner slots, never as an extra.
    ? services.filter((s) => !SLOT_CODES.has(s.code ?? '') && s.category !== 'meal' && !people.has(s.vendor.id) && match(s.name, s.vendor.name))
      .map((service) => ({ kind: 'service', service }))
    : vendors.filter((v) => v.is_active && v.type === (tab === 'hotels' ? 'hotel' : 'restaurant') && match(v.name, v.city))
      .map((vendor) => ({ kind: 'vendor', vendor }))
  // Meals: restaurants; then, apart, the hotels that serve lunch or dinner (a meal on their price list).
  const serving = new Set(services.filter((s) => s.category === 'meal' || s.code === 'lunch' || s.code === 'dinner').map((s) => s.vendor.id))
  const hotelMeals: Item[] = tab === 'food'
    ? vendors.filter((v) => v.is_active && v.type === 'hotel' && serving.has(v.id) && match(v.name, v.city)).map((vendor) => ({ kind: 'vendor', vendor }))
    : []
  return (
    <aside className="rounded-xl border border-slate-200 bg-white lg:sticky lg:top-12 lg:flex lg:max-h-[calc(100vh-11rem)] lg:flex-col lg:self-start">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">{t('builderPalette')}</p>
          <IconButton size="sm" label={t('hideList')} onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="flex flex-wrap gap-1 text-xs" role="tablist" aria-label={t('builderPalette')}>
          {(['hotels', 'food', 'services'] as Tab[]).map((x) => (
            <button type="button" key={x} onClick={() => setTab(x)} role="tab" aria-selected={tab === x}
              className={cn('min-w-fit flex-1 whitespace-nowrap rounded-lg px-2 py-1.5 font-medium', tab === x ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
              {t(`palette_${x}`)}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-8 pl-8 text-xs" />
        </div>
        <p className="text-xs text-slate-500">{t('builderHelp')}</p>
        {tab === 'services' && <p className="rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-600">{t('paletteStaffHint')}</p>}
      </div>
      <ul className="max-h-72 space-y-1 overflow-y-auto p-2 lg:max-h-none lg:min-h-0 lg:flex-1">
        {items.length === 0 && hotelMeals.length === 0 && <li className="px-2 py-4 text-center text-xs text-slate-500">{tab === 'services' ? t('noServicesYet') : tab === 'hotels' ? t('noHotelsYet') : t('noRestaurantsYet')}</li>}
        {[...items, ...hotelMeals].map((item, i) => {
          const id = item.kind === 'vendor' ? item.vendor.id : item.service.id
          const isPicked = picked && (picked.kind === 'vendor' ? picked.vendor.id : picked.service.id) === id
          return (
            <Fragment key={id}>
              {i === items.length && <li role="presentation" className="px-1 pb-0.5 pt-2 text-xs font-semibold text-slate-500">{t('paletteHotelMeals')}</li>}
              <PaletteItem id={id} item={item} picked={!!isPicked} onPick={() => onPick(isPicked ? null : item)} />
            </Fragment>
          )
        })}
      </ul>
      {onAdd && (
        <div className="border-t border-slate-200 p-2">
          <button type="button" onClick={() => onAdd(tab)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50">
            <Plus size={15} />{t(`paletteNew_${tab}`)}
          </button>
        </div>
      )}
    </aside>
  )
}

function PaletteItem({ id, item, picked, onPick }: { id: string; item: Item; picked: boolean; onPick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `p-${id}`, data: { item } })
  return (
    <li ref={setNodeRef} {...listeners} {...attributes} onClick={onPick}
      className={cn('cursor-grab touch-none rounded-lg active:cursor-grabbing', isDragging && 'opacity-40')}>
      <Chip item={item} selected={picked} />
    </li>
  )
}

function Chip({ item, selected, lifted }: { item: Item; selected?: boolean; lifted?: boolean }) {
  const { t } = useI18n()
  const icon = item.kind === 'service' ? <Ticket size={14} /> : item.vendor.type === 'hotel' ? <BedDouble size={14} /> : <Utensils size={14} />
  const name = item.kind === 'vendor' ? item.vendor.name : item.service.name
  const sub = item.kind === 'vendor' ? item.vendor.city : `${item.service.vendor.name} · ${t(`unit_${item.service.unit}`)}`
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm',
      selected ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-300' : 'border-slate-200 bg-white hover:border-slate-300',
      lifted && 'shadow-lg ring-2 ring-brand-400')}>
      <span className="text-slate-500">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        {sub && <span className="block truncate text-xs text-slate-500">{sub}</span>}
      </span>
    </div>
  )
}

// --- day card --------------------------------------------------------------------------------

function DayCard({ id, index, day, date, last, vendors, byId, disabled, fixedLength, dragging, picked, alerts,
  menus, canCreate, onNewVendor, onNewService, prevCity, prevHotel, crew, simple,
  onSet, onPlace, onDuplicate, onInsert, onRemove, onHotelNext }: {
  id: string; index: number; day: DayFields; date?: string; last: boolean; vendors: Vendor[]; byId: Map<string, Vendor>
  prevCity?: string
  prevHotel?: string | null
  disabled?: boolean; fixedLength?: boolean; dragging: Item | null; picked: Item | null; alerts: TourAlert[]
  menus: ServiceBrief[]; canCreate: boolean; crew?: Crew
  simple?: boolean      // the four questions; the rest under "More for this day" (what a day already uses stays shown)
  onNewVendor: (type: VendorType, then: (v: Vendor) => void) => void
  onNewService: (vendorId: string | undefined, menu: boolean, then: (s: Service) => void, meal?: 'breakfast' | 'lunch' | 'dinner') => void
  onSet: (p: Partial<DayFields>) => void; onPlace: (slot: Slot, item: Item) => void
  onDuplicate: () => void; onInsert: () => void; onRemove: () => void; onHotelNext: () => void
}) {
  const { t, lang } = useI18n()
  const factor = useWorkspace()?.drive_factor ?? 1.25
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  const hotel = day.hotel_id ? byId.get(day.hotel_id) : undefined
  // Dishes served twice today (lunch and dinner) are shown in red - the chosen menu's, or the usual one's.
  const dishesOf = (menuId: string | null | undefined, vendorId: string | null | undefined, meal: 'lunch' | 'dinner') =>
    (day.meal_dishes?.[meal] ?? menuOf(menus, menuId, vendorId, meal)?.dishes ?? []).map((x) => x.name.toLowerCase())
  const lunchDishes = dishesOf(day.lunch_menu_id, day.lunch_id, 'lunch')
  const twiceToday = new Set(dishesOf(day.dinner_menu_id, day.dinner_id, 'dinner').filter((x) => lunchDishes.includes(x)))
  const [more, setMore] = useState(false)
  const [details, setDetails] = useState(false)
  const show = !simple || details          // the less used parts of the day
  const [mealOpen, setMealOpen] = useState<Record<string, boolean>>({})
  // What's done and what's missing in this day (the same rules as "Check" and "Next missing").
  const mealState = (m: 'lunch' | 'dinner') => (mealDone(day, m) ? 'done' : 'todo') as 'done' | 'todo'
  const hotelState = last ? undefined : day.hotel_id ? 'done' as const : 'todo' as const
  const bm = day.breakfast_mode ?? 'hotel'
  const breakfastState = bm === 'hotel' || bm === 'own' ? (index === 0 && bm === 'hotel' ? undefined : 'done' as const) : day.breakfast_id ? 'done' as const : 'todo' as const
  const missing = [!day.city.trim(), hotelState === 'todo', mealState('lunch') === 'todo', mealState('dinner') === 'todo'].filter(Boolean).length
  // Meals: restaurants, and the hotels that serve them (a meal on their price list) — not every hotel.
  const serving = useMemo(() => new Set(menus.filter((s) => s.category === 'meal' || s.code === 'lunch' || s.code === 'dinner').map((s) => s.vendor.id)), [menus])
  const eats = (v: Vendor) => v.type !== 'hotel' || serving.has(v.id)
  return (
    <article ref={setNodeRef} id={`day-card-${index}`} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('scroll-mt-28 rounded-xl border bg-white', isDragging ? 'z-10 border-brand-400 shadow-lg' : 'border-slate-200',
        alerts.some((a) => a.severity === 'error') && 'border-red-300')}>
      <header className="flex flex-wrap items-center gap-2 rounded-t-xl border-b border-slate-100 bg-slate-50/70 px-3 py-2">
        {!disabled && (
          <button type="button" {...attributes} {...listeners} aria-label={t('dragToReorder')} title={t('dragToReorder')}
            className="cursor-grab touch-none rounded p-1 text-slate-400 hover:bg-slate-100 active:cursor-grabbing"><GripVertical size={16} /></button>
        )}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-white"
          title={`${t('day')} ${index + 1}`}>{index + 1}</span>
        <span className="sr-only">{t('day')} {index + 1}</span>
        <PlaceInput disabled={disabled} value={day.city} onChange={(city) => onSet({ city })} placeholder={t('cityNight')}
          title={t('cityNightHelp')} className={cn(field, 'h-9 w-52 font-semibold')} aria-label={t('city')} />
        {(show || (day.stops ?? []).length > 0) && <Stops stops={day.stops ?? []} disabled={disabled} onChange={(stops) => onSet({ stops })}
          own={vendors.filter((v) => (v.type === 'activity' || v.type === 'other') && v.is_active)
            .map((v) => ({ name: v.name, detail: v.city, kind: '', lat: 0, lon: 0, own: true }))} />}
        {(show || (day.flights ?? []).length > 0) && <Flights flights={day.flights ?? []} disabled={disabled} onChange={(flights) => onSet({ flights })} />}
        {date && <span className="text-xs text-slate-500">{weekday(date, lang)} {fmt(date, lang)}</span>}
        {index > 0 && (show || !!day.km) && (
          <label className="flex items-center gap-1 text-xs text-slate-500" title={prevCity ? t('kmFrom', { city: prevCity }) : t('kmDriven')}>
            <Car size={14} className="shrink-0" />
            <input type="number" min={0} max={5000} disabled={disabled} value={day.km ?? ''} placeholder="—"
              onChange={(e) => onSet({ km: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
              className="h-7 w-16 rounded border border-transparent bg-transparent px-1 text-right tabular-nums hover:border-slate-300 focus:border-brand-600 focus:outline-none"
              aria-label={t('kmDriven')} />
            km
          </label>
        )}
        {(day.drive_minutes ?? []).some((m) => m > 0) && (() => {
          const drive = (day.drive_minutes ?? []).reduce((x, m) => x + m, 0) * factor
          return (
            <Tooltip label={t('driveDayTip', { h: hours(drive) })}>
              <span tabIndex={0} className={cn('rounded px-1.5 py-0.5 text-xs tabular-nums', drive > 9 * 60 ? 'bg-amber-100 font-medium text-amber-900' : 'text-slate-600')}>
                ≈ {hours(drive)} {t('driveShort')}
              </span>
            </Tooltip>
          )
        })()}
        <div className="flex-1" />
        {/* The day's verdict, in the words of "Check". */}
        <span className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
          missing ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800')}>
          {missing ? t('gridMissingN', { n: missing }) : <><Check size={12} aria-hidden />{t('gridReadyShort')}</>}
        </span>
        {!disabled && (
          <span className="flex items-center gap-0.5">
            {!fixedLength && <IconBtn title={t('duplicateDay')} onClick={onDuplicate}><CopyPlus size={15} /></IconBtn>}
            {!fixedLength && <IconBtn title={t('insertDayAfter')} onClick={onInsert}><Plus size={15} /></IconBtn>}
            {!fixedLength && <IconBtn title={t('delete')} danger onClick={onRemove}><Trash2 size={15} /></IconBtn>}
          </span>
        )}
      </header>
      {alerts.length > 0 && (
        <ul className="space-y-1 border-b border-slate-100 bg-amber-50/60 px-3 py-1.5 text-xs text-amber-900">
          {alerts.map((a, i) => <li key={i} className="flex items-center gap-1.5"><AlertTriangle size={13} />{t(`alert_${a.code}` as TKey, a.params)}</li>)}
        </ul>
      )}
      <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-4">
        <SlotBox day={index} slot="hotel" label={last ? t('lastDayNoHotel') : simple ? t('whereSleep') : t('hotel')} icon={<BedDouble size={14} />}
          dragging={dragging} picked={picked} onTap={(item) => onPlace('hotel', item)} state={hotelState}
          footer={!disabled && hotel && !last && <button type="button" onClick={onHotelNext} className="text-xs text-brand-700 hover:underline">{t('sameHotelNextNight')}</button>}>
          <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['hotel']} value={day.hotel_id} onChange={(v) => onSet({ hotel_id: v })}
            placeholder={last ? undefined : t('chooseHotel')}
            cities={[day.city]}
            onAddNew={canCreate ? () => onNewVendor('hotel', (v) => onSet({ hotel_id: v.id, city: day.city || v.city })) : undefined} />
          {!last && (show || (day.staff_stay ?? 'none') !== 'none') && <StaffStayPick day={day} vendors={vendors} disabled={disabled} onSet={onSet} />}
        </SlotBox>
        {(show || (day.breakfast_mode ?? 'hotel') !== 'hotel') && <SlotBox day={index} slot="breakfast" label={t('breakfast')} icon={<Coffee size={14} />} dragging={dragging} picked={picked} state={breakfastState}
          onTap={(item) => onPlace('breakfast', item)}
          aside={<BreakfastModePick value={day.breakfast_mode ?? 'hotel'} disabled={disabled}
            onChange={(m) => onSet(m === 'hotel' || m === 'own' ? { breakfast_mode: m, breakfast_id: null, breakfast_menu_id: null } : { breakfast_mode: m })} />}>
          {(day.breakfast_mode ?? 'hotel') === 'hotel' ? (
            // Which hotel: last night's, by name - or a quiet note when that night has no hotel yet.
            <p className={cn('flex items-center gap-1 py-1.5 text-xs', index > 0 && !prevHotel ? 'text-amber-700' : 'text-slate-600')}>
              {index === 0 ? t('breakfastNoneFirstDay')
                : prevHotel ? <><BedDouble size={13} className="shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 truncate"><span className="text-slate-500">{t('breakfastAtLastHotel')}:</span> <b className="font-medium text-slate-800">{byId.get(prevHotel)?.name ?? '…'}</b></span></>
                : t('breakfastLastHotelNotSet')}
              <InfoTip label={index === 0 ? t('breakfastHotelFirstDay') : t('breakfastHotelHelp')} />
            </p>
          ) : day.breakfast_mode === 'own' ? <p className="py-1.5 text-xs text-slate-500">{t('mealOwnHelp')}</p> : <>
            <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} only={eats} value={day.breakfast_id ?? null}
              cities={[prevCity ?? '', ...(day.stops ?? []), day.city].filter(Boolean)}
              onChange={(v) => onSet({ breakfast_id: v, breakfast_menu_id: null })}
              onAddNew={canCreate ? () => onNewVendor('restaurant', (v) => onSet({ breakfast_id: v.id, breakfast_menu_id: null })) : undefined} />
            <MenuPick meal="breakfast" vendorId={day.breakfast_id ?? null} value={day.breakfast_menu_id ?? null} menus={menus} disabled={disabled} twice={twiceToday}
              onChange={(m) => onSet({ breakfast_menu_id: m })}
              onAddNew={canCreate && day.breakfast_id ? () => onNewService(day.breakfast_id!, true, (s) => onSet({ breakfast_menu_id: s.id ?? null }), 'breakfast') : undefined} />
            {day.breakfast_mode === 'tourists' && <p className="mt-1 text-[11px] text-amber-700">{t('mealTouristsHelp')}</p>}
          </>}
        </SlotBox>}
        <SlotBox day={index} slot="lunch" label={t('lunch')} icon={<Utensils size={14} />} dragging={dragging} picked={picked} onTap={(item) => onPlace('lunch', item)} state={mealState('lunch')}
          aside={(show || (day.lunch_mode ?? 'included') !== 'included') && <MealModePick value={day.lunch_mode ?? 'included'} disabled={disabled}
            onChange={(m) => onSet(m === 'own' ? { lunch_mode: m, lunch_id: null, lunch_menu_id: null } : { lunch_mode: m })} />}>
          {(day.lunch_mode ?? 'included') === 'own' ? <p className="py-1.5 text-xs text-slate-500">{t('mealOwnHelp')}</p> : <>
          <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} only={eats} value={day.lunch_id} placeholder={t('chooseRestaurant')}
            cities={[...(day.stops ?? []), day.city]}
            onChange={(v) => onSet({ lunch_id: v, lunch_menu_id: null })}
            onAddNew={canCreate ? () => onNewVendor('restaurant', (v) => onSet({ lunch_id: v.id, lunch_menu_id: null })) : undefined} />
          {day.lunch_id && !show && !mealOpen.lunch ? (
            <MealSummary meal="lunch" day={day} menu={menuOf(menus, day.lunch_menu_id, day.lunch_id, 'lunch')} crew={crew} dayNumber={index + 1}
              onOpen={() => setMealOpen({ ...mealOpen, lunch: true })} />
          ) : <>
          <MenuPick meal="lunch" vendorId={day.lunch_id} value={day.lunch_menu_id ?? null} menus={menus} disabled={disabled} twice={twiceToday} compact
            onChange={(m) => onSet({ lunch_menu_id: m, meal_dishes: withoutMeal(day, 'lunch') })}
            onAddNew={canCreate && day.lunch_id ? () => onNewService(day.lunch_id!, true, (s) => onSet({ lunch_menu_id: s.id ?? null }), 'lunch') : undefined} />
          <MealPlan meal="lunch" day={day} dayNumber={index + 1} crew={crew} disabled={disabled} twice={twiceToday} onSet={onSet}
            menu={menuOf(menus, day.lunch_menu_id, day.lunch_id, 'lunch')} />
          </>}
          {day.lunch_mode === 'tourists' && <p className="mt-1 text-[11px] text-amber-700">{t('mealTouristsHelp')}</p>}
          </>}
        </SlotBox>
        <SlotBox day={index} slot="dinner" label={t('dinner')} icon={<Utensils size={14} />} dragging={dragging} picked={picked} onTap={(item) => onPlace('dinner', item)} state={mealState('dinner')}
          aside={(show || (day.dinner_mode ?? 'included') !== 'included') && <MealModePick value={day.dinner_mode ?? 'included'} disabled={disabled}
            onChange={(m) => onSet(m === 'own' ? { dinner_mode: m, dinner_id: null, dinner_menu_id: null } : { dinner_mode: m })} />}>
          {(day.dinner_mode ?? 'included') === 'own' ? <p className="py-1.5 text-xs text-slate-500">{t('mealOwnHelp')}</p> : <>
          <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} only={eats} value={day.dinner_id} placeholder={t('chooseRestaurant')}
            cities={[day.city, ...(day.stops ?? [])]}
            onChange={(v) => onSet({ dinner_id: v, dinner_menu_id: null })}
            onAddNew={canCreate ? () => onNewVendor('restaurant', (v) => onSet({ dinner_id: v.id, dinner_menu_id: null })) : undefined} />
          {day.dinner_id && !show && !mealOpen.dinner ? (
            <MealSummary meal="dinner" day={day} menu={menuOf(menus, day.dinner_menu_id, day.dinner_id, 'dinner')} crew={crew} dayNumber={index + 1}
              onOpen={() => setMealOpen({ ...mealOpen, dinner: true })} />
          ) : <>
          <MenuPick meal="dinner" vendorId={day.dinner_id} value={day.dinner_menu_id ?? null} menus={menus} disabled={disabled} twice={twiceToday} compact
            onChange={(m) => onSet({ dinner_menu_id: m, meal_dishes: withoutMeal(day, 'dinner') })}
            onAddNew={canCreate && day.dinner_id ? () => onNewService(day.dinner_id!, true, (s) => onSet({ dinner_menu_id: s.id ?? null }), 'dinner') : undefined} />
          <MealPlan meal="dinner" day={day} dayNumber={index + 1} crew={crew} disabled={disabled} twice={twiceToday} onSet={onSet}
            menu={menuOf(menus, day.dinner_menu_id, day.dinner_id, 'dinner')} />
          </>}
          {day.dinner_mode === 'tourists' && <p className="mt-1 text-[11px] text-amber-700">{t('mealTouristsHelp')}</p>}
          </>}
        </SlotBox>
        <SlotBox day={index} slot="extras" label={simple ? t('whatTheyDo') : t('dayServices')} icon={<Ticket size={14} />} wide dragging={dragging} picked={picked}
          state={day.extras.length ? 'done' : 'optional'}
          onTap={(item) => onPlace('extras', item)}>
          <DayServices value={day.extras} disabled={disabled} onChange={(extras) => onSet({ extras })}
            onAddNew={canCreate ? (vendorId) => onNewService(vendorId, false, (s) => s.id && onSet({ extras: [...day.extras, { id: slotId(), service_id: s.id, quantity: null, notes: '' }] })) : undefined} />
        </SlotBox>
        {(show || (day.schedule ?? []).length > 0) && <DayProgramme day={day} index={index} last={last} byId={byId} services={menus} disabled={disabled} from={prevCity} fromHotel={prevHotel}
          onSetDay={onSet}
          onChange={(schedule) => onSet({ schedule })} />}
        {/* Border crossings and notes are rare: folded away until used. */}
        {more || day.border_crossing || day.notes ? (
          <div className="col-span-full grid gap-2 sm:grid-cols-2">
            <Input disabled={disabled} value={day.border_crossing} onChange={(e) => onSet({ border_crossing: e.target.value })} autoFocus={more && !day.border_crossing && !day.notes}
              placeholder={t('borderCrossingPh')} className="h-8 text-xs" aria-label={t('border')} />
            <Input disabled={disabled} value={day.notes} onChange={(e) => onSet({ notes: e.target.value })}
              placeholder={t('notes')} className="h-8 text-xs" aria-label={t('notes')} />
          </div>
        ) : !disabled && show && (
          <button type="button" onClick={() => setMore(true)} className="col-span-full justify-self-start text-xs text-slate-500 hover:text-brand-700">
            + {t('dayBorderNotes')}
          </button>
        )}
        {simple && (
          // The rest of the day, one tap away.
          <button type="button" onClick={() => setDetails(!details)} aria-expanded={details}
            className="col-span-full flex items-center gap-1 justify-self-start text-xs font-medium text-brand-700 hover:underline">
            <ChevronDown size={14} className={cn('transition-transform', details && 'rotate-180')} aria-hidden />
            {details ? t('fewerDetails') : t('moreForDay')}
          </button>
        )}
      </div>
    </article>
  )
}

/** A meal in one line (simple card): its menu and tables - tap to open them. */
function MealSummary({ meal, day, menu, crew, dayNumber, onOpen }: {
  meal: 'lunch' | 'dinner'; day: DayFields; menu: ServiceBrief | undefined; crew?: Crew; dayNumber: number; onOpen: () => void
}) {
  const { t } = useI18n()
  const own = day.meal_dishes?.[meal]
  const what = own ? t('gridOwnMenu') : menu?.name && !menu.code ? menu.name : t('menuUsual')
  const n = (own ?? menu?.dishes ?? []).length
  const staff = crew ? crew.staff.filter((a) => ['guide', 'driver', 'assistant'].includes(a.role) && a.start_day <= dayNumber && (a.end_day === null || a.end_day >= dayNumber)).length + (crew.leaders || 0) : 0
  return (
    <button type="button" onClick={onOpen} className="mt-1.5 flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs text-slate-600 hover:bg-slate-50">
      <span className="min-w-0 flex-1 truncate">{what}{n > 0 && ` · ${t('dishesN', { n })}`}{crew && ` · ${staff ? `${crew.pax - (crew.leaders || 0)} + ${staff}` : crew.pax}`}</span>
      <span className="shrink-0 font-medium text-brand-700">{t('menuAndTables')}</span>
      <ChevronRight size={13} className="shrink-0 text-brand-700" aria-hidden />
    </button>
  )
}

/** The next day with something missing (a night's hotel, lunch, dinner, the city), or -1. */
const mealDone = (d: DayFields, m: 'lunch' | 'dinner') => (m === 'lunch' ? d.lunch_mode : d.dinner_mode) === 'own' || !!(m === 'lunch' ? d.lunch_id : d.dinner_id)
const nextGapOf = (days: DayFields[]) =>
  days.findIndex((d, i) => !d.city.trim() || (i < days.length - 1 && !d.hotel_id) || !mealDone(d, 'lunch') || !mealDone(d, 'dinner'))

/** Where the build stands, as plain text: route, hotels, meals, activities (optional). */
function BuildSteps({ days }: { days: DayFields[] }) {
  const { t } = useI18n()
  if (!days.length) return null
  const nights = days.slice(0, -1)
  const steps: [string, number, number, boolean][] = [
    [t('stepRoute'), days.filter((d) => d.city.trim()).length, days.length, false],
    [t('stepHotels'), nights.filter((d) => d.hotel_id).length, nights.length, false],
    [t('stepMeals'), days.reduce((n, d) => n + (mealDone(d, 'lunch') ? 1 : 0) + (mealDone(d, 'dinner') ? 1 : 0), 0), days.length * 2, false],
    [t('stepActivities'), days.filter((d) => d.extras.length).length, days.length, true],
  ]
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label={t('buildProgress')}>
      {steps.map(([label, n, total, optional]) => {
        const done = n >= total
        return (
          <li key={label} className="flex items-center gap-1">
            {done ? <Check size={14} className="text-emerald-600" aria-hidden />
              : <span className={cn('h-2 w-2 rounded-full', optional ? 'bg-slate-300' : 'bg-amber-400')} aria-hidden />}
            <span className="text-slate-600">{label}</span>
            <span className={cn('tabular-nums', done ? 'text-emerald-700' : optional ? 'text-slate-500' : 'font-medium text-amber-800')}>
              {optional && !n ? t('stepOptional') : done ? '' : `${n}/${total}`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const SLOT_TONE: Partial<Record<Slot, { pill: string }>> = {
  hotel: { pill: 'bg-sky-50 text-sky-800' },
  breakfast: { pill: 'bg-emerald-50 text-emerald-800' },
  lunch: { pill: 'bg-emerald-50 text-emerald-800' },
  dinner: { pill: 'bg-emerald-50 text-emerald-800' },
  extras: { pill: 'bg-pink-50 text-pink-800' },
}

function SlotBox({ day, slot, label, icon, wide, dragging, picked, onTap, children, footer, aside, state }: {
  day: number; slot: Slot; label: string; icon: ReactNode; wide?: boolean; dragging: Item | null; picked: Item | null
  onTap: (item: Item) => void; children: ReactNode; footer?: ReactNode; aside?: ReactNode
  state?: 'done' | 'todo' | 'optional'   // a tick in the label, an amber frame and "to do", or a quiet dashed "optional"
}) {
  const { t } = useI18n()
  const { setNodeRef, isOver } = useDroppable({ id: `${day}:${slot}`, data: { day, slot } })
  const active = dragging ?? picked
  const ok = active ? accepts(slot, active) : false
  // The kind of box at a glance, in the calculation's colours: hotel blue, meals green, activities pink -
  // only the label is a soft coloured pill; the box stays white, so warnings still stand out.
  const tone = SLOT_TONE[slot]
  return (
    <div ref={setNodeRef} onClick={() => picked && ok && onTap(picked)}
      className={cn('rounded-lg border p-2 transition-colors', wide && 'col-span-full',
        active && ok ? 'border-dashed border-brand-400 bg-brand-50/60'
          : state === 'todo' ? 'border-amber-300 bg-amber-50/40'
            : state === 'optional' ? 'border-dashed border-slate-300 bg-white' : 'border-slate-200 bg-white',
        isOver && ok && 'border-solid border-brand-600 bg-brand-100', picked && ok && 'cursor-copy')}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5', tone?.pill)}>
          {icon}{label}{state === 'done' && <Check size={12} className="text-emerald-600" aria-label={t('gridLegendDone')} />}
        </span>
        {state === 'todo' && <span className="text-[11px] font-semibold text-amber-700">{t('slotTodo')}</span>}
        {state === 'optional' && <span className="text-[11px] text-slate-500">{t('stepOptional')}</span>}
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
      {footer && <div className="mt-1">{footer}</div>}
    </div>
  )
}

interface Leg { from_city: string | null; to_city: string; km: number | null; minutes: number | null; skipped: 'not_found' | 'far' | 'pending' | null; where: string }

/** 250 → "4 h 10"; the coach factor applied by the caller. */
export function hours(min: number): string {
  const m = Math.round(min / 5) * 5
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`
}

/** Total road km of the itinerary, and a button that fills each day's km from OpenStreetMap. */
/**
 * Every arranged day programme laid out again in one go (the drives from the map, each step after the one
 * before) — what opening each day would do. Pinned times stay unless released. Days still "suggested"
 * are always up to date and are left alone.
 */
function RecalcTimes({ days, byId, onChange, tools }: { days: DayFields[]; byId: Map<string, Vendor>; onChange: (d: DayFields[]) => void; tools: { current: Tools } }) {
  const ws = useWorkspace()!
  const services = useServiceList()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [release, setRelease] = useState(false)
  const [busy, setBusy] = useState(false)
  const arranged = days.filter((d) => d.schedule?.length).length
  const pinned = days.reduce((n, d) => n + (d.schedule ?? []).filter((x) => x.fixed && x.kind !== 'flight').length, 0)
  tools.current.recalc = () => setOpen(true)
  if (!arranged) return null
  const run = async () => {
    setBusy(true)
    const factor = ws.drive_factor ?? 1.25
    const next = await Promise.all(days.map(async (d, i) => {
      const s = await relayDay(ws.id, d, i, i === days.length - 1, byId, i > 0 ? days[i - 1].city : undefined,
        i > 0 ? days[i - 1].hotel_id : null, factor, release, services.data ?? [])
      return s ? { ...d, schedule: s } : d
    }))
    const changed = next.filter((d, i) => d !== days[i]).length
    if (changed) onChange(next)
    setBusy(false)
    setOpen(false)
    toast(changed ? 'recalcTimesDone' : 'recalcTimesSame')
  }
  return <>
    {open && (
      <Dialog title={t('recalcTimes')} onClose={() => !busy && setOpen(false)} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button disabled={busy} onClick={run}>{busy ? t('recalcTimesBusy') : t('recalcTimesGo')}</Button>
      </>}>
        <div className="space-y-3 text-sm text-slate-700">
          <p>{t('recalcTimesBody', { n: arranged, of: days.length })}</p>
          {pinned > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
              <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand-600" />
              <span><span className="font-medium text-slate-800">{t('recalcTimesRelease', { n: pinned })}</span>
                <span className="block text-xs text-slate-500">{t('recalcTimesReleaseHelp')}</span></span>
            </label>
          )}
          <p className="text-xs text-slate-500">{t('recalcTimesSaveNote')}</p>
        </div>
      </Dialog>
    )}
  </>
}

/**
 * The bus back to its garage when the tour ends elsewhere (the group flies home from Batumi, the bus is
 * from Tbilisi): the same day, or the next — one more bus day to pay. Its km count with the trip's;
 * tour costs and calculations take the extra day and the km.
 */
function BusBack({ days, value, onChange, disabled }: {
  days: DayFields[]; value: BusReturn | null; onChange: (b: BusReturn | null) => void; disabled?: boolean
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const end = days[days.length - 1]?.city?.trim() ?? ''
  const home = days[0]?.city?.trim() ?? ''
  const ask = useMutation({
    mutationFn: (to: string) => api<{ legs: Leg[] }>(wsPath(ws.id, '/distances'), { method: 'POST', body: { cities: [end, to] } }),
    onSuccess: (r, to) => { const km = r.legs[1]?.km; if (km != null) onChange({ ...(value ?? { on: 'last', to }), to, km }) },
    meta: { silent: true },
  })
  const start = () => {
    const to = home || end
    onChange({ on: 'last', to, km: null })
    if (end && to && end.toLowerCase() !== to.toLowerCase()) ask.mutate(to)
  }
  return (
    <section aria-labelledby="bus-back" className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Bus size={18} className="shrink-0 text-slate-500" aria-hidden />
        <h3 id="bus-back" className="text-sm font-semibold text-slate-800">{t('busBack')}</h3>
        <InfoTip label={t('busBackTip')} />
        {!value ? (
          <>
            <span className="text-sm text-slate-500">{end ? t('busBackEndsIn', { city: end }) : t('busBackNone')}</span>
            {!disabled && <Button type="button" size="sm" variant="tertiary" className="ml-auto" onClick={start}><Plus size={14} aria-hidden />{t('busBackAdd')}</Button>}
          </>
        ) : (
          <>
            <span className="text-sm text-slate-500">{t('busBackFrom', { city: end || '—' })}</span>
            {!disabled && (
              <Tooltip label={t('busBackRemove')}>
                <button type="button" onClick={() => onChange(null)} aria-label={t('busBackRemove')}
                  className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><X size={16} /></button>
              </Tooltip>
            )}
          </>
        )}
      </div>
      {value && (
        <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
          <MiniLabel label={t('busBackTo')}>
            <PlaceInput disabled={disabled} value={value.to} onChange={(to) => onChange({ ...value, to })}
              onPicked={(p) => { onChange({ ...value, to: p.name, km: null }); if (end) ask.mutate(p.name) }}
              className={cn(field, 'h-9 w-48')} aria-label={t('busBackTo')} />
          </MiniLabel>
          <MiniLabel label={t('busBackWhen')}>
            <SegmentedControl size="sm" label={t('busBackWhen')} value={value.on} onChange={(on) => !disabled && onChange({ ...value, on })}
              options={[['last', t('busBackSameDay', { n: days.length })], ['next', t('busBackNextDay')]]} />
          </MiniLabel>
          <MiniLabel label={t('busBackKm')}>
            <span className="flex items-center gap-2">
              <input type="number" min={0} max={5000} disabled={disabled} value={value.km ?? ''} placeholder="—" aria-label={t('busBackKm')}
                onChange={(e) => onChange({ ...value, km: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
                className={cn(field, 'h-9 w-24 text-right tabular-nums')} />
              {!disabled && end && value.to && (
                <Button type="button" size="sm" variant="secondary" disabled={ask.isPending} onClick={() => ask.mutate(value.to)}>
                  <MapPinned size={14} aria-hidden />{ask.isPending ? t('askingMap') : t('busBackFromMap')}
                </Button>
              )}
            </span>
          </MiniLabel>
          {value.on === 'next' && <p className="basis-full text-xs text-amber-800">{t('busBackNextHelp')}</p>}
          {ask.isError && <p className="basis-full text-xs text-red-700">{t('mapUnavailable')}</p>}
        </div>
      )}
    </section>
  )
}

function MiniLabel({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1"><span className="block text-xs font-medium text-slate-500">{label}</span>{children}</div>
}

interface Tools { openMap?: () => void; suggestKm?: () => void; recalc?: () => void }

function DistanceBar({ days, disabled, onChange, byId, back = 0, tools }: {
  days: DayFields[]; disabled?: boolean; onChange: (d: DayFields[]) => void; byId: Map<string, Vendor>
  back?: number   // km of the bus's drive back to its garage
  tools: { current: Tools }
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  // Every place in order: each day's stops, then where it sleeps. A day's km = the legs that end in it.
  const path = days.flatMap((d, i) => [...(d.stops ?? []), d.city].filter((p) => p?.trim()).map((place) => ({ place, day: i })))
  const total = days.reduce((s, d) => s + (d.km ?? 0), 0)
  const factor = ws.drive_factor ?? 1.25
  const driving = days.reduce((s, d) => s + (d.drive_minutes ?? []).reduce((a, m) => a + m, 0), 0) * factor
  const fuel = Math.round((total * (ws.fuel_l_per_100km ?? 30)) / 100)
  const suggest = useMutation({
    mutationFn: () => api<{ legs: Leg[]; total: number }>(wsPath(ws.id, '/distances'),
      { method: 'POST', body: { cities: path.map((p) => p.place) } }),
    onSuccess: (r) => onChange(days.map((d, i) => {
      const legs = r.legs.map((l, j) => ({ ...l, j })).filter((l) => path[l.j].day === i && l.j > 0)
      if (i === 0 && !legs.length) return { ...d, km: d.km ?? 0 }
      // The night's city itself unknown, or no road found: keep what's typed. A skipped stop on the
      // way is left out; the km goes around it.
      const city = legs[legs.length - 1]
      if (!city || city.skipped || legs.some((l) => l.km === null)) return d
      // Minutes per leg (skipped stops: 0); unknown driving time keeps the old ones.
      const minutes = legs.some((l) => l.minutes === null) ? d.drive_minutes : legs.map((l) => l.minutes ?? 0)
      return { ...d, km: legs.reduce((s, l) => s + (l.km ?? 0), 0), drive_minutes: minutes, drive_km: legs.map((l) => l.km ?? 0) }
    })),
    meta: { silent: true },
  })
  const legs = suggest.data?.legs ?? []
  const unknown = legs.slice(1).filter((l) => l.km === null).length
  const notFound = legs.filter((l) => l.skipped === 'not_found').map((l) => l.to_city)
  const pending = legs.filter((l) => l.skipped === 'pending').map((l) => l.to_city)
  const far = legs.filter((l) => l.skipped === 'far')
  const [mapOpen, setMapOpen] = useState(false)
  // The whole trip on a map: each day's stops on the way, then where it sleeps.
  const mapStops: MapStop[] = days.flatMap((d, i) => [
    ...(d.stops ?? []).filter((p) => p.trim()).map((p): MapStop => ({ place: p, label: p, kind: 'stop', day: i + 1 })),
    ...(d.city.trim() ? [{ place: d.city, label: d.city, kind: 'night', day: i + 1 } as MapStop] : []),
  ])
  tools.current.openMap = () => setMapOpen(true)
  tools.current.suggestKm = () => suggest.mutate()
  if (days.length < 2) return null
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="flex items-center gap-2 font-medium"><Car size={16} className="text-slate-500" />{t('totalKm', { km: (total + back).toLocaleString('en-US') })}
        {back > 0 && <span className="text-xs font-normal text-slate-500">{t('kmWithBack', { km: back.toLocaleString('en-US') })}</span>}</span>
      {total > 0 && <span className="text-xs text-slate-500">{t('fuelEstimate', { l: fuel.toLocaleString('en-US'), per: ws.fuel_l_per_100km ?? 30 })}</span>}
      {driving > 0 && <span className="text-xs text-slate-600">{t('drivingTotal', { h: hours(driving), pct: Math.round((factor - 1) * 100) })}</span>}
      <div className="flex-1" />
      {suggest.isError && <span className="text-xs text-red-700">{t('mapUnavailable')}</span>}
      {unknown > 0 && <span className="text-xs text-amber-800">{t('kmNotFound', { n: unknown })}</span>}
      {pending.length > 0 && (
        <p className="basis-full rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-950"><b>{t('kmPending', { n: pending.length })}</b> {pending.join(', ')}</p>
      )}
      {(notFound.length > 0 || far.length > 0) && (
        <div className="basis-full space-y-0.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">
          {notFound.length > 0 && <p><b>{t('kmSkippedUnknown')}</b> {notFound.join(', ')}</p>}
          {far.length > 0 && <p><b>{t('kmSkippedFar')}</b> {far.map((l) => `${l.to_city} (${l.where.split(',').slice(0, 2).join(',')}…)`).join('; ')}</p>}
          <p>{t('kmSkippedHint')}</p>
        </div>
      )}
      {suggest.isPending && <span className="text-xs text-slate-500">{t('askingMap')}</span>}
      {mapOpen && <TripMap stops={mapStops} title={t('mapTrip')} subtitle={t('mapTripSub', { days: days.length, km: total.toLocaleString('en-US') })}
        onClose={() => setMapOpen(false)} />}
      {!disabled && <RecalcTimes days={days} byId={byId} onChange={onChange} tools={tools} />}
    </div>
  )
}

/** The set menu at a restaurant: its dishes shown under it (served twice today = red). */
const SYSTEM_PRICES = new Set(['breakfast', 'lunch', 'dinner', 'staff_meal', 'staff_room', 'room_DBL', 'room_TWN', 'room_SGL', 'room_TRP', 'room_QUAD', 'day'])

/** The place's usual menu for a meal: its lunch / dinner / breakfast price, with the dishes it lists. */
const usualMenu = (menus: ServiceBrief[], vendorId: string | null | undefined, meal: string) =>
  vendorId ? menus.find((m) => m.vendor.id === vendorId && m.code === meal) : undefined

/** "Khinkali, Mtsvadi, Salad…" - enough to tell menus apart in a list. */
const dishPreview = (m?: ServiceBrief) => {
  const d = m?.dishes ?? []
  return d.length ? ` — ${d.slice(0, 3).map((x) => x.name).join(', ')}${d.length > 3 ? '…' : ''}` : ''
}

/** The menu a meal serves: the chosen set menu, else the place's usual one. */
const menuOf = (menus: ServiceBrief[], menuId: string | null | undefined, vendorId: string | null | undefined, meal: string) =>
  menus.find((m) => m.id === menuId) ?? usualMenu(menus, vendorId, meal)

/** The day's own dishes without this meal's (another menu was chosen). */
const withoutMeal = (day: DayFields, meal: 'lunch' | 'dinner') => {
  const next = { ...(day.meal_dishes ?? {}) }
  delete next[meal]
  return next
}

function MenuPick({ meal, vendorId, value, menus, disabled, twice, onChange, onAddNew, compact }: {
  meal: 'breakfast' | 'lunch' | 'dinner'
  compact?: boolean      // the dishes are shown under it (the meal card), not as chips here
  vendorId: string | null; value: string | null; menus: ServiceBrief[]; disabled?: boolean; twice: Set<string>
  onChange: (id: string | null) => void; onAddNew?: () => void
}) {
  const { t } = useI18n()
  if (!vendorId) return null
  const usual = usualMenu(menus, vendorId, meal)
  // The place's menus: its set menus and its own priced meals ("per person", "per group", named ones) -
  // not its system prices (breakfast / lunch / dinner / rooms), which are the "usual menu".
  const options = menus.filter((m) => m.vendor.id === vendorId && !SYSTEM_PRICES.has(m.code ?? '')
    && (m.category === 'meal' || (m.category === 'other' && (m.code === 'person' || m.code === 'group' || !m.code))))
  // What is served: the chosen menu, else the usual one - its dishes always in view.
  const chosen = options.find((m) => m.id === value) ?? (value ? undefined : usual)
  if (!options.length && !onAddNew && !usual) return null
  return (
    <div className="mt-1.5 space-y-1">
      <Select className="h-8 text-xs" disabled={disabled} value={value ?? ''} aria-label={t('menu')}
        onChange={(e) => (e.target.value === '__new__' ? onAddNew?.() : onChange(e.target.value || null))}>
        <option value="">{t('menuUsual')}{dishPreview(usual)}</option>
        {options.map((m) => <option key={m.id} value={m.id}>{m.name}{dishPreview(m)}</option>)}
        {onAddNew && <option value="__new__">{t('addNewMenuOption')}</option>}
      </Select>
      {!compact && chosen && !chosen.dishes.length && <p className="text-[11px] text-slate-500">{t('menuNoDishes')}</p>}
      {!compact && chosen && chosen.dishes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chosen.dishes.map(({ name: d }) => (
            <span key={d} title={twice.has(d.toLowerCase()) ? t('dishTwiceToday') : undefined}
              className={cn('rounded-full px-1.5 py-0.5 text-[11px]', twice.has(d.toLowerCase()) ? 'bg-red-100 font-medium text-red-700' : 'bg-amber-50 text-amber-900')}>
              {d}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className={cn('rounded p-1.5 text-slate-400 hover:bg-slate-100', danger ? 'hover:text-red-600' : 'hover:text-slate-700')}>{children}</button>
  )
}

/** Places visited during the day before the night's city: "via Mtskheta, Gori". */
function Stops({ stops, disabled, onChange, own }: { stops: string[]; disabled?: boolean; onChange: (s: string[]) => void; own?: PlaceSuggestion[] }) {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const add = (picked?: string) => {
    const v = (picked ?? text).trim()
    if (v && !stops.some((s) => s.toLowerCase() === v.toLowerCase()) && stops.length < 8) onChange([...stops, v])
    setText('')
    setAdding(false)
  }
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      {stops.length > 0 && <span className="text-slate-500">{t('via')}</span>}
      {stops.map((s, i) => (
        <span key={s} className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-800 ring-1 ring-sky-200">
          {s}
          {!disabled && <button type="button" aria-label={`${t('delete')} ${s}`} onClick={() => onChange(stops.filter((_, j) => j !== i))}
            className="text-sky-400 hover:text-red-600"><X size={11} /></button>}
        </span>
      ))}
      {!disabled && (adding ? (
        <PlaceInput autoFocus value={text} own={own} onChange={setText} onBlur={() => add()} maxLength={100} onPicked={(p) => add(p.name)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } if (e.key === 'Escape') { setText(''); setAdding(false) } }}
          placeholder={t('stopPh')} aria-label={t('addStop')} className="h-7 w-44 rounded border border-slate-300 px-2 text-xs focus:border-brand-600 focus:outline-none" />
      ) : (
        <button type="button" onClick={() => setAdding(true)} title={t('addStopHelp')}
          className="rounded px-1.5 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-brand-700">+ {t('addStop')}</button>
      ))}
    </span>
  )
}

/** Breakfast: at last night's hotel (in the room price) · at a restaurant (we pay / they pay) · on their own. */
const STAFF_STAYS: DayStaffStay[] = ['none', 'same', 'own', 'free']

/** Where the driver and guide sleep after this day: costed and booked like the group's rooms. */
function StaffStayPick({ day, vendors, disabled, onSet }: {
  day: DayFields; vendors: Vendor[]; disabled?: boolean; onSet: (p: Partial<DayFields>) => void
}) {
  const { t } = useI18n()
  const stay = day.staff_stay ?? 'none'
  return (
    <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <span className="shrink-0">{t('staffStay')}:</span>
        <select disabled={disabled} value={stay} onChange={(e) => onSet({ staff_stay: e.target.value as DayStaffStay, ...(e.target.value === 'own' ? {} : { staff_hotel_id: null }) })}
          className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs">
          {STAFF_STAYS.map((v) => <option key={v} value={v}>{t(`dayStaffStay_${v}`)}</option>)}
        </select>
      </label>
      {stay === 'own' && (
        <VendorSelect className="h-8" disabled={disabled} vendors={vendors} types={['hotel']} value={day.staff_hotel_id ?? null}
          cities={[day.city]} onChange={(v) => onSet({ staff_hotel_id: v })} />
      )}
      {(stay === 'same' || stay === 'own') && (
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600" title={t('staffRoomPriceHelp')}>
          <input type="checkbox" disabled={disabled} checked={!!day.staff_twin} onChange={(e) => onSet({ staff_twin: e.target.checked })} />{t('staffTwin')}
        </label>
      )}
    </div>
  )
}

function BreakfastModePick({ value, disabled, onChange }: { value: BreakfastMode; disabled?: boolean; onChange: (m: BreakfastMode) => void }) {
  const { t } = useI18n()
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as BreakfastMode)} aria-label={t('breakfastWhere')}
      title={t('breakfastWhere')}
      className={cn('rounded border-0 bg-transparent py-0 pl-1 pr-5 text-[11px] font-medium focus:ring-1 focus:ring-brand-500',
        value === 'hotel' ? 'text-slate-500' : value === 'tourists' ? 'text-amber-700' : value === 'own' ? 'text-slate-400' : 'text-brand-700')}>
      <option value="hotel">{t('breakfastAtHotel')}</option>
      <option value="included">{t('breakfastElsewhere')}</option>
      <option value="tourists">{t('mealTourists')}</option>
      <option value="own">{t('mealOwn')}</option>
    </select>
  )
}

/** Who pays this meal: included in our price · the tourists on the spot (we reserve) · free time. */
function MealModePick({ value, disabled, onChange }: { value: MealMode; disabled?: boolean; onChange: (m: MealMode) => void }) {
  const { t } = useI18n()
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as MealMode)} aria-label={t('mealWhoPays')}
      title={t('mealWhoPays')}
      className={cn('rounded border-0 bg-transparent py-0 pl-1 pr-5 text-[11px] font-medium focus:ring-1 focus:ring-brand-500',
        value === 'included' ? 'text-slate-500' : value === 'tourists' ? 'text-amber-700' : 'text-slate-400')}>
      <option value="included">{t('mealIncluded')}</option>
      <option value="tourists">{t('mealTourists')}</option>
      <option value="own">{t('mealOwn')}</option>
    </select>
  )
}

/** Group flights on this day: shown as chips; "+ flight" opens a small form. */
function Flights({ flights, disabled, onChange }: { flights: Flight[]; disabled?: boolean; onChange: (f: Flight[]) => void }) {
  const { t } = useI18n()
  const blank: Flight = { direction: 'departure', number: '', time: '', airport: '', other: '' }
  const [draft, setDraft] = useState<Flight | null>(null)
  const save = () => {
    if (draft && draft.number.trim()) onChange([...flights, { ...draft, number: draft.number.trim().toUpperCase().replace(/\s/g, '') }])
    setDraft(null)
  }
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      {flights.map((f, i) => (
        <span key={i} title={f.notes || undefined}
          className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-800 ring-1 ring-indigo-200">
          <Plane size={11} className={f.direction === 'arrival' ? 'rotate-90' : ''} />
          {f.number}{f.time && ` ${f.time}`}{f.airport && ` ${f.airport}`}{f.other && ` ${f.direction === 'arrival' ? '←' : '→'} ${f.other}`}
          {!disabled && <button type="button" aria-label={`${t('delete')} ${f.number}`} onClick={() => onChange(flights.filter((_, j) => j !== i))}
            className="text-indigo-400 hover:text-red-600"><X size={11} /></button>}
        </span>
      ))}
      {!disabled && (draft ? (
        <span className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-50 p-1 ring-1 ring-slate-200"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } if (e.key === 'Escape') setDraft(null) }}>
          <select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value as Flight['direction'] })}
            className="h-7 rounded border border-slate-300 px-1 text-xs" aria-label={t('flightDirection')}>
            <option value="arrival">{t('flightArrival')}</option>
            <option value="departure">{t('flightDeparture')}</option>
          </select>
          <input autoFocus value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} placeholder="CZ6040" maxLength={12}
            className="h-7 w-20 rounded border border-slate-300 px-1.5 text-xs uppercase" aria-label={t('flightNumber')} />
          <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })}
            className="h-7 rounded border border-slate-300 px-1 text-xs" aria-label={t('flightTime')} />
          <input value={draft.airport} onChange={(e) => setDraft({ ...draft, airport: e.target.value })} placeholder="TBS" maxLength={40}
            className="h-7 w-14 rounded border border-slate-300 px-1.5 text-xs uppercase" aria-label={t('flightAirport')} />
          <input value={draft.other} onChange={(e) => setDraft({ ...draft, other: e.target.value })} maxLength={60}
            placeholder={draft.direction === 'arrival' ? t('flightFrom') : t('flightTo')}
            className="h-7 w-24 rounded border border-slate-300 px-1.5 text-xs" aria-label={draft.direction === 'arrival' ? t('flightFrom') : t('flightTo')} />
          <button type="button" onClick={save} className="rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white">{t('add')}</button>
          <button type="button" onClick={() => setDraft(null)} aria-label={t('cancel')} className="rounded p-1 text-slate-400 hover:text-slate-700"><X size={12} /></button>
        </span>
      ) : (
        <button type="button" onClick={() => setDraft(blank)} title={t('addFlightHelp')}
          className="rounded px-1.5 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-brand-700">+ {t('addFlight')}</button>
      ))}
    </span>
  )
}
