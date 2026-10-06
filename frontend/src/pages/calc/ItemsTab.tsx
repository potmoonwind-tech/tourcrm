import { useQuery } from '@tanstack/react-query'
import { ask, Drawer } from '../../components/overlay'
import { AlertTriangle, Copy, Layers, Plus, Trash2, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { VendorSelect } from '../../components/tour'
import { Button, Card, Chip, Field, IconButton, Input, Select } from '../../components/ui'
import { kindLine, KindsDialog, TravelEditor, useKinds, withTravel } from './kinds'
import {
  api, QUOTE_CATEGORIES, VENDOR_TYPES,
  type Breakdown, type ItemCalc, type QuoteBasis, type QuoteCategory, type QuoteDoc, type QuoteItem, type QuoteResult, type QuoteWho,
} from '../../lib/api'
import { useVendors, wsPath } from '../../lib/data'
import { useI18n, type TKey } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn, money } from '../../lib/utils'
import { CURRENCIES } from '../Onboarding'
import { FormulaInput } from './FormulaBuilder'
import { sizeLabel, useSample } from './BuildTab'
import { qtyExpr, qtyMode, sentence, tierText, type QtyMode } from './lineText'

type Edit = (fn: (d: QuoteDoc) => void) => void

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)

export const newItem = (currency: string, category: QuoteCategory = 'other'): QuoteItem => ({
  id: newId(), category, name: '', vendor_id: null, currency, unit_price: '0', quantity: '1', basis: 'group', who: 'persons',
  capacity: null, extra: 0, tiers: [], included: true, vehicle: false, day: null, notes: '',
})

/** Live line amounts for one sample group size, computed by the server from the unsaved doc. */
export function useBreakdown(doc: QuoteDoc, tourists: number, season = '') {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['quoteBreakdown', ws.id, tourists, season, JSON.stringify(doc)],
    queryFn: () => api<Breakdown>(wsPath(ws.id, `/quotes/preview/breakdown?tourists=${tourists}${season ? `&season=${season}` : ''}`), { method: 'POST', body: doc }),
    placeholderData: (prev) => prev, retry: false,
  })
}

export function ItemsTab({ doc, debounced, edit, result }: { doc: QuoteDoc; debounced: QuoteDoc; edit: Edit; result?: QuoteResult }) {
  const { t } = useI18n()
  const [sample, setSample] = useSample(doc)
  const [editing, setEditing] = useState<number | null>(null)
  const n = Math.min(Math.max(sample, doc.pax_min), doc.pax_max)
  const bd = useBreakdown(debounced, n)
  const calc = bd.data?.items
  const sizes = useMemo(() => Array.from({ length: doc.pax_max - doc.pax_min + 1 }, (_, k) => doc.pax_min + k), [doc.pax_min, doc.pax_max])
  // Lines keep their position in the document; the screen groups them by kind (the agency's own too).
  const K = useKinds()
  const [kindsOpen, setKindsOpen] = useState(false)
  const keys = [...QUOTE_CATEGORIES, ...K.kinds.map((k) => k.id)]
  const groups = keys.map((cat) => ({ cat, rows: doc.items.map((it, i) => ({ it, i })).filter((r) => K.keyOf(r.it) === cat) }))
  const total = calc?.reduce((s, c) => s + c.amount, 0) ?? 0
  // The transport plan's lines come after the calculation's own: in the total, so shown too.
  const plan = calc?.slice(doc.items.length) ?? []
  const add = (cat: string) => {
    const own = K.byId[cat]
    edit((d) => { d.items.push(own ? kindLine(own, newItem(d.currency, own.base)) : { ...newItem(d.currency, cat as QuoteCategory), name: K.nameOf(cat) }) })
    setEditing(doc.items.length)
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50/95 px-1 py-2 text-sm backdrop-blur">
        <span className="text-slate-500">{t('sampleGroup')}</span>
        <Select size="sm" value={n} onChange={(e) => setSample(Number(e.target.value))} className="w-28">
          {sizes.map((s) => <option key={s} value={s}>{sizeLabel(doc, s)}</option>)}
        </Select>
        <span className="ml-auto text-slate-500">{t('total')}: <b className="tabular-nums text-slate-900">{money(total, doc.currency)}</b></span>
      </div>

      {groups.filter((g) => g.rows.length > 0).map(({ cat, rows }) => {
        const sub = rows.reduce((s, r) => s + (calc?.[r.i]?.amount ?? 0), 0)
        return (
          <Card key={cat}>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
              <h3 className="flex items-center gap-2 font-semibold"><span className={cn('h-2.5 w-2.5 rounded-sm', K.colorOf(cat))} />{K.nameOf(cat)} <span className="text-sm font-normal text-slate-500">· {t('linesInCategory', { n: rows.length })}</span></h3>
              <span className="text-sm text-slate-500">{t('subtotal')} <b className="tabular-nums text-slate-900">{money(sub)}</b></span>
            </div>
            <ul className="divide-y divide-slate-200">
              {rows.map(({ it, i }) => <LineRow key={i} item={it} calc={calc?.[i]} doc={doc} sample={n}
                onToggle={(v) => edit((d) => { d.items[i].included = v })} onOpen={() => setEditing(i)} />)}
            </ul>
            <div className="px-4 py-2">
              <Button variant="tertiary" size="sm" onClick={() => add(cat)}><Plus size={16} />{t('addItem')}</Button>
            </div>
          </Card>
        )
      })}

      {plan.length > 0 && (
        <Card>
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
            <h3 className="flex items-center gap-2 font-semibold"><span className={cn('h-2.5 w-2.5 rounded-sm', K.colorOf('transport'))} />{t('transportPlanLines')}</h3>
            <span className="text-sm text-slate-500">{t('subtotal')} <b className="tabular-nums text-slate-900">{money(plan.reduce((s, c) => s + c.amount, 0))}</b></span>
          </div>
          <ul className="divide-y divide-slate-200 text-sm">
            {plan.map((c, k) => <li key={k} className="flex justify-between gap-3 px-4 py-2"><span>{c.name}</span><span className="tabular-nums">{money(c.amount)}</span></li>)}
          </ul>
          <p className="px-4 pb-3 text-xs text-slate-500">{t('transportPlanHint')}</p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">{t('addItem')}:</span>
        {keys.filter((c) => c !== 'hotel').map((c) => (
          <Chip key={c} onClick={() => add(c)}>+ {K.nameOf(c)}</Chip>
        ))}
        {K.canManage && <Button variant="tertiary" size="sm" onClick={() => setKindsOpen(true)}>{t('manageKinds')}</Button>}
      </div>
      {kindsOpen && <KindsDialog onClose={() => setKindsOpen(false)} />}

      {editing !== null && doc.items[editing] && (
        <LineEditor doc={doc} index={editing} calc={calc?.[editing]} sample={n} edit={edit} onClose={() => setEditing(null)}
          tourPrice={result?.tiers.find((x) => x.tourists === n)?.price_dbl}
          onDuplicate={() => { edit((d) => { d.items.splice(editing + 1, 0, { ...structuredClone(d.items[editing]), id: newId() }) }); setEditing(editing + 1) }}
          onDelete={() => { edit((d) => { d.items.splice(editing, 1) }); setEditing(null) }} />
      )}
    </div>
  )
}

function LineRow({ item, calc, doc, sample, onToggle, onOpen }: {
  item: QuoteItem; calc?: ItemCalc; doc: QuoteDoc; sample: number; onToggle: (v: boolean) => void; onOpen: () => void
}) {
  const { t } = useI18n()
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', !item.included && 'bg-slate-50')}>
      <input type="checkbox" checked={item.included} onChange={(e) => onToggle(e.target.checked)} title={t('includedInPrice')}
        className="mt-1 h-4 w-4 shrink-0" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-baseline justify-between gap-x-4">
          <span className={cn('font-medium', !item.included && 'text-slate-400 line-through')}>
            {item.day && <span className="mr-1.5 text-xs font-normal text-slate-400">{t('day')} {item.day}</span>}
            {item.name || '—'}
            {item.service_id && <span title={t('fromCatalogHelp')} className="ml-2 rounded-full bg-sky-50 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-sky-700">{t('fromCatalog')}</span>}
          </span>
          <span className={cn('tabular-nums', item.included ? 'font-semibold' : 'text-slate-400')}>
            {calc?.error ? <span className="text-sm font-normal text-red-600">{calc.error}</span>
              : item.included ? money(calc?.amount ?? 0) : t('notIncluded')}
          </span>
        </span>
        <span className="mt-0.5 block text-sm text-slate-500">{calc ? sentence(item, calc, doc, t, sample) : '…'}</span>
        {item.tiers.length > 0 && (
          <span className="mt-1 flex items-start gap-1 text-xs text-slate-400"><Layers size={12} className="mt-0.5 shrink-0" />{tierText(item, t)}</span>
        )}
      </button>
    </li>
  )
}

// --- the rule builder ------------------------------------------------------------------------

function Choice<V extends string>({ value, options, onChange }: { value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label]) => <Chip key={v} on={value === v} onClick={() => onChange(v)}>{label}</Chip>)}
    </div>
  )
}

function Section({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      {children}
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  )
}

export function LineEditor({ doc, index, calc, sample, edit, onClose, onDuplicate, onDelete, tourPrice }: {
  doc: QuoteDoc; index: number; calc?: ItemCalc; sample: number; edit: Edit
  onClose: () => void; onDuplicate: () => void; onDelete: () => void
  tourPrice?: number   // the tour's price per person for the sample group, now (the panel covers the price card)
}) {
  const { t } = useI18n()
  // The price when the panel opened, to show what this line's changes did to it.
  const [startPrice, setStartPrice] = useState(tourPrice)
  if (startPrice == null && tourPrice != null) setStartPrice(tourPrice)
  const vendors = useVendors()
  const it = doc.items[index]
  const set = (patch: Partial<QuoteItem>) => edit((d) => { Object.assign(d.items[index], patch) })
  const { kinds, byId } = useKinds()
  const mode = qtyMode(it.quantity, doc.variables)
  const setMode = (m: QtyMode) => set({ quantity: qtyExpr(m, it.quantity) })
  const varNames = Object.keys(doc.variables)
  const tiered = it.tiers.length > 0
  const tierQty = it.tiers.some((x) => x.quantity)
  const [showTierQty, setShowTierQty] = useState(tierQty)
  const setTier = (i: number, patch: Partial<QuoteItem['tiers'][number]>) => set({ tiers: it.tiers.map((x, j) => (j === i ? { ...x, ...patch } : x)) })

  return (
    <Drawer size="lg" title={it.name || t('newLine')} onClose={onClose}>
      <div className="space-y-5">
        {/* What the line is */}
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem_9rem]">
          <Field label={t('name')}><Input autoFocus={!it.name} value={it.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label={t('costKind')} info={t('costKindHelp')}>
            <Select value={it.kind && byId[it.kind] ? it.kind : it.category} onChange={(e) => {
              const k = byId[e.target.value]
              if (k) set({ kind: k.id, category: k.base, ...(k.travel && !it.travel ? withTravel(it, true) : {}) })
              else set({ kind: null, category: e.target.value as QuoteCategory })
            }}>
              <optgroup label={t('kindsBuiltIn')}>{QUOTE_CATEGORIES.map((k) => <option key={k} value={k}>{t(`qcat_${k}` as TKey)}</option>)}</optgroup>
              {kinds.length > 0 && <optgroup label={t('kindsOwn')}>{kinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</optgroup>}
            </Select>
          </Field>
          <Field label={t('dayWordOne')}>
            <Select value={it.day ?? ''} onChange={(e) => set({ day: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('wholeTrip')}</option>
              {Array.from({ length: Math.max(doc.days, it.day ?? 0) }, (_, k) => <option key={k + 1} value={k + 1}>{t('dayN', { n: k + 1 })}</option>)}
            </Select>
          </Field>
        </div>

        {/* Price */}
        <div className="grid gap-3 sm:grid-cols-[10rem_7rem_1fr]">
          <Field label={it.travel ? t('farePerTicket') : t('unitPrice')}>
            {it.price_formula !== undefined && it.price_formula !== '' ? (
              <span className="flex h-10 items-center rounded-md bg-violet-50 px-2 text-xs text-violet-800">{t('priceByFormula')}</span>
            ) : (
              <Input type="number" step="any" value={it.unit_price} onChange={(e) => set({ unit_price: e.target.value || '0' })} className="text-right" />
            )}
          </Field>
          <Field label={t('currency')}>
            <Select value={it.currency} onChange={(e) => set({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
          <Field label={t('vendor')}>
            <VendorSelect vendors={vendors.data ?? []} types={VENDOR_TYPES} value={it.vendor_id} onChange={(v) => set({ vendor_id: v })} />
          </Field>
        </div>

        {it.travel && <TravelEditor value={it.travel} currency={it.currency} onChange={(v) => set({ travel: v })} />}

        <Field label={t('comesWith')} info={t('comesWithHelp')}>
          <Select value={it.with_line ?? ''} onChange={(e) => set({ with_line: e.target.value || null })}>
            <option value="">{t('comesWithNone')}</option>
            {doc.items.filter((x) => x.id !== it.id).map((x) => (
              <option key={x.id} value={x.id}>{x.day ? `${t('dayN', { n: x.day })} · ` : ''}{x.name || '—'}</option>
            ))}
          </Select>
        </Field>

        {(doc.seasons?.length ?? 0) > 0 && (
          <Section label={t('seasonPrices')} hint={t('seasonPriceHelp')}>
            <div className="flex flex-wrap gap-3">
              {doc.seasons!.map((sn) => (
                <Field key={sn.id} label={sn.name}>
                  <Input type="number" step="any" value={it.season_prices?.[sn.id] ?? ''} placeholder={it.unit_price} className="w-32 text-right"
                    onChange={(e) => edit((d) => {
                      const sp = { ...(d.items[index].season_prices ?? {}) }
                      if (e.target.value === '') delete sp[sn.id]
                      else sp[sn.id] = e.target.value
                      d.items[index].season_prices = sp
                    })} />
                </Field>
              ))}
            </div>
          </Section>
        )}

        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={!!it.travel} className="h-4 w-4 accent-brand-600" onChange={(e) => set(withTravel(it, e.target.checked))} />
          {t('isTicket')}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600" title={t('priceFormulaHelp')}>
          <input type="checkbox" checked={!!it.price_formula} className="h-4 w-4"
            onChange={(e) => set({ price_formula: e.target.checked ? (it.unit_price && it.unit_price !== '0' ? it.unit_price : '0') : '' })} />
          {t('priceIsFormula')}
        </label>
        {!!it.price_formula && (
          <div className="space-y-1">
            <FormulaInput value={it.price_formula} onChange={(v) => set({ price_formula: v || '0' })} doc={doc} sample={sample} placeholder="558 if crossings == 2 else 316" />
          </div>
        )}

        {/* How it's charged */}
        <Section label={t('charged')}>
          <Choice<QuoteBasis> value={it.basis} onChange={(b) => set({ basis: b, capacity: b === 'per_vehicle' ? it.capacity ?? 7 : it.capacity })}
            options={[['group', t('chargedOnce')], ['per_person', t('chargedPerson')], ['per_vehicle', t('chargedVehicle')]]} />
        </Section>
        {it.basis !== 'group' && (
          <Section label={t('countWho')}>
            {it.basis === 'per_person' && Object.keys(it.uses ?? {}).length > 0 && (
              <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">{t('usesOverrideNote')}</p>
            )}
            <Choice<QuoteWho> value={it.who} onChange={(w) => set({ who: w })}
              options={(['tourists', 'persons', 'everyone', 'staff', 'crew'] as const).map((w) => [w, t(`who_${w}` as TKey)])} />
            {it.category === 'meal' && it.basis === 'per_person' && it.who === 'everyone' && (
              <button type="button" title={t('splitStaffTableHelp')} className="text-xs font-medium text-brand-700 hover:underline"
                onClick={() => edit((d) => {
                  // One table becomes two: the tourists', and the leader + driver + guide's (own menu and price).
                  const mine = d.items[index]
                  mine.who = 'tourists'
                  d.items.splice(index + 1, 0, { ...structuredClone(mine), id: newId(), who: 'crew', name: `${mine.name} · ${t('staffTable')}` })
                })}>
                {t('splitStaffTable')}
              </button>
            )}
            {it.basis === 'per_vehicle' && (
              <div className="flex flex-wrap items-end gap-3 pt-1">
                <Field label={t('seatsPerVehicle')}><Input type="number" min={1} value={it.capacity ?? ''} onChange={(e) => set({ capacity: Number(e.target.value) || null })} className="w-28" /></Field>
                <Field label={t('extraSeatsHelp')}><Input type="number" min={0} value={it.extra} onChange={(e) => set({ extra: Number(e.target.value) || 0 })} className="w-28" /></Field>
              </div>
            )}
          </Section>
        )}

        {/* How many times */}
        <Section label={t('howMany')}>
          <Choice<QtyMode['kind']> value={mode.kind}
            onChange={(k) => setMode(k === 'number' ? { kind: 'number', n: '2' } : k === 'variable' ? { kind: 'variable', name: varNames[0] ?? '' } : k === 'formula' ? { kind: 'formula' } : { kind: k })}
            options={[['once', t('hmOnce')], ['days', `${t('hmDays')} (${doc.days})`], ['nights', t('hmNights')], ['number', t('hmNumber')],
              ...(varNames.length ? [['variable', t('hmVariable')] as ['variable', string]] : []), ['formula', t('hmFormula')]]} />
          {mode.kind === 'number' && (
            <Input type="number" min={0} step="any" value={mode.n} onChange={(e) => setMode({ kind: 'number', n: e.target.value })} className="w-32" />
          )}
          {mode.kind === 'variable' && (
            <Select value={mode.name} onChange={(e) => setMode({ kind: 'variable', name: e.target.value })} className="max-w-md">
              {varNames.map((v) => <option key={v} value={v}>{doc.variable_notes?.[v] ? `${doc.variable_notes[v]} (${v} = ${doc.variables[v]})` : `${v} = ${doc.variables[v]}`}</option>)}
            </Select>
          )}
          {mode.kind === 'formula' && (
            <FormulaInput value={it.quantity} onChange={(v) => set({ quantity: v })} doc={doc} sample={sample} />
          )}
        </Section>

        {/* Group-size prices */}
        <Section label={t('byGroupSize')} hint={tiered ? t('byGroupSizeHelp') : undefined}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={tiered} className="h-4 w-4"
              onChange={(e) => set({ tiers: e.target.checked ? [{ max_pax: 12, unit_price: it.unit_price, quantity: null, label: '' }, { max_pax: doc.pax_max, unit_price: it.unit_price, quantity: null, label: '' }] : [] })} />
            {t('byGroupSize')}
          </label>
          {tiered && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">{t('tierUpTo')} · {t('unitPrice')}{showTierQty ? ` · ${t('quantity')}` : ''} · {t('vehicleName')}</p>
              {it.tiers.map((x, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input type="number" min={1} value={x.max_pax} onChange={(e) => setTier(i, { max_pax: Number(e.target.value) || 1 })} className="w-20" />
                  <Input type="number" step="any" placeholder={it.unit_price} value={x.unit_price ?? ''} onChange={(e) => setTier(i, { unit_price: e.target.value === '' ? null : e.target.value })} className="w-28 text-right" />
                  <span className="text-sm text-slate-500">{it.currency}</span>
                  {showTierQty && (
                    <div className="w-full sm:w-72">
                      <FormulaInput compact value={x.quantity ?? ''} placeholder={it.quantity} doc={doc} sample={Math.min(x.max_pax, doc.pax_max)}
                        onChange={(v) => setTier(i, { quantity: v || null })} />
                    </div>
                  )}
                  <Input placeholder={t('vehicleName')} value={x.label} onChange={(e) => setTier(i, { label: e.target.value })} className="w-44" />
                  <IconButton label={t('remove')} tone="danger" onClick={() => set({ tiers: it.tiers.filter((_, j) => j !== i) })}><X size={16} /></IconButton>
                </div>
              ))}
              <div className="flex flex-wrap gap-4 text-sm">
                <button type="button" className="text-brand-600 hover:underline"
                  onClick={() => set({ tiers: [...it.tiers, { max_pax: (it.tiers.at(-1)?.max_pax ?? 0) + 5, unit_price: it.unit_price, quantity: null, label: '' }] })}>+ {t('addTier')}</button>
                {!showTierQty && <button type="button" className="text-slate-500 hover:underline" onClick={() => setShowTierQty(true)}>{t('qtyBySize')}</button>}
                <label className="flex items-center gap-2"><input type="checkbox" checked={it.vehicle} onChange={(e) => set({ vehicle: e.target.checked })} />{t('showAsVehicle')}</label>
              </div>
            </div>
          )}
        </Section>

        <Field label={t('notes')}><Input value={it.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>

        {/* Live result for the sample group */}
        <div className={cn('rounded-lg px-4 py-3', calc?.error ? 'bg-red-50 text-red-800' : 'bg-brand-50')}>
          <p className="text-xs font-medium text-slate-500">{t('result')} · {sizeLabel(doc, sample)}</p>
          {calc?.error
            ? <p className="mt-1 flex items-center gap-2"><AlertTriangle size={16} />{calc.error}</p>
            : <p className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-slate-600">{calc ? sentence(it, calc, doc, t, sample) : '…'}</span>
                <span className="text-lg font-semibold tabular-nums text-brand-700">{money(calc?.amount ?? 0, doc.currency)}</span>
              </p>}
          {tourPrice != null && (
            <p className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-brand-100 pt-2 text-sm">
              <span className="text-slate-600">{t('tourPricePp')}</span>
              <span className="tabular-nums font-semibold text-slate-800">
                {startPrice != null && startPrice !== tourPrice && <>
                  <span className="font-normal text-slate-400 line-through">{money(startPrice)}</span>{' → '}
                </>}
                {money(tourPrice, doc.currency)}
                {startPrice != null && startPrice !== tourPrice && (
                  <span className={cn('ml-2 rounded px-1.5 text-xs', tourPrice > startPrice ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800')}>
                    {tourPrice > startPrice ? '+' : '−'}{money(Math.abs(tourPrice - startPrice))}
                  </span>
                )}
              </span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={it.included} onChange={(e) => set({ included: e.target.checked, ...(e.target.checked ? { optional: false } : {}) })} className="h-4 w-4" />{t('includedInPrice')}</label>
          <label className="flex items-center gap-2 text-sm" title={t('freeLineHelp')}>
            <input type="checkbox" checked={!!it.free} onChange={(e) => set({ free: e.target.checked, ...(e.target.checked ? { unit_price: '0', price_formula: '' } : {}) })} className="h-4 w-4" />{t('freeLine')}
          </label>
          <label className="flex items-center gap-2 text-sm" title={t('standardLineHelp')}>
            <input type="checkbox" checked={!!it.standard} onChange={(e) => set({ standard: e.target.checked })} className="h-4 w-4" />{t('standardLine')}
          </label>
          {!it.included && (
            <label className="flex items-center gap-2 text-sm" title={t('optionalExtraHelp')}>
              <input type="checkbox" checked={!!it.optional} onChange={(e) => set({ optional: e.target.checked })} className="h-4 w-4" />{t('optionalExtra')}
            </label>
          )}
          <div className="flex-1" />
          <Button variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmDeleteLine', { name: it.name || '—' }), danger: true, confirmLabel: t('delete') }).then((ok) => ok && onDelete())}><Trash2 size={16} />{t('delete')}</Button>
          <Button variant="secondary" onClick={onDuplicate}><Copy size={16} />{t('duplicate')}</Button>
          <Button onClick={onClose}>{t('done')}</Button>
        </div>
      </div>
    </Drawer>
  )
}
