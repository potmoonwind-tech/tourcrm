import { ACTIVITY_CATS, catLabel, catOf, ownCats } from '../lib/activities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SetupNudge } from '../components/GetStarted'
import { Drawer, ask, askText, useGuardedClose, useUnsaved, toast } from '../components/overlay'
import { ChevronDown, Landmark, Plus, Search, ChefHat } from 'lucide-react'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { PaymentTermsEditor } from '../components/PaymentTermsEditor'
import { ScaleEditor } from '../components/ScaleEditor'
import { GuideInfo } from '../components/GuideInfo'
import { MenuBuilder } from '../components/MenuBuilder'
import { ServicesEditor } from '../components/ServicesEditor'
import { EmptyState, Phone } from '../components/tour'
import { Button, ButtonLink, ErrorText, Field, field, Input, Select } from '../components/ui'
import { addressOf, PlaceInput, pinPlace, type PlaceSuggestion } from '../components/PlaceInput'
import { QuickVendorDialog } from '../components/QuickAdd'
import {
  api, VENDOR_TYPES,
  type Client, type Vendor, type VendorType, can } from '../lib/api'
import { useClients, useOpenFromUrl, useVendors, wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { CURRENCIES } from './Onboarding'
import { PageHeader } from './Dashboard'

const TYPE_STYLE: Record<VendorType, string> = {
  hotel: 'bg-indigo-100 text-indigo-800',
  restaurant: 'bg-orange-100 text-orange-800',
  transport: 'bg-sky-100 text-sky-800',
  guide: 'bg-emerald-100 text-emerald-800',
  driver: 'bg-teal-100 text-teal-800',
  activity: 'bg-violet-100 text-violet-800',
  airline: 'bg-blue-100 text-blue-800',
  rail: 'bg-cyan-100 text-cyan-800',
  other: 'bg-slate-200 text-slate-700',
}

function TypePill({ type }: { type: VendorType }) {
  const { t } = useI18n()
  return <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold', TYPE_STYLE[type])}>{t(`vendorType_${type}`)}</span>
}

const matches = (q: string, ...fields: string[]) => {
  const s = q.trim().toLowerCase()
  return !s || fields.some((f) => f.toLowerCase().includes(s))
}

// --- vendors ---------------------------------------------------------------------

export function VendorsPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [showInactive, setShowInactive] = useState(false)
  const vendors = useVendors(showInactive)
  const [type, setType] = useState<VendorType | ''>('')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null)
  useOpenFromUrl(vendors.data, setEditing)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const canEdit = can(ws, 'operations')   // suppliers and all their prices

  const all = vendors.data ?? []
  const [cat, setCat] = useState('')
  const rows = all.filter((v) => (!type || v.type === type) && (type !== 'activity' || !cat || v.category === cat)
    && matches(q, v.name, v.city, v.contact_person, v.phone))
  const cats = [...new Set(all.filter((v) => v.type === 'activity' && v.category).map((v) => v.category!))]
  const counts = Object.fromEntries(VENDOR_TYPES.map((ty) => [ty, all.filter((v) => v.type === ty).length]))

  return (
    <>
      <PageHeader section="catalog" title={t('catalog')} subtitle={t('vendorsHelp')}
        action={canEdit && <Button onClick={() => setEditing('new')}><Plus size={16} />{t('newVendor')}</Button>} />
      <div className="space-y-4 p-4 md:p-8">
        <SetupNudge step="vendors" />
        {canEdit && <SightsFromRoutes />}
        <div className="flex flex-wrap gap-2">
          <FilterChip active={!type} onClick={() => setType('')}>{t('all')} · {all.length}</FilterChip>
          {VENDOR_TYPES.filter((ty) => counts[ty]).map((ty) => (
            <FilterChip key={ty} active={type === ty} onClick={() => setType(ty)}>{t(`vendorType_${ty}`)} · {counts[ty]}</FilterChip>
          ))}
        </div>
        {type === 'activity' && cats.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label={t('activityCategory')}>
            <FilterChip active={!cat} onClick={() => setCat('')}>{t('all')}</FilterChip>
            {cats.map((c) => {
              const k = catOf(c)!
              return (
                <FilterChip key={c} active={cat === c} onClick={() => setCat(c)}>
                  <span className="inline-flex items-center gap-1"><k.icon size={13} aria-hidden />{catLabel(t, c)} · {all.filter((v) => v.type === 'activity' && v.category === c).length}</span>
                </FilterChip>
              )
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1">
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="pl-9" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{t('showInactive')}
          </label>
        </div>
        {vendors.isSuccess && all.length === 0 ? (
          <EmptyState title={t('emptyVendors')} hint={t('emptyVendorsHint')} action={canEdit && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setEditing('new')}><Plus size={16} />{t('newVendor')}</Button>
              <ButtonLink to="../settings/import" relative="path">{t('importFromExcel')}</ButtonLink>
            </div>
          )} />
        ) : vendors.isSuccess && rows.length === 0 ? <EmptyState title={t('noMatch')} hint={t('noMatchHint')} /> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('name')}</th><th className="px-4 py-3">{t('type')}</th>
                  <th className="px-4 py-3">{t('city')}</th><th className="px-4 py-3">{t('contactPerson')}</th>
                  <th className="px-4 py-3">{t('phone')}</th><th className="px-4 py-3">{t('paymentTerms')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((v) => (
                  <tr key={v.id} onClick={() => setEditing(v)} className={cn('cursor-pointer hover:bg-slate-50', !v.is_active && 'opacity-50')}>
                    <td className="px-4 py-3 font-medium">
                      {v.name}
                      {v.company_id && <span className="block text-xs font-normal text-slate-600">{all.find((c) => c.id === v.company_id)?.name}</span>}
                    </td>
                    <td className="px-4 py-3"><TypePill type={v.type} />
                      {v.category && <span className="mt-1 block text-xs text-slate-500">{catLabel(t, v.category)}</span>}</td>
                    <td className="px-4 py-3 text-slate-600">{v.city}</td>
                    <td className="px-4 py-3 text-slate-600">{v.contact_person}</td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><Phone phone={v.phone} /></td>
                    <td className="px-4 py-3 text-slate-600">{v.payment_days} {t(`pay_${v.payment_timing}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <VendorModal key={editing === 'new' ? 'new' : editing.id} vendor={editing === 'new' ? null : editing} defaultType={type || 'hotel'}
        canEdit={canEdit} onClose={() => { setEditing(null); setCreatedId(null) }} onCreated={(v) => { setCreatedId(v.id); setEditing(v) }}
        justCreated={editing !== 'new' && editing.id === createdId} />}
    </>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('rounded-full border px-3 py-1 text-sm font-medium',
      active ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
      {children}
    </button>
  )
}

function useCrud<T>(collection: 'vendors' | 'clients', item: T & { id: string } | null, onClose: () => void, onCreated?: (x: T & { id: string }) => void) {
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const done = () => { qc.invalidateQueries({ queryKey: [collection, ws.id] }); onClose() }
  const save = useMutation({
    mutationFn: (body: Partial<T>) => item
      ? api<T & { id: string }>(wsPath(ws.id, `/${collection}/${item.id}`), { method: 'PATCH', body })
      : api<T & { id: string }>(wsPath(ws.id, `/${collection}`), { method: 'POST', body }),
    onSuccess: (x) => {
      if (!item && onCreated) { qc.invalidateQueries({ queryKey: [collection, ws.id] }); onCreated(x) } else done()
    },
  })
  const remove = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/${collection}/${item!.id}`), { method: 'DELETE' }),
    onSuccess: done,
  })
  return { save, remove }
}

function VendorModal({ vendor, defaultType, canEdit, onClose: close, onCreated, justCreated }: {
  vendor: Vendor | null; defaultType: VendorType; canEdit: boolean; onClose: () => void; onCreated: (v: Vendor) => void
  justCreated?: boolean
}) {
  const { t } = useI18n()
  const [pricesDirty, setPricesDirty] = useState(false)
  const [building, setBuilding] = useState(false)
  const onClose = () => {
    if (!pricesDirty) return close()
    void ask({ title: t('unsavedPrices'), message: t('unsavedPricesMsg'), confirmLabel: t('discard'), danger: true }).then((ok) => ok && close())
  }
  const [f, setF] = useState(() => ({
    name: vendor?.name ?? '', type: vendor?.type ?? defaultType, city: vendor?.city ?? '', address: vendor?.address ?? '',
    contact_person: vendor?.contact_person ?? '', phone: vendor?.phone ?? '', phone2: vendor?.phone2 ?? '',
    email: vendor?.email ?? '', payment_timing: vendor?.payment_timing ?? 'after',
    payment_days: String(vendor?.payment_days ?? 0), currency: vendor?.currency ?? '', notes: vendor?.notes ?? '',
    is_active: vendor?.is_active ?? true, cancel_terms: vendor?.cancel_terms ?? [],
    languages: vendor?.languages ?? [], unavailable: vendor?.unavailable ?? [],
    vat_invoice: vendor?.vat_invoice ?? false,
    visit_minutes: vendor?.visit_minutes != null ? String(vendor.visit_minutes) : '',
    company_id: vendor?.company_id ?? '',
    category: vendor?.category ?? '',
  }))
  const allVendors = useVendors().data ?? []
  const companies = allVendors.filter((v) => (v.type === 'transport' || v.type === 'other') && v.id !== vendor?.id)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  // A place picked from the map: its address and town are filled in, and the address is fixed to that
  // exact spot, so day programmes drive there (two places in one city get their own drive).
  const placePicked = (asName: boolean) => (p: PlaceSuggestion) => {
    const address = addressOf(p)
    setF((cur) => ({ ...cur, ...(asName ? { name: p.name } : {}), address, city: p.city || cur.city }))
    void pinPlace(ws.id, address, p).catch(() => undefined)
  }
  const { save, remove } = useCrud<Vendor>('vendors', vendor, onClose, onCreated)
  const formDirty = useUnsaved(f)
  const guarded = useGuardedClose(canEdit && (formDirty || pricesDirty), close)
  const ws = useWorkspace()!
  // Open when this supplier already has any of the extra details filled in.
  const [moreOpen, setMoreOpen] = useState(() => !!vendor && !!(vendor.contact_person || vendor.email || vendor.phone2 || vendor.notes
    || vendor.payment_days || vendor.cancel_terms?.length || !vendor.is_active))
  // One Save for the whole drawer: the prices first (they may be incomplete), then the details.
  const pricesSave = useRef<(() => Promise<void>) | null>(null)
  const [pricesError, setPricesError] = useState<unknown>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setPricesError(null)
    try { await pricesSave.current?.() } catch (err) { setPricesError(err); return }
    save.mutate({ ...f, payment_days: Number(f.payment_days) || 0, visit_minutes: f.visit_minutes ? Number(f.visit_minutes) : null,
      company_id: ['driver', 'guide'].includes(f.type) ? f.company_id || null : null } as unknown as Partial<Vendor>)
  }
  return (
    <Drawer size="lg" title={vendor ? vendor.name : t('newVendor')} onClose={guarded}
      footer={canEdit && (
        <div className="w-full space-y-2">
          <ErrorText error={pricesError || save.error || remove.error} />
          <ModalActions isNew={!vendor} busy={save.isPending} onDelete={() => remove.mutate()} onClose={guarded} formId="vendor-form" />
        </div>
      )}>
      <form id="vendor-form" onSubmit={submit} className="space-y-4">
        <fieldset disabled={!canEdit} className="space-y-4">
          <Field label={t('name')} hint={PLACE_TYPES.includes(f.type) ? t('vendorNamePlaceHint') : undefined}>
            {PLACE_TYPES.includes(f.type) ? (
              // A hotel, restaurant or sight: suggested from the map; picking one fills its address and city.
              <PlaceInput required autoFocus value={f.name} maxLength={200} onChange={(name) => setF({ ...f, name })}
                onPicked={placePicked(true)} className={cn(field, 'w-full')} aria-label={t('name')} />
            ) : <Input required autoFocus value={f.name} onChange={set('name')} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('type')}>
              <Select value={f.type} onChange={set('type')}>
                {VENDOR_TYPES.map((ty) => <option key={ty} value={ty}>{t(`vendorType_${ty}`)}</option>)}
              </Select>
            </Field>
            <Field label={t('city')}>
              <PlaceInput value={f.city} onChange={(city) => setF({ ...f, city })} className={cn(field, 'w-full')} aria-label={t('city')} />
            </Field>
          </div>
          {['guide', 'driver'].includes(f.type) && (
            <Field label={t('worksFor')} hint={t(f.type === 'driver' ? 'worksForDriverHint' : 'worksForGuideHint')}>
              <Select value={f.company_id} onChange={set('company_id')}>
                <option value="">{t('worksForNone')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
          {['guide', 'driver'].includes(f.type) && (
            <GuideInfo languages={f.languages} away={f.unavailable} disabled={!canEdit} onChange={(patch) => setF({ ...f, ...patch })} />
          )}
          {['hotel', 'restaurant', 'activity', 'other'].includes(f.type) && (
            <Field label={t('address')} hint={t('addressPickHint')}>
              <PlaceInput value={f.address} maxLength={300} onChange={(address) => setF({ ...f, address })}
                onPicked={placePicked(false)} className={cn(field, 'w-full')} aria-label={t('address')} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('phone')}><Input value={f.phone} onChange={set('phone')} /></Field>
            <Field label={t('currency')} hint={t('supplierCurrencyHelp')}>
              <Select value={f.currency} onChange={set('currency')}>
                <option value="">{t('defaultCurrency')} ({ws.base_currency})</option>
                {CURRENCIES.filter((c) => c !== ws.base_currency).map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
          </div>
          {['activity', 'other'].includes(f.type) && (
            <Field label={t('activityCategory')} hint={t('activityCategoryHint')}>
              <Select value={f.category} disabled={!canEdit} className="w-64" onChange={async (e) => {
                if (e.target.value !== '__new__') { setF({ ...f, category: e.target.value }); return }
                const own = await askText({ title: t('activityCategoryNew'), confirmLabel: t('save'), input: { placeholder: t('activityCategoryNewPh'), required: true } })
                if (own?.trim()) setF({ ...f, category: own.trim().slice(0, 40) })
              }}>
                <option value="">{t('activityCategoryNone')}</option>
                {ACTIVITY_CATS.map((c) => <option key={c.key} value={c.key}>{t(`actCat_${c.key}` as TKey)}</option>)}
                {ownCats(allVendors).map((c) => <option key={c} value={c}>{c}</option>)}
                {f.category && !ACTIVITY_CATS.some((c) => c.key === f.category) && !ownCats(allVendors).includes(f.category) && <option value={f.category}>{f.category}</option>}
                <option value="__new__">{t('activityCategoryAdd')}</option>
              </Select>
            </Field>
          )}
          {['activity', 'other'].includes(f.type) && (
            <Field label={t('visitLength')} hint={t('visitLengthHint')}>
              <Select value={f.visit_minutes} onChange={set('visit_minutes')} className="w-40">
                <option value="">{t('visitLengthNone')}</option>
                {VISIT_LENGTHS.map((m) => <option key={m} value={String(m)}>{m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}`}</option>)}
              </Select>
            </Field>
          )}
          {ws.vat_rate != null && (
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4" checked={f.vat_invoice} onChange={(e) => setF({ ...f, vat_invoice: e.target.checked })} />
              <span>
                <span className="font-medium text-slate-800">{t('vatInvoice')}</span>
                <span className="block text-slate-600">{t('vatInvoiceHelp', { rate: ws.vat_rate })}</span>
              </span>
            </label>
          )}
          <button type="button" onClick={() => setMoreOpen(!moreOpen)} aria-expanded={moreOpen}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
            <ChevronDown size={15} className={cn('transition-transform', moreOpen && 'rotate-180')} />{moreOpen ? t('lessDetails') : t('moreDetails')}
            {!moreOpen && <span className="font-normal text-slate-500">· {t('moreDetailsWhat')}</span>}
          </button>
          {moreOpen && (<>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('contactPerson')}><Input value={f.contact_person} onChange={set('contact_person')} /></Field>
            <Field label={t('email')}><Input type="email" value={f.email} onChange={set('email')} /></Field>
            <Field label={t('phone2')}><Input value={f.phone2} onChange={set('phone2')} /></Field>
          </div>
          <Field label={t('paymentTerms')}>
            <div className="flex gap-2">
              <Input type="number" min={0} max={365} value={f.payment_days} onChange={set('payment_days')} className="w-24" />
              <Select value={f.payment_timing} onChange={set('payment_timing')}>
                <option value="before">{t('pay_before')}</option>
                <option value="after">{t('pay_after')}</option>
              </Select>
            </div>
          </Field>
          <Field label={t('notes')}><Input value={f.notes} onChange={set('notes')} /></Field>
          <Field label={t('cancelTerms')} hint={t('cancelTermsHelp')}>
            <ScaleEditor of="booked" value={f.cancel_terms} disabled={!canEdit} onChange={(cancel_terms) => setF({ ...f, cancel_terms })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />{t('active')}
          </label>
          </>)}
        </fieldset>
      </form>
      {vendor && (vendor.type === 'transport' || vendor.type === 'other') && <CompanyDrivers company={vendor} canEdit={canEdit} />}
      {vendor && canEdit && vendor.type === 'restaurant' && (
        // Its dishes with prices (Excel, a photo of the menu, by hand) and its set menus, built by dragging.
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/50 px-4 py-3">
          <span className="min-w-0 flex-1 text-sm text-slate-700"><b className="block text-slate-900">{t('mbOpenTitle')}</b>{t('mbOpenHelp')}</span>
          <Button type="button" onClick={() => (pricesDirty ? toast('mbSaveFirst', 'error') : setBuilding(true))}><ChefHat size={16} />{t('mbOpen')}</Button>
        </div>
      )}
      {building && vendor && <MenuBuilder vendor={vendor} onClose={() => setBuilding(false)} />}
      {vendor && canEdit && <ServicesEditor vendor={vendor} onDirtyChange={setPricesDirty} autoStart={justCreated} saveRef={pricesSave} />}
      {!vendor && canEdit && <p className="mt-6 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">{t('pricesAfterCreate')}</p>}
    </Drawer>
  )
}

/** The vendor's price list, used to calculate tour costs. Saved separately from the vendor form. */
const VISIT_LENGTHS = [15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300]

/** A bus company's drivers: who works for it, and "+ Add a driver" (new, or one already in the catalogue). */
function CompanyDrivers({ company, canEdit }: { company: Vendor; canEdit: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const all = useVendors().data ?? []
  const mine = all.filter((v) => v.company_id === company.id)
  const free = all.filter((v) => v.type === 'driver' && !v.company_id)
  const [creating, setCreating] = useState(false)
  const link = useMutation({
    mutationFn: ({ id, company_id }: { id: string; company_id: string | null }) =>
      api(wsPath(ws.id, `/vendors/${id}`), { method: 'PATCH', body: { company_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendors', ws.id] }),
  })
  return (
    <section className="mt-6 space-y-2" aria-labelledby={`drivers-${company.id}`}>
      <h3 id={`drivers-${company.id}`} className="text-sm font-semibold text-slate-800">{t('companyDrivers', { n: mine.length })}</h3>
      {mine.length === 0 && <p className="text-sm text-slate-600">{t('companyDriversNone')}</p>}
      {mine.length > 0 && <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {mine.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="min-w-40 flex-1 font-medium text-slate-800">{d.name}
              {d.languages?.length ? <span className="ml-2 text-xs font-normal text-slate-500">{d.languages.join(', ')}</span> : null}
            </span>
            <Phone phone={d.phone} />
            {canEdit && (
              <Button size="sm" variant="ghost" onClick={() => link.mutate({ id: d.id, company_id: null })}>{t('companyDriverRemove')}</Button>
            )}
          </li>
        ))}
      </ul>}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {free.length > 0 && (
            <Select className="h-9 w-64" value="" aria-label={t('companyDriverPick')}
              onChange={(e) => e.target.value && link.mutate({ id: e.target.value, company_id: company.id })}>
              <option value="">{t('companyDriverPick')}</option>
              {free.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          )}
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden />{t('companyDriverNew')}</Button>
        </div>
      )}
      <ErrorText error={link.error} />
      {creating && <QuickVendorDialog type="driver" city={company.city} onClose={() => setCreating(false)}
        onCreated={(d) => link.mutate({ id: d.id, company_id: company.id })} />}
    </section>
  )
}

/** Places the routes pass ("via" stops, visits) that aren't suppliers yet — free sights like Bodbe or
 * Jvari — offered as activities with no price, so they have a spot on the map and a visit length. */
function SightsFromRoutes() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const found = useQuery({
    queryKey: ['stop-suggestions', ws.id],
    queryFn: () => api<{ name: string; uses: number; routes: string[]; similar: string | null }[]>(wsPath(ws.id, '/vendors/stop-suggestions')),
  })
  const rows = found.data ?? []
  // Ticked to start with: all but the ones that probably are a supplier already.
  const chosen = picked ?? new Set(rows.filter((r) => !r.similar).map((r) => r.name))
  const add = useMutation({
    mutationFn: async () => {
      for (const name of rows.map((r) => r.name).filter((n) => chosen.has(n))) {
        await api(wsPath(ws.id, '/vendors'), { method: 'POST', body: { name, type: 'activity' } })
      }
    },
    onSuccess: () => {
      setOpen(false)
      setPicked(null)
      qc.invalidateQueries({ queryKey: ['vendors', ws.id] })
      qc.invalidateQueries({ queryKey: ['stop-suggestions', ws.id] })
    },
  })
  if (!rows.length) return null
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Landmark size={16} aria-hidden className="shrink-0 text-violet-700" />
        <span className="min-w-48 flex-1 text-slate-800">
          <b>{t('sightsFound', { n: rows.length })}</b> {rows.slice(0, 4).map((r) => r.name).join(', ')}{rows.length > 4 ? '…' : ''}
        </span>
        <Button size="sm" variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? t('cancel') : t('sightsReview')}</Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-slate-700">{t('sightsHelp')}</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {rows.map((r) => (
              <li key={r.name}>
                <label className="flex items-start gap-2 rounded-md bg-white px-2 py-1.5 ring-1 ring-violet-100">
                  <input type="checkbox" className="mt-0.5 size-4" checked={chosen.has(r.name)} onChange={(e) => {
                    const next = new Set(chosen)
                    if (e.target.checked) next.add(r.name)
                    else next.delete(r.name)
                    setPicked(next)
                  }} />
                  <span>
                    <span className="font-medium text-slate-800">{r.name}</span>
                    <span className="block text-xs text-slate-600">{t(r.uses === 1 ? 'sightsUses1' : 'sightsUses', { n: r.uses })}{r.routes.length > 0 && ` · ${r.routes.join(', ')}`}</span>
                    {r.similar && <span className="block text-xs font-medium text-amber-800">{t('sightsSimilar', { name: r.similar })}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <ErrorText error={add.error} />
          <Button size="sm" disabled={!chosen.size || add.isPending} onClick={() => add.mutate()}>{t('sightsAdd', { n: chosen.size })}</Button>
        </div>
      )}
    </div>
  )
}

// Suppliers that are a place on the map (not a person or a bus company).
const PLACE_TYPES: string[] = ['hotel', 'restaurant', 'activity', 'other']

function ModalActions({ isNew, busy, onDelete, onClose, formId }: {
  isNew: boolean; busy: boolean; onDelete: () => void; onClose: () => void
  formId?: string   // when the buttons sit outside the form (a drawer footer)
}) {
  const { t } = useI18n()
  return (
    <div className="flex w-full items-center gap-3">
      {!isNew && <Button type="button" variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && onDelete())}>{t('delete')}</Button>}
      <div className="flex-1" />
      <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      <Button type="submit" form={formId} disabled={busy}>{isNew ? t('create') : t('save')}</Button>
    </div>
  )
}

// --- clients ---------------------------------------------------------------------

export function ClientsPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const clients = useClients()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Client | 'new' | null>(null)
  useOpenFromUrl(clients.data, setEditing)
  const canEdit = can(ws, 'finance', 'sales')   // clients
  const rows = (clients.data ?? []).filter((c) => matches(q, c.name, c.country, c.contact_person, c.email))

  return (
    <>
      <PageHeader title={t('clients')} subtitle={t('clientsHelp')}
        action={canEdit && <Button onClick={() => setEditing('new')}><Plus size={16} />{t('newClient')}</Button>} />
      <div className="space-y-4 p-4 md:p-8">
        <SetupNudge step="clients" />
        <div className="relative">
          <Search size={16} className="absolute left-3 top-3 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="pl-9" />
        </div>
        {clients.isSuccess && !clients.data.length ? (
          <EmptyState title={t('emptyClients')} hint={t('emptyClientsHint')} action={canEdit && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setEditing('new')}><Plus size={16} />{t('newClient')}</Button>
              <ButtonLink to="../settings/import" relative="path">{t('importFromExcel')}</ButtonLink>
            </div>
          )} />
        ) : clients.isSuccess && rows.length === 0 ? <EmptyState title={t('noMatch')} hint={t('noMatchHint')} /> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('name')}</th><th className="px-4 py-3">{t('type')}</th>
                  <th className="px-4 py-3">{t('country')}</th><th className="px-4 py-3">{t('contactPerson')}</th>
                  <th className="px-4 py-3">{t('email')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => (
                  <tr key={c.id} onClick={() => setEditing(c)} className="cursor-pointer hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-slate-600">{t(`clientType_${c.type}`)}</td>
                    <td className="px-4 py-3 text-slate-600">{c.country}</td>
                    <td className="px-4 py-3 text-slate-600">{c.contact_person}</td>
                    <td className="px-4 py-3 text-slate-600">{c.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <ClientModal client={editing === 'new' ? null : editing} canEdit={canEdit} onClose={() => setEditing(null)} />}
    </>
  )
}

function ClientModal({ client, canEdit, onClose }: { client: Client | null; canEdit: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [f, setF] = useState(() => ({
    name: client?.name ?? '', type: client?.type ?? 'agency', country: client?.country ?? '',
    contact_person: client?.contact_person ?? '', email: client?.email ?? '', phone: client?.phone ?? '', notes: client?.notes ?? '',
    cancellation_scale: client?.cancellation_scale ?? null as Client['cancellation_scale'],
    payment_terms: client?.payment_terms ?? null as Client['payment_terms'],
  }))
  const ws = useWorkspace()!
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const { save, remove } = useCrud<Client>('clients', client, onClose)
  const formDirty = useUnsaved(f)
  const guarded = useGuardedClose(canEdit && formDirty, onClose)
  return (
    <Drawer size="md" title={client ? client.name : t('newClient')} onClose={guarded}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(f as Partial<Client>) }} className="space-y-4">
        <fieldset disabled={!canEdit} className="space-y-4">
          <Field label={t('name')}><Input required autoFocus value={f.name} onChange={set('name')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('type')}>
              <Select value={f.type} onChange={set('type')}>
                <option value="agency">{t('clientType_agency')}</option>
                <option value="direct">{t('clientType_direct')}</option>
              </Select>
            </Field>
            <Field label={t('country')}><Input value={f.country} onChange={set('country')} /></Field>
            <Field label={t('contactPerson')}><Input value={f.contact_person} onChange={set('contact_person')} /></Field>
            <Field label={t('phone')}><Input value={f.phone} onChange={set('phone')} /></Field>
          </div>
          <Field label={t('email')}><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label={t('notes')}><Input value={f.notes} onChange={set('notes')} /></Field>
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={f.payment_terms !== null}
                onChange={(e) => setF({ ...f, payment_terms: e.target.checked ? { ...ws.payment_terms } : null })} />
              {t('ownPaymentTerms')}
            </label>
            {f.payment_terms === null
              ? <p className="text-xs text-slate-500">{t('usesAgencyTerms')}</p>
              : <PaymentTermsEditor value={f.payment_terms} disabled={!canEdit} onChange={(payment_terms) => setF({ ...f, payment_terms })} />}
          </div>
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={f.cancellation_scale !== null}
                onChange={(e) => setF({ ...f, cancellation_scale: e.target.checked ? [...ws.cancellation_scale] : null })} />
              {t('ownCancellationScale')}
            </label>
            {f.cancellation_scale === null
              ? <p className="text-xs text-slate-500">{t('usesAgencyScale')}</p>
              : <ScaleEditor of="price" value={f.cancellation_scale} disabled={!canEdit} onChange={(cancellation_scale) => setF({ ...f, cancellation_scale })} />}
          </div>
        </fieldset>
        <ErrorText error={save.error || remove.error} />
        {canEdit && <ModalActions isNew={!client} busy={save.isPending} onDelete={() => remove.mutate()} onClose={guarded} />}
      </form>
    </Drawer>
  )
}
