import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RatesNeeded } from '../components/money'
import { InvoiceModal, InvoiceStatusPill } from '../components/InvoiceModal'
import { CodeChip, EmptyState } from '../components/tour'
import { Button, Card, Input, Select } from '../components/ui'
import { api, type ClientDebt, type InvoiceSummary, type ProfitReport, type ProfitRow, can } from '../lib/api'
import { useOpenIdFromUrl, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money, moneyList } from '../lib/utils'
import { PageHeader } from './Dashboard'

type Tab = 'invoices' | 'debts' | 'profit'

export function FinancePage() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const ws = useWorkspace()
  const tab = (params.get('tab') ?? (can(ws, 'finance') ? 'profit' : 'invoices')) as Tab
  return (
    <>
      <PageHeader section="finance" title={t('finance')} subtitle={t('financeHelp')} />
      <div className="space-y-4 p-4 md:p-8">
        {tab === 'invoices' && <InvoicesList />}
        {tab === 'debts' && <Debts />}
        {tab === 'profit' && <Profit />}
      </div>
    </>
  )
}

// --- invoices ----------------------------------------------------------------------

type InvFilter = 'all' | 'open' | 'overdue' | 'draft' | 'paid'

export function useInvoices(query: string) {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['invoices', ws.id, query],
    queryFn: () => api<InvoiceSummary[]>(wsPath(ws.id, `/invoices?${query}`)),
    placeholderData: (prev) => prev,
  })
}

function InvoicesList() {
  const { t } = useI18n()
  const [filter, setFilter] = useState<InvFilter>('open')
  const [open, setOpen] = useState<string | 'new' | null>(null)
  useOpenIdFromUrl(setOpen)
  const invoices = useInvoices(`status=${filter}`)
  const labels: Record<InvFilter, TKey> = { all: 'filter_all', open: 'filter_open', overdue: 'inv_overdue', draft: 'inv_draft', paid: 'inv_paid' }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
          {(['open', 'overdue', 'draft', 'paid', 'all'] as InvFilter[]).map((f) => (
            <button type="button" key={f} onClick={() => setFilter(f)}
              className={cn('shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 font-medium', filter === f ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
              {t(labels[f])}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button onClick={() => setOpen('new')}><Plus size={16} />{t('newInvoice')}</Button>
      </div>
      <InvoiceTable rows={invoices.data} onOpen={setOpen} />
      {open && <InvoiceModal invoiceId={open === 'new' ? undefined : open} onClose={() => setOpen(null)} />}
    </div>
  )
}

export function InvoiceTable({ rows, onOpen, hideTour }: { rows?: InvoiceSummary[]; onOpen: (id: string) => void; hideTour?: boolean }) {
  const { t, lang } = useI18n()
  if (rows && rows.length === 0) return <EmptyState title={t('noInvoices')} />
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr>
            <th className="px-4 py-3">{t('number')}</th><th className="px-4 py-3">{t('client')}</th>
            {!hideTour && <th className="px-4 py-3">{t('tourCode')}</th>}
            <th className="px-4 py-3">{t('dueDate')}</th><th className="px-4 py-3 text-right">{t('total')}</th>
            <th className="px-4 py-3 text-right">{t('balance')}</th><th className="px-4 py-3 text-center">{t('status')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows?.map((r) => (
            <tr key={r.id} onClick={() => onOpen(r.id)} className={cn('cursor-pointer hover:bg-slate-50', r.status === 'void' && 'opacity-50')}>
              <td className="px-4 py-2.5 font-mono font-semibold">{r.number ?? <span className="font-sans font-normal italic text-slate-400">{t('draftNumber')}</span>}</td>
              <td className="px-4 py-2.5 font-medium">{r.client.name}</td>
              {!hideTour && <td className="px-4 py-2.5">{r.tour ? <CodeChip code={r.tour.code} color={r.tour.color} /> : '—'}</td>}
              <td className={cn('whitespace-nowrap px-4 py-2.5', r.display_status === 'overdue' && 'font-semibold text-red-600')}>{fmt(r.due_date, lang)}</td>
              <td className={cn('whitespace-nowrap px-4 py-2.5 text-right tabular-nums', r.kind === 'credit_note' && 'text-rose-700')}>
                {r.kind === 'credit_note' ? '− ' : ''}{money(r.total, r.currency)}
              </td>
              <td className={cn('whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums', r.balance < 0 && 'text-violet-700')}>
                {r.status === 'issued' && r.kind === 'invoice' ? money(r.balance) : '—'}
              </td>
              <td className="px-4 py-2.5 text-center"><InvoiceStatusPill status={r.display_status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- debts -------------------------------------------------------------------------

function Debts() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const debts = useQuery({ queryKey: ['debts', ws.id], queryFn: () => api<ClientDebt[]>(wsPath(ws.id, '/debts')) })
  if (debts.data?.length === 0) return <EmptyState title={t('noDebts')} />
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr>
            <th className="px-4 py-3">{t('client')}</th><th className="px-4 py-3 text-right">{t('owes')}</th>
            <th className="px-4 py-3 text-right">{t('inv_overdue')}</th><th className="px-4 py-3 text-right">{t('openInvoices')}</th>
            <th className="px-4 py-3">{t('oldestDue')}</th><th className="px-4 py-3 text-right">{t('refundDue')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {debts.data?.map((d) => (
            <tr key={d.client.id}>
              <td className="px-4 py-3 font-medium">{d.client.name}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">{Object.keys(d.open).length ? moneyList(d.open) : '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-red-600">{Object.keys(d.overdue).length ? moneyList(d.overdue) : '—'}</td>
              <td className="px-4 py-3 text-right tabular-nums">{d.open_invoices}</td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{d.oldest_due ? fmt(d.oldest_due, lang) : '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-violet-700">{Object.keys(d.refund_due ?? {}).length ? moneyList(d.refund_due) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- profit ------------------------------------------------------------------------

function Profit() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const year = today().slice(0, 4)
  const [range, setRange] = useState({ from: `${year}-01-01`, to: `${year}-12-31` })
  const [group, setGroup] = useState<'tour' | 'month' | 'route'>('month')
  const q = new URLSearchParams({ date_from: range.from, date_to: range.to, group })
  const report = useQuery({
    queryKey: ['profit', ws.id, q.toString()],
    queryFn: () => api<ProfitReport>(wsPath(ws.id, `/reports/profit?${q}`)),
    placeholderData: (prev) => prev,
  })
  const r = report.data
  const tot = r?.totals
  const cur = r?.base_currency ?? ws.base_currency
  const maxAbs = Math.max(1, ...(r?.rows ?? []).map((x) => Math.max(x.revenue, x.cost)))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm"><span className="mb-1 block text-slate-500">{t('dateFrom')}</span>
          <Input type="date" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} className="w-40" /></label>
        <label className="text-sm"><span className="mb-1 block text-slate-500">{t('dateTo')}</span>
          <Input type="date" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} className="w-40" /></label>
        <label className="text-sm"><span className="mb-1 block text-slate-500">{t('groupBy')}</span>
          <Select value={group} onChange={(e) => setGroup(e.target.value as typeof group)} className="w-40">
            {(['month', 'tour', 'route'] as const).map((g) => <option key={g} value={g}>{t(`group_${g}`)}</option>)}
          </Select></label>
      </div>

      {tot && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Stat label={t('revenue')} value={money(tot.revenue, cur)} />
          <Stat label={t('costs')} value={tot.missing_rates ? '—' : money(tot.cost, cur)} />
          <Stat label={t('profit')} value={tot.missing_rates ? '—' : money(tot.profit, cur)} tone={tot.missing_rates ? undefined : tot.profit < 0 ? 'red' : 'green'}
            sub={tot.profit_after_vat != null && !tot.missing_rates ? `${t('afterVat', { amount: money(tot.profit_after_vat, cur) })} · ${t('vatBack')} ${money(tot.vat ?? 0, cur)}` : undefined} />
          <Stat label={t('margin')} value={tot.missing_rates || tot.margin === null ? '—' : `${tot.margin}%`} sub={`${tot.tours} ${t('tours').toLowerCase()} · ${tot.pax} ${t('pax').toLowerCase()}`} />
        </div>
      )}
      {tot?.missing_rates && <RatesNeeded currencies={tot.missing_currencies} />}
      {tot && tot.uninvoiced > 0 && (
        <div className="flex flex-wrap gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <span className="flex items-center gap-2"><AlertTriangle size={15} />{t('notInvoiced', { n: tot.uninvoiced })} · {t('draftsNotCounted')}</span>
        </div>
      )}

      {r && r.rows.length === 0 ? <EmptyState title={t('noTours')} hint={t('profitEmptyHint')} /> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
              <tr>
                <th className="px-4 py-3">{t(`group_${group}`)}</th>
                {group !== 'tour' && <th className="px-4 py-3 text-right">{t('tours_n')}</th>}
                <th className="px-4 py-3 text-right">{t('pax')}</th>
                <th className="px-4 py-3 text-right">{t('revenue')}</th><th className="px-4 py-3 text-right">{t('costs')}</th>
                <th className="px-4 py-3 text-right">{t('profit')}</th>
                {tot?.vat != null && <th className="px-4 py-3 text-right" title={t('vatColumnHelp')}>{t('profitAfterVat')}</th>}
                <th className="px-4 py-3 text-right">{t('margin')}</th>
                <th className="w-40 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {r?.rows.map((row) => <ProfitTr key={row.key} row={row} group={group} maxAbs={maxAbs} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ProfitTr({ row, group, maxAbs }: { row: ProfitRow; group: string; maxAbs: number }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const label = group === 'tour'
    ? <Link to={`/w/${ws.id}/tours/${row.key}?tab=costs`} className="flex items-center gap-2"><CodeChip code={row.label} color={row.color ?? 'slate'} />
        <span className="text-xs text-slate-400">{row.start_date && fmt(row.start_date, lang)}</span></Link>
    : group === 'month' ? <span className="font-medium capitalize">{fmt(`${row.key}-01`, lang, { month: 'long', year: 'numeric' })}</span>
    : <span className="font-medium">{row.label}</span>
  return (
    <tr>
      <td className="px-4 py-2.5">
        <span className="flex items-center gap-2">{label}
          {row.uninvoiced > 0 && <span title={t('notInvoiced', { n: row.uninvoiced })} className="text-amber-500"><AlertTriangle size={14} /></span>}
        </span>
      </td>
      {group !== 'tour' && <td className="px-4 py-2.5 text-right tabular-nums">{row.tours}</td>}
      <td className="px-4 py-2.5 text-right tabular-nums">{row.pax}</td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{money(row.revenue)}</td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-500">{money(row.cost)}</td>
      <td className={cn('whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums', row.profit < 0 ? 'text-red-600' : 'text-emerald-700')}>{money(row.profit)}</td>
      {row.profit_after_vat != null && (
        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-700" title={`${t('vatBack')} ${money(row.vat ?? 0)}`}>{money(row.profit_after_vat)}</td>
      )}
      <td className="px-4 py-2.5 text-right tabular-nums">{row.margin === null ? '—' : `${row.margin}%`}</td>
      <td className="px-4 py-2.5">
        {/* Revenue vs cost at a glance; same scale for every row. */}
        <div className="space-y-0.5">
          <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${(row.revenue / maxAbs) * 100}%` }} />
          <div className="h-1.5 rounded-full bg-slate-300" style={{ width: `${(row.cost / maxAbs) * 100}%` }} />
        </div>
      </td>
    </tr>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'green' }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', tone === 'red' && 'text-red-600', tone === 'green' && 'text-emerald-700')}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </Card>
  )
}
