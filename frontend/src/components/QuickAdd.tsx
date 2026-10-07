/**
 * "+ Add new" from wherever something is picked (an itinerary slot, a palette, a
 * services list): a short dialog creates the hotel, restaurant, service or set menu
 * and hands it back, so nobody has to leave what they were doing.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { api, VENDOR_TYPES, type Client, type Dish, type Service, type ServiceCategory, type ServiceUnit, type Vendor, type VendorType } from '../lib/api'
import { useServiceList, useVendors, wsPath } from '../lib/data'
import { nextMenuName } from '../lib/menus'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { CURRENCIES } from '../pages/Onboarding'
import { Dialog } from './overlay'
import { VendorSelect } from './tour'
import { Button, ErrorText, Field, Input, Select } from './ui'

export function QuickVendorDialog({ type, city, onCreated, onClose }: {
  type: VendorType; city?: string; onCreated: (v: Vendor) => void; onClose: () => void
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [f, setF] = useState({ name: '', type, city: city ?? '', phone: '' })
  const create = useMutation({
    mutationFn: () => api<Vendor>(wsPath(ws.id, '/vendors'), { method: 'POST', body: f }),
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ['vendors', ws.id] }); onCreated(v); onClose() },
  })
  return (
    <Dialog title={t('addNewOfType', { type: t(`vendorType_${f.type}`) })} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="space-y-4">
        <Field label={t('name')}><Input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('type')}>
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as VendorType })}>
              {VENDOR_TYPES.map((x) => <option key={x} value={x}>{t(`vendorType_${x}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('city')}><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        </div>
        <Field label={t('phone')}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <p className="text-xs text-slate-500">{t('quickAddHelp')}</p>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={create.isPending}>{t('create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

export function QuickClientDialog({ onCreated, onClose }: { onCreated: (c: Client) => void; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [f, setF] = useState({ name: '', type: 'agency' as Client['type'], country: '', email: '' })
  const create = useMutation({
    mutationFn: () => api<Client>(wsPath(ws.id, '/clients'), { method: 'POST', body: f }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['clients', ws.id] }); onCreated(c); onClose() },
  })
  return (
    <Dialog top title={t('newClient')} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="space-y-4">
        <Field label={t('name')}><Input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('type')}>
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Client['type'] })}>
              <option value="agency">{t('clientType_agency')}</option>
              <option value="direct">{t('clientType_direct')}</option>
            </Select>
          </Field>
          <Field label={t('country')}><Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} /></Field>
        </div>
        <Field label={t('email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <p className="text-xs text-slate-500">{t('quickAddHelp')}</p>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={create.isPending}>{t('create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Sum of the dish prices, when every dish has one. */
export const dishSum = (ds: Dish[]) => (ds.length && ds.every((d) => d.price !== null) ? ds.reduce((a, d) => a + (d.price ?? 0), 0) : null)

/**
 * Dishes as chips, each with an optional price per person: type a dish and press
 * Enter (or a comma). Below: the sum, and a button to use it as the menu price.
 */
export function DishesInput({ value, onChange, disabled, currency, onUseSum }: {
  value: Dish[]; onChange: (v: Dish[]) => void; disabled?: boolean; currency?: string; onUseSum?: (sum: number) => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const add = () => {
    const parts = text.split(',').map((x) => x.trim()).filter(Boolean)
    const next = [...value]
    for (const p of parts) if (!next.some((x) => x.name.toLowerCase() === p.toLowerCase())) next.push({ name: p, price: null })
    onChange(next)
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
  }
  const sum = dishSum(value)
  const priced = value.filter((d) => d.price !== null).length
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5">
        {value.map((d, i) => (
          <span key={d.name} className="inline-flex items-center gap-1 rounded-full bg-amber-50 py-0.5 pr-1.5 pl-2 text-xs text-amber-900">
            {d.name}
            <input type="number" min="0" step="0.01" disabled={disabled} value={d.price ?? ''} placeholder={t('price')}
              aria-label={t('dishPriceOf', { dish: d.name })} title={t('dishPriceHelp')}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, price: e.target.value === '' ? null : Number(e.target.value) } : x)))}
              className="h-5 w-16 rounded border border-amber-200 bg-white px-1 text-right tabular-nums" />
            <select disabled={disabled} value={d.per_plate ?? ''} aria-label={t('dishShareOf', { dish: d.name })} title={t('dishShareHelp')}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, per_plate: e.target.value === '' ? null : Number(e.target.value) } : x)))}
              className="h-5 rounded border border-amber-200 bg-white px-0.5 text-[11px]">
              <option value="">{t('dishShareUsual')}</option>
              {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n === 1 ? t('dishShareOwn') : `1/${n}`}</option>)}
            </select>
            {!disabled && <button type="button" aria-label={t('delete')} onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={11} /></button>}
          </span>
        ))}
        {!disabled && (
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => text.trim() && add()}
            placeholder={value.length ? t('addDishPh') : t('dishesPh')} className="min-w-32 flex-1 bg-transparent text-sm outline-none" />
        )}
      </div>
      {value.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {sum !== null
            ? <span>{t('dishSum')}: <b className="font-semibold text-slate-700 tabular-nums">{sum.toFixed(2)} {currency}</b></span>
            : <span>{t('dishesPriced', { n: priced, total: value.length })}</span>}
          {sum !== null && onUseSum && !disabled && (
            <button type="button" onClick={() => onUseSum(sum)} className="font-medium text-brand-700 hover:underline">{t('useSumAsPrice')}</button>
          )}
        </p>
      )}
    </div>
  )
}

/** A new service (or a set menu) for a vendor: appended to the vendor's services. */
export function QuickServiceDialog({ vendorId, category = 'other', menu, meal, onCreated, onClose }: {
  vendorId?: string; category?: ServiceCategory; menu?: boolean; onCreated: (s: Service) => void; onClose: () => void
  meal?: 'breakfast' | 'lunch' | 'dinner'     // a menu for this meal: named "Restaurant · Lunch 1"
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const vendors = useVendors()
  const [f, setF] = useState({
    vendor_id: vendorId ?? null as string | null, name: '', category: menu ? 'meal' as ServiceCategory : category,
    unit: 'person' as ServiceUnit, price: '', currency: ws.base_currency, dishes: [] as Dish[],
  })
  // A menu's name is made for you ("Barbarestan · Lunch 2") until you type your own.
  const all = useServiceList()
  const [typed, setTyped] = useState(false)
  const place = vendors.data?.find((v) => v.id === f.vendor_id)
  const auto = menu && place
    ? nextMenuName(place.name, t(meal ?? 'menu'), (all.data ?? []).filter((x) => x.vendor.id === place.id).map((x) => x.name)) : ''
  const name = typed ? f.name : f.name || auto
  const create = useMutation({
    mutationFn: async () => {
      const url = wsPath(ws.id, `/vendors/${f.vendor_id}/services`)
      const existing = await api<Service[]>(url)
      const mine = { code: null, name, category: f.category, unit: f.unit, notes: '', dishes: f.dishes, is_active: true,
        rates: f.price ? [{ valid_from: null, valid_to: null, min_pax: null, max_pax: null, price: Number(f.price), currency: f.currency, notes: '' }] : [] }
      const saved = await api<Service[]>(url, { method: 'PUT', body: [...existing, mine] })
      return saved.find((s) => s.name === name && !existing.some((e) => e.id === s.id))!
    },
    onSuccess: (s) => {
      for (const k of ['services', 'vendorServices', 'catalog']) qc.invalidateQueries({ queryKey: [k] })
      onCreated(s); onClose()
    },
  })
  return (
    <Dialog title={menu ? t('newMenu') : t('newService')} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="space-y-4">
        {!vendorId && (
          <Field label={t('vendor')}>
            <VendorSelect vendors={vendors.data ?? []} types={VENDOR_TYPES} value={f.vendor_id} onChange={(v) => setF({ ...f, vendor_id: v })} />
          </Field>
        )}
        <Field label={menu ? t('menuName') : t('serviceName')}>
          <Input required autoFocus value={name} onChange={(e) => { setTyped(true); setF({ ...f, name: e.target.value }) }} placeholder={menu ? t('menuNamePh') : ''} />
        </Field>
        {menu && <Field label={t('dishes')} hint={t('dishesHelp')}><DishesInput value={f.dishes} currency={f.currency} onChange={(dishes) => setF({ ...f, dishes })} onUseSum={(n) => setF({ ...f, price: n.toFixed(2) })} /></Field>}
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label={menu ? t('pricePerPerson') : t('unitPrice')}>
            <Input type="number" min="0" step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
          </Field>
          <Field label={t('currency')}>
            <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
        </div>
        <p className="text-xs text-slate-500">{t('quickServiceHelp')}</p>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={create.isPending || !f.vendor_id}>{t('create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
