import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Drawer, Label, type Tone, ask, useGuardedClose, useUnsaved } from './overlay'
import { Check, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api, COST_CATEGORIES, INCIDENT_KINDS, VENDOR_TYPES,
  type CarriedBy, type CatalogRow, type CostCategory, type Incident, type IncidentCost, type IncidentKind, type Tour, can } from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { addDays, diffDays, fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { CURRENCIES } from '../pages/Onboarding'
import { VendorSelect } from './tour'
import { Button, ErrorText, Field, Input, Select } from './ui'

const INCIDENT_TONE: Record<Incident['status'], Tone> = { open: 'orange', approved: 'green', rejected: 'grey', settled: 'blue' }

export function IncidentStatusPill({ status }: { status: Incident['status'] }) {
  const { t } = useI18n()
  return <Label tone={INCIDENT_TONE[status]}>{t(`incident_${status}` as TKey)}</Label>
}

const num = (x: string | number | null | undefined) => Number(x ?? 0) || 0

/**
 * Report an incident (anyone in the office) and decide its money (managers):
 * what it costs us, who carries it, what we charge the client or claim from a vendor.
 */
export function IncidentModal({ tourId, incident, onClose, onChanged }: {
  tourId: string; incident?: Incident; onClose: () => void; onChanged: () => void
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const seesMoney = can(ws, 'operations', 'finance')
  const vendors = useVendors()
  const tour = useQuery({ queryKey: ['tour', ws.id, tourId], queryFn: () => api<Tour>(wsPath(ws.id, `/tours/${tourId}`)) })
  const open = !incident || incident.status === 'open'
  const [f, setF] = useState(() => ({
    day: incident?.day ? String(incident.day) : '',
    kind: (incident?.kind ?? 'other') as IncidentKind,
    title: incident?.title ?? '',
    description: incident?.description ?? '',
    carried_by: (incident?.carried_by ?? 'agency') as CarriedBy,
    vendor_id: incident?.vendor?.id ?? null as string | null,
    costs: (incident?.costs ?? []).map((c) => ({ ...c, quantity: String(c.quantity), unit_price: String(c.unit_price) })) as IncidentCost[],
    client_charge: incident?.client_charge != null ? String(incident.client_charge) : '',
    client_credit: incident?.client_credit != null ? String(incident.client_credit) : '',
    client_currency: incident?.client_currency || ws.base_currency,
    vendor_claim: incident?.vendor_claim != null ? String(incident.vendor_claim) : '',
    claim_currency: incident?.claim_currency || ws.base_currency,
  }))
  const formDirty = useUnsaved(f)
  const guarded = useGuardedClose(formDirty, onClose)
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })
  const setCost = (i: number, patch: Partial<IncidentCost>) => set({ costs: f.costs.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  const body = () => ({
    day: f.day ? Number(f.day) : null, kind: f.kind, title: f.title, description: f.description,
    carried_by: f.carried_by, vendor_id: f.vendor_id,
    ...(seesMoney ? {
      costs: f.costs, client_charge: f.carried_by === 'client' ? f.client_charge || null : null,
      client_credit: f.carried_by !== 'client' ? f.client_credit || null : null, client_currency: f.client_currency,
      vendor_claim: f.vendor_claim || null, claim_currency: f.claim_currency,
    } : {}),
  })
  const done = () => { qc.invalidateQueries({ queryKey: ['incidents', ws.id] }); onChanged() }
  const save = useMutation({
    mutationFn: () => incident
      ? api<Incident>(wsPath(ws.id, `/incidents/${incident.id}`), { method: 'PATCH', body: body() })
      : api<Incident>(wsPath(ws.id, `/tours/${tourId}/incidents`), { method: 'POST', body: body() }),
    onSuccess: () => { done(); onClose() },
  })
  const [note, setNote] = useState('')
  const act = useMutation({
    mutationFn: async (action: 'approve' | 'reject' | 'reopen' | 'settle' | 'delete') => {
      if (!incident) return
      const url = wsPath(ws.id, `/incidents/${incident.id}`)
      if (action === 'delete') return api(url, { method: 'DELETE' })
      // Approving saves the latest edits first, so what is approved is what is on screen.
      if (action === 'approve') await api(url, { method: 'PATCH', body: body() })
      return api(`${url}/${action}`, { method: 'POST', body: action === 'approve' || action === 'reject' ? { note } : undefined })
    },
    onSuccess: () => { done(); onClose() },
  })

  const tr = tour.data
  const days = tr ? diffDays(tr.start_date, tr.end_date) + 1 : 0
  const costTotal = (cur: string) => f.costs.filter((c) => c.currency === cur).reduce((s, c) => s + num(c.quantity) * num(c.unit_price), 0)
  const costCurrencies = [...new Set(f.costs.map((c) => c.currency))]
  const dayDate = tr && f.day ? addDays(tr.start_date, Number(f.day) - 1) : tr?.start_date

  return (
    <Drawer size="lg" title={incident ? incident.title : t('reportIncident')} onClose={guarded}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="space-y-5">
        {incident && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <IncidentStatusPill status={incident.status} />
            <span>{t('reportedBy', { who: incident.reported_by ?? '—', when: fmt(incident.reported_at.slice(0, 10), lang) })}</span>
            {incident.decided_by && <span>· {t('decidedBy', { who: incident.decided_by })}{incident.decision_note && `: “${incident.decision_note}”`}</span>}
          </div>
        )}
        <fieldset disabled={!open} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem_11rem]">
            <Field label={t('whatHappened')}><Input required autoFocus={!incident} value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder={t('incidentTitlePh')} /></Field>
            <Field label={t('day')}>
              <Select value={f.day} onChange={(e) => set({ day: e.target.value })}>
                <option value="">{t('wholeTour')}</option>
                {tr && Array.from({ length: days }, (_, i) => (
                  <option key={i} value={i + 1}>{i + 1} · {fmt(addDays(tr.start_date, i), lang)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('kind')}>
              <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as IncidentKind })}>
                {INCIDENT_KINDS.map((k) => <option key={k} value={k}>{t(`incidentKind_${k}` as TKey)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={t('details')}>
            <textarea value={f.description} onChange={(e) => set({ description: e.target.value })} rows={2} maxLength={5000}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </Field>

          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">{t('whoCarriesIt')}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['client', 'agency', 'vendor'] as CarriedBy[]).map((c) => (
                <button key={c} type="button" onClick={() => set({ carried_by: c })}
                  className={cn('rounded-lg border p-3 text-left text-sm', f.carried_by === c ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-200' : 'border-slate-200 hover:bg-slate-50')}>
                  <b className="block">{t(`carried_${c}` as TKey)}</b>
                  <span className="text-xs text-slate-500">{t(`carried_${c}_help` as TKey)}</span>
                </button>
              ))}
            </div>
          </div>
          {(f.carried_by === 'vendor' || f.vendor_id) && (
            <Field label={t('vendorAtFault')}>
              <VendorSelect vendors={vendors.data ?? []} types={VENDOR_TYPES} value={f.vendor_id} onChange={(v) => set({ vendor_id: v })} />
            </Field>
          )}

          {seesMoney ? (
            <div className="space-y-3 rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-semibold">{t('incidentCosts')}</p>
              {f.costs.length === 0 && <p className="text-xs text-slate-500">{t('incidentCostsHelp')}</p>}
              {f.costs.map((c, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[10rem_7rem_1fr_4.5rem_6rem_5rem_auto]">
                  <VendorSelect className="h-9" vendors={vendors.data ?? []} types={VENDOR_TYPES} value={c.vendor_id} onChange={(v) => setCost(i, { vendor_id: v })} />
                  <Select className="h-9" value={c.category} onChange={(e) => setCost(i, { category: e.target.value as CostCategory })}>
                    {COST_CATEGORIES.map((k) => <option key={k} value={k}>{t(`cat_${k}`)}</option>)}
                  </Select>
                  <Input className="col-span-2 h-9 sm:col-span-1" required value={c.description} placeholder={t('description')} onChange={(e) => setCost(i, { description: e.target.value })} />
                  <Input className="h-9 text-right" type="number" step="0.01" min="0.01" required value={c.quantity} onChange={(e) => setCost(i, { quantity: e.target.value })} aria-label={t('qty')} />
                  <Input className="h-9 text-right" type="number" step="0.01" min="0" required value={c.unit_price} onChange={(e) => setCost(i, { unit_price: e.target.value })} aria-label={t('unitPrice')} />
                  <Select className="h-9" value={c.currency} onChange={(e) => setCost(i, { currency: e.target.value })}>{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</Select>
                  <button type="button" onClick={() => set({ costs: f.costs.filter((_, j) => j !== i) })} aria-label={t('delete')}
                    className="justify-self-end rounded p-2 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="secondary"
                  onClick={() => set({ costs: [...f.costs, { vendor_id: null, category: 'other', description: '', quantity: '1', unit_price: '', currency: ws.base_currency }] })}>
                  <Plus size={14} />{t('addCost')}
                </Button>
                {dayDate && <CatalogPick on={dayDate} onPick={(r) => set({
                  costs: [...f.costs, {
                    vendor_id: r.vendor.id, category: catOf(r.service.category), description: r.service.name, quantity: '1',
                    unit_price: String(r.price ?? ''), currency: r.currency ?? ws.base_currency,
                  }],
                })} />}
                <span className="ml-auto text-sm tabular-nums text-slate-600">{costCurrencies.map((cur) => `${money(costTotal(cur))} ${cur}`).join(' + ')}</span>
              </div>

              {f.carried_by === 'client' && (
                <MoneyRow label={t('chargeClient')} hint={tr?.client_name ?? t('tourHasNoClient')} amount={f.client_charge} currency={f.client_currency}
                  onChange={(client_charge, client_currency) => set({ client_charge, client_currency })}
                  suggest={costCurrencies.length === 1 ? costTotal(costCurrencies[0]) : null} suggestCurrency={costCurrencies[0]} />
              )}
              {f.carried_by !== 'client' && (
                <MoneyRow label={t('compensateClient')} hint={t('compensateClientHelp')} amount={f.client_credit} currency={f.client_currency}
                  onChange={(client_credit, client_currency) => set({ client_credit, client_currency })} suggest={null} />
              )}
              {(f.carried_by === 'vendor' || f.vendor_claim) && (
                <MoneyRow label={t('claimFromVendor')} hint={vendors.data?.find((v) => v.id === f.vendor_id)?.name ?? t('chooseVendor')}
                  amount={f.vendor_claim} currency={f.claim_currency} onChange={(vendor_claim, claim_currency) => set({ vendor_claim, claim_currency })}
                  suggest={costCurrencies.length === 1 ? costTotal(costCurrencies[0]) : null} suggestCurrency={costCurrencies[0]} />
              )}
              <Effects f={f} costTotal={costTotal} currencies={costCurrencies} />
            </div>
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">{t('staffIncidentHelp')}</p>
          )}
        </fieldset>

        <ErrorText error={save.error || act.error} />
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          {incident && seesMoney && incident.status !== 'settled' && incident.status !== 'open' && (
            <Button type="button" variant="ghost" onClick={() => void ask({ title: t('confirmReopenIncident'), message: t('confirmReopenIncidentMsg') }).then((ok) => ok && act.mutate('reopen'))}><RotateCcw size={15} />{t('reopen')}</Button>
          )}
          {incident && seesMoney && (incident.status === 'open' || incident.status === 'rejected') && (
            <Button type="button" variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && act.mutate('delete'))}><Trash2 size={15} /></Button>
          )}
          {incident?.invoice_id && <Link to={`/w/${ws.id}/print/invoice/${incident.invoice_id}`} className="text-sm text-brand-600 hover:underline">{t('itsInvoice')}</Link>}
          <div className="flex-1" />
          {incident?.status === 'approved' && seesMoney && <Button type="button" variant="secondary" onClick={() => void ask({ title: t('confirmSettle'), message: t('confirmSettleMsg') }).then((ok) => ok && act.mutate('settle'))}>{t('markSettled')}</Button>}
          {open && <Button type="submit" variant={incident?.can_decide ? 'secondary' : 'primary'} disabled={save.isPending}>{incident ? t('save') : t('report')}</Button>}
        </div>
        {incident?.status === 'open' && seesMoney && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('decisionNotePh')} maxLength={500} className="h-9 min-w-48 flex-1" />
            {incident.can_decide ? (
              <>
                <Button type="button" variant="secondary" disabled={act.isPending} onClick={() => void ask({ title: t('confirmReject'), message: t('confirmRejectMsg'), danger: true }).then((ok) => ok && act.mutate('reject'))}><X size={15} />{t('reject')}</Button>
                <Button type="button" disabled={act.isPending} onClick={() => act.mutate('approve')}><Check size={15} />{t('approve')}</Button>
              </>
            ) : <span className="text-sm text-amber-700">{t('needsAdmin', { limit: money(ws.incident_approval_limit ?? 0, ws.base_currency) })}</span>}
          </div>
        )}
      </form>
    </Drawer>
  )
}

const CAT: Record<string, CostCategory> = { activity: 'ticket', border: 'visa', tips: 'other' }
const catOf = (c: string): CostCategory => (CAT[c] ?? (COST_CATEGORIES.includes(c as CostCategory) ? c : 'other')) as CostCategory

function MoneyRow({ label, hint, amount, currency, onChange, suggest, suggestCurrency }: {
  label: string; hint: string; amount: string; currency: string; onChange: (amount: string, currency: string) => void
  suggest: number | null; suggestCurrency?: string
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
      <span className="text-sm font-medium">{label}</span><span className="text-xs text-slate-500">{hint}</span>
      <div className="ml-auto flex items-center gap-2">
        {suggest !== null && suggest > 0 && (
          <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => onChange(suggest.toFixed(2), suggestCurrency ?? currency)}>
            {t('sameAsCosts')}
          </button>
        )}
        <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => onChange(e.target.value, currency)} className="h-9 w-28 text-right" aria-label={label} />
        <Select value={currency} onChange={(e) => onChange(amount, e.target.value)} className="h-9 w-20">{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</Select>
      </div>
    </div>
  )
}

/** "When approved:" in words, so nobody has to guess what the button does. */
function Effects({ f, costTotal, currencies }: {
  f: { costs: IncidentCost[]; carried_by: CarriedBy; client_charge: string; client_credit: string; client_currency: string; vendor_claim: string; claim_currency: string }
  costTotal: (cur: string) => number; currencies: string[]
}) {
  const { t } = useI18n()
  const items: string[] = []
  if (f.costs.length) items.push(t('effectCosts', { n: f.costs.length, total: currencies.map((c) => `${money(costTotal(c))} ${c}`).join(' + ') }))
  if (f.carried_by === 'client' && num(f.client_charge)) items.push(t('effectInvoice', { amount: `${money(num(f.client_charge))} ${f.client_currency}` }))
  if (num(f.vendor_claim)) items.push(t('effectClaim', { amount: `${money(num(f.vendor_claim))} ${f.claim_currency}` }))
  if (f.carried_by !== 'client' && num(f.client_credit)) items.push(t('effectCredit', { amount: `${money(num(f.client_credit))} ${f.client_currency}` }))
  if (f.carried_by === 'agency' && f.costs.length) items.push(t('effectAbsorbed'))
  if (!items.length) return null
  return (
    <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
      <p className="font-semibold">{t('whenApproved')}</p>
      <ul className="list-inside list-disc">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  )
}

/** Add a cost from the price catalog, priced for the incident's day. */
function CatalogPick({ on, onPick }: { on: string; onPick: (r: CatalogRow) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rows = useQuery({
    queryKey: ['catalog', ws.id, `on=${on}`], enabled: open,
    queryFn: () => api<CatalogRow[]>(wsPath(ws.id, `/catalog?on=${on}`)),
  })
  if (!open) return <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>{t('fromCatalogPick')}</Button>
  return (
    <select autoFocus className="h-8 max-w-72 rounded-md border border-slate-300 bg-white px-1 text-xs" value="" onBlur={() => setOpen(false)}
      onChange={(e) => { const r = rows.data?.find((x) => x.service.id === e.target.value); if (r) onPick(r); setOpen(false) }}>
      <option value="">{rows.isLoading ? '…' : t('pickService')}</option>
      {rows.data?.map((r) => (
        <option key={r.service.id} value={r.service.id}>{r.vendor.name} · {r.service.name}{r.price !== null ? ` · ${money(r.price)} ${r.currency}` : ''}</option>
      ))}
    </select>
  )
}
