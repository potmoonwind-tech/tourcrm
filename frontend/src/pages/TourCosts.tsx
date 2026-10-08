import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask } from '../components/overlay'
import { AlertTriangle, CalendarClock, Calculator, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { InvoiceModal } from '../components/InvoiceModal'
import { GuideReports } from '../components/GuideReports'
import { ScheduleModal } from '../components/ScheduleModal'
import { BillStatePill, BillsModal } from '../components/BillsModal'
import { PaymentModal, PayStatusPill, RatesNeeded } from '../components/money'
import { EmptyState, Modal, VendorSelect } from '../components/tour'
import { Button, Card, ErrorText, Field, Input, Select, Spinner } from '../components/ui'
import {
  api, COST_CATEGORIES, VENDOR_TYPES,
  type BudgetLine, type CostCategory, type CostLine, type GenerateResult, type Payable, type ProfitRow, type Tour, type TourCosts,
} from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money, moneyList } from '../lib/utils'
import { InvoiceTable, useInvoices } from './Finance'
import { CURRENCIES } from './Onboarding'
import { BudgetPanel, budgetKey, useBudget } from './TourBudget'

export function CostsTab({ tour }: { tour: Tour }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const base = wsPath(ws.id, `/tours/${tour.id}`)
  const key = ['costs', ws.id, tour.id]
  const costs = useQuery({ queryKey: key, queryFn: () => api<TourCosts>(`${base}/costs`) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ['schedule', ws.id] })
    qc.invalidateQueries({ queryKey: ['profit', ws.id] })  // cost changes move the profit
    qc.invalidateQueries({ queryKey: budgetKey(ws.id, tour.id) })
  }
  const budget = useBudget(tour.id)
  const budgetLines = budget.data?.set ? budget.data.lines : null
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [paying, setPaying] = useState<Payable | null>(null)
  const [billing, setBilling] = useState<Payable | null>(null)
  const [adding, setAdding] = useState(false)

  const generate = useMutation({
    mutationFn: () => api<GenerateResult>(`${base}/costs/generate`, { method: 'POST' }),
    onSuccess: (r) => { setResult(r); refresh() },
  })
  const delPayment = useMutation({ mutationFn: (id: string) => api(`${base}/payments/${id}`, { method: 'DELETE' }), onSuccess: refresh })

  const data = costs.data
  if (!data) return <div className="flex justify-center py-10"><Spinner /></div>
  const totals = data.totals

  return (
    <div className="space-y-4">
      <TourRevenue tour={tour} />
      <GuideReports tour={tour} onChanged={refresh} />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => generate.mutate()} disabled={generate.isPending || tour.status === 'cancelled'}>
          <Calculator size={16} />{t('generateCosts')}
        </Button>
        <Button variant="secondary" onClick={() => setAdding(true)}><Plus size={16} />{t('addCost')}</Button>
        <p className="w-full text-xs text-slate-500 lg:w-auto lg:max-w-md">{t('generateHelp')}</p>
      </div>
      <ErrorText error={generate.error} />
      {result && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm">
          <p className="font-medium text-brand-800">
            {t('generated', { created: result.created, updated: result.updated, removed: result.removed, kept: result.kept })}
            {result.linked > 0 && ` · ${t('generatedLinked', { n: result.linked })}`}
          </p>
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-amber-800">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
        </div>
      )}

      <BudgetPanel tour={tour} onChanged={refresh} />
      {data.lines.length === 0 && data.payments.length === 0 ? (
        <EmptyState title={t('noCosts')} hint={t('noCostsHint')} />
      ) : (
        <>
          <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4">
            <span className="text-sm text-slate-500">{t('totalCost')}</span>
            {totals.missing_rates.length > 0 ? (
              // No rate yet: show what it really is per currency, never a fake total in the base currency.
              <span className="text-2xl font-bold tabular-nums">{moneyList(totals.by_currency)}</span>
            ) : (
              <>
                <span className="text-2xl font-bold tabular-nums">{money(totals.base_total, totals.base_currency)}</span>
                <span className="text-sm text-slate-500">{moneyList(totals.by_currency)}</span>
                {totals.vat_base != null && (
                  <span className="text-sm text-slate-700">{t('vatBack')}: <b className="tabular-nums">{money(totals.vat_base, totals.base_currency)}</b></span>
                )}
              </>
            )}
            {totals.missing_rates.length > 0 && <div className="w-full"><RatesNeeded currencies={totals.missing_rates} compact /></div>}
          </Card>

          <Card>
            <h3 className="border-b border-slate-100 px-5 py-3 font-semibold">{t('whatWeOwe')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <tr>
                    <th className="px-4 py-2">{t('vendor')}</th><th className="px-4 py-2 text-right">{t('total')}</th>
                    <th className="px-4 py-2 text-right">{t('paid')}</th><th className="px-4 py-2 text-right">{t('balance')}</th>
                    <th className="px-4 py-2">{t('due')}</th><th className="px-4 py-2 text-center">{t('status')}</th>
                    <th className="px-4 py-2">{t('vendorInvoice')}</th><th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.payables.map((p) => (
                    <tr key={p.vendor.id + p.currency}>
                      <td className="px-4 py-2 font-medium">{p.vendor.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(p.total, p.currency)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600">{money(p.paid)}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{money(p.balance)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">{p.due_date ? fmt(p.due_date, lang) : '—'}</td>
                      <td className="px-4 py-2 text-center"><PayStatusPill status={p.status} /></td>
                      <td className="px-4 py-2">
                        <button type="button" onClick={() => setBilling(p)} className="flex items-center gap-2 text-left hover:underline">
                          <BillStatePill state={p.bill_state} />
                          {p.billed > 0 && <span className="text-xs tabular-nums text-slate-500">{money(p.billed)}</span>}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {p.status !== 'paid' && <Button size="sm" variant="secondary" onClick={() => setPaying(p)}>{t('pay')}</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {data.payments.length > 0 && (
            <Card>
              <h3 className="border-b border-slate-100 px-5 py-3 font-semibold">{t('paymentsMade')}</h3>
              <ul className="divide-y divide-slate-100 text-sm">
                {data.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-2">
                    <span className="w-24 text-slate-500">{fmt(p.paid_on, lang)}</span>
                    <span className="min-w-40 flex-1 font-medium">{p.vendor.name}</span>
                    <span className="text-slate-500">{t(`method_${p.method}`)}{p.reference && ` · ${p.reference}`}
                      {p.paid_by && <> · {t('paidByName', { name: p.paid_by.name })}</>}</span>
                    <span className="w-36 text-right font-semibold tabular-nums">{money(p.amount, p.currency)}</span>
                    <button type="button" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && delPayment.mutate(p.id))}
                      className="rounded-md p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <h3 className="border-b border-slate-100 px-5 py-3 font-semibold">{t('costLines')} · {data.lines.length}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <tr>
                    <th className="px-3 py-2">{t('date')}</th><th className="px-3 py-2">{t('vendor')}</th>
                    <th className="px-3 py-2">{t('description')}</th><th className="w-24 px-3 py-2 text-right">{t('qty')}</th>
                    <th className="w-32 px-3 py-2 text-right">{t('unitPrice')}</th><th className="px-3 py-2 text-right">{t('amount')}</th>
                    {ws.vat_rate != null && <th className="px-3 py-2" title={t('vatColumnHelp')}>{t('vat')}</th>}
                    {budgetLines && <th className="px-3 py-2" title={t('budgetLineHelp')}>{t('budgetLine')} <span className="font-normal normal-case text-slate-400">· {t('budgetLineShort')}</span></th>}<th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.lines.map((c) => <CostRow key={c.id} line={c} base={base} budgetLines={budgetLines} vatRate={ws.vat_rate ?? null} onChange={refresh} />)}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {paying && <PaymentModal payable={paying} onClose={() => setPaying(null)} onDone={refresh} />}
      {billing && <BillsModal tourId={tour.id} payable={billing} onClose={() => setBilling(null)} onChanged={refresh} />}
      {adding && <AddCostModal tour={tour} onClose={() => setAdding(false)} onDone={refresh} />}
    </div>
  )
}

function CostRow({ line, base, budgetLines, vatRate, onChange }: {
  line: CostLine; base: string; budgetLines: BudgetLine[] | null; vatRate: number | null; onChange: () => void
}) {
  const { t, lang } = useI18n()
  const [qty, setQty] = useState(String(line.quantity))
  const [price, setPrice] = useState(line.unit_price.toFixed(2))
  useEffect(() => { setQty(String(line.quantity)); setPrice(line.unit_price.toFixed(2)) }, [line])
  const save = useMutation({
    mutationFn: (body: Record<string, string | null>) => api(`${base}/costs/${line.id}`, { method: 'PATCH', body }),
    onSuccess: onChange,
  })
  const del = useMutation({ mutationFn: () => api(`${base}/costs/${line.id}`, { method: 'DELETE' }), onSuccess: onChange })
  const cell = 'h-8 border-transparent bg-transparent text-right shadow-none hover:border-slate-300 focus:bg-white'
  return (
    <tr className={cn(save.isPending && 'opacity-60', save.isError && 'bg-red-50')}>
      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
        {fmt(line.service_date, lang)}{line.service_end && ` – ${fmt(line.service_end, lang)}`}
      </td>
      <td className="px-3 py-1.5">
        <span className="font-medium">{line.vendor?.name ?? '—'}</span>
        <span className="ml-2 text-xs text-slate-400">{t(`cat_${line.category}`)}</span>
      </td>
      <td className="px-3 py-1.5 text-slate-600">
        {line.description}
        {line.reason && <span className={cn('ml-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase',
          line.reason === 'incident' ? 'bg-rose-100 text-rose-800' : line.reason === 'bill_adjustment' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')}>{t(`reason_${line.reason}`)}</span>}
        {line.auto && <span className={cn('ml-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase',
          line.locked ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500')}>{line.locked ? t('edited') : t('fromItinerary')}</span>}
      </td>
      <td className="px-1 py-1">
        <Input className={cell} type="number" step="0.01" min="0.01" value={qty} onChange={(e) => setQty(e.target.value)}
          onBlur={() => Number(qty) > 0 && Number(qty) !== line.quantity && save.mutate({ quantity: qty })} />
      </td>
      <td className="px-1 py-1">
        <Input className={cell} type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)}
          onBlur={() => Number(price) >= 0 && Number(price) !== line.unit_price && save.mutate({ unit_price: price })} />
      </td>
      <td className={cn('whitespace-nowrap px-3 py-1.5 text-right font-semibold tabular-nums', line.amount === 0 && 'text-amber-600')}>
        {money(line.amount, line.currency)}
      </td>
      {vatRate != null && (
        <td className="px-1 py-1">
          {/* "" = the supplier's usual; "0" = no VAT invoice this time; the agency's rate = this time there is one. */}
          <Select value={line.vat_by_hand ? String(Number(line.vat_rate ?? 0)) : ''} aria-label={t('vat')}
            onChange={(e) => save.mutate({ vat_rate: e.target.value === '' ? null : e.target.value })}
            className="h-8 w-40 px-2 text-xs">
            <option value="">{line.vat_by_hand ? t('vatUsualPlain') : t('vatUsual', { rate: Number(line.vat_rate ?? 0) })}</option>
            <option value="0">{t('vatNone')}</option>
            <option value={String(vatRate)}>{t('vatWith', { rate: vatRate })}</option>
          </Select>
          {!!line.vat && <div className="px-2 text-xs tabular-nums text-slate-600">{money(line.vat, line.currency)}</div>}
        </td>
      )}
      {budgetLines && (
        <td className="px-1 py-1">
          <Select value={line.budget_line_id ?? ''} onChange={(e) => save.mutate({ budget_line_id: e.target.value || null })}
            className={cn('h-8 w-48 px-2 text-xs', !line.budget_line_id && 'border-amber-300 text-amber-700')} aria-label={t('budgetLine')}>
            <option value="">{t('notInBudget')}</option>
            {budgetLines.map((b) => <option key={b.id} value={b.id}>{b.day ? `${t('day')} ${b.day} · ` : ''}{b.name}</option>)}
          </Select>
        </td>
      )}
      <td className="px-1">
        <button type="button" aria-label={t('delete')} title={t('delete')} onClick={() => void ask({ title: t('confirmDeleteCost'), danger: true }).then((ok) => ok && del.mutate())}
          className="rounded-md p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
      </td>
    </tr>
  )
}

function AddCostModal({ tour, onClose, onDone }: { tour: Tour; onClose: () => void; onDone: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const vendors = useVendors()
  const [f, setF] = useState({
    vendor_id: null as string | null, category: 'ticket' as CostCategory, description: '',
    service_date: tour.start_date, quantity: String(tour.participant_count || tour.pax || 1), unit_price: '',
    currency: ws.base_currency,
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${tour.id}/costs`), { method: 'POST', body: f }),
    onSuccess: () => { onDone(); onClose() },
  })
  return (
    <Modal title={t('addCost')} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('category')}>
            <Select value={f.category} onChange={set('category')}>
              {COST_CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat_${c}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('vendor')}>
            <VendorSelect vendors={vendors.data ?? []} types={VENDOR_TYPES} value={f.vendor_id} onChange={(v) => setF({ ...f, vendor_id: v })} />
          </Field>
        </div>
        <Field label={t('description')}><Input required value={f.description} onChange={set('description')} placeholder={t('costDescriptionPh')} /></Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t('date')}><Input type="date" required min={tour.start_date} max={tour.end_date} value={f.service_date} onChange={set('service_date')} /></Field>
          <Field label={t('qty')}><Input type="number" step="0.01" min="0.01" required value={f.quantity} onChange={set('quantity')} /></Field>
          <Field label={t('unitPrice')}><Input type="number" step="0.01" min="0" required value={f.unit_price} onChange={set('unit_price')} /></Field>
          <Field label={t('currency')}>
            <Select value={f.currency} onChange={set('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={save.isPending}>{t('add')}</Button>
        </div>
      </form>
    </Modal>
  )
}

/** Revenue (issued invoices) vs cost for this tour, and its invoices. */
function TourRevenue({ tour }: { tour: Tour }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [open, setOpen] = useState<string | 'new' | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const profit = useQuery({
    queryKey: ['profit', ws.id, 'tour', tour.id],
    queryFn: () => api<ProfitRow>(wsPath(ws.id, `/tours/${tour.id}/profit`)),
  })
  const invoices = useInvoices(`tour_id=${tour.id}`)
  const p = profit.data
  const expected = p?.expected_revenue ?? null
  return (
    <div className="space-y-3">
      {p && (
        <Card className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
          {expected !== null ? (
            // Not invoiced yet: what the price per person will bring.
            <>
              <Metric label={t('expectedRevenue')} value={money(expected, ws.base_currency)} sub={`${p?.expected_paying ?? tour.pax} × ${money(tour.price_pp ?? 0, tour.price_currency ?? undefined)}`} />
              <Metric label={t('costs')} value={p.missing_rates ? '—' : money(p.cost, ws.base_currency)} />
              <Metric label={t('expectedProfit')} value={p.missing_rates ? '—' : money(p.expected_profit ?? 0, ws.base_currency)}
                tone={p.missing_rates ? undefined : (p.expected_profit ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700'}
                sub={p.vat != null && !p.missing_rates ? t('afterVat', { amount: money((p.expected_profit ?? 0) + p.vat, ws.base_currency) }) : undefined} />
              <Metric label={t('margin')} value={p.missing_rates || !expected ? '—' : `${Math.round(((p.expected_profit ?? 0) / expected) * 1000) / 10}%`} />
            </>
          ) : (
            <>
              <Metric label={t('revenue')} value={money(p.revenue, ws.base_currency)} />
              <Metric label={t('costs')} value={p.missing_rates ? '—' : money(p.cost, ws.base_currency)} />
              {/* Nothing sold yet (no invoice, no price): no "profit" of minus all costs. */}
              <Metric label={t('profit')} value={p.missing_rates || p.revenue === 0 ? '—' : money(p.profit, ws.base_currency)}
                tone={p.missing_rates || p.revenue === 0 ? undefined : p.profit < 0 ? 'text-red-600' : 'text-emerald-700'}
                sub={p.profit_after_vat != null && !p.missing_rates && p.revenue !== 0 ? t('afterVat', { amount: money(p.profit_after_vat, ws.base_currency) }) : undefined} />
              <Metric label={t('margin')} value={p.missing_rates || p.margin === null ? '—' : `${p.margin}%`} />
            </>
          )}
          {!p.missing_rates && p.revenue === 0 && expected === null && p.cost > 0 && tour.pax > 0 && (
            <p className="col-span-full text-sm text-slate-600">{t('costPerPersonHint', { amount: money(p.cost / tour.pax, ws.base_currency) })}</p>
          )}
          {p.missing_rates && <div className="col-span-full"><RatesNeeded currencies={p.missing_currencies} /></div>}
          {p.uninvoiced > 0 && !p.missing_rates && (
            <p className="col-span-full flex items-center gap-2 text-sm text-amber-700"><AlertTriangle size={15} />{t('draftsNotCounted')}</p>
          )}
        </Card>
      )}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t('invoices')}</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setScheduling(true)}><CalendarClock size={14} />{t('paymentSchedule')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setOpen('new')}><Plus size={14} />{t('invoiceTour')}</Button>
        </div>
      </div>
      {invoices.data && (invoices.data.length > 0 ? <InvoiceTable rows={invoices.data} onOpen={setOpen} hideTour />
        : <p className="rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">{t('noTourInvoicesHint')}</p>)}
      {open && <InvoiceModal invoiceId={open === 'new' ? undefined : open} fromTour={tour} onClose={() => setOpen(null)} />}
      {scheduling && <ScheduleModal tour={tour} onClose={() => setScheduling(false)} />}
    </div>
  )
}

function Metric({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums', tone)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 tabular-nums">{sub}</p>}
    </div>
  )
}
