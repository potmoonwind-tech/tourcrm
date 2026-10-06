/**
 * Kinds of cost: the built-in ones (hotel, meal, transport…) plus the agency's own (Flight, Train,
 * Visa, Insurance…), shared by all its calculations. An own kind counts as its `base` in budgets and
 * finance, has its own colour and icon, and a recipe can mark it up on its own. "Travel" kinds are
 * tickets with a journey: legs, class, baggage, taxes on top of each fare, the date to issue them by.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRightLeft, BedDouble, Bus, Camera, Car, FileText, Gift, Plane, Plus, ShieldCheck, Ship, Tag, Ticket, TrainFront, User, Utensils, X, type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Dialog, Menu, toast } from '../../components/overlay'
import { Button, Field, IconButton, Input, SegmentedControl, Select } from '../../components/ui'
import { api, can, type CostKind, type QuoteCategory, type QuoteItem, type TravelInfo, type TravelLeg, type TravelMode } from '../../lib/api'
import { wsPath } from '../../lib/data'
import { useI18n, type TKey } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn } from '../../lib/utils'

export const BUILT_IN: QuoteCategory[] = ['hotel', 'meal', 'transport', 'guide', 'ticket', 'activity', 'tips', 'border', 'other']

export const CAT_COLOR: Record<string, string> = {
  hotel: 'bg-sky-500', meal: 'bg-emerald-500', transport: 'bg-amber-500', guide: 'bg-violet-500',
  ticket: 'bg-pink-500', activity: 'bg-pink-400', tips: 'bg-slate-400', border: 'bg-slate-500', other: 'bg-slate-300',
}
const COLORS: Record<string, string> = {
  blue: 'bg-blue-600', teal: 'bg-teal-500', indigo: 'bg-indigo-500', violet: 'bg-violet-600', emerald: 'bg-emerald-600',
  lime: 'bg-lime-500', orange: 'bg-orange-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500', slate: 'bg-slate-600',
}
export const ICONS: Record<string, LucideIcon> = {
  plane: Plane, train: TrainFront, ship: Ship, bus: Bus, car: Car, ticket: Ticket, file: FileText, shield: ShieldCheck,
  camera: Camera, gift: Gift, tag: Tag,
}
const CAT_ICON: Record<string, LucideIcon> = { hotel: BedDouble, meal: Utensils, transport: Bus, guide: User, ticket: Ticket, activity: Camera }
const MODE_ICON: Record<TravelMode, string> = { flight: 'plane', train: 'train', ferry: 'ship', coach: 'bus', other: 'ticket' }

/** Ready to add: the usual ones an agency needs beyond the built-in kinds. */
const PRESETS: (Omit<CostKind, 'name'> & { key: TKey })[] = [
  { id: 'flight', key: 'kindFlight', base: 'transport', icon: 'plane', color: 'blue', basis: 'per_person', travel: true },
  { id: 'train', key: 'kindTrain', base: 'transport', icon: 'train', color: 'teal', basis: 'per_person', travel: true },
  { id: 'ferry', key: 'kindFerry', base: 'transport', icon: 'ship', color: 'indigo', basis: 'per_person', travel: true },
  { id: 'visa', key: 'kindVisa', base: 'other', icon: 'file', color: 'violet', basis: 'per_person', travel: false },
  { id: 'insurance', key: 'kindInsurance', base: 'other', icon: 'shield', color: 'emerald', basis: 'per_person', travel: false },
]

interface Style { kinds?: CostKind[] }

/** The agency's own kinds, and how to show any line's kind. */
export function useKinds() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const q = useQuery({ queryKey: ['calcStyle', ws.id], queryFn: () => api<Style>(wsPath(ws.id, '/calc-style')) })
  const kinds = q.data?.kinds ?? []
  const byId = Object.fromEntries(kinds.map((k) => [k.id, k]))
  const keyOf = (it: Pick<QuoteItem, 'kind' | 'category'>) => (it.kind && byId[it.kind] ? it.kind : it.category)
  const nameOf = (key: string) => byId[key]?.name ?? t(`qcat_${key}` as TKey)
  const colorOf = (key: string) => (byId[key] ? COLORS[byId[key].color] ?? COLORS.slate : CAT_COLOR[key] ?? CAT_COLOR.other)
  const iconOf = (key: string): LucideIcon | undefined => (byId[key] ? ICONS[byId[key].icon] ?? Tag : CAT_ICON[key])
  return { kinds, byId, keyOf, nameOf, colorOf, iconOf, canManage: can(ws, 'operations') || can(ws, 'sales') }
}

/** A new line of the agency's own kind (a flight starts as a ticket with one empty leg). */
export function kindLine(k: CostKind, line: QuoteItem): QuoteItem {
  return {
    ...line, kind: k.id, category: k.base, name: k.name, basis: k.basis, who: k.basis === 'per_person' ? 'persons' : line.who,
    travel: k.travel ? emptyTravel(k) : null,
  }
}

const emptyLeg = (): TravelLeg => ({ from_place: '', to_place: '', on: null, carrier: '', number: '', depart: '', arrive: '' })
const emptyTravel = (k?: CostKind): TravelInfo => ({
  mode: (Object.entries(MODE_ICON).find(([, i]) => i === k?.icon)?.[0] as TravelMode) ?? 'flight',
  legs: [emptyLeg()], cabin: '', baggage: '', taxes: '0', ticket_by: null,
})

/** "Tbilisi → Yerevan · Yerevan → Tbilisi" */
export const journey = (tr: TravelInfo) => tr.legs.filter((l) => l.from_place || l.to_place).map((l) => `${l.from_place || '?'} → ${l.to_place || '?'}`).join(' · ')

/** Days until the tickets must be issued (negative: late), or null. */
export const daysToTicket = (tr?: TravelInfo | null) =>
  tr?.ticket_by ? Math.ceil((new Date(tr.ticket_by).getTime() - Date.now()) / 86_400_000) : null

// --- managing the kinds ----------------------------------------------------------------------------

const slug = (name: string, taken: Set<string>) => {
  let base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  if (!/^[a-z]/.test(base) || base.length < 2 || BUILT_IN.includes(base as QuoteCategory)) base = `k_${base || Date.now().toString(36)}`.slice(0, 24)
  let id = base, n = 2
  while (taken.has(id)) id = `${base}_${n++}`
  return id
}

export function KindsDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const { kinds } = useKinds()
  const [list, setList] = useState<CostKind[]>(kinds)
  const save = useMutation({
    mutationFn: () => api<Style>(wsPath(ws.id, '/calc-style/kinds'), { method: 'PUT', body: list }),
    onSuccess: (st) => { qc.setQueryData(['calcStyle', ws.id], st); toast('kindsSaved'); onClose() },
  })
  const set = (i: number, patch: Partial<CostKind>) => setList((l) => l.map((k, j) => (j === i ? { ...k, ...patch } : k)))
  const taken = new Set(list.map((k) => k.id))
  const add = (k: CostKind) => setList((l) => [...l, k])
  return (
    <Dialog wide title={t('kindsTitle')} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        <Button disabled={save.isPending || list.some((k) => !k.name.trim())} onClick={() => save.mutate()}>{t('save')}</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('kindsHelp')}</p>
        {list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">{t('kindsEmpty')}</p>}
        <ul className="space-y-2">
          {list.map((k, i) => {
            const Icon = ICONS[k.icon] ?? Tag
            return (
              <li key={k.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded text-white', COLORS[k.color] ?? COLORS.slate)}><Icon size={16} /></span>
                  <Input size="sm" value={k.name} onChange={(e) => set(i, { name: e.target.value })} className="min-w-0 flex-1" aria-label={t('name')} />
                  <IconButton size="sm" tone="danger" label={`${t('delete')}: ${k.name}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}><X size={16} /></IconButton>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-10 text-sm">
                  <label className="flex items-center gap-2 text-slate-600">{t('kindCountsAs')}
                    <Select size="sm" value={k.base} onChange={(e) => set(i, { base: e.target.value as QuoteCategory })} className="w-auto">
                      {BUILT_IN.map((c) => <option key={c} value={c}>{t(`qcat_${c}` as TKey)}</option>)}
                    </Select>
                  </label>
                  <SegmentedControl size="sm" label={t('charged')} value={k.basis === 'group' ? 'group' : 'per_person'}
                    onChange={(b) => set(i, { basis: b })} options={[['per_person', t('chargedPerson')], ['group', t('chargedOnce')]]} />
                  <label className="flex items-center gap-2 text-slate-700">
                    <input type="checkbox" checked={k.travel} onChange={(e) => set(i, { travel: e.target.checked })} className="h-4 w-4 accent-brand-600" />
                    {t('kindIsTravel')}
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-1 pl-10" role="radiogroup" aria-label={t('kindLook')}>
                  {Object.entries(ICONS).map(([name, Ic]) => (
                    <button key={name} type="button" role="radio" aria-checked={k.icon === name} aria-label={name} onClick={() => set(i, { icon: name })}
                      className={cn('flex h-8 w-8 items-center justify-center rounded text-slate-600 hover:bg-slate-100', k.icon === name && 'bg-brand-100 text-brand-800')}>
                      <Ic size={16} />
                    </button>
                  ))}
                  <span className="mx-1 h-5 w-px bg-slate-200" />
                  {Object.entries(COLORS).map(([name, cls]) => (
                    <button key={name} type="button" role="radio" aria-checked={k.color === name} aria-label={name} onClick={() => set(i, { color: name })}
                      className={cn('h-6 w-6 rounded-full ring-offset-2', cls, k.color === name && 'ring-2 ring-brand-600')} />
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
        <Menu kind="add" label={t('addKind')} items={[
          ...PRESETS.filter((p) => !taken.has(p.id)).map(({ key, ...p }) => ({ label: t(key), onClick: () => add({ ...p, name: t(key) }) })),
          { label: t('kindCustom'), icon: <Plus size={16} />, onClick: () => add({ id: slug(t('kindNew'), taken), name: t('kindNew'), base: 'other', icon: 'tag', color: 'slate', basis: 'per_person', travel: false }) },
        ]} />
        <p className="text-xs text-slate-500">{t('kindsDeleteNote')}</p>
      </div>
    </Dialog>
  )
}

// --- a ticket's journey ------------------------------------------------------------------------------

export function TravelEditor({ value, currency, onChange }: { value: TravelInfo; currency: string; onChange: (v: TravelInfo) => void }) {
  const { t } = useI18n()
  const set = (patch: Partial<TravelInfo>) => onChange({ ...value, ...patch })
  const setLeg = (i: number, patch: Partial<TravelLeg>) => set({ legs: value.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  const last = value.legs.at(-1)
  const left = daysToTicket(value)
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-800">{t('journey')}</h3>
        <SegmentedControl size="sm" label={t('journey')} value={value.mode} onChange={(m) => set({ mode: m })}
          options={(['flight', 'train', 'ferry', 'coach'] as TravelMode[]).map((m) => [m, t(`mode_${m}` as TKey)])} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-xs text-slate-500">
            <th className="pb-1 font-medium">{t('legFrom')}</th><th className="pb-1 font-medium">{t('legTo')}</th>
            <th className="w-36 pb-1 font-medium">{t('date')}</th><th className="w-24 pb-1 font-medium">{t('legNumber')}</th>
            <th className="w-20 pb-1 font-medium">{t('legDepart')}</th><th className="w-20 pb-1 font-medium">{t('legArrive')}</th><th className="w-9" />
          </tr></thead>
          <tbody>
            {value.legs.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2"><Input size="sm" value={l.from_place} onChange={(e) => setLeg(i, { from_place: e.target.value })} aria-label={t('legFrom')} placeholder="Tbilisi" /></td>
                <td className="py-1 pr-2"><Input size="sm" value={l.to_place} onChange={(e) => setLeg(i, { to_place: e.target.value })} aria-label={t('legTo')} placeholder="Yerevan" /></td>
                <td className="py-1 pr-2"><Input size="sm" type="date" value={l.on ?? ''} onChange={(e) => setLeg(i, { on: e.target.value || null })} aria-label={t('date')} /></td>
                <td className="py-1 pr-2"><Input size="sm" value={l.number} onChange={(e) => setLeg(i, { number: e.target.value })} aria-label={t('legNumber')} placeholder="A9 123" /></td>
                <td className="py-1 pr-2"><Input size="sm" value={l.depart} maxLength={5} onChange={(e) => setLeg(i, { depart: e.target.value })} aria-label={t('legDepart')} placeholder="10:40" /></td>
                <td className="py-1 pr-2"><Input size="sm" value={l.arrive} maxLength={5} onChange={(e) => setLeg(i, { arrive: e.target.value })} aria-label={t('legArrive')} placeholder="11:45" /></td>
                <td className="py-1">{value.legs.length > 1 && <IconButton size="sm" tone="danger" label={`${t('delete')}: ${l.from_place} → ${l.to_place}`} onClick={() => set({ legs: value.legs.filter((_, j) => j !== i) })}><X size={16} /></IconButton>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button variant="tertiary" size="sm" onClick={() => set({ legs: [...value.legs, { ...emptyLeg(), from_place: last?.to_place ?? '' }] })}><Plus size={16} />{t('addLeg')}</Button>
        {last && (last.from_place || last.to_place) && (
          <Button variant="tertiary" size="sm" onClick={() => set({ legs: [...value.legs, { ...emptyLeg(), from_place: last.to_place, to_place: value.legs[0].from_place, carrier: last.carrier }] })}>
            <ArrowRightLeft size={16} />{t('addReturn')}
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('taxesPerTicket')} info={t('taxesHelp')}>
          <div className="flex">
            <Input type="number" min={0} step="any" value={value.taxes} onChange={(e) => set({ taxes: e.target.value || '0' })} className="rounded-r-none text-right" />
            <span className="flex items-center rounded-r border border-l-0 border-slate-300 bg-slate-50 px-3 text-sm text-slate-500">{currency}</span>
          </div>
        </Field>
        <Field label={t('cabinClass')}><Input value={value.cabin} onChange={(e) => set({ cabin: e.target.value })} placeholder={t('cabinPh')} /></Field>
        <Field label={t('baggage')}><Input value={value.baggage} onChange={(e) => set({ baggage: e.target.value })} placeholder="23 kg + 8 kg" /></Field>
        <Field label={t('ticketBy')} info={t('ticketByHelp')}>
          <Input type="date" value={value.ticket_by ?? ''} onChange={(e) => set({ ticket_by: e.target.value || null })}
            aria-invalid={left !== null && left < 0} />
        </Field>
      </div>
      {left !== null && left <= 14 && (
        <p className={cn('rounded-lg px-3 py-2 text-sm', left < 0 ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900')}>
          {left < 0 ? t('ticketLate', { n: -left }) : t('ticketSoon', { n: left })}
        </p>
      )}
      <p className="text-sm text-slate-500">{t('fareHelp')}</p>
    </div>
  )
}

/** Turn any line into a ticket with a journey, or back. */
export const withTravel = (it: QuoteItem, on: boolean): Partial<QuoteItem> => ({ travel: on ? it.travel ?? emptyTravel() : null })
