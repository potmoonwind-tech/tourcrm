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
import { AlertTriangle, BedDouble, CalendarDays, ChevronDown, Bookmark, Bus, Car, Clock, PanelLeft, CopyPlus, GripVertical, Hand, Map as MapIcon, MapPinned, Plane, Plus, Search, Ticket, Trash2, Utensils, X, ArrowRight, Check, ChevronRight, Download, ChevronsUpDown, LayoutGrid } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStickyHeight } from '../lib/sticky'
import { api, type BreakfastMode, type DayExtra, type DayTemplate, type ScheduleItem, type StaffAssignment, type BusReturn, type DayFields, type Flight, type MealMode, type Service, type ServiceBrief, type DayStaffStay, type TourAlert, type Vendor, type VendorType, can } from '../lib/api'
import { useServiceList, useVendors, wsPath } from '../lib/data'
import { fmt, weekday, dayDate } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { cn, slotId, townKey } from '../lib/utils'
import { DayServices } from './DayServices'
import { DayProgramme, relayDay, sightOf, suggest, withoutTbd } from './DayProgramme'
import { Dialog, toast, Menu, askText } from './overlay'
import { InfoTip, Tooltip } from './Tooltip'
import { VendorSelect } from './tour'
import { QuickServiceDialog, QuickVendorDialog } from './QuickAdd'
import { Button, field, IconButton, Input, SegmentedControl, Select } from './ui'
import { PlaceInput, type PlaceSuggestion } from './PlaceInput'
import { TripMap, type MapStop } from './TripMap'
import { useWorkspace, useDateStyle } from '../lib/session'

type Slot = 'hotel' | 'breakfast' | 'lunch' | 'dinner' | 'extras'
type Item = { kind: 'vendor'; vendor: Vendor } | { kind: 'service'; service: ServiceBrief }
/** Where a dragged box comes from (a day's hotel, a meal, or a place with its activities). */
type Carry = { day: number; slot: Slot; serviceIds?: string[] }
const MEALS: Slot[] = ['breakfast', 'lunch', 'dinner']

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

export function ItineraryBuilder({ days, onChange, dates, fixedLength, disabled, alerts = [], busReturn, onBusReturn, crew, onDownload, pending, flush, top }: {
  days: DayFields[]; onChange: (days: DayFields[]) => void
  flush?: boolean             // right under the page's tabs: the toolbar joins them (no gap)
  top?: string                // where its sticky bars start when not under a page's tab bar (a drawer: '0px')
  pending?: ReactNode         // unsaved changes: "Discard / Save", shown in the builder's bottom bar
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
  const [view, setViewState] = useState<'days' | 'check'>(() => {
    // Two views: the days to build, the whole tour to see and fix (the old "overview" opens the days).
    try { return localStorage.getItem('itineraryView') === 'check' ? 'check' : 'days' } catch { return 'days' }
  })
  const setView = (v: 'days' | 'check') => { setViewState(v); try { localStorage.setItem('itineraryView', v) } catch { /* private window */ } }
  // The list on the left (the days, saved days): always open when a tour opens; folding it lasts for this visit.
  const [listOpen, setListOpen] = useState(true)
  const [listTab, setListTab] = useState<Tab>('days')
  const toolbar = useStickyHeight('--bar-h')
  // Simple day cards (the four questions; the rest under "More for this day") unless "Show everything" is on.
  const [full, setFullState] = useState(() => { try { return localStorage.getItem('builderFull') === '1' } catch { return false } })
  const setFull = (v: boolean) => { setFullState(v); try { localStorage.setItem('builderFull', v ? '1' : '0') } catch { /* private window */ } }
  // The map, "Suggest km" and "Recalculate times" keep their own dialogs; the "⋯" opens them.
  const tools = useRef<Tools>({})
  // The day being worked on: the one in view (the strip follows it), or the one just clicked into.
  const [activeDay, setActiveDay] = useState(0)
  const canMap = days.flatMap((d) => [...(d.stops ?? []), d.city]).filter((x) => x?.trim()).length > 1
  const restaurants = useMemo(() => new Set((vendors.data ?? []).filter((v) => v.type === 'restaurant').map((v) => v.id)), [vendors.data])
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
  // "Fill the gaps from the catalogue": a night without a hotel gets the one of the night before in the same town,
  // else the catalogue's in that town; a meal without a place gets a restaurant of the town (lunch on the way
  // first), not the same one twice in a row. Then it's checked and saved (or Discard).
  const fillGaps = () => {
    const act = (vendors.data ?? []).filter((v) => v.is_active && !v.placeholder)
    const inTown = (type: string, town: string) => act.filter((v) => v.type === type && townKey(v.city ?? '') === townKey(town))
    let filled = 0
    let lastMeal: string | null = null
    const next = days.map((d, i) => {
      const out = { ...d }
      const last = i === days.length - 1
      if (!last && !out.hotel_id && out.city.trim()) {
        const prev = i > 0 && townKey(days[i - 1].city) === townKey(out.city) ? days[i - 1].hotel_id : null
        const h = prev ?? inTown('hotel', out.city)[0]?.id ?? null
        if (h) { out.hotel_id = h; filled++ }
      }
      for (const m of ['lunch', 'dinner'] as const) {
        const id = m === 'lunch' ? out.lunch_id : out.dinner_id
        const mode = m === 'lunch' ? out.lunch_mode : out.dinner_mode
        if (id) { lastMeal = id; continue }
        if (mode === 'own' || out.meal_tbd?.[m]) continue
        const towns = m === 'lunch' ? [...(out.stops ?? []), out.city] : [out.city]
        const pick = towns.flatMap((x) => inTown('restaurant', x)).find((r) => r.id !== lastMeal)
        if (pick) {
          if (m === 'lunch') { out.lunch_id = pick.id; out.lunch_menu_id = null } else { out.dinner_id = pick.id; out.dinner_menu_id = null }
          lastMeal = pick.id
          filled++
        }
      }
      return out
    })
    if (filled) onChange(next)
    toast(filled ? t('fillGapsDone', { n: filled }) : t('fillGapsNone'))
  }
  // Saved days ("Tbilisi day"): one fills a day - its hotel, meals, programme (the day keeps its town if it has one).
  const savedDays = useQuery({ queryKey: ['day-templates', ws.id], queryFn: () => api<DayTemplate[]>(wsPath(ws.id, '/day-templates')), staleTime: 60_000, enabled: !disabled })
  const applyDayTemplate = (i: number, tpl: DayTemplate) => {
    const before = days
    onChange(days.map((d, j) => (j === i ? { ...blankDay(), ...tpl.data, city: d.city.trim() || tpl.city } : d)))
    toast('savedDayAppliedTo', 'ok', { label: t('undo'), onClick: () => onChange(before) })
  }
  const place = (i: number, slot: Slot, item: Item) => {
    if (!accepts(slot, item)) return
    if (slot === 'extras' && item.kind === 'service') set(i, { extras: [...days[i].extras, { id: slotId(), service_id: item.service.id, quantity: null, notes: '' }] })
    else if (item.kind === 'vendor' && slot !== 'extras') {
      const patch: Partial<DayFields> = { [SLOT_FIELD[slot]]: item.vendor.id }
      if (slot !== 'hotel' && days[i].meal_tbd?.[slot]) patch.meal_tbd = withoutTbd(days[i], slot)
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

  // A box dragged from one day to another moves; with Ctrl (⌥ on a Mac) held it is copied.
  const [carrying, setCarrying] = useState<Carry | null>(null)
  const copyKey = useRef(false)
  const [copying, setCopying] = useState(false)
  useEffect(() => {
    if (!carrying) return
    const f = (e: KeyboardEvent | PointerEvent) => {
      const on = e.ctrlKey || e.metaKey || e.altKey
      if (on !== copyKey.current) { copyKey.current = on; setCopying(on) }
    }
    window.addEventListener('keydown', f); window.addEventListener('keyup', f); window.addEventListener('pointermove', f)
    return () => { window.removeEventListener('keydown', f); window.removeEventListener('keyup', f); window.removeEventListener('pointermove', f) }
  }, [carrying])
  const carry = (from: Carry, to: { day: number; slot: Slot }, item: Item, copy: boolean) => {
    if ((from.day === to.day && from.slot === to.slot) || !accepts(to.slot, item)) return
    const before = days
    const next = days.map((d) => ({ ...d }))
    const src = next[from.day], dst = next[to.day]
    const w = (d: DayFields, k: string, v: unknown) => { (d as unknown as Record<string, unknown>)[k] = v }
    const r = (d: DayFields, k: string) => (d as unknown as Record<string, unknown>)[k]
    if (from.slot === 'extras') {
      const ids = new Set(from.serviceIds ?? [])
      const moving = src.extras.filter((x) => ids.has(x.service_id))
      dst.extras = [...dst.extras, ...moving.filter((x) => !dst.extras.some((y) => y.service_id === x.service_id)).map((x) => ({ ...x, id: slotId() }))]
      if (!copy) src.extras = src.extras.filter((x) => !ids.has(x.service_id))
    } else if (item.kind === 'vendor' && to.slot !== 'extras') {
      const f = from.slot as 'hotel' | 'breakfast' | 'lunch' | 'dinner'
      // A meal takes its menu, its own dishes and who sits where along to the other meal.
      const menu = MEALS.includes(f) ? r(src, `${f}_menu_id`) ?? null : null
      const dishes = MEALS.includes(f) ? src.meal_dishes?.[f as 'lunch'] : undefined
      const seats = MEALS.includes(f) ? src.seating?.[f as 'lunch'] : undefined
      const mode = f === 'lunch' || f === 'dinner' ? r(src, `${f}_mode`) : undefined
      if (!copy) {
        w(src, SLOT_FIELD[f], null)
        if (MEALS.includes(f)) {
          w(src, `${f}_menu_id`, null)
          if (src.meal_dishes?.[f as 'lunch']) { const m = { ...src.meal_dishes }; delete m[f as 'lunch']; src.meal_dishes = m }
          if (src.seating?.[f as 'lunch']) { const m = { ...src.seating }; delete m[f as 'lunch']; src.seating = m }
        }
        if (f === 'breakfast') src.breakfast_mode = 'hotel'
      }
      w(dst, SLOT_FIELD[to.slot], item.vendor.id)
      if (to.slot === 'hotel' && !dst.city && item.vendor.city) dst.city = item.vendor.city
      if (to.slot === 'breakfast' && ['hotel', 'own'].includes(dst.breakfast_mode ?? 'hotel')) dst.breakfast_mode = 'included'
      if (MEALS.includes(f) && MEALS.includes(to.slot)) {
        const m = to.slot as 'lunch'
        w(dst, `${m}_menu_id`, menu)
        dst.meal_dishes = { ...dst.meal_dishes, [m]: dishes }
        if (!dishes) { const x = { ...dst.meal_dishes }; delete x[m]; dst.meal_dishes = x }
        dst.seating = { ...dst.seating, [m]: seats }
        if (!seats) { const x = { ...dst.seating }; delete x[m]; dst.seating = x }
        if (mode && (m === 'lunch' || m === 'dinner')) w(dst, `${m}_mode`, mode)
      }
    } else return
    onChange(next)
    toast(copy ? 'dragCopied' : 'dragMoved', 'ok', { label: t('undo'), onClick: () => onChange(before) })
  }

  const onDragStart = (e: DragStartEvent) => {
    setDragging((e.active.data.current?.item as Item) ?? null)
    setCarrying((e.active.data.current?.from as Carry) ?? null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    setCarrying(null)
    const { active, over } = e
    if (!over) return
    const tpl = active.data.current?.template as DayTemplate | undefined
    if (tpl) {   // a saved day dropped on a day (its card, or the day in the list)
      const at = keys.current.indexOf(String(over.id).replace(/^pd:/, ''))
      if (at >= 0) applyDayTemplate(at, tpl)
      return
    }
    const item = active.data.current?.item as Item | undefined
    if (item) {   // palette → slot, or a box from one day to another
      const target = over.data.current as { day: number; slot: Slot } | undefined
      const from = active.data.current?.from as Carry | undefined
      if (target && from) carry(from, target, item, copyKey.current)
      else if (target) place(target.day, target.slot, item)
      return
    }
    // a day card, or a day in the list on the left ("pd:" + its key)
    const from = keys.current.indexOf(String(active.id).replace(/^pd:/, ''))
    const to = keys.current.indexOf(String(over.id).replace(/^pd:/, ''))
    if (from >= 0 && to >= 0 && from !== to) {
      keys.current = arrayMove(keys.current, from, to)
      onChange(arrayMove(days, from, to))
    }
  }

  const vs = vendors.data ?? []
  const byId = useMemo(() => new Map(vs.map((v) => [v.id, v])), [vs])
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onDragCancel={() => { setDragging(null); setCarrying(null) }}>
      {/* The sticky bars stack from the page's tab bar; in a drawer there's none, so they start at its top. */}
      {/* (When the top row is folded away, nothing sits between the tabs and the day headers.) */}
      <div className={cn('contents', view !== 'days' && '[--bar-h:0px]', view === 'days' && listOpen && !disabled && 'lg:[--bar-h:0px]')}
        style={top ? ({ '--tabs-h': top } as CSSProperties) : undefined}>
        {/* The builder's toolbar, kept in view: how to look at the days, and the days themselves. */}
        <div ref={toolbar} data-builder-toolbar className={cn('sticky top-[var(--tabs-h,42px)] z-20 -mx-4 mb-3 flex items-center gap-2 border-b border-slate-200 bg-white/95 px-4 py-1.5 backdrop-blur md:-mx-8 md:px-8', flush && '-mt-6', top && 'mx-0 px-0 md:mx-0 md:px-0',
          view !== 'days' && 'hidden', view === 'days' && listOpen && !disabled && 'lg:hidden')}>
          {/* The days: in the list on the left when it's open (wide screens), else this strip. */}
          {view === 'days' ? <>
            <div className={cn('flex min-w-0 flex-1', listOpen && !disabled && 'lg:hidden')}><DayStrip days={days} dates={dates} at={activeDay} onAt={setActiveDay} /></div>
            {listOpen && !disabled && <div className="hidden flex-1 lg:block" />}
          </> : <div className="flex-1" />}
        </div>
      <div className={cn('grid gap-4', view === 'days' && !disabled && (listOpen ? 'lg:grid-cols-[16rem_1fr]' : 'lg:grid-cols-[2.75rem_1fr]'))}>
        {view === 'days' && !disabled && !listOpen && <PaletteRail onOpen={(tab) => { setListTab(tab); setListOpen(true) }} />}
        {view === 'days' && listOpen && !disabled && <Palette vendors={vs} services={services.data ?? []} picked={picked} onPick={setPicked}
          tab={listTab} onTab={setListTab} days={days} dates={dates} dayKeys={keys.current} at={activeDay}
          templates={savedDays.data ?? []} onUseTemplate={applyDayTemplate}
          onClose={() => { setListOpen(false); setPicked(null) }}
          onAdd={canCreate ? (tab) => (tab === 'services' ? setNewService({}) : setNewVendor({ type: tab === 'hotels' ? 'hotel' : 'restaurant' })) : undefined} />}
        <div className={cn('stagger min-w-0 space-y-3', view === 'days' && 'w-full max-w-[60rem] justify-self-center')}>
          {picked && (
            <p className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
              <Hand size={16} className="shrink-0" />
              <span className="min-w-0">{t('tapToPlace', { name: picked.kind === 'vendor' ? picked.vendor.name : `${picked.service.vendor.name} · ${picked.service.name}` })}</span>
              {picked.kind === 'service' && (
                <Button type="button" size="sm" variant="secondary" className="ml-auto shrink-0" onClick={() => placeEveryDay(picked)}>{t('addEveryDay')}</Button>
              )}
              <button type="button" className={cn('rounded-md p-1 hover:bg-brand-100', picked.kind !== 'service' && 'ml-auto')} onClick={() => setPicked(null)} aria-label={t('done')} title={t('done')}><X size={14} /></button>
            </p>
          )}
          {/* Where the tour stands and the builder's tools, floating at the bottom (names on hover);
              it moves up when the "save changes" bar is there. */}
          <div className={cn('fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit [[role=dialog]_&]:bottom-20 max-w-[calc(100%-2rem)] items-center gap-x-3 rounded-full border py-1 pl-4 pr-1 text-sm shadow-lg backdrop-blur',
            pending ? 'border-brand-200 bg-brand-50/95' : 'border-slate-200 bg-white/95', 'pl-1.5')}>
            {/* How to look at the tour (its days / the whole tour): one small button. */}
          <Menu label={t('itineraryView')} triggerClassName="flex h-8 shrink-0 items-center gap-0.5 rounded-full px-2 text-slate-700 hover:bg-slate-100"
            trigger={<>{view === 'check' ? <LayoutGrid size={16} aria-hidden /> : <CalendarDays size={16} aria-hidden />}
              <span className="sr-only">{t('itineraryView')}: </span>
              <span className="text-xs font-medium">{t(view === 'check' ? 'viewCheck' : 'viewDays')}</span>
              <ChevronDown size={13} aria-hidden className="text-slate-400" /></>}
            items={[
              { label: `${t('viewDays')}${view === 'days' ? ' ✓' : ''}`, icon: <CalendarDays size={16} />, onClick: () => setView('days') },
              { label: `${t('viewCheck')}${view === 'check' ? ' ✓' : ''}`, icon: <LayoutGrid size={16} />, onClick: () => setView('check') },
            ]} />
            <span className="h-5 w-px shrink-0 bg-slate-200" aria-hidden />
            <DistanceBar days={days} disabled={disabled} onChange={onChange} byId={byId} back={busReturn?.km ?? 0} tools={tools} />
            <span className="max-md:hidden"><BuildSteps days={days} restaurants={restaurants} onGo={openDay} /></span>
            <span className="h-5 w-px shrink-0 bg-slate-200" aria-hidden />
            {pending ?? <span className="flex shrink-0 items-center gap-0.5">
              {/* Every row of every day open - only in Days (the whole tour has no rows to open). */}
              {view === 'days' && (
                <IconButton size="sm" label={full ? t('simpleView') : t('showEverything')} onClick={() => setFull(!full)}
                  aria-pressed={full || undefined} className={cn('rounded-full', full && 'bg-brand-50 text-brand-700')}><ChevronsUpDown size={16} /></IconButton>
              )}
              <Menu kind="icon" label={t('moreActions')} items={[
                { label: t('recalcTimes'), icon: <Clock size={16} />, onClick: () => tools.current.recalc?.(), hidden: disabled },
                { label: t('mapOpen'), icon: <MapIcon size={16} />, onClick: () => tools.current.openMap?.(), hidden: !canMap },
                { label: t('suggestKm'), icon: <MapPinned size={16} />, onClick: () => tools.current.suggestKm?.(), hidden: disabled || !days.some((d) => d.city.trim()) },
                { label: t('programmeDownload'), icon: <Download size={16} />, onClick: () => onDownload?.(), hidden: !onDownload },
              ]} />
            </span>}
          </div>
          {view === 'check' && (
            // Every day on one screen: what is done, what is missing, days side by side.
            <DayGrid days={days} dates={dates} byId={byId} menus={services.data ?? []} alerts={alerts} crew={crew} onOpen={openDay}
              vendors={vs} disabled={disabled} onSet={set} onFill={fillGaps} />
          )}
          {view === 'days' && <SortableContext items={keys.current} strategy={verticalListSortingStrategy}>
            {days.map((d, i) => (
              <DayCard key={keys.current[i]} id={keys.current[i]} index={i} day={d} date={dates?.[i]} last={i === days.length - 1}
                total={days.length} active={activeDay === i} onFocusDay={() => setActiveDay(i)}
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
      <DragOverlay>{dragging && (
        <div className="relative">
          <Chip item={dragging} lifted />
          {carrying && <span className="absolute -right-2 -top-3 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-white">
            {copying ? t('dragCopy') : t('dragMove')}</span>}
        </div>
      )}</DragOverlay>
      {newVendor && <QuickVendorDialog type={newVendor.type} city={newVendor.city} onClose={() => setNewVendor(null)}
        onCreated={(v) => newVendor.then?.(v)} />}
      {newService && <QuickServiceDialog vendorId={newService.vendorId} menu={newService.menu} meal={newService.meal} onClose={() => setNewService(null)}
        onCreated={(sv) => newService.then?.(sv)} />}
      </div>
    </DndContext>
  )
}

/** The whole trip at a glance: one chip per day (city + what is still missing); a click jumps there. */
function DayStrip({ days, dates, at, onAt: setAt }: { days: DayFields[]; dates?: string[]; at: number; onAt: (i: number) => void }) {
  const { t, lang } = useI18n()
  // The day being worked on: the last one whose header has come up to the reading line (a little under the
  // toolbar) - so the next day takes over as soon as its header gets there, not when the last bit of the day
  // before has gone. Marked in the strip and kept in view in it.
  const strip = useRef<HTMLElement>(null)
  useEffect(() => {
    const check = () => {
      // under the toolbar - or, when it's folded away (the days are in the list), under the page's tabs
      const bar = strip.current?.closest('[data-builder-toolbar]')?.getBoundingClientRect()
      const tabs = document.querySelector('[role=tablist]')?.getBoundingClientRect()
      const line = (bar?.height ? bar.bottom : tabs?.bottom ?? 0) + 140
      let at = 0
      for (let i = 0; i < days.length; i++) {
        const el = document.getElementById(`day-card-${i}`)
        if (el && el.getBoundingClientRect().top <= line) at = i
      }
      setAt(at)
    }
    check()
    // the page scrolls (phones) or its panel does (wide screens): both
    window.addEventListener('scroll', check, { passive: true })
    document.addEventListener('scroll', check, { capture: true, passive: true })
    return () => { window.removeEventListener('scroll', check); document.removeEventListener('scroll', check, { capture: true }) }
  }, [days.length])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { strip.current?.querySelector(`[data-day="${at}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [at])
  if (days.length < 2) return <div className="flex-1" />
  const jump = (i: number) => document.getElementById(`day-card-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <nav ref={strip} aria-label={t('itinerary')}
      className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto">
      {days.map((d, i) => {
        const last = i === days.length - 1
        return (
          <button type="button" key={i} onClick={() => jump(i)} data-day={i} aria-current={at === i ? 'true' : undefined}
            title={[`${t('day')} ${i + 1}`, d.city, dates?.[i] && fmt(dates[i], lang)].filter(Boolean).join(' · ')}
            className={cn('relative flex shrink-0 items-baseline gap-1.5 rounded-md px-2 py-1 text-left text-xs',
              at === i ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-white')}>
            {/* Quiet: "1  Baku  Sat 25"; the day being worked on is tinted; a small amber dot = something missing. */}
            <span className={cn('tabular-nums', at === i ? 'font-semibold' : 'text-slate-400')}>{i + 1}</span>
            <span className={cn('max-w-[8rem] truncate', at === i ? 'font-semibold' : 'font-medium text-slate-700')}>{d.city || '—'}</span>
            {dates?.[i] && at === i && <span className="tabular-nums text-brand-700">{weekday(dates[i], lang)} {Number(dates[i].slice(8))}</span>}
            {((!last && !d.hotel_id) || (!d.lunch_id && d.lunch_mode !== 'own') || (!d.dinner_id && d.dinner_mode !== 'own')) && (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" aria-label={t('somethingMissing')} />
            )}
          </button>
        )
      })}
    </nav>
  )
}

// --- palette ---------------------------------------------------------------------------------

type Tab = 'days' | 'saved' | 'hotels' | 'food' | 'services'

/** Prices the day slots already cover (hotel nights, lunch, dinner): not offered again as extras. */
const SLOT_CODES = new Set(['room_SGL', 'room_DBL', 'room_TWN', 'room_TRP', 'room_QUAD', 'lunch', 'dinner'])

const TAB_ICON: Record<Tab, typeof BedDouble> = { days: CalendarDays, saved: Bookmark, hotels: BedDouble, food: Utensils, services: Ticket }
/** What the list on the left offers: the tour's days (go to, reorder) and the saved days (preview, drop on a day). */
const LIST_TABS: Tab[] = ['days', 'saved']

/** The list, folded: three icons on the left; a tap opens the list on that tab. Only on wide screens. */
function PaletteRail({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const { t } = useI18n()
  return (
    <div className="hidden lg:sticky lg:top-[calc(var(--tabs-h,42px)+var(--bar-h,45px)+0.5rem)] lg:flex lg:flex-col lg:items-center lg:gap-1 lg:self-start lg:rounded-xl lg:border lg:border-slate-200 lg:bg-white lg:py-1.5">
      {LIST_TABS.map((x) => {
        const Icon = TAB_ICON[x]
        return (
          <button type="button" key={x} onClick={() => onOpen(x)} title={t(`palette_${x}`)} aria-label={t(`palette_${x}`)}
            className="rounded-lg p-2 text-slate-500 hover:bg-brand-50 hover:text-brand-700"><Icon size={18} /></button>
        )
      })}
    </div>
  )
}

function Palette({ vendors, services, picked, onPick, onAdd, onClose, tab, onTab: setTab, days, dates, dayKeys, at, templates, onUseTemplate }: {
  vendors: Vendor[]; services: ServiceBrief[]; picked: Item | null; onPick: (i: Item | null) => void
  onAdd?: (tab: Tab) => void; onClose: () => void; tab: Tab; onTab: (t: Tab) => void
  days: DayFields[]; dates?: string[]; dayKeys: string[]; at: number   // the "Days" tab: the tour's days, to jump to and reorder
  templates: DayTemplate[]; onUseTemplate: (day: number, tpl: DayTemplate) => void   // the "Saved days" tab
}) {
  const byId = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors])
  const { t } = useI18n()
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
    <aside className="rounded-xl border border-slate-200 bg-white lg:sticky lg:top-[calc(var(--tabs-h,42px)+var(--bar-h,45px)+0.5rem)] lg:flex lg:max-h-[calc(100vh-var(--tabs-h,42px)-var(--bar-h,45px)-5rem)] lg:flex-col lg:self-start">
      <div className="space-y-2 border-b border-slate-200 p-2">
        {/* Tabs as icons with a word, and "fold" - one line. The how-to sits in the title. */}
        <div className="flex items-center gap-1 text-xs" role="tablist" aria-label={t('builderPalette')} title={t('builderHelp')}>
          {LIST_TABS.map((x) => {
            const Icon = TAB_ICON[x]
            return (
              <button type="button" key={x} onClick={() => setTab(x)} role="tab" aria-selected={tab === x}
                title={t(`palette_${x}`)} aria-label={t(`palette_${x}`)}
                className={cn('flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 font-medium',
                  tab === x ? 'flex-1 bg-brand-50 text-brand-700 ring-1 ring-brand-200' : 'text-slate-500 hover:bg-slate-100')}>
                <Icon size={15} className="shrink-0" />{tab === x && <span className="truncate">{t(`palette_${x}`)}</span>}
              </button>
            )
          })}
          <IconButton size="sm" label={t('hideList')} onClick={onClose}><PanelLeft size={16} /></IconButton>
        </div>
        {tab === 'saved' && <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-8 pl-8 text-xs" />
        </div>}
      </div>
      {tab === 'days' ? (
        // The tour's days: a click goes to the day, the grip moves it (drop on another day here or on its card).
        <SortableContext items={dayKeys.map((k) => `pd:${k}`)} strategy={verticalListSortingStrategy}>
          <ul className="max-h-72 space-y-0.5 overflow-y-auto p-1.5 lg:max-h-none lg:min-h-0 lg:flex-1">
            {days.map((d, i) => <PaletteDay key={dayKeys[i]} id={`pd:${dayKeys[i]}`} day={d} index={i} date={dates?.[i]} last={i === days.length - 1} active={at === i} />)}
          </ul>
        </SortableContext>
      ) : tab === 'saved' ? (
        // Saved days: drag one onto a day (or open it: what's in it, and "Use on day N").
        <ul className="max-h-72 space-y-0.5 overflow-y-auto p-1.5 lg:max-h-none lg:min-h-0 lg:flex-1">
          {templates.filter((x) => match(x.name, x.city)).length === 0 && <li className="px-2 py-4 text-center text-xs text-slate-500">{t('savedDaysNone')}</li>}
          {templates.filter((x) => match(x.name, x.city)).map((x) => (
            <PaletteTemplate key={x.id} tpl={x} byId={byId} services={services} day={at} onUse={() => onUseTemplate(at, x)} />
          ))}
        </ul>
      ) : (
      <ul className="max-h-72 space-y-0.5 overflow-y-auto p-1.5 lg:max-h-none lg:min-h-0 lg:flex-1">
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
      )}
      {onAdd && !LIST_TABS.includes(tab) && (
        <div className="border-t border-slate-200 p-2">
          <button type="button" onClick={() => onAdd(tab)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50">
            <Plus size={15} />{t(`paletteNew_${tab as 'hotels' | 'food' | 'services'}`)}
          </button>
        </div>
      )}
    </aside>
  )
}

/** A day in the list: number (amber while something's missing), date, town; click = go there, grip = move it. */
function PaletteDay({ id, day: d, index: i, date, last, active }: { id: string; day: DayFields; index: number; date?: string; last: boolean; active: boolean }) {
  const { t, lang } = useI18n()
  const dateStyle = useDateStyle()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const missing = (!last && !d.hotel_id) || (!d.lunch_id && d.lunch_mode !== 'own') || (!d.dinner_id && d.dinner_mode !== 'own')
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group/row flex items-center gap-1 rounded-lg', active ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-slate-100', isDragging && 'relative z-10 bg-white opacity-80 shadow-lg')}>
      <button type="button" onClick={() => document.getElementById(`day-card-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-sm">
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white',
          active ? 'bg-brand-600' : missing ? 'bg-amber-500' : 'bg-slate-800')}>{i + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-slate-800">{d.city || '—'}</span>
          {date && <span className="block text-[11px] leading-tight text-slate-500">{dayDate(date, lang, dateStyle)}</span>}
        </span>
      </button>
      <span {...listeners} {...attributes} aria-label={t('dragToReorder')} title={t('dragToReorder')}
        className="cursor-grab touch-none rounded-md p-1 text-slate-300 hover:text-slate-500 active:cursor-grabbing"><GripVertical size={14} /></span>
    </li>
  )
}

/** A saved day in the list: drag it onto a day; a click shows what's in it (hotel, meals, programme) and "Use on day N". */
function PaletteTemplate({ tpl, byId, services, day, onUse }: { tpl: DayTemplate; byId: Map<string, Vendor>; services: ServiceBrief[]; day: number; onUse: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `t-${tpl.id}`, data: { template: tpl } })
  const d = tpl.data
  const name = (id?: string | null) => (id ? byId.get(id)?.name : undefined)
  const meal = (m: 'lunch' | 'dinner') => {
    const mode = m === 'lunch' ? d.lunch_mode : d.dinner_mode
    return mode === 'own' ? t('mealOwn') : name(m === 'lunch' ? d.lunch_id : d.dinner_id) ?? (d.meal_tbd?.[m] ? `${t('mealTbd')} · ${d.meal_tbd[m]}` : '—')
  }
  const extras = (d.extras ?? []).map((x) => services.find((s) => s.id === x.service_id)?.vendor.name).filter(Boolean)
  const steps = (d.schedule ?? []).filter((x) => x.time)
  return (
    <li ref={setNodeRef} className={cn('rounded-lg', open ? 'bg-slate-50 ring-1 ring-slate-200' : 'hover:bg-slate-100', isDragging && 'opacity-40')}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-sm">
          <Bookmark size={14} aria-hidden className="shrink-0 text-slate-400" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-slate-800">{tpl.name}</span>
            {tpl.city && <span className="block text-[11px] leading-tight text-slate-500">{tpl.city}</span>}
          </span>
          <ChevronRight size={13} aria-hidden className={cn('shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
        </button>
        <span {...listeners} {...attributes} aria-label={t('dragOntoDay')} title={t('dragOntoDay')}
          className="cursor-grab touch-none rounded-md p-1 text-slate-300 hover:text-slate-500 active:cursor-grabbing"><GripVertical size={14} /></span>
      </div>
      {open && (
        // Quick look: what using it puts in the day.
        <div className="animate-reveal space-y-0.5 px-2 pb-2 pl-8 text-xs text-slate-600">
          {d.hotel_id && <p><span className="text-slate-400">{t('hotel')}:</span> {name(d.hotel_id)}</p>}
          <p><span className="text-slate-400">{t('lunch')}:</span> {meal('lunch')}</p>
          <p><span className="text-slate-400">{t('dinner')}:</span> {meal('dinner')}</p>
          {extras.length > 0 && <p><span className="text-slate-400">{t('whatTheyDo')}:</span> {extras.join(', ')}</p>}
          {steps.length > 0 && <p className="text-slate-400">{steps.map((x) => `${x.time} ${x.title || t(`prog_${x.kind}` as TKey)}`).join(' · ')}</p>}
          <Button type="button" size="sm" variant="secondary" className="mt-1.5 w-full" onClick={onUse}>{t('useOnDay', { n: day + 1 })}</Button>
        </div>
      )}
    </li>
  )
}

function PaletteItem({ id, item, picked, onPick }: { id: string; item: Item; picked: boolean; onPick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `p-${id}`, data: { item } })
  return (
    <li ref={setNodeRef} {...listeners} {...attributes} onClick={onPick}
      className={cn('group/row cursor-grab touch-none rounded-lg active:cursor-grabbing', isDragging && 'opacity-40')}>
      <Chip item={item} selected={picked} flat />
    </li>
  )
}

function Chip({ item, selected, lifted, flat }: { item: Item; selected?: boolean; lifted?: boolean; flat?: boolean }) {
  const { t } = useI18n()
  const icon = item.kind === 'service' ? <Ticket size={14} /> : item.vendor.type === 'hotel' ? <BedDouble size={14} /> : <Utensils size={14} />
  const name = item.kind === 'vendor' ? item.vendor.name : item.service.name
  const sub = item.kind === 'vendor' ? item.vendor.city : `${item.service.vendor.name} · ${t(`unit_${item.service.unit}`)}`
  return (
    <div className={cn('flex items-center gap-2 rounded-lg px-2 text-sm',
      flat ? 'py-1' : 'border py-1.5',
      selected ? 'bg-brand-50 ring-1 ring-brand-300' : flat ? 'hover:bg-slate-100' : 'border-slate-200 bg-white',
      lifted && 'border-brand-300 bg-white shadow-lg ring-2 ring-brand-400')}>
      <span className="text-slate-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-800">{name}</span>
        {sub && <span className="block truncate text-[11px] leading-tight text-slate-500">{sub}</span>}
      </span>
      {flat && <GripVertical size={14} aria-hidden className="shrink-0 text-slate-300 opacity-0 group-hover/row:opacity-100" />}
    </div>
  )
}

// --- day card --------------------------------------------------------------------------------

function DayCard({ id, index, day, date, last, total, active, onFocusDay, vendors, byId, disabled, fixedLength, dragging, picked, alerts,
  menus, canCreate, onNewVendor, onNewService, prevCity, prevHotel, crew, simple,
  onSet, onPlace, onDuplicate, onInsert, onRemove, onHotelNext }: {
  id: string; index: number; day: DayFields; date?: string; last: boolean; vendors: Vendor[]; byId: Map<string, Vendor>
  total: number; active: boolean; onFocusDay: () => void      // the day being worked on: highlighted
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
  const dateStyle = useDateStyle()
  const factor = useWorkspace()?.drive_factor ?? 1.25
  // Days are moved in the list on the left; the card only follows (and takes a saved day dropped on it).
  const { setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  const hotel = day.hotel_id ? byId.get(day.hotel_id) : undefined
  // Dishes served twice today (lunch and dinner) are shown in red - the chosen menu's, or the usual one's.
  const dishesOf = (menuId: string | null | undefined, vendorId: string | null | undefined, meal: 'lunch' | 'dinner') =>
    (day.meal_dishes?.[meal] ?? menuOf(menus, menuId, vendorId, meal)?.dishes ?? []).map((x) => x.name.toLowerCase())
  const lunchDishes = dishesOf(day.lunch_menu_id, day.lunch_id, 'lunch')
  const twiceToday = new Set(dishesOf(day.dinner_menu_id, day.dinner_id, 'dinner').filter((x) => lunchDishes.includes(x)))
  const [more, setMore] = useState(false)
  const [details, setDetails] = useState(false)
  const [whatOpen, setWhatOpen] = useState(false)
  // A folded row's line: what's chosen, or what's still to choose. It takes drops too (same place as open).
  const mealLine = (m: 'lunch' | 'dinner') => {
    const mode = m === 'lunch' ? day.lunch_mode : day.dinner_mode
    const where = day.meal_tbd?.[m]
    if (mode === 'own') return where ? `${t('mealOwn')} · ${where}` : t('mealOwn')
    const v = byId.get((m === 'lunch' ? day.lunch_id : day.dinner_id) ?? '')
    if (!v) return where ? `${t('mealTbd')} · ${where}` : t('chooseRestaurant')
    const menu = menus.find((x) => x.id === (m === 'lunch' ? day.lunch_menu_id : day.dinner_menu_id))
    return needsMenu(m) ? `${v.name} · ${t('chooseMenu')}` : menu ? `${v.name} · ${menu.name}` : v.name
  }
  const summaryDrop = (slot: Slot, text: string) => (
    <SlotDrop day={index} slot={slot} dragging={dragging} picked={picked} onTap={(item) => onPlace(slot, item)}>{text}</SlotDrop>
  )   // "What they do": folded (the timeline shows the visits)
  const [editStops, setEditStops] = useState(false)      // the stops' chips open only while editing them
  const show = !simple || details          // the less used parts of the day
  const [mealOpen, setMealOpen] = useState<Record<string, boolean>>({})
  // What's done and what's missing in this day (the same rules as "Check" and "Next missing").
  const restaurantIds = useMemo(() => new Set(vendors.filter((v) => v.type === 'restaurant').map((v) => v.id)), [vendors])
  // A restaurant chosen without its menu: the step isn't finished (say so under it).
  const needsMenu = (m: 'lunch' | 'dinner') => {
    const id = m === 'lunch' ? day.lunch_id : day.dinner_id
    return !!id && restaurantIds.has(id) && (m === 'lunch' ? day.lunch_mode : day.dinner_mode) !== 'own'
      && !(m === 'lunch' ? day.lunch_menu_id : day.dinner_menu_id) && !day.meal_dishes?.[m]
  }
  const mealState = (m: 'lunch' | 'dinner') =>
    (!(m === 'lunch' ? day.lunch_id : day.dinner_id) && day.meal_tbd?.[m] && (m === 'lunch' ? day.lunch_mode : day.dinner_mode) !== 'own'
      ? undefined : mealDone(day, m, restaurantIds) ? 'done' : 'todo') as 'done' | 'todo' | undefined
  const hotelState = last ? undefined : day.hotel_id ? 'done' as const : 'todo' as const
  const bm = day.breakfast_mode ?? 'hotel'
  const breakfastState = bm === 'hotel' || bm === 'own' ? (index === 0 && bm === 'hotel' ? undefined : 'done' as const) : day.breakfast_id ? 'done' as const : 'todo' as const
  const holds = (id: string | null | undefined): Item | undefined => {
    const v = !disabled && id ? byId.get(id) : undefined
    return v ? { kind: 'vendor', vendor: v } : undefined
  }
  // Saved days ("Kutaisi day"): this day kept to fill another tour's day; or one of them filling this day.
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const saveTemplate = async () => {
    const city = day.city.trim()
    const name = await askText({ title: t('saveDayTitle'), message: t('saveDayMsg'), confirmLabel: t('save'),
      input: { value: city ? t('saveDayDefault', { city }) : '', required: true } })
    if (!name?.trim()) return
    try {
      await api(wsPath(ws.id, '/day-templates'), { method: 'POST', body: { name: name.trim(), city, data: day } })
      void qc.invalidateQueries({ queryKey: ['day-templates', ws.id] })
      toast('savedDaySaved')
    } catch { toast('savedDayFailed', 'error') }
  }
  const savedAll = useQuery({ queryKey: ['day-templates', ws.id], queryFn: () => api<DayTemplate[]>(wsPath(ws.id, '/day-templates')), staleTime: 60_000, enabled: !disabled })
  const savedHere = (savedAll.data ?? []).filter((x) => day.city.trim() && townKey(x.city) === townKey(day.city))
  const applyTemplate = (tpl: DayTemplate) => {
    const before = day
    onSet({ ...blankDay(), ...tpl.data, city: day.city.trim() || tpl.city })
    toast('savedDayApplied', 'ok', { label: t('undo'), onClick: () => onSet(before) })
  }
  // "What they do" and the timeline are one list: an activity added here gets its step in the timeline (or
  // takes over a visit to the same place typed there); one taken off loses its step. A timeline never kept
  // ("suggested") follows by itself.
  const setExtras = (extras: DayExtra[]) => {
    let schedule = day.schedule ?? []
    if (schedule.length) {
      const all = [...day.extras, ...extras]
      const placeOf = (ref: string | null) => {
        const e = ref?.startsWith('extra:') ? all.find((x) => x.id === ref.slice(6)) : undefined
        return e ? menus.find((s) => s.id === e.service_id)?.vendor.id : undefined
      }
      // Taken off: its step moves to another activity at the same place, or goes.
      const kept = new Set(extras.map((e) => e.id))
      schedule = schedule.flatMap((x) => {
        if (!x.ref?.startsWith('extra:') || kept.has(x.ref.slice(6))) return [x]
        const other = extras.find((e) => menus.find((s) => s.id === e.service_id)?.vendor.id === placeOf(x.ref))
        return other ? [{ ...x, ref: `extra:${other.id}` }] : []
      })
      const had = new Set(day.extras.map((e) => e.id))
      for (const e of extras.filter((x) => !had.has(x.id))) {
        const s = menus.find((x) => x.id === e.service_id)
        if (!s || ['transport', 'guide', 'meal', 'hotel'].includes(s.category)) continue
        if (schedule.some((x) => placeOf(x.ref) === s.vendor.id)) continue          // the place is in the day already
        const typed = schedule.findIndex((x) => x.kind === 'visit' && !x.ref && sightOf(x, byId)?.id === s.vendor.id)
        schedule = typed >= 0 ? schedule.map((x, i) => (i === typed ? { ...x, ref: `extra:${e.id}`, title: '', place: '' } : x))
          : withStep(schedule, { id: slotId(), kind: 'visit', time: '', end: '', title: '', ref: `extra:${e.id}`, place: '', notes: '' })
      }
    }
    onSet({ extras, schedule })
  }
  const missing = [!day.city.trim(), hotelState === 'todo', mealState('lunch') === 'todo', mealState('dinner') === 'todo'].filter(Boolean).length
  // Meals: restaurants, and the hotels that serve them (a meal on their price list) — not every hotel.
  const serving = useMemo(() => new Set(menus.filter((s) => s.category === 'meal' || s.code === 'lunch' || s.code === 'dinner').map((s) => s.vendor.id)), [menus])
  // Every hotel can serve a meal; one with no meal price yet says so (its price is added in the catalogue).
  const mealNote = (v: Vendor) => (v.type === 'hotel' && !serving.has(v.id) ? ` · ${t('noMealPrice')}` : '')
  return (
    <article ref={setNodeRef} id={`day-card-${index}`} style={{ transform: CSS.Transform.toString(transform), transition }}
      onFocusCapture={onFocusDay}
      className={cn('scroll-mt-24 rounded-xl border bg-white transition-shadow', isDragging ? 'z-10 border-brand-400 shadow-lg'
        : active ? 'border-brand-300 shadow-md ring-1 ring-brand-200' : 'border-slate-200',
        alerts.some((a) => a.severity === 'error') && 'border-red-300')}>
      {/* The day's head: which day, when, from where to where - pinned while working down the day. */}
      <header className={cn('group/head sticky top-[calc(var(--tabs-h,42px)+var(--bar-h,45px))] z-10 flex items-center gap-2.5 rounded-t-xl border-b px-3 py-1.5 backdrop-blur',
        active ? 'border-brand-200 bg-brand-50/95' : 'border-slate-100 bg-white/95')}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
          {/* Which day and when, in one quiet bubble ("3/8 · Wed 4 Nov"): the places are the title. */}
          <span title={`${t('dayN', { n: index + 1 })} ${t('dayOfN', { n: total })}`}
            className={cn('flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-0.5 pr-2 text-xs tabular-nums',
              active ? 'bg-brand-100 font-semibold text-brand-800' : 'bg-slate-100 font-medium text-slate-600')}>
            <span className={cn('flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white', active ? 'bg-brand-600' : 'bg-slate-700')}>{index + 1}</span>
            <span>/{total}{date && ` · ${dayDate(date, lang, dateStyle)}`}</span>
          </span>
          {/* From where (last night's town) to tonight's: the day's title. */}
          <span className="flex min-w-0 items-center gap-1">
            {index > 0 && prevCity?.trim() && townKey(prevCity) !== townKey(day.city) && (
              <span className="flex min-w-0 items-center gap-1.5 text-lg font-semibold text-slate-500" title={t('fromLastNight')}>
                <span className="max-w-[12rem] truncate">{prevCity.trim()}</span>
                <ArrowRight size={15} aria-hidden className="shrink-0" />
              </span>
            )}
            <PlaceInput disabled={disabled} value={day.city} onChange={(city) => onSet({ city })} placeholder={t('cityNight')}
              title={t('cityNightHelp')} aria-label={t('city')} size={Math.max(6, day.city.length + 1)}
              className="h-8 w-auto max-w-56 min-w-0 rounded-md border border-transparent bg-transparent px-1 text-lg font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-600 focus:bg-white focus:outline-none" />
          </span>
          {/* The day's way and flights, quietly - on the same line. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {/* The places on the way (the road goes through them): one quiet line; the chips only while editing. */}
            {show && (editStops || !(day.stops ?? []).length ? (
              <span className="contents" onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setEditStops(false) }}>
                <Stops stops={day.stops ?? []} disabled={disabled} onChange={(stops) => { setEditStops(true); onSet({ stops }) }}
                  own={vendors.filter((v) => (v.type === 'activity' || v.type === 'other') && v.is_active)
                    .map((v) => ({ name: v.name, detail: v.city, kind: '', lat: 0, lon: 0, own: true }))} />
                {(day.stops ?? []).length > 0 && (
                  <button type="button" onClick={() => setEditStops(false)} className="text-xs font-medium text-brand-700 hover:underline">{t('done')}</button>
                )}
              </span>
            ) : (
              <button type="button" onClick={() => !disabled && setEditStops(true)} title={(day.stops ?? []).join(' → ')}
                className="max-w-full truncate rounded-md px-1 text-left text-xs text-slate-500 hover:bg-white hover:text-slate-800">
                {t('viaShort')} {(day.stops ?? []).slice(0, 2).join(' · ')}{(day.stops ?? []).length > 2 && ` +${(day.stops ?? []).length - 2}`}
              </button>
            ))}
            {(show || (day.flights ?? []).length > 0) && <Flights flights={day.flights ?? []} disabled={disabled} onChange={(flights) => onSet({ flights })} />}
            {/* The road: "458 km · 10 h 35" in grey (a long day's hours in amber); the km typed in under "Show everything". */}
            {index > 0 && show ? (
              <label className="flex items-center gap-1 text-xs text-slate-500" title={prevCity ? t('kmFrom', { city: prevCity }) : t('kmDriven')}>
                <Car size={14} className="shrink-0" />
                <input type="number" min={0} max={5000} disabled={disabled} value={day.km ?? ''} placeholder="—"
                  onChange={(e) => onSet({ km: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })}
                  className="h-7 w-16 rounded-md border border-transparent bg-transparent px-1 text-right tabular-nums hover:border-slate-300 focus:border-brand-600 focus:outline-none"
                  aria-label={t('kmDriven')} />
                km
              </label>
            ) : null}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* The day's verdict, in the words of "Check". */}
          <span className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
            missing ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800')}>
            {missing ? t('gridMissingN', { n: missing }) : <><Check size={12} aria-hidden />{t('gridReadyShort')}</>}
          </span>
          {!disabled && (
            <Menu kind="icon" label={t('dayActions', { n: index + 1 })} items={[
              ...savedHere.map((x) => ({ label: t('useSavedDay', { name: x.name }), icon: <Bookmark size={16} />, onClick: () => applyTemplate(x) })),
              { label: t('saveDayAsTemplate'), icon: <Bookmark size={16} />, onClick: () => void saveTemplate() },
              { label: t('duplicateDay'), icon: <CopyPlus size={16} />, onClick: onDuplicate, hidden: fixedLength },
              { label: t('insertDayAfter'), icon: <Plus size={16} />, onClick: onInsert, hidden: fixedLength },
              { label: t('delete'), icon: <Trash2 size={16} />, onClick: onRemove, danger: true, hidden: fixedLength },
            ]} />
          )}
        </div>
      </header>
      {alerts.length > 0 && (
        <ul className="space-y-1 border-b border-slate-100 bg-amber-50/60 px-3 py-1.5 text-xs text-amber-900">
          {alerts.map((a, i) => <li key={i} className="flex items-center gap-1.5"><AlertTriangle size={13} />{t(`alert_${a.code}` as TKey, a.params)}</li>)}
        </ul>
      )}
      {/* The day is one list, in time order: the hotel, breakfast, lunch and dinner are chosen in their rows. */}
      <div className="p-2 sm:p-3">
        <DayProgramme day={day} index={index} last={last} byId={byId} services={menus} disabled={disabled} from={prevCity} fromHotel={prevHotel} date={date}
          expandAll={!simple}
          bare onSetDay={onSet} onChange={(schedule) => onSet({ schedule })}
          onAddMore={disabled ? undefined : (what) => (what === 'flight' ? setDetails(true) : setMore(true))}
          addAside={whatOpen || ((dragging ?? picked) && accepts('extras', (dragging ?? picked)!)) ? undefined : (
            <button type="button" onClick={() => setWhatOpen(true)}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-brand-700">
                {t('whatTheyDo')}{day.extras.length > 0 && <span className="rounded-full bg-slate-100 px-1.5 font-medium tabular-nums text-slate-700">{day.extras.length}</span>}
                <ChevronRight size={13} aria-hidden />
              </button>)}
          slots={{
            ...(last ? {} : { hotel: {
              state: hotelState, summary: summaryDrop('hotel', hotel ? hotel.name : t('chooseHotel')), grip: (() => { const c = holds(day.hotel_id); return c ? <SlotGrip day={index} slot="hotel" item={c} /> : null })(),
              node: <SlotDrop day={index} slot="hotel" dragging={dragging} picked={picked} onTap={(item) => onPlace('hotel', item)}>

          <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['hotel']} value={day.hotel_id} onChange={(v) => onSet({ hotel_id: v })}
            placeholder={last ? undefined : t('chooseHotel')}
            cities={[day.city]}
            onAddNew={canCreate ? () => onNewVendor('hotel', (v) => onSet({ hotel_id: v.id, city: day.city || v.city })) : undefined} />
          {!last && (show || (day.staff_stay ?? 'none') !== 'none' || Object.keys(day.staff_stays ?? {}).length > 0 || (crew?.staff ?? []).length > 0) && (
            <StaffStayPick day={day} vendors={vendors} disabled={disabled} onSet={onSet}
              people={(crew?.staff ?? []).filter((a) => ['guide', 'driver', 'assistant'].includes(a.role)
                && a.start_day <= index + 1 && (a.end_day === null || a.end_day >= index + 1))} />
          )}

                {!disabled && hotel && <button type="button" onClick={onHotelNext} className="mt-1 text-xs text-brand-700 hover:underline">{t('sameHotelNextNight')}</button>}
              </SlotDrop> } }),
            breakfast: {
              state: breakfastState, summary: summaryDrop('breakfast', (day.breakfast_mode ?? 'hotel') === 'hotel'
                ? `${t('breakfastAtHotel')}${prevHotel && byId.get(prevHotel) ? ` · ${byId.get(prevHotel)!.name}` : ''}`
                : day.breakfast_mode === 'own' ? t('mealOwn') : byId.get(day.breakfast_id ?? '')?.name ?? t('chooseRestaurant')),
              aside: <BreakfastModePick value={day.breakfast_mode ?? 'hotel'} disabled={disabled}
                onChange={(m) => onSet(m === 'hotel' || m === 'own' ? { breakfast_mode: m, breakfast_id: null, breakfast_menu_id: null } : { breakfast_mode: m })} />,
              node: <SlotDrop day={index} slot="breakfast" dragging={dragging} picked={picked} onTap={(item) => onPlace('breakfast', item)}>

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
            <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} note={mealNote} value={day.breakfast_id ?? null}
              cities={[prevCity ?? '', ...(day.stops ?? []), day.city].filter(Boolean)}
              onChange={(v) => onSet({ breakfast_id: v, breakfast_menu_id: null })}
              onAddNew={canCreate ? () => onNewVendor('restaurant', (v) => onSet({ breakfast_id: v.id, breakfast_menu_id: null })) : undefined} />
            <MenuPick meal="breakfast" vendorId={day.breakfast_id ?? null} value={day.breakfast_menu_id ?? null} menus={menus} disabled={disabled} twice={twiceToday}
              onChange={(m) => onSet({ breakfast_menu_id: m })}
              onAddNew={canCreate && day.breakfast_id ? () => onNewService(day.breakfast_id!, true, (s) => onSet({ breakfast_menu_id: s.id ?? null }), 'breakfast') : undefined} />
            {day.breakfast_mode === 'tourists' && <p className="mt-1 text-[11px] text-amber-700">{t('mealTouristsHelp')}</p>}
          </>}

              </SlotDrop>,
            },
            lunch: {
              state: mealState('lunch'), summary: summaryDrop('lunch', mealLine('lunch')),
              grip: (() => { const c = day.lunch_mode === 'own' ? undefined : holds(day.lunch_id); return c ? <SlotGrip day={index} slot="lunch" item={c} /> : null })(),
              aside: <MealModePick value={day.lunch_mode ?? 'included'} disabled={disabled}
                onChange={(m) => onSet(m === 'own' ? { lunch_mode: m, lunch_id: null, lunch_menu_id: null } : { lunch_mode: m })} />,
              node: <SlotDrop day={index} slot="lunch" dragging={dragging} picked={picked} onTap={(item) => onPlace('lunch', item)}>

          {(day.lunch_mode ?? 'included') === 'own' ? (
            <OwnMealWhere value={day.meal_tbd?.lunch ?? ''} disabled={disabled}
              onChange={(x) => onSet({ meal_tbd: x.trim() ? { ...day.meal_tbd, lunch: x } : withoutTbd(day, 'lunch') })} />
          ) : <>
          {day.meal_tbd?.lunch && !day.lunch_id ? (
            <MealTbd town={day.meal_tbd.lunch} disabled={disabled} onTown={(x) => onSet({ meal_tbd: { ...day.meal_tbd, lunch: x } })}
              onPick={() => onSet({ meal_tbd: withoutTbd(day, 'lunch') })} />
          ) : <>
          <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} note={mealNote} value={day.lunch_id} placeholder={t('chooseRestaurant')}
            cities={[...(day.stops ?? []), day.city]}
            onChange={(v) => onSet({ lunch_id: v, lunch_menu_id: null, meal_tbd: withoutTbd(day, 'lunch') })}
            onAddNew={canCreate ? () => onNewVendor('restaurant', (v) => onSet({ lunch_id: v.id, lunch_menu_id: null, meal_tbd: withoutTbd(day, 'lunch') })) : undefined} />
          {!day.lunch_id && !disabled && (
            <button type="button" onClick={() => { lastTbd = Date.now(); onSet({ meal_tbd: { ...day.meal_tbd, lunch: (day.stops?.[0] || day.city).trim() || '?' } }) }}
              className="mt-1 text-xs text-slate-500 hover:text-brand-700 hover:underline">{t('mealTbdSet')}</button>
          )}
          </>}
          {day.lunch_id && !mealOpen.lunch ? (
            <MealSummary meal="lunch" todo={needsMenu('lunch')} day={day} menu={menuOf(menus, day.lunch_menu_id, day.lunch_id, 'lunch')} crew={crew} dayNumber={index + 1}
              onOpen={() => setMealOpen({ ...mealOpen, lunch: true })} />
          ) : <>
          <MenuPick meal="lunch" vendorId={day.lunch_id} value={day.lunch_menu_id ?? null} menus={menus} disabled={disabled} twice={twiceToday} compact
            onChange={(m) => onSet({ lunch_menu_id: m, meal_dishes: withoutMeal(day, 'lunch') })}
            onAddNew={canCreate && day.lunch_id ? () => onNewService(day.lunch_id!, true, (s) => onSet({ lunch_menu_id: s.id ?? null }), 'lunch') : undefined} />
          {/* Dishes, plates and tables only with a menu (or the tour's own dishes): no menu - just the meal. */}
          {(day.lunch_menu_id || day.meal_dishes?.lunch) && (
          <MealPlan meal="lunch" day={day} dayNumber={index + 1} crew={crew} disabled={disabled} twice={twiceToday} onSet={onSet}
            menu={menuOf(menus, day.lunch_menu_id, day.lunch_id, 'lunch')} />
          )}
          </>}
          {day.lunch_mode === 'tourists' && <p className="mt-1 text-[11px] text-amber-700">{t('mealTouristsHelp')}</p>}
          </>}

              </SlotDrop>,
            },
            dinner: {
              state: mealState('dinner'), summary: summaryDrop('dinner', mealLine('dinner')),
              grip: (() => { const c = day.dinner_mode === 'own' ? undefined : holds(day.dinner_id); return c ? <SlotGrip day={index} slot="dinner" item={c} /> : null })(),
              aside: <MealModePick value={day.dinner_mode ?? 'included'} disabled={disabled}
                onChange={(m) => onSet(m === 'own' ? { dinner_mode: m, dinner_id: null, dinner_menu_id: null } : { dinner_mode: m })} />,
              node: <SlotDrop day={index} slot="dinner" dragging={dragging} picked={picked} onTap={(item) => onPlace('dinner', item)}>

          {(day.dinner_mode ?? 'included') === 'own' ? (
            <OwnMealWhere value={day.meal_tbd?.dinner ?? ''} disabled={disabled}
              onChange={(x) => onSet({ meal_tbd: x.trim() ? { ...day.meal_tbd, dinner: x } : withoutTbd(day, 'dinner') })} />
          ) : <>
          {day.meal_tbd?.dinner && !day.dinner_id ? (
            <MealTbd town={day.meal_tbd.dinner} disabled={disabled} onTown={(x) => onSet({ meal_tbd: { ...day.meal_tbd, dinner: x } })}
              onPick={() => onSet({ meal_tbd: withoutTbd(day, 'dinner') })} />
          ) : <>
          <VendorSelect className="h-9" disabled={disabled} vendors={vendors} types={['restaurant', 'hotel']} note={mealNote} value={day.dinner_id} placeholder={t('chooseRestaurant')}
            cities={[day.city, ...(day.stops ?? [])]}
            onChange={(v) => onSet({ dinner_id: v, dinner_menu_id: null, meal_tbd: withoutTbd(day, 'dinner') })}
            onAddNew={canCreate ? () => onNewVendor('restaurant', (v) => onSet({ dinner_id: v.id, dinner_menu_id: null, meal_tbd: withoutTbd(day, 'dinner') })) : undefined} />
          {!day.dinner_id && !disabled && (
            <button type="button" onClick={() => { lastTbd = Date.now(); onSet({ meal_tbd: { ...day.meal_tbd, dinner: (day.city).trim() || '?' } }) }}
              className="mt-1 text-xs text-slate-500 hover:text-brand-700 hover:underline">{t('mealTbdSet')}</button>
          )}
          </>}
          {day.dinner_id && !mealOpen.dinner ? (
            <MealSummary meal="dinner" todo={needsMenu('dinner')} day={day} menu={menuOf(menus, day.dinner_menu_id, day.dinner_id, 'dinner')} crew={crew} dayNumber={index + 1}
              onOpen={() => setMealOpen({ ...mealOpen, dinner: true })} />
          ) : <>
          <MenuPick meal="dinner" vendorId={day.dinner_id} value={day.dinner_menu_id ?? null} menus={menus} disabled={disabled} twice={twiceToday} compact
            onChange={(m) => onSet({ dinner_menu_id: m, meal_dishes: withoutMeal(day, 'dinner') })}
            onAddNew={canCreate && day.dinner_id ? () => onNewService(day.dinner_id!, true, (s) => onSet({ dinner_menu_id: s.id ?? null }), 'dinner') : undefined} />
          {/* Dishes, plates and tables only with a menu (or the tour's own dishes): no menu - just the meal. */}
          {(day.dinner_menu_id || day.meal_dishes?.dinner) && (
          <MealPlan meal="dinner" day={day} dayNumber={index + 1} crew={crew} disabled={disabled} twice={twiceToday} onSet={onSet}
            menu={menuOf(menus, day.dinner_menu_id, day.dinner_id, 'dinner')} />
          )}
          </>}
          {day.dinner_mode === 'tourists' && <p className="mt-1 text-[11px] text-amber-700">{t('mealTouristsHelp')}</p>}
          </>}

              </SlotDrop>,
            },
          }}
          footer={<div className="mt-1 space-y-2">
            {/* What they do: already in the timeline, so folded - "What they do · 3 ›" opens the list (tickets, prices).
                It opens by itself while an activity is dragged or picked, to drop it here. */}
            {whatOpen || ((dragging ?? picked) && accepts('extras', (dragging ?? picked)!)) ? (
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 pt-1.5 text-right text-xs text-slate-500">{t('whatTheyDo')}</span>
              <SlotDrop day={index} slot="extras" dragging={dragging} picked={picked} onTap={(item) => onPlace('extras', item)}>

          <DayServices value={day.extras} disabled={disabled} onChange={setExtras}
            visits={(day.schedule ?? []).filter((x) => x.kind === 'visit' && !x.ref && x.title.trim()).map((x) => ({ id: x.id, title: x.title, vendorId: sightOf(x, byId)?.id }))}
            onAddVisit={(v) => onSet({ schedule: withStep(day.schedule?.length ? day.schedule : suggest(day, index, last, menus, factor),
              { id: slotId(), kind: 'visit', time: '', end: '', title: v.name, ref: null, place: '', notes: '' }) })}
            onRemoveVisit={(id) => onSet({ schedule: (day.schedule ?? []).filter((x) => x.id !== id) })}
            grip={disabled ? undefined : (_vid, ids) => {
              const s = menus.find((x) => x.id === ids[0])
              return s ? <SlotGrip day={index} slot="extras" item={{ kind: 'service', service: s }} serviceIds={ids} /> : null
            }}
            onAddNew={canCreate ? (vendorId) => onNewService(vendorId, false, (s) => s.id && setExtras([...day.extras, { id: slotId(), service_id: s.id, quantity: null, notes: '' }])) : undefined} />

              </SlotDrop>
            </div>
            ) : null}

        {/* Border crossings and notes are rare: folded away until used. */}
        {more || day.border_crossing || day.notes ? (
          <div className="col-span-full grid gap-2 sm:grid-cols-2">
            <Input disabled={disabled} value={day.border_crossing} onChange={(e) => onSet({ border_crossing: e.target.value })} autoFocus={more && !day.border_crossing && !day.notes}
              placeholder={t('borderCrossingPh')} className="h-8 text-xs" aria-label={t('border')} />
            <Input disabled={disabled} value={day.notes} onChange={(e) => onSet({ notes: e.target.value })}
              placeholder={t('notes')} className="h-8 text-xs" aria-label={t('notes')} />
          </div>
        ) : null}

          </div>} />
      </div>
    </article>
  )
}

/** A meal in one line (simple card): its menu and tables - tap to open them. */
function MealSummary({ meal, day, menu, crew, dayNumber, onOpen, todo }: {
  meal: 'lunch' | 'dinner'; day: DayFields; menu: ServiceBrief | undefined; crew?: Crew; dayNumber: number; onOpen: () => void
  todo?: boolean      // a restaurant without its menu: "Choose a menu", in amber
}) {
  const { t } = useI18n()
  const own = day.meal_dishes?.[meal]
  const what = own ? t('gridOwnMenu') : menu?.name ?? (todo ? t('menuChoose') : t('menuNone'))
  const n = (own ?? menu?.dishes ?? []).length
  const staff = crew ? crew.staff.filter((a) => ['guide', 'driver', 'assistant'].includes(a.role) && a.start_day <= dayNumber && (a.end_day === null || a.end_day >= dayNumber)).length + (crew.leaders || 0) : 0
  return (
    <button type="button" onClick={onOpen} className="mt-1.5 flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs text-slate-600 hover:bg-slate-50">
      <span className={cn('min-w-0 flex-1 truncate', todo && 'font-medium text-amber-700')}>{what}{n > 0 && ` · ${t('dishesN', { n })}`}{crew && ` · ${staff ? `${crew.pax} + ${staff}` : crew.pax}`}</span>
      <span className="shrink-0 font-medium text-brand-700">{t('menuAndTables')}</span>
      <ChevronRight size={13} className="shrink-0 text-brand-700" aria-hidden />
    </button>
  )
}

/** The next day with something missing (a night's hotel, lunch, dinner, the city), or -1. */
// A meal is done when it's their own, still to decide (TBD), or has its place - and, at a restaurant, its menu
// (a hotel's lunch or dinner needs none). `restaurants`: the ids of the agency's restaurants.
const mealDone = (d: DayFields, m: 'lunch' | 'dinner', restaurants?: Set<string>) => {
  if ((m === 'lunch' ? d.lunch_mode : d.dinner_mode) === 'own' || d.meal_tbd?.[m]) return true
  const id = m === 'lunch' ? d.lunch_id : d.dinner_id
  if (!id) return false
  return !restaurants?.has(id) || !!(m === 'lunch' ? d.lunch_menu_id : d.dinner_menu_id) || !!d.meal_dishes?.[m]
}

/** Where the build stands, as plain text: route, hotels, meals, activities (optional). */
function BuildSteps({ days, restaurants, onGo }: { days: DayFields[]; restaurants: Set<string>; onGo?: (day: number) => void }) {
  const { t } = useI18n()
  if (!days.length) return null
  const last = days.length - 1
  const nights = days.slice(0, -1)
  // Each step: done of how many, and the first day it's missing on (a click goes there).
  const steps: [string, number, number, boolean, ReactNode, number][] = [
    [t('stepRoute'), days.filter((d) => d.city.trim()).length, days.length, false, <MapPinned size={15} />, days.findIndex((d) => !d.city.trim())],
    [t('stepHotels'), nights.filter((d) => d.hotel_id).length, nights.length, false, <BedDouble size={15} />, days.findIndex((d, i) => i < last && !d.hotel_id)],
    [t('stepMeals'), days.reduce((n, d) => n + (mealDone(d, 'lunch', restaurants) ? 1 : 0) + (mealDone(d, 'dinner', restaurants) ? 1 : 0), 0), days.length * 2, false, <Utensils size={15} />,
      days.findIndex((d) => !mealDone(d, 'lunch', restaurants) || !mealDone(d, 'dinner', restaurants))],
    [t('stepActivities'), days.filter((d) => d.extras.length).length, days.length, true, <Ticket size={15} />, -1],
  ]
  return (
    <ul className="flex items-center gap-x-1" aria-label={t('buildProgress')}>
      {steps.every(([, n, total, optional]) => optional || n >= total) && (
        <li className="flex items-center gap-1 px-1.5 text-xs font-medium text-emerald-700"><Check size={14} aria-hidden />{t('stepReady')}</li>
      )}
      {steps.map(([label, n, total, optional, icon, first]) => {
        const done = n >= total
        if (optional || done) return null
        const go = !done && first >= 0 && onGo
        const tip = done ? `${label}: ${t('stepAllDone')}` : optional ? `${label}: ${t('stepOptionalCount', { n, total })}`
          : `${label}: ${t('stepToDo', { n: total - n, total })}${first >= 0 ? ` · ${t('stepFirstOn', { n: first + 1 })}` : ''}`
        // "🍴 Meals 5/22" - the word on wide screens; amber while something's left, green when done.
        return (
          <li key={label}>
            <button type="button" title={tip} aria-label={tip} disabled={!go} onClick={() => go && onGo!(first)}
              className={cn('flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs', go ? 'cursor-pointer hover:bg-amber-50' : 'cursor-default')}>
              <span className={done ? 'text-emerald-600' : optional ? 'text-slate-400' : 'text-amber-600'} aria-hidden>{icon}</span>
              <span className={cn('max-xl:hidden', done ? 'text-slate-600' : optional ? 'text-slate-500' : 'text-slate-700')}>{label}</span>
              {done ? <Check size={13} className="text-emerald-600" aria-hidden />
                : <span className={cn('tabular-nums', optional ? 'text-slate-500' : 'font-semibold text-amber-800')}>{n}/{total}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** A frameless place to drop (or tap) a hotel, restaurant or activity from the list onto a row of the day. */
function SlotDrop({ day, slot, dragging, picked, onTap, children }: {
  day: number; slot: Slot; dragging: Item | null; picked: Item | null; onTap: (item: Item) => void; children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${day}:${slot}`, data: { day, slot } })
  const active = dragging ?? picked
  const ok = active ? accepts(slot, active) : false
  return (
    <div ref={setNodeRef} onClick={() => picked && ok && onTap(picked)}
      className={cn('min-w-0 flex-1 rounded-lg transition-colors', active && ok && 'bg-brand-50/70 outline-1 outline-dashed outline-brand-400',
        isOver && ok && 'bg-brand-100', picked && ok && 'cursor-copy')}>
      {children}
    </div>
  )
}

/** A handle on a filled box: drag it onto another day's box to move it there (Ctrl/⌥ copies). */
function SlotGrip({ day, slot, item, serviceIds }: { day: number; slot: Slot; item: Item; serviceIds?: string[] }) {
  const { t } = useI18n()
  const from: Carry = { day, slot, serviceIds }
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `s-${day}:${slot}:${serviceIds?.join(',') ?? ''}`, data: { item, from } })
  return (
    <button ref={setNodeRef} type="button" {...attributes} {...listeners} title={t('dragToDay')} aria-label={t('dragToDay')}
      className="cursor-grab touch-none rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing">
      <GripVertical size={14} aria-hidden />
    </button>
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
  tools.current.recalc = () => (arranged ? setOpen(true) : toast('recalcTimesAuto'))
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
                  className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><X size={16} /></button>
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
  const [warnOpen, setWarnOpen] = useState(false)
  const problems = unknown + pending.length + notFound.length + far.length + (suggest.isError ? 1 : 0)
  // The whole trip on a map: each day's stops on the way, then where it sleeps.
  const mapStops: MapStop[] = days.flatMap((d, i) => [
    ...(d.stops ?? []).filter((p) => p.trim()).map((p): MapStop => ({ place: p, label: p, kind: 'stop', day: i + 1 })),
    ...(d.city.trim() ? [{ place: d.city, label: d.city, kind: 'night', day: i + 1 } as MapStop] : []),
  ])
  tools.current.openMap = () => setMapOpen(true)
  tools.current.suggestKm = () => suggest.mutate()
  if (days.length < 2) return null
  return (
    <div className="relative flex shrink-0 items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 whitespace-nowrap font-medium"
        title={[t('totalKm', { km: (total + back).toLocaleString('en-US') }), back > 0 && t('kmWithBack', { km: back.toLocaleString('en-US') }), total > 0 && t('fuelEstimate', { l: fuel.toLocaleString('en-US'), per: ws.fuel_l_per_100km ?? 30 }),
          driving > 0 && t('drivingTotal', { h: hours(driving), pct: Math.round((factor - 1) * 100) })].filter(Boolean).join('\n') || undefined}>
        <Car size={16} className="text-slate-500" />{(total + back).toLocaleString('en-US')} km
      </span>
      {suggest.isPending && <span className="whitespace-nowrap text-xs text-slate-500">{t('askingMap')}</span>}
      {problems > 0 && (
        <button type="button" onClick={() => setWarnOpen(!warnOpen)} aria-expanded={warnOpen}
          className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-200">
          <AlertTriangle size={12} aria-hidden />{problems}
        </button>
      )}
      {/* What the map couldn't count: opens above the bar, on demand. */}
      {warnOpen && problems > 0 && (
        <div className="absolute bottom-full left-0 mb-3 w-[min(36rem,calc(100vw-2rem))] space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 shadow-lg">
          <button type="button" onClick={() => setWarnOpen(false)} aria-label={t('close')} className="float-right rounded-md p-0.5 hover:bg-amber-100"><X size={14} /></button>
          {suggest.isError && <p className="text-red-700">{t('mapUnavailable')}</p>}
          {unknown > 0 && <p>{t('kmNotFound', { n: unknown })}</p>}
          {pending.length > 0 && <p><b>{t('kmPending', { n: pending.length })}</b> {pending.join(', ')}</p>}
          {notFound.length > 0 && <p><b>{t('kmSkippedUnknown')}</b> {notFound.join(', ')}</p>}
          {far.length > 0 && <p><b>{t('kmSkippedFar')}</b> {far.map((l) => `${l.to_city} (${l.where.split(',').slice(0, 2).join(',')}…)`).join('; ')}</p>}
          {(notFound.length > 0 || far.length > 0) && <p className="text-amber-800">{t('kmSkippedHint')}</p>}
        </div>
      )}
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
// The chosen menu only: without one the meal is just lunch or dinner there (the usual price counts, no dishes).
const menuOf = (menus: ServiceBrief[], menuId: string | null | undefined, _vendorId: string | null | undefined, _meal: string) =>
  menus.find((m) => m.id === menuId)

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
  const usual = usualMenu(menus, vendorId, meal)      // the restaurant's usual price (kept for the check below)
  // The place's menus: its set menus and its own priced meals ("per person", "per group", named ones) -
  // not its system prices (breakfast / lunch / dinner / rooms), which are the "usual menu".
  const options = menus.filter((m) => m.vendor.id === vendorId && !SYSTEM_PRICES.has(m.code ?? '')
    && (m.category === 'meal' || (m.category === 'other' && (m.code === 'person' || m.code === 'group' || !m.code))))
  // What is served: the chosen menu's dishes. No menu chosen: just the meal (no dishes listed).
  const chosen = options.find((m) => m.id === value)
  if (!options.length && !onAddNew && !usual) return null
  return (
    <div className="mt-1.5 space-y-1">
      <span className="flex items-center gap-1">
        <Select className="h-8 min-w-0 flex-1 text-xs" disabled={disabled} value={value ?? ''} aria-label={t('menu')}
          onChange={(e) => (e.target.value === '__new__' ? onAddNew?.() : onChange(e.target.value || null))}>
          <option value="">{t('menuNone')}</option>
          {options.map((m) => <option key={m.id} value={m.id}>{m.name}{dishPreview(m)}</option>)}
          {onAddNew && <option value="__new__">{t('addNewMenuOption')}</option>}
        </Select>
        {value && !disabled && (
          <Tooltip label={t('menuRemove')}>
            <button type="button" onClick={() => onChange(null)} aria-label={t('menuRemove')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={15} /></button>
          </Tooltip>
        )}
      </span>
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
          placeholder={t('stopPh')} aria-label={t('addStop')} className="h-7 w-44 rounded-md border border-slate-300 px-2 text-xs focus:border-brand-600 focus:outline-none" />
      ) : (
        <button type="button" onClick={() => setAdding(true)} title={t('addStopHelp')}
          className="rounded-md px-1.5 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-brand-700">+ {t('addStop')}</button>
      ))}
    </span>
  )
}

/** Breakfast: at last night's hotel (in the room price) · at a restaurant (we pay / they pay) · on their own. */
const STAFF_STAYS: DayStaffStay[] = ['none', 'same', 'own', 'free']

/** Where the driver and guide sleep after this day: costed and booked like the group's rooms. */
function StaffStayPick({ day, vendors, disabled, onSet, people = [] }: {
  day: DayFields; vendors: Vendor[]; disabled?: boolean; onSet: (p: Partial<DayFields>) => void
  people?: StaffAssignment[]     // the staff working that day (a tour): each gets their own night
}) {
  const { t } = useI18n()
  const stay = day.staff_stay ?? 'none'
  if (people.length > 0) {
    // One row per person: the guide with the group, the driver in another hotel, each where they really sleep.
    const own = day.staff_stays ?? {}
    const of = (a: StaffAssignment) => own[a.id] ?? { stay, hotel_id: stay === 'own' ? day.staff_hotel_id ?? null : null }
    const put = (a: StaffAssignment, x: { stay: DayStaffStay; hotel_id?: string | null }) =>
      onSet({ staff_stays: { ...own, [a.id]: { stay: x.stay, hotel_id: x.stay === 'own' ? x.hotel_id ?? null : null } } })
    const together = people.filter((a) => ['same', 'own'].includes(of(a).stay)).length > 1
    // One quiet line: "Staff: Driver not counted ▾ · Guide with the group ▾" (a hotel picker only for "own hotel").
    return (
      <div className="mt-1.5 space-y-1">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-slate-500">
          <span title={t('staffStayEach')}>{t('staffNightsShort')}:</span>
          {people.map((a, k) => {
            const x = of(a)
            return (
              <span key={a.id} className="flex items-center" title={a.vendor.placeholder ? undefined : a.vendor.name}>
                {k > 0 && <span className="mr-1 text-slate-300">·</span>}
                <b className="font-medium text-slate-700">{t(`staffRole_${a.role}` as TKey)}</b>
                <select disabled={disabled} value={x.stay} onChange={(e) => put(a, { stay: e.target.value as DayStaffStay, hotel_id: x.hotel_id })}
                  aria-label={`${t(`staffRole_${a.role}` as TKey)} · ${t('staffStay')}`}
                  className={cn('w-auto rounded-md border-0 bg-transparent py-0 pl-1 pr-6 text-xs [field-sizing:content] focus:ring-1 focus:ring-brand-500', x.stay === 'none' ? 'text-slate-400' : 'text-brand-700')}>
                  {STAFF_STAYS.map((v) => <option key={v} value={v}>{t(`dayStaffStay_${v}`)}</option>)}
                </select>
              </span>
            )
          })}
        </div>
        {people.filter((a) => of(a).stay === 'own').map((a) => (
          <label key={a.id} className="flex items-center gap-2 text-xs text-slate-600">
            <span className="shrink-0 font-medium text-slate-700">{t(`staffRole_${a.role}` as TKey)}</span>
            <VendorSelect className="h-8 flex-1" disabled={disabled} vendors={vendors} types={['hotel']} value={of(a).hotel_id ?? null}
              cities={[day.city]} placeholder={t('chooseHotel')} onChange={(v) => put(a, { stay: 'own', hotel_id: v })} />
          </label>
        ))}
        {together && (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600" title={t('staffRoomPriceHelp')}>
            <input type="checkbox" disabled={disabled} checked={!!day.staff_twin} onChange={(e) => onSet({ staff_twin: e.target.checked })} />{t('staffTwinSameHotel')}
          </label>
        )}
      </div>
    )
  }
  return (
    <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <span className="shrink-0">{t('staffStay')}:</span>
        <select disabled={disabled} value={stay} onChange={(e) => onSet({ staff_stay: e.target.value as DayStaffStay, ...(e.target.value === 'own' ? {} : { staff_hotel_id: null }) })}
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs">
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
      className={cn('h-5 cursor-pointer rounded-full border-0 py-0 pl-2 pr-5 text-[11px] font-semibold [field-sizing:content] [background-position:right_5px_center] [background-size:10px] [&>option]:bg-white [&>option]:font-normal [&>option]:text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-200',
        value === 'hotel' || value === 'included' ? 'bg-emerald-50 text-emerald-800' : value === 'tourists' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')}>
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
      className={cn('h-5 cursor-pointer rounded-full border-0 py-0 pl-2 pr-5 text-[11px] font-semibold [field-sizing:content] [background-position:right_5px_center] [background-size:10px] [&>option]:bg-white [&>option]:font-normal [&>option]:text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-200',
        value === 'included' ? 'bg-emerald-50 text-emerald-800' : value === 'tourists' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')}>
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
          {t(f.direction === 'arrival' ? 'flightArrives' : 'flightDeparts')} {f.number}{f.time && ` ${f.time}`}{f.airport && ` ${f.airport}`}{f.other && ` ${f.direction === 'arrival' ? '←' : '→'} ${f.other}`}
          {!disabled && <button type="button" aria-label={`${t('delete')} ${f.number}`} onClick={() => onChange(flights.filter((_, j) => j !== i))}
            className="text-indigo-400 hover:text-red-600"><X size={11} /></button>}
        </span>
      ))}
      {!disabled && (draft ? (
        <span className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-50 p-1 ring-1 ring-slate-200"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } if (e.key === 'Escape') setDraft(null) }}>
          <select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value as Flight['direction'] })}
            className="h-7 rounded-md border border-slate-300 px-1 text-xs" aria-label={t('flightDirection')}>
            <option value="arrival">{t('flightArrival')}</option>
            <option value="departure">{t('flightDeparture')}</option>
          </select>
          <input autoFocus value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} placeholder="CZ6040" maxLength={12}
            className="h-7 w-20 rounded-md border border-slate-300 px-1.5 text-xs uppercase" aria-label={t('flightNumber')} />
          <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })}
            className="h-7 rounded-md border border-slate-300 px-1 text-xs" aria-label={t('flightTime')} />
          <input value={draft.airport} onChange={(e) => setDraft({ ...draft, airport: e.target.value })} placeholder="TBS" maxLength={40}
            className="h-7 w-14 rounded-md border border-slate-300 px-1.5 text-xs uppercase" aria-label={t('flightAirport')} />
          <input value={draft.other} onChange={(e) => setDraft({ ...draft, other: e.target.value })} maxLength={60}
            placeholder={draft.direction === 'arrival' ? t('flightFrom') : t('flightTo')}
            className="h-7 w-24 rounded-md border border-slate-300 px-1.5 text-xs" aria-label={draft.direction === 'arrival' ? t('flightFrom') : t('flightTo')} />
          <button type="button" onClick={save} className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white">{t('add')}</button>
          <button type="button" onClick={() => setDraft(null)} aria-label={t('cancel')} className="rounded-md p-1 text-slate-400 hover:text-slate-700"><X size={12} /></button>
        </span>
      ) : (
        <button type="button" onClick={() => setDraft(blank)} title={t('addFlightHelp')}
          className="rounded-md px-1.5 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-brand-700">+ {t('addFlight')}</button>
      ))}
    </span>
  )
}


let lastTbd = 0      // when a meal was just marked "to be decided" (its location field then takes the focus)

/** A meal whose place isn't known yet: "TBD · Yerevan" (the town can be changed), or pick the place now. */
function MealTbd({ town, disabled, onTown, onPick }: { town: string; disabled?: boolean; onTown: (x: string) => void; onPick: () => void }) {
  const { t } = useI18n()
  // Just marked: the town is suggested and selected - type the real location over it.
  const [fresh] = useState(() => Date.now() - lastTbd < 1500)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!fresh) return
    const el = box.current?.querySelector('input')
    const id = setTimeout(() => { el?.focus(); el?.select() }, 0)
    return () => clearTimeout(id)
  }, [fresh])
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-2.5 py-1.5 text-sm">
      <Clock size={14} aria-hidden className="shrink-0 text-slate-500" />
      <span className="font-medium text-slate-700">{t('mealTbd')}</span>
      <span className="text-slate-400">·</span>
      <span ref={box} className="min-w-32 flex-1 [&>span]:w-full">
        <PlaceInput value={town} disabled={disabled} onChange={onTown} maxLength={100} aria-label={t('mealTbdTown')} placeholder={t('mealTbdTownPh')}
          onFocus={(e) => e.currentTarget.select()}
          title={t('mealTbdRoadTip')}
          className="h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-sm text-slate-800 hover:border-slate-300 focus:border-brand-600 focus:bg-white focus:outline-none" />
      </span>
      {!disabled && <button type="button" onClick={onPick} className="ml-auto text-xs font-medium text-brand-700 hover:underline">{t('mealTbdPick')}</button>}
    </div>
  )
}

/** A new step in the day: before the check-in (or dinner) - the timeline then gives it its time. */
function withStep(schedule: ScheduleItem[], step: ScheduleItem): ScheduleItem[] {
  const at = schedule.findIndex((x) => x.ref === 'hotel' || x.ref === 'dinner')
  return at < 0 ? [...schedule, step] : [...schedule.slice(0, at), step, ...schedule.slice(at)]
}

/** A meal on their own: no restaurant, but where - a town or place (the day's road goes there, the programme says it). */
function OwnMealWhere({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (x: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="space-y-1 py-0.5">
      <p className="text-xs text-slate-500">{t('mealOwnHelp')}</p>
      <div className="flex items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-2.5 py-1">
        <MapPinned size={14} aria-hidden className="shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 [&>span]:w-full">
          <PlaceInput value={value} disabled={disabled} onChange={onChange} maxLength={100} aria-label={t('mealOwnWhere')} placeholder={t('mealOwnWherePh')}
            title={t('mealOwnWhereTip')} onFocus={(e) => e.currentTarget.select()}
            className="h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-sm text-slate-800 placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-600 focus:bg-white focus:outline-none" />
        </span>
      </div>
    </div>
  )
}

/** The day's date as a calendar leaf: weekday, day, month - or just "Day N" on a route (no dates). */

