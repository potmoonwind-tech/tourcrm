import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CalendarRange, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  api, CODE_DEFAULTS, RATE_KINDS, RATE_KINDS_FOR, SERVICE_CATEGORIES, SERVICE_UNITS,
  type Dish, type RateKind, type Service, type ServiceCategory, type ServiceUnit, type Vendor,
} from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { CURRENCIES } from '../pages/Onboarding'
import { DishesInput } from './QuickAdd'
import { Button, ErrorText, Input, Select } from './ui'

// Inputs hold text; the draft converts to numbers on save.
interface RateDraft { id?: string; valid_from: string; valid_to: string; min_pax: string; max_pax: string; price: string; currency: string; notes: string }
interface ServiceDraft { id?: string; code: RateKind | ''; name: string; category: ServiceCategory; unit: ServiceUnit; notes: string; dishes: Dish[]; is_active: boolean; rates: RateDraft[] }

const toDraft = (s: Service): ServiceDraft => ({
  id: s.id, code: s.code ?? '', name: s.name, category: s.category, unit: s.unit, notes: s.notes, dishes: s.dishes ?? [], is_active: s.is_active,
  rates: s.rates.map((r) => ({
    id: r.id, valid_from: r.valid_from ?? '', valid_to: r.valid_to ?? '', min_pax: r.min_pax?.toString() ?? '',
    max_pax: r.max_pax?.toString() ?? '', price: r.price.toFixed(2), currency: r.currency, notes: r.notes,
  })),
})
const fromDraft = (s: ServiceDraft) => ({
  ...s, code: s.code || null,
  rates: s.rates.map((r) => ({
    ...r, valid_from: r.valid_from || null, valid_to: r.valid_to || null,
    min_pax: r.min_pax ? Number(r.min_pax) : null, max_pax: r.max_pax ? Number(r.max_pax) : null,
  })),
})

// Same rule as the server (app/catalog.py): rows may overlap only if one lies inside the other.
const span = (r: RateDraft) => ({
  d: [r.valid_from || '0000-01-01', r.valid_to || '9999-12-31'] as const,
  p: [Number(r.min_pax) || 0, Number(r.max_pax) || 1e6] as const,
})
const overlap = <T,>(a: readonly [T, T], b: readonly [T, T]) => a[0] <= b[1] && b[0] <= a[1]
const inside = <T,>(a: readonly [T, T], b: readonly [T, T]) => b[0] <= a[0] && a[1] <= b[1]
export function clashing(rates: RateDraft[]): Set<number> {
  const bad = new Set<number>()
  rates.forEach((ra, i) => rates.slice(i + 1).forEach((rb, k) => {
    const a = span(ra), b = span(rb), j = i + 1 + k
    if (!overlap(a.d, b.d) || !overlap(a.p, b.p)) return
    const aInB = inside(a.d, b.d) && inside(a.p, b.p), bInA = inside(b.d, a.d) && inside(b.p, a.p)
    if (aInB === bInA) { bad.add(i); bad.add(j) }
  }))
  return bad
}

/** A vendor's services and their prices by season and group size. */
export function ServicesEditor({ vendor, standalone, onDirtyChange, autoStart, saveRef }: {
  vendor: Vendor; standalone?: boolean; onDirtyChange?: (dirty: boolean) => void
  autoStart?: boolean   // just created: scroll here and have the first price row ready
  // In the supplier drawer: its one Save calls this; no Save button of our own.
  saveRef?: { current: (() => Promise<void>) | null }
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const url = wsPath(ws.id, `/vendors/${vendor.id}/services`)
  const services = useQuery({ queryKey: ['vendorServices', vendor.id], queryFn: () => api<Service[]>(url) })
  const [rows, setRows] = useState<ServiceDraft[] | null>(null)
  useEffect(() => { if (services.data) setRows(services.data.map(toDraft)) }, [services.data])
  const save = useMutation({
    mutationFn: () => api<Service[]>(url, { method: 'PUT', body: rows!.map(fromDraft) }),
    onSuccess: (data) => {
      qc.setQueryData(['vendorServices', vendor.id], data)
      qc.invalidateQueries({ queryKey: ['catalog'] })
      qc.invalidateQueries({ queryKey: ['services'] })
    },
  })
  const isDirty = !!rows && JSON.stringify(rows) !== JSON.stringify(services.data?.map(toDraft))
  useEffect(() => { onDirtyChange?.(isDirty) }, [isDirty, onDirtyChange])
  const [detailed, setDetailed] = useState<Set<string>>(new Set())   // services showing season / size prices
  const [more, setMore] = useState<Set<string>>(new Set())           // services showing name, unit, cost group
  // Just created: bring the price list into view, so the next step is right there.
  const rootRef = useRef<HTMLDivElement>(null)
  const loaded = rows !== null
  useEffect(() => { if (autoStart && loaded) rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [autoStart, loaded])
  if (!rows) return null

  const cur = vendor.currency || ws.base_currency
  const used = new Set(rows.map((r) => r.code).filter(Boolean))
  const dirty = JSON.stringify(rows) !== JSON.stringify(services.data?.map(toDraft))
  const clashes = rows.map((s) => clashing(s.rates))
  const incomplete = rows.some((s) => !s.name.trim() || s.rates.some((r) => r.price === ''))
  if (saveRef) {
    saveRef.current = async () => {
      if (!dirty) return
      if (incomplete) throw new Error(t('pricesIncomplete'))
      if (clashes.some((c) => c.size > 0)) throw new Error(t('priceOverlap'))
      await save.mutateAsync()
    }
  }
  const setSvc = (i: number, patch: Partial<ServiceDraft>) => setRows(rows.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const setRate = (i: number, k: number, patch: Partial<RateDraft>) =>
    setSvc(i, { rates: rows[i].rates.map((r, j) => (j === k ? { ...r, ...patch } : r)) })
  const lastCurrency = () => [...rows].reverse().flatMap((x) => [...x.rates].reverse())[0]?.currency
  const blankRate = (s?: ServiceDraft): RateDraft =>
    ({ valid_from: '', valid_to: '', min_pax: '', max_pax: '', price: '', currency: s?.rates.at(-1)?.currency ?? lastCurrency() ?? cur, notes: '' })
  // What a code means for this kind of supplier: a guide's "per day" is a guide cost, a bus company's is a vehicle per day.
  const defaultsFor = (code: RateKind) => {
    const d = { ...CODE_DEFAULTS[code] }
    if (vendor.type === 'guide' && (code === 'day' || code === 'group')) d.category = 'guide'
    if ((vendor.type === 'transport' || vendor.type === 'driver') && (code === 'day' || code === 'group')) d.category = 'transport'
    if (vendor.type === 'transport' && code === 'day') d.unit = 'vehicle_day'
    if (vendor.type === 'activity') d.category = 'activity'
    return d
  }
  const addService = () => {
    const code = RATE_KINDS_FOR[vendor.type].find((k) => !used.has(k))
    setRows([...rows, {
      code: code ?? '', name: code ? t(`rate_${code}`) : '', notes: '', dishes: [], is_active: true, rates: [blankRate()],
      ...(code ? defaultsFor(code) : { unit: 'person', category: 'other' }),
    }])
  }
  // Season / group-size prices are an extra: shown when used, or when asked for.
  const keyOf = (s: ServiceDraft, i: number) => s.id ?? `new-${i}`
  const isDetailed = (s: ServiceDraft, i: number) =>
    detailed.has(keyOf(s, i)) || s.rates.length > 1 || s.rates.some((r) => r.valid_from || r.valid_to || r.min_pax || r.max_pax)

  // The name follows the code while it is still a code's default label (empty or e.g. "TWN room / night");
  // a name the user typed is kept.
  const pickCode = (i: number, code: RateKind | '') => {
    const name = rows[i].name
    const auto = !name || RATE_KINDS.some((k) => t(`rate_${k}`) === name) || /^(SGL|DBL|TWN|TRP|QUAD) (room|ოთახი)/.test(name)
    setSvc(i, { code, ...(code ? { ...defaultsFor(code), name: auto ? t(`rate_${code}`) : name } : {}) })
  }

  return (
    <div ref={rootRef} className={cn('scroll-mt-4', !standalone && 'mt-6 border-t border-slate-100 pt-5')}>
      <h3 className="font-semibold">{t('servicesPrices')}</h3>
      <p className="mb-3 text-xs text-slate-500">{t('servicesHelp')}</p>
      {rows.length === 0 && (
        <div className={cn('rounded-lg border border-dashed px-4 py-5 text-center', autoStart ? 'border-brand-300 bg-brand-50/60' : 'border-slate-300')}>
          <p className="text-sm text-slate-600">{t('noPricesYet')}</p>
          <Button type="button" size="sm" className="mt-3" onClick={addService}><Plus size={14} />{t('addFirstPrice')}</Button>
        </div>
      )}
      <div className="space-y-3">
        {rows.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-[2] space-y-1">
                <span className="block text-xs font-medium text-slate-500">{t('whatIsIt')}</span>
                <Select value={!s.code && s.category === 'meal' ? '__menu__' : s.code} title={t('systemCodeHelp')}
                  onChange={(e) => e.target.value === '__menu__'
                    ? setSvc(i, { code: '', category: 'meal', unit: 'person', name: RATE_KINDS.some((k) => t(`rate_${k}`) === s.name) ? '' : s.name })
                    : pickCode(i, e.target.value as RateKind | '')}>
                  {(vendor.type === 'restaurant' || vendor.type === 'hotel') && <option value="__menu__">{t('setMenuOption')}</option>}
                  <option value="">{t('ownService')}</option>
                  {RATE_KINDS.filter((k) => k === s.code || RATE_KINDS_FOR[vendor.type].includes(k)).map((k) => <option key={k} value={k} disabled={k !== s.code && used.has(k)}>{t(`rate_${k}`)}</option>)}
                </Select>
              </label>
              {(!s.code || more.has(keyOf(s, i))) && (
                <label className="min-w-40 flex-[2] space-y-1">
                  <span className="block text-xs font-medium text-slate-500">{t('serviceName')}</span>
                  <Input value={s.name} placeholder={t('serviceNamePh')} onChange={(e) => setSvc(i, { name: e.target.value })} />
                </label>
              )}
              {!s.code && (
                <label className="min-w-32 flex-1 space-y-1">
                  <span className="block text-xs font-medium text-slate-500">{t('pricedPer')}</span>
                  <Select value={s.unit} onChange={(e) => setSvc(i, { unit: e.target.value as ServiceUnit })}>
                    {SERVICE_UNITS.map((u) => <option key={u} value={u}>{t(`unit_${u}`)}</option>)}
                  </Select>
                </label>
              )}
              {more.has(keyOf(s, i)) && (
                <>
                  {s.code && (
                    <label className="min-w-32 flex-1 space-y-1">
                      <span className="block text-xs font-medium text-slate-500">{t('pricedPer')}</span>
                      <Select value={s.unit} onChange={(e) => setSvc(i, { unit: e.target.value as ServiceUnit })}>
                        {SERVICE_UNITS.map((u) => <option key={u} value={u}>{t(`unit_${u}`)}</option>)}
                      </Select>
                    </label>
                  )}
                  <label className="min-w-32 flex-1 space-y-1">
                    <span className="block text-xs font-medium text-slate-500">{t('costGroup')}</span>
                    <Select value={s.category} onChange={(e) => setSvc(i, { category: e.target.value as ServiceCategory })}>
                      {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`qcat_${c}`)}</option>)}
                    </Select>
                  </label>
                </>
              )}
              <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t('delete')} title={t('delete')}
                className="ml-auto rounded p-2 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
            </div>

            {s.category === 'meal' && (
              <div className="mt-2">
                <p className="mb-1 text-xs font-medium text-slate-500">{t('dishes')} <span className="font-normal">· {t('dishesHelp')}</span></p>
                <DishesInput value={s.dishes} currency={s.rates[0]?.currency ?? cur} onChange={(dishes) => setSvc(i, { dishes })}
                  onUseSum={s.rates.length <= 1 ? (n) => setSvc(i, { rates: [{ ...(s.rates[0] ?? blankRate(s)), price: n.toFixed(2) }] }) : undefined} />
              </div>
            )}
            {!isDetailed(s, i) ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                {s.rates.slice(0, 1).map((r) => (
                  <div key={r.id ?? 'new'} className="flex items-end gap-2">
                    <label className="space-y-1">
                      <span className="block text-xs font-medium text-slate-500">{t('unitPrice')} · {t(`unit_${s.unit}`)}</span>
                      <Input type="number" step="0.01" min="0" required value={r.price} placeholder="0.00" onChange={(e) => setRate(i, 0, { price: e.target.value })}
                        className="h-9 w-32 text-right" />
                    </label>
                    <Select value={r.currency} onChange={(e) => setRate(i, 0, { currency: e.target.value })} className="h-9 w-24" aria-label={t('currency')}>
                      {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                    </Select>
                  </div>
                ))}
                {s.rates.length === 0 && (
                  <button type="button" onClick={() => setSvc(i, { rates: [blankRate(s)] })} className="text-sm font-medium text-brand-700 hover:underline">{t('addPrice')}</button>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 pb-2 text-xs">
                  <button type="button" onClick={() => setDetailed(new Set(detailed).add(keyOf(s, i)))}
                    className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"><CalendarRange size={13} />{t('priceBySeason')}</button>
                  {!more.has(keyOf(s, i)) && (
                    <button type="button" onClick={() => setMore(new Set(more).add(keyOf(s, i)))} className="font-medium text-slate-500 hover:underline">{t('moreOptions')}</button>
                  )}
                </div>
              </div>
            ) : (
            <>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="py-1 pr-2 text-right font-medium">{t('unitPrice')} · {t(`unit_${s.unit}`)}</th>
                    <th className="py-1 pr-2 font-medium" />
                    <th className="py-1 pr-2 font-medium">{t('season')}</th>
                    <th className="py-1 pr-2 font-medium">{t('groupSize')}</th>
                    <th className="py-1 pr-2 font-medium">{t('note')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {s.rates.map((r, k) => (
                    <tr key={r.id ?? `new-${k}`} className={cn(clashes[i].has(k) && 'bg-red-50')}>
                      <td className="py-1 pr-2">
                        <Input type="number" step="0.01" min="0" value={r.price} onChange={(e) => setRate(i, k, { price: e.target.value })} className="h-8 w-24 px-2 text-right" aria-label={t('unitPrice')} />
                      </td>
                      <td className="py-1 pr-2">
                        <Select value={r.currency} onChange={(e) => setRate(i, k, { currency: e.target.value })} className="h-8 w-20 px-2" aria-label={t('currency')}>
                          {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                        </Select>
                      </td>
                      <td className="py-1 pr-2">
                        <div className="flex items-center gap-1">
                          <Input type="date" value={r.valid_from} onChange={(e) => setRate(i, k, { valid_from: e.target.value })} className="h-8 w-36 px-2" aria-label={t('from')} />
                          <span className="text-slate-400">–</span>
                          <Input type="date" value={r.valid_to} onChange={(e) => setRate(i, k, { valid_to: e.target.value })} className="h-8 w-36 px-2" aria-label={t('to')} />
                        </div>
                        {!r.valid_from && !r.valid_to && <span className="text-xs text-slate-400">{t('allYear')}</span>}
                      </td>
                      <td className="py-1 pr-2">
                        <div className="flex items-center gap-1">
                          <Input type="number" min="1" value={r.min_pax} placeholder="1" onChange={(e) => setRate(i, k, { min_pax: e.target.value })} className="h-8 w-16 px-2" aria-label={t('from')} />
                          <span className="text-slate-400">–</span>
                          <Input type="number" min="1" value={r.max_pax} placeholder="∞" onChange={(e) => setRate(i, k, { max_pax: e.target.value })} className="h-8 w-16 px-2" aria-label={t('to')} />
                        </div>
                      </td>
                      <td className="py-1 pr-2">
                        <Input value={r.notes} placeholder={t('seasonNotePh')} onChange={(e) => setRate(i, k, { notes: e.target.value })} className="h-8 px-2" maxLength={300} aria-label={t('note')} />
                      </td>
                      <td>
                        <button type="button" onClick={() => setSvc(i, { rates: s.rates.filter((_, j) => j !== k) })} aria-label={t('delete')}
                          className="rounded p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {clashes[i].size > 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-red-700"><AlertTriangle size={13} />{t('priceOverlap')}</p>
            )}
            <button type="button" onClick={() => setSvc(i, { rates: [...s.rates, blankRate(s)] })}
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
              <CalendarRange size={13} />{t('addSeason')}
            </button>
            </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        {rows.length > 0 && <Button type="button" size="sm" variant="secondary" onClick={addService}><Plus size={14} />{t('addService')}</Button>}
        <div className="flex-1" />
        {!saveRef && save.isSuccess && !dirty && <span className="text-sm text-emerald-600">{t('saved')}</span>}
        {!saveRef && dirty && (
          <Button type="button" size="sm" disabled={save.isPending || incomplete || clashes.some((c) => c.size > 0)} onClick={() => save.mutate()}>
            {t('save')}
          </Button>
        )}
      </div>
      <ErrorText error={save.error} />
    </div>
  )
}
