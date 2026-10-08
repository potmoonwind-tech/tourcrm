/**
 * The calculator as the agency thinks about it - three questions on one screen:
 *   Who travels?      its own types of person: who pays, who travels free, who works
 *   What's the trip?  day by day: the hotel that night, meals, tickets, bus, guide…
 *   How do we price?  its own recipe from cost to price (profit, markup, commission, VAT, rounding…)
 * …with the price always in view, for any group size.
 */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { BedDouble, GripVertical, Bus, ChevronRight, Copy, Pencil, Plus, Ticket, Trash2, User, Users, Utensils, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Dialog, Drawer, Menu, toast } from '../../components/overlay'
import { VendorSelect } from '../../components/tour'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Chip, ChoiceCard, Field, IconButton, Input, ListRow, Panel, SegmentedControl, Select, Stepper } from '../../components/ui'
import { InfoTip } from '../../components/Tooltip'
import { useRemove, type EditFn } from './undo'
import { MealsLine } from './MealPlan'
import { lineMissing, missingPrices } from './missing'
import { CAT_COLOR, daysToTicket, journey, kindLine, KindsDialog, useKinds } from './kinds'
import type {
  TransportPlan, Vehicle,
  PersonRole, PersonType, PriceStep, QuoteCategory, QuoteDoc, QuoteItem, QuoteNight, QuoteResult, RoomUse, StaffStay, StepKind, UseMode,
} from '../../lib/api'
import { useI18n, type TKey } from '../../lib/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, can } from '../../lib/api'
import { useVendors, wsPath } from '../../lib/data'
import { useWorkspace } from '../../lib/session'
import { Sparkles } from 'lucide-react'
import { cn, money } from '../../lib/utils'
import { CURRENCIES } from '../Onboarding'
import { LineEditor, newId, newItem, useBreakdown } from './ItemsTab'

type Edit = EditFn<QuoteDoc>

// --- the agency's way, made explicit -----------------------------------------------------------

/** People as the engine reads an older calculation (tourists + free leaders + staff), written out. */
type Names = { tourists: string; leaders: string; staff: string }
const NAMES: Names = { tourists: 'Tourists', leaders: 'Tour leader', staff: 'Driver and guide' }

/** Default names in the app's language, for calculations that don't have their own people yet. */
function useNames(): Names {
  const { t } = useI18n()
  return { tourists: t('tourists'), leaders: t('ptLeader'), staff: t('driverAndGuide') }
}

// The three built-in people keep their default name in any language: shown in the app's language, until renamed.
const DEFAULT_NAMES: Record<keyof Names, string[]> = {
  tourists: ['Tourists', 'Paying tourists', 'გადამხდელი ტურისტები'],
  leaders: ['Tour leader', 'ტურლიდერი'],
  staff: ['Staff', 'Driver and guide', 'მძღოლი და გიდი'],
}
const isDefault = (id: string): id is keyof Names => id in DEFAULT_NAMES

export function peopleOf(d: QuoteDoc, names: Names = NAMES): PersonType[] {
  if (d.people?.length) {
    return d.people.map((p) => isDefault(p.id) && DEFAULT_NAMES[p.id].includes(p.name) && p.name !== names[p.id] ? { ...p, name: names[p.id] } : p)
  }
  const room: RoomUse = d.leader_room === 'free' ? 'free' : d.leader_single ? 'sgl' : 'dbl'
  return [
    { id: 'tourists', name: names.tourists, role: 'pay', count: null, room: 'dbl' },
    { id: 'leaders', name: names.leaders, role: 'free', count: d.leaders, per: d.leaders_per ?? null, room },
    { id: 'staff', name: names.staff, role: 'staff', count: d.staff, room: 'staff' },
  ]
}

/** The recipe as the engine reads an older calculation: the best of three profits, then rounding. */
export function recipeOf(d: QuoteDoc): PriceStep[] {
  if (d.recipe?.length) return d.recipe
  return [
    { id: 'profit', kind: 'profit', label: '', on: true, value: d.margin_floor_pct, group: d.profit_group, min_pp: d.profit_min_pp, only: [] },
    { id: 'round', kind: 'round', label: '', on: true, value: d.rounding_step, mode: d.rounding_mode, only: [] },
  ]
}

/**
 * The calculation's own currency changes (GEL → USD). Lines and hotels keep their currency - the
 * supplier is still paid in it - but the exchange rates are re-based on the new currency and the
 * amounts typed in the old one (profit, amounts per person / per group) are converted.
 * `rate` = units of the new currency per 1 of the old one (1 GEL = 0.37 USD).
 */
export function switchCurrency(d: QuoteDoc, to: string, rate: number) {
  const from = d.currency
  if (to === from || !(rate > 0)) return
  const fx: Record<string, string> = {}
  for (const [c, v] of Object.entries(d.fx)) if (c !== to) fx[c] = String(+(Number(v) / rate).toFixed(6))
  fx[from] = String(+(1 / rate).toFixed(6))
  d.fx = fx
  const conv = (v: string | undefined) => (v === undefined || v === '' ? v : String(Math.round(Number(v) * rate * 100) / 100))
  d.profit_group = conv(d.profit_group) ?? d.profit_group
  d.profit_min_pp = conv(d.profit_min_pp) ?? d.profit_min_pp
  d.recipe?.forEach((s) => {
    if (s.kind === 'add_pp' || s.kind === 'add_group') s.value = conv(s.value) ?? s.value
    if (s.kind === 'profit') { s.group = conv(s.group); s.min_pp = conv(s.min_pp) }
  })
  // Other selling currencies: their rate is now per 1 of the new currency; the new one isn't "other" any more.
  d.sell_in = (d.sell_in ?? []).filter((s) => s.currency !== to)
    .map((s) => ({ ...s, rate: s.rate ? String(+(Number(s.rate) / rate).toFixed(6)) : s.rate }))
  d.currency = to
}

/** Free places (the "+N") for a group of n, whichever way the calculation counts them. */
export function freeAt(d: QuoteDoc, n: number): number {
  if (d.people?.length) return d.people.filter((p) => p.role === 'free' && p.count !== null)
    .reduce((s, p) => s + Math.max(p.count ?? 0, p.per ? Math.floor(n / p.per) : 0), 0)
  return d.leaders_per ? Math.min(Math.max(d.leaders, Math.floor(n / d.leaders_per)), 10) : d.leaders
}
export const sizeLabel = (d: QuoteDoc, n: number) => { const f = freeAt(d, n); return f ? `${n}+${f}` : String(n) }

/** The group size being looked at, shared by every tab and kept in the URL (?n=19). */
export function useSample(doc: QuoteDoc): [number, (n: number) => void] {
  const [params, setParams] = useSearchParams()
  const n = Math.min(Math.max(Number(params.get('n')) || 19, doc.pax_min), doc.pax_max)
  return [n, (v: number) => setParams((p) => { p.set('n', String(v)); return p }, { replace: true })]
}

const ensure = (d: QuoteDoc, names: Names) => {
  if (!d.people?.length) d.people = peopleOf(d, names)
  if (!d.recipe?.length) d.recipe = recipeOf(d)
}

const WHO_ROLES: Record<string, PersonRole[]> = {
  tourists: ['pay'], persons: ['pay', 'free'], everyone: ['pay', 'free', 'staff'], staff: ['staff'], crew: ['free', 'staff'],
}
const usageOf = (it: QuoteItem, p: PersonType): UseMode =>
  it.uses?.[p.id]?.mode ?? (WHO_ROLES[it.who]?.includes(p.role) ? 'full' : 'none')

const ROLE_DOT: Record<PersonRole, string> = { pay: 'bg-sky-600', free: 'bg-orange-500', staff: 'bg-slate-500' }

// --- the screen --------------------------------------------------------------------------------

export function BuildTab({ doc, debounced, result, edit }: { doc: QuoteDoc; debounced: QuoteDoc; result?: QuoteResult; edit: Edit }) {
  const [sample, setSample] = useSample(doc)
  const n = Math.min(Math.max(sample, doc.pax_min), doc.pax_max)
  const [season, setSeason] = useState('')   // '' = the base prices
  const bd = useBreakdown(debounced, n, season)
  const [editing, setEditing] = useState<number | null>(null)
  const [night, setNight] = useState<number | null>(null)
  const remove = useRemove(edit)

  // What each part adds to the price of one person: the screen reads like a receipt.
  const row = result?.tiers.find((x) => x.tourists === n)
  const lines = bd.data?.items ?? []
  const sum = (xs: { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0)
  const hotel = bd.data ? bd.data.steps.hotel_dbl_pp * n + bd.data.steps.leader_room + (bd.data.steps.staff_room ?? 0) : 0
  const { t } = useI18n()
  const per = (v: number) => `${money(v / n)} ${doc.currency} / ${t('perPersonShort')}`
  const parts = bd.data ? {
    trip: per(sum(lines.slice(0, doc.items.length)) + hotel),
    transport: doc.transport ? per(sum(lines.slice(doc.items.length))) : undefined,
    pricing: row ? `+${money(row.price_dbl - row.cost_dbl)} ${doc.currency} / ${t('perPersonShort')}` : undefined,
  } : {}

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="stagger min-w-0 space-y-4">
        <ToFill doc={doc} onItem={setEditing} onNight={setNight} />
        <PeopleCard doc={doc} n={n} edit={edit} />
        <TripBoard doc={doc} n={n} amounts={bd.data?.items.map((x) => x.amount)} beds={bd.data?.hotel_nights} edit={edit} value={parts.trip}
          onItem={setEditing} onNight={setNight} vehicle={row?.vehicle} />
        <TransportCard doc={doc} n={n} result={result} breakdown={bd.data} edit={edit} value={parts.transport} />
        <RecipeCard doc={doc} edit={edit} value={parts.pricing} />
        <SellingCard doc={doc} edit={edit} />
        <OurWayBar doc={doc} edit={edit} />
        <MoreTools doc={doc}>
          <UsesGrid doc={doc} edit={edit} />
          <InputsCard doc={doc} edit={edit} />
          <FormulasCard doc={doc} edit={edit} calc={bd.data?.items} onItem={setEditing} />
        </MoreTools>
      </div>
      <PriceCard doc={doc} n={n} setN={setSample} result={result} breakdown={bd.data} season={season} setSeason={setSeason} />

      {editing !== null && doc.items[editing] && (
        <LineEditor doc={doc} index={editing} calc={bd.data?.items[editing]} sample={n} edit={edit} onClose={() => setEditing(null)}
          tourPrice={row?.price_dbl}
          onDuplicate={() => { edit((d) => { d.items.splice(editing + 1, 0, { ...structuredClone(d.items[editing]), id: newId() }) }, true); setEditing(editing + 1) }}
          onDelete={() => { remove((d) => { d.items.splice(editing, 1) }); setEditing(null) }} />
      )}
      {night !== null && doc.nights[night] && <NightDrawer doc={doc} index={night} edit={edit} onClose={() => setNight(null)} />}
    </div>
  )
}

const OPEN_KEY = 'calc.open'
const readOpen = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') } catch { return {} } }

/** A part of the calculation (see Panel): folds to one line that says what's in it; whether it's
 * open is remembered on this device. Its "+ Add" opens it too. */
function Section({ id, icon, step, title, hint, summary, value, actions, defaultOpen = true, children }: {
  id: string; icon: ReactNode; step?: number; title: string; hint?: string; summary?: ReactNode; value?: ReactNode; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(() => readOpen()[id] ?? defaultOpen)
  const put = (next: boolean) => {
    setOpen(next)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: next })) } catch { /* private mode */ }
  }
  return (
    <Panel id={`sec-${id}`} title={title}
      // The three parts of the work are numbered (1 who travels, 2 the trip, 3 how we price); the rest keep an icon.
      icon={step ? <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">{step}</span> : icon} subtitle={open ? hint : summary ?? hint} value={value}
      open={open} onToggle={() => put(!open)}
      actions={actions && <span className="flex items-center gap-1" onClickCapture={() => { if (!open) put(true) }}>{actions}</span>}>
      {children}
    </Panel>
  )
}

// --- who travels -------------------------------------------------------------------------------

const PERSON_PRESETS: { key: TKey; role: PersonRole; count: number; room: RoomUse }[] = [
  { key: 'ptChild', role: 'pay', count: 2, room: 'none' },
  { key: 'ptInfant', role: 'pay', count: 1, room: 'none' },
  { key: 'ptLeader', role: 'free', count: 1, room: 'sgl' },
  { key: 'ptGuide', role: 'staff', count: 1, room: 'staff' },
  { key: 'ptDriver', role: 'staff', count: 1, room: 'staff' },
  { key: 'ptOther', role: 'pay', count: 1, room: 'dbl' },
]

const ROLE_HINT: Record<PersonRole, TKey> = { pay: 'prole_pay_hint', free: 'prole_free_hint', staff: 'prole_staff_hint' }

function PeopleCard({ doc, n, edit }: { doc: QuoteDoc; n: number; edit: Edit }) {
  const { t } = useI18n()
  const names = useNames()
  const remove = useRemove(edit)
  const [open, setOpen] = useState<number | null>(null)
  const people = peopleOf(doc, names)
  const counted = (p: PersonType) => p.count === null ? n : Math.max(p.count, p.per ? Math.floor(n / p.per) : 0)
  const set = (i: number, patch: Partial<PersonType>) => edit((d) => { ensure(d, names); Object.assign(d.people![i], patch) })
  const total = people.reduce((s, p) => s + counted(p), 0)
  const del = (i: number) => { remove((d) => { ensure(d, names); d.people!.splice(i, 1) }); setOpen(null) }
  const dup = (i: number) => edit((d) => { ensure(d, names); d.people!.splice(i + 1, 0, { ...structuredClone(d.people![i]), id: newId(), name: `${d.people![i].name} 2` }) }, true)
  // "Travels free · single room · +1 per 15" - the row says how it's set without opening it.
  const meta = (p: PersonType) => [
    t(`prole_${p.role}` as TKey), t(`room_${p.room}` as TKey),
    p.per ? t('plusOnePer', { n: p.per }) : '',
    p.role === 'pay' && p.count !== null && Number(p.weight ?? 1) !== 1 ? t(Number(p.weight) === 0 ? 'shareNone' : 'shareHalf') : '',
  ].filter(Boolean).join(' · ')
  return (
    <Section id="who" step={1} icon={<Users size={20} />} title={t('whoTravels')} hint={t('peopleTotal', { n: total })}
      summary={people.filter((p) => counted(p) > 0).map((p) => `${counted(p)} ${p.name}`).join(' · ')}
      actions={<Menu kind="add" label={t('addPersonType')}
        items={PERSON_PRESETS.map((x) => ({ label: t(x.key), onClick: () => {
          edit((d) => { ensure(d, names); d.people!.push({ id: newId(), name: t(x.key), role: x.role, count: x.count, room: x.room }) }, true)
          setOpen(people.length)
        } }))} />}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-700">
        {t('groupSizesRange')}
        <Input size="sm" type="number" min={1} max={500} value={doc.pax_min} aria-label={t('groupMin')} className="w-20 text-right"
          onChange={(e) => edit((d) => { d.pax_min = e.target.value === '' ? 0 : Number(e.target.value) })} />
        –
        <Input size="sm" type="number" min={1} max={500} value={doc.pax_max} aria-label={t('groupMax')} className="w-20 text-right"
          onChange={(e) => edit((d) => { d.pax_max = e.target.value === '' ? 0 : Number(e.target.value) })} />
        {t('touristsWord')}
      </div>
      <div className="mb-3 flex flex-wrap gap-1" aria-hidden="true">
        {people.flatMap((p) => Array.from({ length: Math.min(counted(p), 60) }, (_, k) => (
          <span key={`${p.id}${k}`} className={cn('h-2.5 w-2.5 rounded-full', ROLE_DOT[p.role])} />
        )))}
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        {people.map((p, i) => (
          <ListRow key={p.id} lead={<span className={cn('h-3 w-3 shrink-0 rounded-full', ROLE_DOT[p.role])} />}
            title={p.name || '—'} meta={meta(p)} onOpen={() => setOpen(i)}
            control={p.count === null
              ? <Badge tone="brand" className="h-6 px-2 text-sm">{n} · {t('theGroup')}</Badge>
              : <Stepper value={p.count} min={0} max={99} label={p.name} onChange={(v) => set(i, { count: v })} />}
            menu={<Menu kind="icon" label={`${t('moreActions')}: ${p.name}`} items={[
              { label: t('edit'), icon: <Pencil size={16} />, onClick: () => setOpen(i) },
              { label: t('duplicate'), icon: <Copy size={16} />, onClick: () => dup(i), hidden: p.count === null },
              { label: t('delete'), icon: <Trash2 size={16} />, danger: true, onClick: () => del(i), hidden: p.count === null },
            ]} />} />
        ))}
      </div>
      {open !== null && people[open] && (
        <PersonDrawer p={people[open]} n={n} set={(patch) => set(open, patch)} onDelete={() => del(open)} onClose={() => setOpen(null)} />
      )}
    </Section>
  )
}

/** One type of person, every setting with what it means. */
function PersonDrawer({ p, n, set, onDelete, onClose }: {
  p: PersonType; n: number; set: (patch: Partial<PersonType>) => void; onDelete: () => void; onClose: () => void
}) {
  const { t } = useI18n()
  const group = p.count === null
  return (
    <Drawer title={p.name || t('typeOfPerson')} subtitle={t(`prole_${p.role}` as TKey)} onClose={onClose} size="md"
      footer={<div className="flex w-full justify-between">
        {group ? <span /> : <Button variant="secondary" onClick={onDelete}><Trash2 size={16} />{t('delete')}</Button>}
        <Button onClick={onClose}>{t('done')}</Button>
      </div>}>
      <div className="space-y-6">
        <Field label={t('name')}><Input value={p.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></Field>

        <Field label={t('howManyPeople')} hint={group ? t('groupTypeHelp') : undefined}>
          {group ? <div className="flex h-10 items-center"><Badge tone="brand" className="h-7 px-2.5 text-sm">{n} · {t('theGroup')}</Badge></div> : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex rounded-md border border-slate-300"><Stepper size="md" value={p.count ?? 0} min={0} max={99} label={t('howManyPeople')} onChange={(v) => set({ count: v })} /></span>
              {p.role !== 'pay' && (
                <span className="flex items-center gap-2 text-sm text-slate-700">
                  {t('orOnePer')}
                  <Input type="number" min={1} value={p.per ?? ''} placeholder="—" className="w-20 text-right" aria-label={t('onePer')}
                    onChange={(e) => set({ per: e.target.value ? Number(e.target.value) : null })} />
                  {t('touristsWord')}
                  <InfoTip label={t(p.role === 'staff' ? 'perStaffHelp' : 'perHelp')} />
                </span>
              )}
            </div>
          )}
        </Field>

        {!group && (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-slate-700">{t('personRole')}</legend>
            <div className="grid gap-2">
              {(['pay', 'free', 'staff'] as const).map((r) => (
                <ChoiceCard key={r} selected={p.role === r} title={t(`prole_${r}` as TKey)} hint={t(ROLE_HINT[r])}
                  icon={<span className={cn('mt-1 block h-3 w-3 rounded-full', ROLE_DOT[r])} />}
                  onClick={() => set({ role: r, ...(r === 'staff' ? { room: 'staff' as RoomUse } : {}), ...(r === 'pay' ? { per: null } : {}) })} />
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-slate-700">{t('sleeps')}</legend>
          <div className="flex flex-wrap gap-2">
            {(['dbl', 'sgl', 'trp', 'free', 'none', 'staff'] as const).map((r) => (
              <Chip key={r} on={p.room === r} onClick={() => set({ room: r })}>{t(`room_${r}` as TKey)}</Chip>
            ))}
          </div>
        </fieldset>

        {p.role === 'pay' && !group && (
          <Field label={t('shareOfShared')} info={t('shareHelp')}>
            <SegmentedControl label={t('shareOfShared')} value={String(Number(p.weight ?? 1))} onChange={(v) => set({ weight: v })}
              options={[['1', t('shareFull')], ['0.5', t('shareHalf')], ['0', t('shareNone')]]} />
          </Field>
        )}
      </div>
    </Drawer>
  )
}

// --- the trip ----------------------------------------------------------------------------------

const ADD_KINDS: { cat: QuoteCategory; perPerson: boolean; icon: ReactNode }[] = [
  { cat: 'meal', perPerson: true, icon: <Utensils size={16} /> },
  { cat: 'ticket', perPerson: true, icon: <Ticket size={16} /> },
  { cat: 'transport', perPerson: false, icon: <Bus size={16} /> },
  { cat: 'guide', perPerson: false, icon: <User size={16} /> },
  { cat: 'activity', perPerson: true, icon: <Ticket size={16} /> },
  { cat: 'other', perPerson: false, icon: <Plus size={16} /> },
]

function TripBoard({ doc, n, amounts, beds, edit, onItem, onNight, vehicle, value }: {
  doc: QuoteDoc; n: number; amounts?: number[]; beds?: { night: number; dbl_pp: number }[]; edit: Edit; onItem: (i: number) => void; onNight: (i: number) => void; vehicle?: string; value?: string
}) {
  const [, setParams] = useSearchParams()
  // The transport plan's lines come after the calculation's own (the engine adds them).
  const transportPp = doc.transport && amounts ? amounts.slice(doc.items.length).reduce((s, x) => s + x, 0) / n : 0
  const [staffTool, setStaffTool] = useState(false)
  const { t } = useI18n()
  const K = useKinds()
  const [kindsOpen, setKindsOpen] = useState(false)
  const addKind = (day: number | null, k: import('../../lib/api').CostKind) => {
    edit((d) => { const it = kindLine(k, newItem(d.currency, k.base)); it.day = day; d.items.push(it) }, true)
    onItem(doc.items.length)
  }
  const tickets = doc.items.filter((i) => i.included && i.travel).map((i) => ({ i, left: daysToTicket(i.travel) })).filter((x) => x.left !== null && x.left <= 14)
  const names = useNames()
  const staff = peopleOf(doc, names).filter((p) => p.role === 'staff' && p.count)
  const hasStaff = staff.length > 0 && doc.nights.length > 0
  const board = useRef<HTMLDivElement>(null)
  // A new day goes at the end of the board: scroll there so it's seen.
  const addDay = () => {
    edit((d) => { d.days += 1 }, true)
    setTimeout(() => board.current?.scrollTo({ left: board.current.scrollWidth, behavior: 'smooth' }), 50)
  }
  // Lines left on days after the trip's end (days were lowered) are still priced: show them, marked.
  const beyond = [...new Set(doc.items.map((i) => i.day).filter((d): d is number => !!d && d > doc.days))].sort((a, b) => a - b)
  const cols: (number | null)[] = [...Array.from({ length: doc.days }, (_, k) => k + 1), ...beyond, null]
  const pp = (i: number) => (amounts?.[i] ?? 0) / n
  const add = (day: number | null, cat: QuoteCategory, perPerson: boolean) => {
    edit((d) => {
      const it = newItem(d.currency, cat)
      it.name = t(`qcat_${cat}` as TKey)
      it.day = day
      if (perPerson) { it.basis = 'per_person'; it.who = cat === 'meal' ? 'everyone' : 'tourists' }
      if (day === null) it.quantity = 'days'
      d.items.push(it)
    })
    onItem(doc.items.length)
  }
  const addNight = (day: number) => {
    edit((d) => {
      while (d.nights.length < day) {
        const last = d.nights.at(-1)
        d.nights.push({ id: newId(), city: '', vendor_id: null, hotel_name: '', currency: last?.currency ?? d.currency, price_dbl: null, price_sgl: null, price_trp: null })
      }
    })
    onNight(day - 1)
  }
  return (
    <Section id="trip" step={2} icon={<BedDouble size={20} />} title={t('theTrip')} hint={t('perTouristAt', { n })} value={value}
      summary={t('tripSummary', { days: doc.days, nights: doc.nights.length, lines: doc.items.length })}
      actions={<Button variant="tertiary" size="sm" onClick={addDay}><Plus size={16} />{t('addDay')}</Button>}>
      <MealsLine doc={doc} edit={edit} />
      {tickets.map(({ i, left }) => (
        <button key={i.id} type="button" onClick={() => onItem(doc.items.indexOf(i))}
          className={cn('mb-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left text-sm', left! < 0 ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900')}>
          <span className="font-medium">{i.name}</span>
          <span className="min-w-0 flex-1">{left! < 0 ? t('ticketLate', { n: -left! }) : t('ticketSoon', { n: left! })}</span>
        </button>
      ))}
      {kindsOpen && <KindsDialog onClose={() => setKindsOpen(false)} />}
      {hasStaff && <StaffStayLine doc={doc} names={staff.map((p) => p.name).join(', ')} onChange={() => setStaffTool(true)} />}
      {doc.nights.length > Math.max(doc.days - 1, 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 py-1 pl-3 pr-1 text-sm text-amber-900">
          <BedDouble size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t('nightsAfterLastDay', { list: Array.from({ length: doc.nights.length - Math.max(doc.days - 1, 0) }, (_, k) => Math.max(doc.days - 1, 0) + k + 1).join(', ') })}</span>
          <Button variant="tertiary" size="sm" onClick={() => setParams((p) => { p.set('tab', 'hotels'); return p }, { replace: true })}>{t('changeWord')}</Button>
        </div>
      )}
      {staffTool && <StaffNights doc={doc} edit={edit} onClose={() => setStaffTool(false)} />}
      <div ref={board} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
        {cols.map((day) => {
          const nightIdx = day !== null && day < doc.days ? day - 1 : null
          const nt = nightIdx !== null ? doc.nights[nightIdx] : undefined
          const rows = doc.items.map((it, i) => ({ it, i })).filter((r) => r.it.day === day)
          const bed = nightIdx !== null ? beds?.find((b) => b.night === nightIdx + 1)?.dbl_pp : undefined   // in the calculation currency
          const dayTotal = rows.reduce((s, r) => s + pp(r.i), 0) + (bed ?? 0)
          return (
            <div key={day ?? 'all'} className={cn('flex w-60 shrink-0 flex-col rounded-xl p-2', day === null ? 'border border-dashed border-slate-300 bg-white' : 'bg-slate-100/80')}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className={cn('text-sm font-semibold', day !== null && day > doc.days && 'text-amber-700')}>
                  {day === null ? t('wholeTrip') : day > doc.days ? `${t('dayN', { n: day })} · ${t('outsideTrip')}` : t('dayN', { n: day })}
                </span>
                {dayTotal > 0 && <span className="text-sm tabular-nums text-slate-600">{money(dayTotal)}</span>}
              </div>
              {nightIdx !== null && (nt ? (
                <TripChip color={CAT_COLOR.hotel} label={nt.hotel_name || nt.city || t('hotel')} missing={nt.price_dbl === null || nt.price_dbl === ''}
                  sub={nt.price_dbl === null || nt.price_dbl === '' ? t('noPriceYet') : bed !== undefined ? money(bed) : `${money(Number(nt.price_dbl) / 2)} ${nt.currency}`}
                  onClick={() => onNight(nightIdx)} icon={<BedDouble size={16} />} />
              ) : (
                <button type="button" onClick={() => addNight(day!)} className="mb-1.5 flex h-9 items-center gap-2 rounded-lg border border-dashed border-slate-300 px-2 text-sm text-slate-600 hover:border-brand-400 hover:text-brand-700">
                  <BedDouble size={16} />{t('addHotelNight')}
                </button>
              ))}
              {day === null && doc.transport && (
                <TripChip color={CAT_COLOR.transport} label={vehicle || t('transport')} sub={money(transportPp)} icon={<Bus size={16} />}
                  onClick={() => document.getElementById('transport-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
              )}
              {rows.map(({ it, i }) => {
                const key = K.keyOf(it), Ic = it.travel || it.kind ? K.iconOf(key) : undefined
                return (
                <TripChip key={it.id} color={K.colorOf(key)} label={it.travel && journey(it.travel) ? `${it.name} · ${journey(it.travel)}` : it.name} muted={!it.included && !it.optional}
                  icon={Ic ? <Ic size={16} /> : undefined}
                  missing={lineMissing(it)}
                  sub={it.optional && !it.included ? t('optionalShort') : lineMissing(it) ? t('noPriceYet') : amounts ? money(pp(i)) : '…'} onClick={() => onItem(i)}
                  dashed={it.optional && !it.included} />
                )
              })}
              <div className="mt-auto w-full">
                <Menu full label={day === null ? t('wholeTrip') : t('dayN', { n: day })}
                  triggerClassName="flex h-8 w-full items-center justify-center gap-1 rounded-md text-sm font-medium text-slate-600 hover:bg-white hover:text-brand-700"
                  trigger={<><Plus size={16} />{t('add')}</>}
                  items={[
                    ...ADD_KINDS.map((k) => ({ label: t(`qcat_${k.cat}` as TKey), icon: k.icon, onClick: () => add(day, k.cat, k.perPerson) })),
                    ...K.kinds.map((k) => { const Ic = K.iconOf(k.id); return { label: k.name, icon: Ic ? <Ic size={16} /> : undefined, onClick: () => addKind(day, k) } }),
                    ...(K.canManage ? [{ label: t('manageKinds'), icon: <Pencil size={16} />, onClick: () => setKindsOpen(true) }] : []),
                  ]} />
              </div>
            </div>
          )
        })}
        <button type="button" onClick={addDay}
          className="flex w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-700">
          <Plus size={16} />{t('addDay')}
        </button>
      </div>
    </Section>
  )
}

/** Where the driver and guide sleep, night by night, said in one line - and changed for all nights at once. */
function StaffStayLine({ doc, names, onChange }: { doc: QuoteDoc; names: string; onChange: () => void }) {
  const { t } = useI18n()
  const groups = new Map<string, number>()
  for (const nt of doc.nights) {
    const stay = nt.staff_stay ?? 'none'
    const paid = (stay === 'own' || stay === 'allowance') && nt.staff_price ? ` ${money(Number(nt.staff_price))} ${nt.staff_currency ?? nt.currency}` : ''
    const key = `${t(`staffStay_${stay}` as TKey)}${paid}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 py-1 pl-3 pr-1 text-sm">
      <Users size={16} className="shrink-0 text-slate-500" aria-hidden />
      <span className="font-medium text-slate-800">{names}</span>
      <span className="min-w-0 flex-1 text-slate-600">
        {[...groups].map(([k, c]) => `${k} · ${t('nNightsShort', { n: c })}`).join('  ·  ')}
      </span>
      <Button variant="tertiary" size="sm" onClick={onChange} title={t('changeAllNights')}>{t('changeWord')}</Button>
    </div>
  )
}

function TripChip({ color, label, sub, onClick, muted, icon, dashed, missing }: { color: string; label: string; sub: string; onClick: () => void; muted?: boolean; icon?: ReactNode; dashed?: boolean; missing?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('mb-1.5 flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left text-sm hover:border-brand-400', muted && 'opacity-50', dashed && 'border-dashed border-violet-300 bg-violet-50/50')}>
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', color)} />
      {icon && <span className="text-slate-400">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 leading-snug">{label || '—'}</span>
        {missing && <span className="block text-xs text-amber-700">{sub}</span>}
      </span>
      {!missing && <span className="shrink-0 text-sm tabular-nums text-slate-600">{sub}</span>}
    </button>
  )
}

/** Empty on purpose (the data isn't there yet), said plainly: what's still to fill, each one a click away. */
function ToFill({ doc, onItem, onNight }: { doc: QuoteDoc; onItem: (i: number) => void; onNight: (i: number) => void }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const m = missingPrices(doc)
  if (!m.count) return null
  const meals = m.items.filter(({ it }) => it.category === 'meal').length
  const rest = m.items.length - meals
  const chips = [
    ...m.nights.map(({ n, i }) => ({ key: `n${i}`, label: `${t('nightN', { n: i + 1 })} · ${n.hotel_name || n.city || t('hotel')}`, open: () => onNight(i) })),
    ...m.items.map(({ it, i }) => ({ key: it.id, label: it.name || '—', open: () => onItem(i) })),
  ]
  const shown = all ? chips : chips.slice(0, 8)
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-amber-900">{t('toFillTitle', { n: m.count })}</h3>
        <span className="text-sm text-amber-900">{[m.nights.length ? t('toFillNights', { n: m.nights.length }) : '', meals ? t('toFillMeals', { n: meals }) : '', rest ? t('toFillOther', { n: rest }) : ''].filter(Boolean).join(' · ')}</span>
      </div>
      <p className="mt-1 text-sm text-amber-900">{t('toFillHelp')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {shown.map((c) => (
          <button key={c.key} type="button" onClick={c.open}
            className="inline-flex h-8 items-center rounded-full border border-amber-300 bg-white px-3 text-sm text-slate-800 hover:border-amber-500">{c.label}</button>
        ))}
        {chips.length > 8 && <Button variant="tertiary" size="sm" onClick={() => setAll(!all)}>{all ? t('showLess') : t('showAllN', { n: chips.length })}</Button>}
      </div>
    </div>
  )
}

export function NightDrawer({ doc, index, edit, onClose }: { doc: QuoteDoc; index: number; edit: Edit; onClose: () => void }) {
  const { t } = useI18n()
  const nt = doc.nights[index]
  const vendors = useVendors()
  const hotelVendors = (vendors.data ?? []).filter((v) => v.type === 'hotel')
  const set = (patch: Partial<QuoteNight>) => edit((d) => { Object.assign(d.nights[index], patch) })
  const price = (k: 'price_dbl' | 'price_sgl' | 'price_trp' | 'price_quad', label: string) => (
    <Field label={label}><Input type="number" min={0} step="any" value={nt[k] ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? null : e.target.value })} className="text-right" /></Field>
  )
  const stay = nt.staff_stay ?? 'none'
  const remove = useRemove(edit)
  return (
    <Drawer title={t('nightN', { n: index + 1 })} subtitle={t('afterDayN', { n: index + 1 })} onClose={onClose} size="md"
      footer={<div className="flex justify-between">
        <Button variant="secondary" onClick={() => { remove((d) => { d.nights.splice(index, 1) }); onClose() }}><Trash2 size={16} />{t('delete')}</Button>
        <Button onClick={onClose}>{t('done')}</Button>
      </div>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('hotel')}>
            <div className="space-y-1">
              <VendorSelect vendors={hotelVendors} types={['hotel']} value={nt.vendor_id} cities={[nt.city]}
                onChange={(id) => { const v = hotelVendors.find((h) => h.id === id); set({ vendor_id: id, hotel_name: v?.name ?? nt.hotel_name, city: nt.city || v?.city || '' }) }} />
              {!nt.vendor_id && <Input value={nt.hotel_name} placeholder={t('hotelNotInCatalog')} onChange={(e) => set({ hotel_name: e.target.value })} />}
            </div>
          </Field>
          <Field label={t('city')}><Input value={nt.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label={t('currency')}><Select value={nt.currency} onChange={(e) => set({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          {price('price_dbl', t('roomDouble'))}{price('price_sgl', t('roomSingle'))}{price('price_trp', t('roomTriple'))}{price('price_quad', t('roomQuad'))}
        </div>
        {(doc.seasons ?? []).map((sn) => {
          const sp = nt.season_prices?.[sn.id] ?? {}
          const setSp = (k: 'price_dbl' | 'price_sgl' | 'price_trp' | 'price_quad', v: string) => edit((d) => {
            const n2 = d.nights[index]
            n2.season_prices = { ...(n2.season_prices ?? {}), [sn.id]: { ...(n2.season_prices?.[sn.id] ?? {}), [k]: v === '' ? null : v } }
          })
          return (
            <div key={sn.id} className="grid items-end gap-3 rounded-lg bg-amber-50/60 p-2 sm:grid-cols-5">
              <div className="pb-2 text-sm font-medium text-amber-900">{sn.name}</div>
              {(['price_dbl', 'price_sgl', 'price_trp', 'price_quad'] as const).map((k) => (
                <Input key={k} type="number" min={0} step="any" value={sp[k] ?? ''} placeholder={nt[k] ?? '—'} aria-label={`${sn.name} ${k}`}
                  onChange={(e) => setSp(k, e.target.value)} className="text-right" />
              ))}
            </div>
          )
        })}
        {(doc.seasons?.length ?? 0) > 0 && <p className="-mt-2 text-xs text-slate-500">{t('seasonPriceHelp')}</p>}
        <Field label={t('staffStay')}>
          <div className="flex flex-wrap gap-2">
            {(['same', 'own', 'allowance', 'free', 'none'] as StaffStay[]).map((s) => (
              <Chip key={s} on={stay === s} onClick={() => set({ staff_stay: s })}>{t(`staffStay_${s}` as TKey)}</Chip>
            ))}
          </div>
        </Field>
        {(stay === 'own' || stay === 'allowance') && (
          <div className="grid gap-3 sm:grid-cols-2">
            {stay === 'own' && <Field label={t('staffHotelPh')}><Input value={nt.staff_hotel ?? ''} onChange={(e) => set({ staff_hotel: e.target.value })} /></Field>}
            <Field label={stay === 'allowance' ? t('allowancePp') : t('pricePerRoom')} hint={stay === 'allowance' ? t('allowanceHelp') : undefined}>
              <div className="flex gap-1">
                <Input type="number" min={0} value={nt.staff_price ?? ''} onChange={(e) => set({ staff_price: e.target.value === '' ? null : e.target.value })} className="text-right" />
                <Select value={nt.staff_currency ?? nt.currency} onChange={(e) => set({ staff_currency: e.target.value })} className="w-24">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
              </div>
            </Field>
          </div>
        )}
        {(stay === 'same' || stay === 'own') && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!nt.staff_twin} onChange={(e) => set({ staff_twin: e.target.checked })} />{t('staffTwin')}</label>
        )}
      </div>
    </Drawer>
  )
}

// --- who uses what -----------------------------------------------------------------------------

function UsesGrid({ doc, edit }: { doc: QuoteDoc; edit: Edit }) {
  const { t } = useI18n()
  const K = useKinds()
  const names = useNames()
  const people = peopleOf(doc, names)
  const [openCat, setOpenCat] = useState<string | null>(null)
  const rows = doc.items.map((it, i) => ({ it, i })).filter((r) => r.it.basis === 'per_person')
  if (!rows.length) return null
  const setUse = (idx: number[], p: PersonType, mode: UseMode, price?: string | null) => edit((d) => {
    ensure(d, names)
    for (const i of idx) {
      const it = d.items[i]
      it.uses = { ...(it.uses ?? {}), [p.id]: { mode, price: mode === 'own' ? (price ?? it.uses?.[p.id]?.price ?? it.unit_price) : null } }
    }
  })
  // Lines by kind of cost: meals, tickets… each row says how every type of person takes them.
  const cats = [...new Set(rows.map((r) => K.keyOf(r.it)))].map((c) => ({ c, rows: rows.filter((r) => K.keyOf(r.it) === c) }))
  const modeOf = (rs: typeof rows, p: PersonType): UseMode | 'mixed' => {
    const ms = new Set(rs.map((r) => usageOf(r.it, p)))
    return ms.size === 1 ? [...ms][0] : 'mixed'
  }
  const exceptions = rows.reduce((n, r) => n + people.filter((p) => usageOf(r.it, p) !== 'full' && WHO_ROLES[r.it.who]?.includes(p.role)).length, 0)
  const cell = (mode: UseMode | 'mixed', onPick: (m: UseMode) => void, label: string) => (
    <select value={mode} onChange={(e) => onPick(e.target.value as UseMode)} aria-label={label}
      className={cn('select-chevron h-8 w-full cursor-pointer rounded-md border pl-2 pr-7 text-sm font-medium',
        mode === 'full' && 'border-sky-200 bg-sky-50 text-sky-800',
        mode === 'half' && 'border-sky-200 bg-white text-sky-700',
        mode === 'own' && 'border-amber-200 bg-amber-50 text-amber-800',
        mode === 'mixed' && 'border-violet-200 bg-violet-50 text-violet-800',
        mode === 'none' && 'border-dashed border-slate-200 bg-white text-slate-400')}>
      {mode === 'mixed' && <option value="mixed" disabled>{t('useMixed')}</option>}
      {(['full', 'half', 'own', 'none'] as UseMode[]).map((m) => <option key={m} value={m}>{t(`use_${m}` as TKey)}</option>)}
    </select>
  )
  return (
    <Section id="uses" defaultOpen={false} icon={<Utensils size={20} />} title={t('whoUsesWhat')} hint={t('whoUsesWhatHelp')}
      summary={cats.map(({ c, rows: rs }) => `${K.nameOf(c)} ${rs.length}`).join(' · ') + ' · ' + (exceptions ? t('nExceptions', { n: exceptions }) : t('noExceptions'))}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1.5 pr-2 font-medium">{t('perPersonCosts')}</th>
              {people.map((p) => (
                <th key={p.id} className="px-1 py-1.5 text-center font-medium">
                  <span className={cn('mr-1 inline-block h-2 w-2 rounded-full', ROLE_DOT[p.role])} />{p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map(({ c, rows: rs }) => {
              const open = openCat === c
              return [
                <tr key={c} className="border-t border-slate-200 bg-slate-50/70">
                  <td className="py-1.5 pr-2">
                    <button type="button" onClick={() => setOpenCat(open ? null : c)} className="flex items-center gap-2 whitespace-nowrap font-medium" aria-expanded={open}>
                      <ChevronRight size={16} className={cn('text-slate-500 transition-transform', open && 'rotate-90')} />
                      <span className={cn('h-2.5 w-2.5 rounded-sm', K.colorOf(c))} />{K.nameOf(c)}
                      <span className="font-normal text-slate-500">· {rs.length}</span>
                    </button>
                  </td>
                  {people.map((p) => {
                    const m = modeOf(rs, p)
                    // A whole kind at once: all meals half for children, no tickets for staff…
                    return <td key={p.id} className="px-1 py-1">{cell(m, (to) => setUse(rs.map((r) => r.i), p, to), `${K.nameOf(c)} · ${p.name}`)}</td>
                  })}
                </tr>,
                ...(open ? rs.map(({ it, i }) => (
                  <tr key={it.id} className="border-t border-slate-200">
                    <td className="py-1.5 pl-6 pr-2">
                      <div className="line-clamp-1 font-medium">{it.name}</div>
                      <div className="text-xs text-slate-500">{money(Number(it.unit_price))} {it.currency}{it.day ? ` · ${t('dayN', { n: it.day })}` : ''}</div>
                    </td>
                    {people.map((p) => {
                      const mode = usageOf(it, p)
                      return (
                        <td key={p.id} className="px-1 py-1 text-center">
                          {mode === 'own' ? (
                            <div className="flex items-center gap-1">
                              <Input size="sm" type="number" min={0} value={it.uses?.[p.id]?.price ?? ''} onChange={(e) => setUse([i], p, 'own', e.target.value)}
                className="w-full min-w-0 bg-amber-50 text-right" aria-label={t('ownPrice')} />
                              <IconButton size="sm" label={t('notUsed')} onClick={() => setUse([i], p, 'none')}><X size={16} /></IconButton>
                            </div>
                          ) : cell(mode, (to) => setUse([i], p, to), `${it.name} · ${p.name}`)}
                        </td>
                      )
                    })}
                  </tr>
                )) : []),
              ]
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">{t('sharedCostsHelp')}</p>
    </Section>
  )
}

// --- how we price ------------------------------------------------------------------------------

// The engine's own names for steps without a label of their own (shown in the app's language instead).
const ENGINE_LABEL: Record<string, string> = {
  profit: 'Profit', markup: 'Markup', add_pp: 'Per person', add_group: 'Per group', commission: 'Commission', vat_margin: 'VAT on margin',
  vat: 'VAT', discount: 'Discount', relative: 'Share of another price', round: 'Rounding', formula: 'Formula',
}
const COST_KINDS = ['hotel', 'meal', 'transport', 'guide', 'ticket', 'activity', 'tips', 'border', 'other']
// One line per step, for the folded recipe: "Profit ≥ 30/person → Round down to 1".
const stepSummary = (s: PriceStep) => {
  const v = Number(s.value)
  switch (s.kind) {
    case 'profit': return `${s.label || 'Profit'} ≥ ${[Number(s.group) ? `${s.group}/group` : '', Number(s.min_pp) ? `${s.min_pp}/pp` : '', v ? `${v}%` : ''].filter(Boolean).join(', ') || '0'}`
    case 'round': return `${s.label || 'Round'} ${s.mode ?? 'ceil'} ${v}`
    case 'formula': return s.label || s.formula || 'Formula'
    default: return `${s.label || s.kind} ${v}${['markup', 'commission', 'vat_margin', 'vat', 'discount', 'relative'].includes(s.kind) ? '%' : ''}`
  }
}

const STEP_KINDS: StepKind[] = ['markup', 'profit', 'add_pp', 'add_group', 'commission', 'vat_margin', 'vat', 'discount', 'relative', 'round', 'formula']

function RecipeCard({ doc, edit, value }: { doc: QuoteDoc; edit: Edit; value?: string }) {
  const { t } = useI18n()
  const K = useKinds()
  const names = useNames()
  const remove = useRemove(edit)
  const steps = recipeOf(doc)
  const people = peopleOf(doc, names).filter((p) => p.role === 'pay')
  const set = (i: number, patch: Partial<PriceStep>) => edit((d) => { ensure(d, names); Object.assign(d.recipe![i], patch) })
  // Steps run top to bottom (a markup before or after the commission is a different price): dragged into order.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const onDragEnd = (e: DragEndEvent) => {
    const from = steps.findIndex((x) => x.id === e.active.id), to = e.over ? steps.findIndex((x) => x.id === e.over!.id) : -1
    if (from >= 0 && to >= 0 && from !== to) edit((d) => { ensure(d, names); d.recipe = arrayMove(d.recipe!, from, to) }, true)
  }
  const addStep = (kind: StepKind) => edit((d) => {
    ensure(d, names)
    const ref = kind === 'relative' ? people[0]?.id ?? null : null
    const step: PriceStep = { id: newId(), kind, label: '', on: true, value: kind === 'round' ? '5' : kind === 'relative' ? '70' : '10', mode: 'ceil',
      // A share of the group's price is for the others (children…), not the group itself.
      only: ref ? people.filter((p) => p.id !== ref).map((p) => p.id) : [],
      ref, formula: kind === 'formula' ? 'cost * 1.15' : '' }
    // New steps go before the final rounding, so the price still comes out round.
    const r = d.recipe!
    const at = kind !== 'round' && r.length && r[r.length - 1].kind === 'round' ? r.length - 1 : r.length
    r.splice(at, 0, step)
  })
  const num = (i: number, k: 'value' | 'group' | 'min_pp', unit: string, s: PriceStep) => (
    <label className="flex items-center gap-1 text-sm">
      <Input size="sm" type="number" step="any" value={(s[k] as string | undefined) ?? '0'} onChange={(e) => set(i, { [k]: e.target.value || '0' })} className="w-24 text-right" />
      <span className="text-slate-500">{unit}</span>
    </label>
  )
  return (
    <Section id="pricing" step={3} icon={<span className="text-base font-semibold leading-none">%</span>} title={t('priceRecipe')} hint={t('priceRecipeHelp')} value={value}
      summary={steps.filter((x) => x.on).map((x) => stepSummary(x)).join(' → ')}
      actions={<Menu kind="add" label={t('addStep')}
        items={STEP_KINDS.map((k) => ({ label: t(`step_${k}` as TKey), onClick: () => addStep(k) }))} />}>
      <ol className="space-y-2">
        <li className="flex items-center gap-2 px-2 text-sm text-slate-500"><span className="h-2 w-2 rounded-full bg-slate-300" />{t('stepCost')}</li>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        {steps.map((s, i) => (
          <SortableStep key={s.id} id={s.id} name={s.label || t(`step_${s.kind}` as TKey)}
            className={cn('rounded-lg border border-slate-200 bg-white py-2 pl-1 pr-1', !s.on && 'bg-slate-50 opacity-60')}>
            {(handle) => <>
            <div className="flex flex-wrap items-center gap-2">
              {handle}
              <input type="checkbox" checked={s.on} onChange={(e) => set(i, { on: e.target.checked })} aria-label={t('stepOn')} className="h-4 w-4 accent-brand-600" />
              <StepName value={s.label} fallback={t(`step_${s.kind}` as TKey)} onChange={(v) => set(i, { label: v })} />
              {s.kind === 'profit' && <>
                <span className="text-xs text-slate-500">{t('bestOf')}</span>
                {num(i, 'group', `${doc.currency} / ${t('perGroupShort')}`, s)}{num(i, 'min_pp', `${doc.currency} / ${t('perPersonShort')}`, s)}{num(i, 'value', `% ${t('ofCost')}`, s)}
              </>}
              {['markup', 'commission', 'vat_margin', 'vat', 'discount'].includes(s.kind) && num(i, 'value', '%', s)}
              {s.kind === 'markup' && <span className="text-xs text-slate-500">{s.cats?.length ? t('onTheseCosts') : t('onWholePrice')}</span>}
              {s.kind === 'add_pp' && num(i, 'value', `${doc.currency} / ${t('perPersonShort')}`, s)}
              {s.kind === 'add_group' && num(i, 'value', `${doc.currency} / ${t('perGroupShort')}`, s)}
              {s.kind === 'relative' && <>
                {num(i, 'value', '%', s)}
                <span className="text-xs text-slate-500">{t('ofPriceOf')}</span>
                <Select size="sm" value={s.ref ?? ''} onChange={(e) => set(i, { ref: e.target.value })} className="w-auto">
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </>}
              {s.kind === 'round' && <>
                <Select size="sm" value={s.mode ?? 'ceil'} onChange={(e) => set(i, { mode: e.target.value as PriceStep['mode'] })} className="w-auto">
                  {(['ceil', 'nearest', 'floor'] as const).map((m) => <option key={m} value={m}>{t(`round_${m}` as TKey)}</option>)}
                </Select>
                {num(i, 'value', doc.currency, s)}
              </>}
              {s.kind === 'formula' && <Input size="sm" value={s.formula ?? ''} onChange={(e) => set(i, { formula: e.target.value })} className="min-w-0 flex-1 font-mono" placeholder="max(cost * 1.15, cost + 120)" />}
              <span className="ml-auto">
                <IconButton size="sm" tone="danger" label={`${t('delete')}: ${s.label || t(`step_${s.kind}` as TKey)}`}
                  onClick={() => remove((d) => { ensure(d, names); d.recipe!.splice(i, 1) })}><Trash2 size={16} /></IconButton>
              </span>
            </div>
            {s.kind === 'markup' && (
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 pr-2 text-sm text-slate-500">
                {t('markupOn')}
                <Chip on={!s.cats?.length} onClick={() => set(i, { cats: [] })}>{t('allCosts')}</Chip>
                {[...COST_KINDS, ...K.kinds.map((k) => k.id)].map((c) => {
                  const on = !!s.cats?.includes(c)
                  return (
                    <Chip key={c} on={on} onClick={() => set(i, { cats: on ? (s.cats ?? []).filter((x) => x !== c) : [...(s.cats ?? []), c] })}>
                      {!on && <span className={cn('h-2 w-2 rounded-sm', K.colorOf(c))} />}{K.nameOf(c)}
                    </Chip>
                  )
                })}
              </div>
            )}
            {people.length > 1 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 pr-2 text-sm text-slate-500">
                {t('appliesTo')}
                {people.map((p) => {
                  const on = !s.only.length || s.only.includes(p.id)
                  return (
                    <Chip key={p.id} on={on} onClick={() => {
                      const all = s.only.length ? s.only : people.map((x) => x.id)
                      const next = on ? all.filter((x) => x !== p.id) : [...all, p.id]
                      set(i, { only: next.length === people.length ? [] : next })
                    }}>{p.name}</Chip>
                  )
                })}
              </div>
            )}
            </>}
          </SortableStep>
        ))}
        </SortableContext>
        </DndContext>
        <li className="flex items-center gap-2 px-2 text-sm font-medium"><span className="h-2 w-2 rounded-full bg-emerald-500" />{t('stepPrice')}</li>
      </ol>
      <label className="mt-3 flex items-center gap-2 border-t border-slate-200 pt-3 text-sm text-slate-700">
        <input type="checkbox" checked={doc.single_profit} onChange={(e) => edit((d) => { d.single_profit = e.target.checked })} className="h-4 w-4 accent-brand-600" />
        {t('singleProfit')}
      </label>
      {doc.items.some((it) => it.optional && !it.included) && (
        <label className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 text-sm text-slate-600">
          {t('extrasMarkup')}
          <Input size="sm" type="number" min={0} value={doc.extra_markup ?? '0'} onChange={(e) => edit((d) => { d.extra_markup = e.target.value || '0' })} className="w-20 text-right" />
          <span>%</span><span className="text-xs text-slate-500">{t('extrasMarkupHelp')}</span>
        </label>
      )}
    </Section>
  )
}

/** A number that counts to its new value (about 0.4 s) instead of jumping; at once when motion is reduced. */
function useTween(target: number | undefined, ms = 420): number | undefined {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (target == null) return
    const start = from.current ?? target
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.easy === 'on'
    if (start === target || still) { from.current = target; setShown(target); return }
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      const v = start + (target - start) * (1 - Math.pow(1 - k, 3))
      from.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    // Animation frames pause in a hidden tab: the exact value is shown when the time is up, whatever happens.
    const done = window.setTimeout(() => { cancelAnimationFrame(raf); from.current = target; setShown(target) }, ms + 80)
    return () => { cancelAnimationFrame(raf); window.clearTimeout(done) }
  }, [target, ms])
  return shown
}

/** How many times a value changed since it first arrived (0 at first): to show a change, not the loading. */
function useChanges<T>(value: T): number {
  const [state, setState] = useState({ value, n: 0 })
  if (state.value === value) return state.n
  const n = state.value == null ? state.n : state.n + 1   // first arrival (loaded): not a change
  setState({ value, n })
  return n
}

/** A pricing step you can drag by its handle (or Space + arrow keys). */
function SortableStep({ id, name, className, children }: { id: string; name: string; className: string; children: (handle: ReactNode) => ReactNode }) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const handle = (
    <button type="button" {...attributes} {...listeners} aria-label={t('dragStep', { name })} title={t('dragNightTip')}
      className="flex h-8 w-6 cursor-grab touch-none items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing">
      <GripVertical size={16} aria-hidden />
    </button>
  )
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn(className, isDragging && 'relative z-10 shadow-lg')}>
      {children(handle)}
    </li>
  )
}

// --- the price, always in view -----------------------------------------------------------------

const tiersOf = (result: QuoteResult | undefined, season: string) =>
  (season ? result?.seasons?.find((x) => x.id === season)?.tiers : undefined) ?? result?.tiers ?? []

function PriceCard({ doc, n, setN, result, breakdown, season, setSeason }: {
  doc: QuoteDoc; n: number; setN: (n: number) => void; result?: QuoteResult
  breakdown?: import('../../lib/api').Breakdown; season: string; setSeason: (s: string) => void
}) {
  const { t } = useI18n()
  const tiers = tiersOf(result, season)
  const [, setParams] = useSearchParams()
  const names = useNames()
  // The engine names an older calculation's people in English; show the app's words.
  const nameOf = (id: string, fallback: string) => peopleOf(doc, names).find((p) => p.id === id)?.name ?? fallback
  const row = tiers.find((x) => x.tourists === n)
  const cur = doc.currency
  const K = useKinds()
  const byCat = useMemo(() => {
    const out: Record<string, number> = {}
    breakdown?.items.forEach((x) => { const k = x.kind ?? x.category; out[k] = (out[k] ?? 0) + x.amount })
    if (breakdown) out.hotel = (out.hotel ?? 0) + breakdown.steps.hotel_dbl_pp * n + breakdown.steps.leader_room + (breakdown.steps.staff_room ?? 0)
    return Object.entries(out).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  }, [breakdown, n])
  const total = byCat.reduce((s, [, v]) => s + v, 0)
  const missing = missingPrices(doc).count
  const priceChanges = useChanges(row?.price_dbl)
  const shownPrice = useTween(row?.price_dbl)
  const sold = new Set(row?.other?.map((o) => o.currency) ?? [])
  const rates = Object.entries(doc.fx).map(([c, v]) => [c, Number(v)] as const).filter(([c, r]) => r > 0 && c !== cur && !sold.has(c))
  const profit = row ? row.group_revenue - row.group_cost : 0
  const pct = row && row.group_revenue > 0 ? (profit / row.group_revenue) * 100 : 0
  // While prices are missing the profit isn't real yet: said in grey, not judged.
  const health = missing > 0 ? 'draft' : profit < 0 ? 'loss' : pct < 1 ? 'thin' : 'ok'
  const slider = (
    <div>
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{t('groupOf')}</span><span className="font-semibold text-slate-900">{row?.label ?? n}</span>
      </div>
      <input type="range" min={doc.pax_min} max={doc.pax_max} step={1} value={n} onChange={(e) => setN(Number(e.target.value))}
        className="mt-1 w-full accent-brand-600" aria-label={t('groupOf')} aria-valuetext={row?.label} />
    </div>
  )
  return (
    <aside className="xl:sticky xl:top-2 xl:self-start">
      <Card className="space-y-4 p-4">
        {(result?.seasons?.length ?? 0) > 0 && (
          <SegmentedControl size="sm" label={t('seasons')} value={season} onChange={setSeason}
            options={[['', t('basePrices')] as [string, string], ...result!.seasons!.map((sn) => [sn.id, sn.name] as [string, string])]} />
        )}
        {row ? <>
          <div>
            <div className="text-sm text-slate-500">{row.types?.[0] ? nameOf(row.types[0].id, row.types[0].name) : t('perPersonShort')} · {t('roomDouble')}</div>
            {missing > 0 && <div className="mb-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{t('priceIncomplete', { n: missing })}</div>}
            <div key={priceChanges} className={cn('-mx-1 px-1 text-[32px] font-semibold leading-10 tabular-nums', priceChanges > 0 && 'animate-flash')}>{money(shownPrice ?? row.price_dbl)} <span className="text-base font-semibold text-slate-500">{cur}</span></div>
            <div className="text-sm text-slate-600">
              {t('roomSingle')} +{money(row.single_supplement)}
              {row.price_trp !== null && ` · ${t('roomTriple')} ${money(row.price_trp)}`}
              {row.price_quad != null && ` · ${t('roomQuad')} ${money(row.price_quad)}`}
            </div>
            {(row.other?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 text-sm font-semibold tabular-nums text-slate-700">
                {row.other!.map((o) => <span key={o.currency}>{money(o.price_dbl)} {o.currency}</span>)}
              </div>
            )}
            {/* The same price in the calculation's other currencies, at its own rates (1 USD = 2.65 GEL): to see it in GEL or USD at a glance. */}
            {rates.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 text-sm tabular-nums text-slate-500" title={t('atCalcRates')}>
                {rates.map(([c, r]) => <span key={c}>≈ {money(row.price_dbl * r)} {c}</span>)}
              </div>
            )}
          </div>
{slider}
          {(row.types?.length ?? 0) > 1 && (
            <ul className="space-y-1 text-sm">
              {row.types!.slice(1).map((x) => (
                <li key={x.id} className="flex justify-between"><span>{nameOf(x.id, x.name)} × {x.count}</span><span className="font-semibold tabular-nums">{money(x.price)}</span></li>
              ))}
            </ul>
          )}
          {/* Cost and profit side by side; the profit coloured by how good it is (grey while prices are missing). */}
          <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-3">
            <div>
              <div className="text-sm text-slate-500">{t('costPerPerson')}</div>
              <div className="text-lg font-semibold tabular-nums text-slate-900">{money(row.cost_dbl)}</div>
            </div>
            <div>
              <div className="text-sm text-slate-500">{t('profitGroup')}</div>
              <div className={cn('text-lg font-semibold tabular-nums',
                health === 'draft' ? 'text-slate-500' : health === 'ok' ? 'text-emerald-700' : health === 'thin' ? 'text-amber-700' : 'text-red-700')}>
                {money(profit)}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className="tabular-nums">{pct.toFixed(1)}%</span>
                {(health === 'thin' || health === 'loss') && (
                  <span className={cn('rounded-md px-1 font-semibold uppercase', health === 'thin' ? 'bg-amber-100 text-amber-900' : 'bg-red-100 text-red-800')}>
                    {t(health === 'thin' ? 'profitThin' : 'profitLoss')}
                  </span>
                )}
              </div>
            </div>
          </div>
          {total > 0 && (
            <div>
              <div className="flex h-2.5 overflow-hidden rounded-full" aria-hidden>
                {byCat.map(([c, v]) => <span key={c} className={K.colorOf(c)} style={{ width: `${(v / total) * 100}%` }} />)}
              </div>
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-700">
                {byCat.map(([c, v]) => (
                  <li key={c} className="flex items-center gap-1.5"><span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', K.colorOf(c))} />
                    <span className="min-w-0 flex-1 truncate">{K.nameOf(c)}</span><span className="tabular-nums">{money(v / n)}</span></li>
                ))}
              </ul>
            </div>
          )}
          {breakdown?.steps.recipe && breakdown.steps.recipe.length > 0 && (
            <details className="group text-xs text-slate-600">
              <summary className="cursor-pointer list-none text-sm font-medium text-slate-700 hover:text-slate-900">
                <ChevronRight size={14} className="mr-1 inline transition-transform group-open:rotate-90" aria-hidden />{t('howPriceBuilt')}
              </summary>
              <ol className="mt-2 space-y-0.5">
                <li className="flex justify-between"><span>{t('stepCost')}</span><span className="tabular-nums">{money(breakdown.tier.cost_dbl)}</span></li>
                {breakdown.steps.recipe.map((r, k) => (
                  <li key={k} className="flex justify-between"><span>{r.amount >= 0 ? '+' : '−'} {r.label === ENGINE_LABEL[r.kind] ? t(`step_${r.kind}` as TKey) : r.label}</span><span className="tabular-nums">{money(Math.abs(r.amount))}</span></li>
                ))}
                <li className="flex justify-between border-t border-slate-200 pt-0.5 font-semibold text-slate-800"><span>{t('stepPrice')}</span><span className="tabular-nums">{money(row.price_dbl)}</span></li>
              </ol>
            </details>
          )}
          {(row.extras?.length ?? 0) > 0 && (
            <div className="border-t border-slate-200 pt-3">
              <div className="mb-1 text-xs text-slate-500">{t('optionalExtras')}</div>
              <ul className="space-y-0.5 text-sm">
                {row.extras!.map((x) => (
                  <li key={x.id} className="flex justify-between gap-2"><span className="truncate text-slate-600">{x.name}</span>
                    <span className="shrink-0 font-medium tabular-nums">+{money(x.price)}</span></li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" onClick={() => setParams((p) => { p.set('tab', 'compare'); return p }, { replace: true })} className="text-sm font-medium text-brand-700 hover:underline">{t('allSizesAndTours')} →</button>
        </> : <>{slider}<p className="text-sm text-slate-500">{result?.errors.length ? t('fixErrorsForPrice') : '…'}</p></>}
      </Card>
    </aside>
  )
}

/** Tools for special cases (who uses what, inputs, formulas): folded under the main three parts, the
 * choice remembered on this device. */
function MoreTools({ doc, children }: { doc: QuoteDoc; children: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(() => readOpen().more ?? false)
  const toggle = () => {
    setOpen(!open)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), more: !open })) } catch { /* private mode */ }
  }
  const inputs = Object.keys(doc.variables).length
  return (
    <div className="space-y-4">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
        <ChevronRight size={16} aria-hidden className={cn('shrink-0 text-slate-500 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800">{t('moreTools')}</span>
          <span className="block text-sm text-slate-500">{t('moreToolsHint', { n: inputs })}</span>
        </span>
      </button>
      {open && children}
    </div>
  )
}


interface CalcStyle {
  people: PersonType[]; recipe: PriceStep[]; single_profit: boolean; transport?: TransportPlan | null
  items?: import('../../lib/api').QuoteItem[]; variables?: Record<string, string>; variable_notes?: Record<string, string>
}

/** "Our way": save how this agency prices once, and start (or bring any calculation) from it. */
function OurWayBar({ doc, edit }: { doc: QuoteDoc; edit: Edit }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const names = useNames()
  const style = useQuery({ queryKey: ['calcStyle', ws.id], queryFn: () => api<CalcStyle>(wsPath(ws.id, '/calc-style')) })
  const save = useMutation({
    mutationFn: () => api<CalcStyle>(wsPath(ws.id, '/calc-style'), {
      method: 'PUT', body: {
        people: peopleOf(doc, names), recipe: recipeOf(doc), single_profit: doc.single_profit,
        // The agency's vehicles and fuel price; each route brings its own km.
        transport: doc.transport ? { ...doc.transport, km: '0', fixed: [], mode: 'auto' } : style.data?.transport ?? null,
        // Its standard lines (tips, water, border…) and the inputs they use.
        items: doc.items.filter((i) => i.standard), variables: doc.variables, variable_notes: doc.variable_notes ?? {},
      },
    }),
    onSuccess: (st) => { qc.setQueryData(['calcStyle', ws.id], st); toast('ourWaySaved') },
  })
  const has = !!style.data?.people.length || !!style.data?.recipe.length
  const same = has && JSON.stringify([style.data!.people, style.data!.recipe]) === JSON.stringify([peopleOf(doc, names), recipeOf(doc)])
  const use = () => {
    edit((d) => {
      const st = style.data!
      if (st.people.length) d.people = structuredClone(st.people)
      if (st.recipe.length) d.recipe = structuredClone(st.recipe)
      d.single_profit = st.single_profit
    })
    toast('ourWayUsed')
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-4 py-2.5 text-sm">
      <Sparkles size={16} className="shrink-0 text-violet-600" />
      <span className="min-w-0 flex-1 text-slate-700">
        {same ? t('ourWayInUse') : has ? t('ourWayDiffers') : t('ourWayNone')}
      </span>
      {has && !same && <Button size="sm" variant="secondary" onClick={use}>{t('useOurWay')}</Button>}
      {can(ws, 'operations') && !same && (
        <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate()}>{t('saveAsOurWay')}</Button>
      )}
    </div>
  )
}

/** Seasons with their own prices, other currencies to sell in, and per-room price lists. */
function SellingCard({ doc, edit }: { doc: QuoteDoc; edit: Edit }) {
  const { t } = useI18n()
  const remove = useRemove(edit)
  const seasons = doc.seasons ?? []
  const sell = doc.sell_in ?? []
  return (
    <Section id="selling" defaultOpen={false} icon={<Sparkles size={20} />} title={t('seasonsAndSelling')} hint={t('seasonsAndSellingHelp')}
      summary={[seasons.length ? t('nSeasons', { n: seasons.length }) : '', sell.length ? `${t('sellAlsoIn')} ${sell.map((c) => c.currency).join(', ')}` : '',
        doc.per_room ? t('sellPerRoom') : ''].filter(Boolean).join(' · ') || t('nothingSet')}>
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-800">{t('seasons')}</h4>
          <p className="mb-3 text-sm text-slate-500">{t('seasonsHelp')}</p>
          <div className="space-y-2">
            {seasons.map((sn, i) => (
              <div key={sn.id} className="flex flex-wrap items-center gap-2">
                <Input size="sm" value={sn.name} onChange={(e) => edit((d) => { d.seasons![i].name = e.target.value })} className="w-44" aria-label={t('name')} />
                <Input size="sm" type="date" value={sn.from_date ?? ''} onChange={(e) => edit((d) => { d.seasons![i].from_date = e.target.value || null })} className="w-40" aria-label={t('dateFrom')} />
                <span className="text-slate-400">–</span>
                <Input size="sm" type="date" value={sn.to_date ?? ''} onChange={(e) => edit((d) => { d.seasons![i].to_date = e.target.value || null })} className="w-40" aria-label={t('dateTo')} />
                <IconButton size="sm" label={`${t('delete')}: ${sn.name}`} tone="danger" onClick={() => remove((d) => {
                  const [gone] = d.seasons!.splice(i, 1)
                  d.nights.forEach((x) => { if (x.season_prices) delete x.season_prices[gone.id] })
                  d.items.forEach((x) => { if (x.season_prices) delete x.season_prices[gone.id] })
                })}><X size={16} /></IconButton>
              </div>
            ))}
            <Button variant="tertiary" size="sm" onClick={() => edit((d) => { d.seasons = [...(d.seasons ?? []), { id: newId(), name: t('highSeason'), from_date: null, to_date: null }] }, true)}>
              <Plus size={16} />{t('addSeasonCalc')}</Button>
          </div>
        </div>
        <div className="border-t border-slate-200 pt-4">
          <h4 className="mb-3 text-sm font-semibold text-slate-800">{t('sellAlsoIn')}</h4>
          <div className="space-y-2">
            {sell.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <Select size="sm" value={c.currency} onChange={(e) => edit((d) => { d.sell_in![i].currency = e.target.value })} className="w-24">
                  {CURRENCIES.filter((x) => x !== doc.currency).map((x) => <option key={x}>{x}</option>)}
                </Select>
                <span className="text-slate-500">1 {doc.currency} =</span>
                <Input size="sm" type="number" min={0} step="any" value={c.rate ?? ''} placeholder={doc.fx[c.currency] ?? '—'} className="w-24 text-right"
         onChange={(e) => edit((d) => { d.sell_in![i].rate = e.target.value || null })} aria-label={t('exchangeRates')} />
                <span className="text-slate-500">{c.currency} · {t('roundTo')}</span>
                <Input size="sm" type="number" min={0} step="any" value={c.step} className="w-20 text-right"
         onChange={(e) => edit((d) => { d.sell_in![i].step = e.target.value || '0' })} aria-label={t('roundTo')} />
                <IconButton size="sm" label={`${t('delete')}: ${c.currency}`} tone="danger" onClick={() => remove((d) => { d.sell_in!.splice(i, 1) })}><X size={16} /></IconButton>
              </div>
            ))}
            <Button variant="tertiary" size="sm" onClick={() => edit((d) => {
              const cur = CURRENCIES.find((x) => x !== d.currency && !(d.sell_in ?? []).some((s2) => s2.currency === x)) ?? 'EUR'
              d.sell_in = [...(d.sell_in ?? []), { currency: cur, rate: null, step: '5', mode: 'ceil' }]
            }, true)}><Plus size={16} />{t('addCurrency')}</Button>
          </div>
        </div>
        <label className="flex items-start gap-2 border-t border-slate-200 pt-4 text-sm">
          <input type="checkbox" checked={!!doc.per_room} onChange={(e) => edit((d) => { d.per_room = e.target.checked })} className="mt-0.5 h-4 w-4 accent-brand-600" />
          <span><span className="font-medium text-slate-800">{t('sellPerRoom')}</span><span className="block text-slate-500">{t('sellPerRoomHelp')}</span></span>
        </label>
      </div>
    </Section>
  )
}

// --- transport: vehicles, rent per day and fuel by distance ------------------------------------------

const VEHICLE_PRESETS: { key: TKey; seats: number; day: string; fuel: string }[] = [
  { key: 'vhSedan', seats: 3, day: '150', fuel: '8' },
  { key: 'vhMinivan', seats: 7, day: '250', fuel: '11' },
  { key: 'vhMinibus', seats: 17, day: '350', fuel: '17' },
  { key: 'vhMidibus', seats: 30, day: '450', fuel: '28' },
  { key: 'vhBus', seats: 45, day: '550', fuel: '40' },
]
const daysAgo = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null)

/** The group's vehicles: chosen by group size (minibus up to 12, bus above) or fixed (2 buses, car +
 * minibus); rent per day and fuel by the route's km, with the date the fuel price was true. */
function TransportCard({ doc, n, result, breakdown, edit, value }: {
  doc: QuoteDoc; n: number; result?: QuoteResult; breakdown?: import('../../lib/api').Breakdown; edit: Edit; value?: string
}) {
  const { t } = useI18n()
  const remove = useRemove(edit)
  const ws = useWorkspace()!
  const routes = useQuery({ queryKey: ['series', ws.id], queryFn: () => api<import('../../lib/api').Series[]>(wsPath(ws.id, '/series')), enabled: !!doc.series_id })
  const style = useQuery({ queryKey: ['calcStyle', ws.id], queryFn: () => api<{ transport?: TransportPlan | null }>(wsPath(ws.id, '/calc-style')) })
  const tp = doc.transport
  const age = daysAgo(tp?.fuel_date ?? null)
  const routeKm = routes.data?.find((r) => r.id === doc.series_id)?.days.reduce((s, d) => s + (d.km ?? 0), 0) ?? 0
  const oldBus = doc.items.filter((i) => i.category === 'transport' && i.day === null && i.included)
  const set = (fn: (p: TransportPlan) => void) => edit((d) => { if (d.transport) fn(d.transport) })
  const row = result?.tiers.find((x) => x.tourists === n)
  const setV = (i: number, patch: Partial<Vehicle>) => set((p) => { Object.assign(p.vehicles[i], patch) })

  if (!tp) {
    const start = () => edit((d) => {
      const base = style.data?.transport
      d.transport = base ? { ...structuredClone(base), km: String(routeKm || 0), fixed: [], mode: 'auto' } : {
        vehicles: [
          { id: newId(), name: t('vhMinibus'), seats: 17, day_price: '350', currency: d.currency, fuel_l_100km: '17', max_pax: 12 },
          { id: newId(), name: t('vhBus'), seats: 45, day_price: '550', currency: d.currency, fuel_l_100km: '40', max_pax: null },
        ],
        mode: 'auto', fixed: [], extra_seats: 1, days: null, extra_days: '0', km: String(routeKm || 0), extra_km: '0',
        fuel_price: null, fuel_currency: d.currency, fuel_date: new Date().toISOString().slice(0, 10),
      }
    })
    return (
      <div id="transport-card">
        <Section id="transport" icon={<Bus size={20} />} title={t('transport')} hint={t('transportHint')} summary={t('transportNotSet')}
          actions={<Button variant="tertiary" size="sm" onClick={start}><Plus size={16} />{style.data?.transport ? t('transportFromOurWay') : t('transportSetUp')}</Button>}>
          <p className="text-sm text-slate-600">{t('transportEmpty')}</p>
        </Section>
      </div>
    )
  }

  const lines = (breakdown?.items ?? []).slice(doc.items.length)
  const rent = lines.filter((x) => !x.name.startsWith('Fuel')).reduce((s, x) => s + x.amount, 0)
  const fuel = lines.filter((x) => x.name.startsWith('Fuel')).reduce((s, x) => s + x.amount, 0)
  return (
    <div id="transport-card">
      <Section id="transport" icon={<Bus size={20} />} title={t('transport')} hint={t('transportHint')} value={value}
        summary={`${row?.vehicle || '—'} · ${money(Number(tp.km) + Number(tp.extra_km))} km${tp.fuel_price ? ` · ${t('fuel')} ${tp.fuel_price} ${tp.fuel_currency ?? ''}` : ''}${age !== null && age > 30 ? ` · ⚠ ${t('fuelOldShort', { days: age })}` : ''}`}
        actions={<Menu kind="icon" label={`${t('moreActions')}: ${t('transport')}`} items={[
          { label: t('transportRemove'), icon: <Trash2 size={16} />, danger: true, onClick: () => remove((d) => { d.transport = null }) },
        ]} />}>
        <div className="space-y-4 text-sm">
          {oldBus.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
              <span className="min-w-0 flex-1">{t('transportDouble', { lines: oldBus.map((i) => i.name).join(', ') })}</span>
              <Button size="sm" variant="secondary" onClick={() => edit((d) => { d.items = d.items.filter((i) => !(i.category === 'transport' && i.day === null && i.included)) })}>{t('transportRemoveOld')}</Button>
            </div>
          )}

          {/* The vehicles */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead><tr className="text-left text-xs text-slate-500">
                <th className="py-1 font-medium">{t('vehicle')}</th><th className="w-16 font-medium">{t('seats')}</th>
                <th className="w-40 font-medium">{t('pricePerDay')}</th><th className="w-20 font-medium">{t('fuelPer100')}</th>
                <th className="w-28 font-medium" title={t('upToGroupHelp')}>{t('upToGroup')}</th><th className="w-8" />
              </tr></thead>
              <tbody>
                {tp.vehicles.map((v, i) => (
                  <tr key={v.id}>
                    <td className="py-1 pr-2"><Input size="sm" value={v.name} onChange={(e) => setV(i, { name: e.target.value })} aria-label={t('vehicle')} /></td>
                    <td className="pr-2"><Input size="sm" type="number" min={1} value={v.seats} onChange={(e) => setV(i, { seats: Number(e.target.value) || 1 })} className="text-right" aria-label={t('seats')} /></td>
                    <td className="pr-2"><div className="flex gap-1">
                      <Input size="sm" type="number" min={0} value={v.day_price} onChange={(e) => setV(i, { day_price: e.target.value || '0' })} className="text-right" aria-label={t('pricePerDay')} />
                      <Select size="sm" value={v.currency} onChange={(e) => setV(i, { currency: e.target.value })} className="w-20">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
                    </div></td>
                    <td className="pr-2"><Input size="sm" type="number" min={0} value={v.fuel_l_100km ?? ''} onChange={(e) => setV(i, { fuel_l_100km: e.target.value || null })} className="text-right" aria-label={t('fuelPer100')} /></td>
                    <td className="pr-2"><Input size="sm" type="number" min={1} value={v.max_pax ?? ''} placeholder={t('bySeats')} onChange={(e) => setV(i, { max_pax: e.target.value ? Number(e.target.value) : null })} className="text-right" aria-label={t('upToGroup')} /></td>
                    <td><IconButton size="sm" label={`${t('delete')}: ${v.name}`} tone="danger" onClick={() => remove((d) => { const p = d.transport!; p.vehicles.splice(i, 1); p.fixed = p.fixed.filter((f) => f.vehicle_id !== v.id) })}><X size={16} /></IconButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 inline-block"><Menu kind="add" label={t('addVehicle')}
              items={VEHICLE_PRESETS.map((x) => ({ label: `${t(x.key)} · ${x.seats}`, onClick: () => set((p) => {
                p.vehicles.push({ id: newId(), name: t(x.key), seats: x.seats, day_price: x.day, currency: p.fuel_currency ?? doc.currency, fuel_l_100km: x.fuel, max_pax: null })
              }) }))} /></div>
          </div>

          {/* Which vehicles */}
          <div className="space-y-2 border-t border-slate-200 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t('whichVehicles')}</span>
              <SegmentedControl size="sm" label={t('whichVehicles')} value={tp.mode}
                onChange={(m) => set((p) => { p.mode = m; if (m === 'fixed' && !p.fixed.length && p.vehicles[0]) p.fixed = [{ vehicle_id: p.vehicles[p.vehicles.length - 1].id, count: 1 }] })}
                options={[['auto', t('vehiclesAuto')], ['fixed', t('vehiclesFixed')]]} />
            </div>
            {tp.mode === 'auto' ? (
              <p className="text-xs text-slate-500">{t('vehiclesAutoHelp')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tp.vehicles.map((v) => {
                  const c = tp.fixed.find((f) => f.vehicle_id === v.id)?.count ?? 0
                  const put = (k: number) => set((p) => { p.fixed = [...p.fixed.filter((f) => f.vehicle_id !== v.id), ...(k > 0 ? [{ vehicle_id: v.id, count: k }] : [])] })
                  return (
                    <span key={v.id} className={cn('inline-flex items-center gap-2 rounded-md border py-0.5 pl-0.5 pr-3', c ? 'border-brand-600 bg-brand-50' : 'border-slate-300')}>
                      <Stepper value={c} onChange={put} min={0} max={20} label={v.name} />
                      <span className="text-sm">{v.name}</span>
                    </span>
                  )
                })}
              </div>
            )}
            <label className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              {t('seatsAlsoFor')}
              <Input size="sm" type="number" min={0} value={tp.extra_seats} onChange={(e) => set((p) => { p.extra_seats = Number(e.target.value) || 0 })} className="w-16 text-right" />
              {t('seatsAlsoForHelp')}
            </label>
          </div>

          {/* Days, distance, fuel */}
          <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-3">
            <Field label={t('rentDays')} hint={t('rentDaysHelp')}>
              <div className="flex items-center gap-1">
                <Input type="number" min={0} step="0.5" value={tp.days ?? ''} placeholder={String(doc.days)} onChange={(e) => set((p) => { p.days = e.target.value || null })} className="text-right" />
                <span className="text-slate-400">+</span>
                <Input type="number" step="0.5" value={tp.extra_days} onChange={(e) => set((p) => { p.extra_days = e.target.value || '0' })} className="text-right" aria-label={t('extraDays')} />
              </div>
            </Field>
            <Field label={t('distanceKm')} hint={t('distanceHelp')}>
              <div className="flex items-center gap-1">
                <Input type="number" min={0} value={tp.km} onChange={(e) => set((p) => { p.km = e.target.value || '0' })} className="text-right" />
                <span className="text-slate-400">+</span>
                <Input type="number" min={0} value={tp.extra_km} onChange={(e) => set((p) => { p.extra_km = e.target.value || '0' })} className="text-right" aria-label={t('reserveKm')} />
              </div>
              {routeKm > 0 && Number(tp.km) !== routeKm && (
                <button type="button" onClick={() => set((p) => { p.km = String(routeKm) })} className="mt-1 text-xs font-medium text-brand-700 hover:underline">{t('kmFromRoute', { km: routeKm })}</button>
              )}
            </Field>
            <Field label={t('fuelPrice')}>
              <div className="flex items-center gap-1">
                <Input type="number" min={0} step="0.01" value={tp.fuel_price ?? ''} onChange={(e) => set((p) => { p.fuel_price = e.target.value || null; p.fuel_date = new Date().toISOString().slice(0, 10) })} className="text-right" />
                <Select value={tp.fuel_currency ?? doc.currency} onChange={(e) => set((p) => { p.fuel_currency = e.target.value })} className="w-20">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
              </div>
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-500">{t('fuelAsOf')}
                <Input size="sm" type="date" value={tp.fuel_date ?? ''} onChange={(e) => set((p) => { p.fuel_date = e.target.value || null })} className="w-40" />
              </label>
            </Field>
          </div>
          {age !== null && age > 30 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{t('fuelOld', { days: age })}</p>
          )}
          {tp.fuel_price === null && <p className="text-xs text-amber-700">{t('fuelMissing')}</p>}

          {/* What it costs at this size */}
          {row && (
            <p className="rounded-lg bg-slate-50 px-3 py-2">
              <b>{row.label}</b>: {row.vehicle || '—'} · {t('rent')} {money(rent)} · {t('fuel')} {money(fuel)} {doc.currency}
              <span className="text-slate-500"> = {money((rent + fuel) / n)} {t('perPersonShort')}</span>
            </p>
          )}
        </div>
      </Section>
    </div>
  )
}

/** Driver and guide, every night at once: same hotel, a staff price, an allowance ("40 USD, they find a
 * hotel")… - except the nights in the home city, where they sleep at home. */
function StaffNights({ doc, edit, onClose }: { doc: QuoteDoc; edit: Edit; onClose: () => void }) {
  const { t } = useI18n()
  const [stay, setStay] = useState<StaffStay>('allowance')
  const [price, setPrice] = useState('40')
  const [cur, setCur] = useState('USD')
  const [home, setHome] = useState(() => doc.nights[0]?.city ?? '')
  const apply = () => edit((d) => {
    d.nights.forEach((n) => {
      if (home && n.city.trim().toLowerCase() === home.trim().toLowerCase()) { n.staff_stay = 'none'; return }
      n.staff_stay = stay
      if (stay === 'own' || stay === 'allowance') { n.staff_price = price || null; n.staff_currency = cur }
    })
  }, true)
  return (
    <Dialog title={t('staffNightsTitle')} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        <Button onClick={() => { apply(); toast('staffNightsApplied'); onClose() }}>{t('applyToNights', { n: doc.nights.length })}</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('staffEveryNightHelp')}</p>
        <Field label={t('staffStay')}>
          <Select value={stay} onChange={(e) => setStay(e.target.value as StaffStay)}>
            {(['allowance', 'same', 'own', 'free', 'none'] as StaffStay[]).map((s) => <option key={s} value={s}>{t(`staffStay_${s}` as TKey)}</option>)}
          </Select>
        </Field>
        {(stay === 'own' || stay === 'allowance') && (
          <Field label={stay === 'allowance' ? t('allowancePp') : t('pricePerRoom')} hint={stay === 'allowance' ? t('perPersonNight') : t('perRoomNight')}>
            <div className="flex gap-2">
              <Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} className="text-right" />
              <Select value={cur} onChange={(e) => setCur(e.target.value)} className="w-28">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
            </div>
          </Field>
        )}
        <Field label={t('staffHomeCity')} hint={t('homeCityHelp')}>
          <Input value={home} onChange={(e) => setHome(e.target.value)} placeholder="Tbilisi" aria-label={t('homeCity')} />
        </Field>
      </div>
    </Dialog>
  )
}

const PLAIN_QTY = /^\s*(\d+(\.\d+)?|days|nights)\s*$/

/** Every formula of the calculation in one place - which line, the formula, what it comes to at this
 * group size - plus the agency's saved formulas, ready to use in a new line. */
function FormulasCard({ doc, edit, calc, onItem }: { doc: QuoteDoc; edit: Edit; calc?: import('../../lib/api').ItemCalc[]; onItem: (i: number) => void }) {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const K = useKinds()
  const lib = useQuery({ queryKey: ['calcStyle', ws.id], queryFn: () => api<{ formulas?: import('../../lib/api').SavedFormula[] }>(wsPath(ws.id, '/calc-style')) })
  const library = lib.data?.formulas ?? []
  type Row = { key: string; i?: number; name: string; color: string; what: string; expr: string; value?: string }
  const rows: Row[] = []
  doc.items.forEach((it, i) => {
    const c = calc?.[i]
    const base = { i, name: it.name || '—', color: K.colorOf(K.keyOf(it)) }
    if (it.price_formula) rows.push({ ...base, key: `${it.id}p`, what: t('fmPrice'), expr: it.price_formula, value: c?.unit_price != null ? `${money(c.unit_price)} ${it.currency}` : undefined })
    if (!PLAIN_QTY.test(it.quantity)) rows.push({ ...base, key: `${it.id}q`, what: t('fmQuantity'), expr: it.quantity, value: c?.quantity != null ? money(c.quantity) : undefined })
    if (it.with_line) {
      const lead = doc.items.find((x) => x.id === it.with_line)
      rows.push({ ...base, key: `${it.id}w`, what: t('comesWith'), expr: lead?.name ?? '—', value: c ? (c.included && c.amount ? t('fmOn') : t('fmOff')) : undefined })
    }
  })
  recipeOf(doc).forEach((st) => {
    if (st.kind === 'formula' && st.formula) rows.push({ key: st.id, name: st.label || t('step_formula'), color: 'bg-slate-400', what: t('fmStep'), expr: st.formula })
  })
  const addLine = (name: string, formula: string) => {
    edit((d) => { d.items.push({ ...newItem(d.currency, 'other'), name, price_formula: formula, unit_price: '0' }) }, true)
    onItem(doc.items.length)
  }
  return (
    <Section id="formulas" defaultOpen={rows.length > 0} icon={<span className="font-mono text-sm font-semibold">f(x)</span>} title={t('fmTitle')}
      hint={t('fmHint')} summary={rows.length ? t('fmCount', { n: rows.length }) : t('fmNone')}
      actions={<Menu kind="add" label={t('fmAdd')} items={[
        { label: t('fmBlankLine'), onClick: () => addLine(t('fmNewLine'), 'cost_total * 0.03') },
        ...library.map((f) => ({ label: `${f.name} · ${f.formula}`, onClick: () => addLine(f.name, f.formula) })),
      ]} />}>
      {rows.length === 0 ? <p className="text-sm text-slate-500">{t('fmEmpty')}</p> : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" disabled={r.i === undefined} onClick={() => (r.i !== undefined ? onItem(r.i) : document.getElementById('sec-pricing')?.scrollIntoView({ behavior: 'smooth' }))}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-default">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', r.color)} />
                <span className="min-w-[8rem] font-medium text-slate-800">{r.name}</span>
                <span className="text-slate-500">{r.what}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">{r.expr}</code>
                {r.value && <span className="shrink-0 tabular-nums font-medium text-slate-800">{r.value}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <h4 className="text-sm font-semibold text-slate-800">{t('fxLibrary')}</h4>
        {library.length === 0 ? <p className="mt-1 text-sm text-slate-500">{t('fmLibraryEmpty')}</p> : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {library.map((f, k) => (
              <li key={`${f.name}${k}`}>
                <button type="button" onClick={() => addLine(f.name, f.formula)} title={t('fmUseInLine')}
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50">
                  <Plus size={16} className="text-slate-500" /><span className="font-medium">{f.name}</span><code className="font-mono text-xs text-slate-500">{f.formula}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/** The calculation's own named inputs ("crossings = 1 · Armenian border crossings"): lines use them in
 * their quantity or price formulas, and changing one here changes all of them. */
function InputsCard({ doc, edit }: { doc: QuoteDoc; edit: Edit }) {
  const { t } = useI18n()
  const remove = useRemove(edit)
  const addInput = () => edit((d) => {
    const k = 'input'
    let i = 1
    while (`${k}${i}` in d.variables) i++
    d.variables = { ...d.variables, [`${k}${i}`]: '1' }
  }, true)
  const vars = Object.entries(doc.variables)
  const used = (name: string) => doc.items.filter((i) => new RegExp(`\\b${name}\\b`).test(`${i.quantity} ${i.price_formula ?? ''} ${(i.tiers ?? []).map((x) => x.quantity ?? '').join(' ')}`)).length
  const ofMeals = (k: string) => k.startsWith('meals_')   // kept by the meal plan: change them there
  const rename = (from: string, to: string) => edit((d) => {
    const key = to.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!key || key === from || key in d.variables) return
    d.variables = Object.fromEntries(Object.entries(d.variables).map(([k, v]) => [k === from ? key : k, v]))
    const notes = { ...(d.variable_notes ?? {}) }
    if (from in notes) { notes[key] = notes[from]; delete notes[from] }
    d.variable_notes = notes
    const re = new RegExp(`\\b${from}\\b`, 'g')
    d.items.forEach((i) => {   // every formula follows the new name: lines, their group sizes, pricing steps
      i.quantity = i.quantity.replace(re, key)
      if (i.price_formula) i.price_formula = i.price_formula.replace(re, key)
      ;(i.tiers ?? []).forEach((tr) => { if (tr.quantity) tr.quantity = tr.quantity.replace(re, key) })
    })
    ;(d.recipe ?? []).forEach((st) => { if (st.formula) st.formula = st.formula.replace(re, key) })
  })
  return (
    <Section id="inputs" defaultOpen={false} icon={<span className="font-mono text-sm font-semibold">x=</span>} title={t('inputs')} hint={t('inputsHint')}
      summary={vars.length ? vars.map(([k, v]) => `${k} = ${v}`).join(' · ') : t('nothingSet')}
      actions={<Button variant="tertiary" size="sm" onClick={addInput}><Plus size={16} />{t('addInput')}</Button>}>
      {vars.length === 0 && <p className="text-sm text-slate-500">{t('inputsEmpty')}</p>}
      <div className="space-y-2">
        {vars.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
            <Input size="sm" defaultValue={k} onBlur={(e) => rename(k, e.target.value)} className="w-40 font-mono" aria-label={t('name')}
              disabled={ofMeals(k)} title={ofMeals(k) ? t('inputKeptByMeals') : undefined} />
            <span className="text-slate-400">=</span>
            <Input size="sm" type="number" step="any" value={v} onChange={(e) => edit((d) => { d.variables[k] = e.target.value || '0' })} className="w-24 text-right" aria-label={t('value')} />
            <Input size="sm" value={doc.variable_notes?.[k] ?? ''} placeholder={t('variableNote')} className="min-w-0 flex-1"
       onChange={(e) => edit((d) => { d.variable_notes = { ...(d.variable_notes ?? {}), [k]: e.target.value } })} />
            <span className="text-xs text-slate-500">{t('usedInLines', { n: used(k) })}</span>
            {ofMeals(k) ? <span className="text-xs text-slate-500">{t('inputKeptByMeals')}</span>
              : <IconButton size="sm" label={`${t('delete')}: ${k}`} tone="danger" onClick={() => remove((d) => { delete d.variables[k] })}><X size={16} /></IconButton>}
          </div>
        ))}
      </div>
    </Section>
  )
}

/** A step's name: its kind ("Markup") until the agency gives it its own ("Partner markup"). */
function StepName({ value, fallback, onChange }: { value: string; fallback: string; onChange: (v: string) => void }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  if (editing) {
    return <Input size="sm" autoFocus defaultValue={value} placeholder={fallback} onBlur={(e) => { onChange(e.target.value.trim()); setEditing(false) }}
   onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} className="w-44" aria-label={t('name')} />
  }
  return (
    <button type="button" onClick={() => setEditing(true)} title={t('renameStep')} className="group inline-flex items-center gap-1 text-sm font-medium text-slate-800">
      {value || fallback}<Pencil size={12} className="text-slate-300 group-hover:text-slate-500" />
    </button>
  )
}

/** The price, on every tab: the group size being looked at, its price, and what the unsaved edits did to it. */
export function PriceStrip({ doc, result, saved, dirty, wideHidden }: {
  doc: QuoteDoc; result?: QuoteResult; saved?: QuoteResult; dirty: boolean; wideHidden?: boolean
}) {
  const { t } = useI18n()
  const [n, setN] = useSample(doc)
  const row = result?.tiers.find((x) => x.tourists === n)
  const before = saved?.tiers.find((x) => x.tourists === n)
  const delta = dirty && row && before ? row.price_dbl - before.price_dbl : 0
  return (
    <div className={cn('sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur md:-mx-8 md:px-8', wideHidden && 'xl:hidden')}>
      <span className="shrink-0 text-sm font-semibold">{row?.label ?? n}</span>
      <input type="range" min={doc.pax_min} max={doc.pax_max} step={1} value={n} onChange={(e) => setN(Number(e.target.value))}
        className="min-w-[6rem] flex-1 accent-brand-600 sm:max-w-xs" aria-label={t('groupOf')} />
      {row ? <>
        <span className="text-lg font-semibold tabular-nums">{money(row.price_dbl)} <span className="text-sm font-semibold text-slate-500">{doc.currency} · {t('perPersonShort')}</span></span>
        {missingPrices(doc).count > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{t('priceIncomplete', { n: missingPrices(doc).count })}</span>
        )}
        {delta !== 0 && (
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', delta > 0 ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900')} title={t('sinceSaved')}>
            {delta > 0 ? '+' : '−'}{money(Math.abs(delta))} {t('sinceSavedShort')}
          </span>
        )}
        <span className="hidden text-sm text-slate-500 sm:inline">{t('profitGroup')}: <b className="text-emerald-700">{money(row.group_revenue - row.group_cost)}</b></span>
      </> : <span className="text-sm text-slate-500">{result?.errors.length ? t('fixErrorsForPrice') : '…'}</span>}
    </div>
  )
}

