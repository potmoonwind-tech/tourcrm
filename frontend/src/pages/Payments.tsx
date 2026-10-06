import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BillStatePill, BillsModal } from '../components/BillsModal'
import { PaymentModal, PayStatusPill } from '../components/money'
import { CodeChip, EmptyState } from '../components/tour'
import { Button, Card, Select } from '../components/ui'
import { api, type Payable, type Schedule } from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money, moneyList } from '../lib/utils'
import { PageHeader } from './Dashboard'

type Filter = 'open' | 'overdue' | 'paid' | 'all' | 'bills'

export function useSchedule(params: string) {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['schedule', ws.id, params],
    queryFn: () => api<Schedule>(wsPath(ws.id, `/payments/schedule?${params}`)),
    placeholderData: (prev) => prev,
  })
}

export function PaymentsPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const vendors = useVendors(true)
  const [filter, setFilter] = useState<Filter>('open')
  const [vendorId, setVendorId] = useState('')
  const [paying, setPaying] = useState<Payable | null>(null)
  const [billing, setBilling] = useState<Payable | null>(null)
  const params = new URLSearchParams({ status: filter })
  if (vendorId) params.set('vendor_id', vendorId)
  const sched = useSchedule(params.toString())
  const s = sched.data
  const now = today()

  return (
    <>
      <PageHeader section="finance" title={t('finance')} subtitle={t('vendorPaymentsHelp')} />
      <div className="space-y-4 p-4 md:p-8">
        <div className="grid gap-4 sm:grid-cols-3">
          <SumCard label={t('filter_overdue')} value={s?.overdue} tone="red" />
          <SumCard label={t('due7')} value={s?.due_7} tone="amber" />
          <SumCard label={t('due30')} value={s?.due_30} tone="slate" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
            {(['open', 'overdue', 'paid', 'all', 'bills'] as Filter[]).map((f) => (
              <button type="button" key={f} onClick={() => setFilter(f)}
                className={cn('shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 font-medium', filter === f ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                {t(`filter_${f}` as TKey)}
              </button>
            ))}
          </div>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-64">
            <option value="">{t('allVendors')}</option>
            {vendors.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        </div>

        {s && s.items.length === 0 ? <EmptyState title={t('nothingDue')} hint={t('paymentsEmptyHint')} /> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('due')}</th><th className="px-4 py-3">{t('tourCode')}</th>
                  <th className="px-4 py-3">{t('vendor')}</th><th className="px-4 py-3 text-right">{t('total')}</th>
                  <th className="px-4 py-3 text-right">{t('paid')}</th><th className="px-4 py-3 text-right">{t('balance')}</th>
                  <th className="px-4 py-3 text-center">{t('status')}</th><th className="px-4 py-3">{t('vendorInvoice')}</th><th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {s?.items.map((p) => (
                  <tr key={p.tour_id + p.vendor.id + p.currency} className="hover:bg-slate-50">
                    <td className={cn('whitespace-nowrap px-4 py-2.5', p.status === 'overdue' && 'font-semibold text-red-600',
                      p.due_date === now && 'font-semibold')}>
                      {p.due_date ? fmt(p.due_date, lang) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => navigate(`/w/${ws.id}/tours/${p.tour_id}?tab=costs`)}>
                        <CodeChip code={p.tour_code} color={p.tour_color} />
                      </button>
                    </td>
                    <td className="px-4 py-2.5 font-medium">{p.vendor.name}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{money(p.total, p.currency)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-500">{money(p.paid)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">{money(p.balance)}</td>
                    <td className="px-4 py-2.5 text-center"><PayStatusPill status={p.status} /></td>
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => setBilling(p)} className="flex items-center gap-2 hover:underline">
                        <BillStatePill state={p.bill_state} />
                        {p.bill_state === 'difference' && <span className="text-xs tabular-nums text-amber-700">{p.bill_difference > 0 ? '+' : ''}{money(p.bill_difference)}</span>}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {p.status !== 'paid' && <Button size="sm" variant="secondary" onClick={() => setPaying(p)}>{t('pay')}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {paying && (
        <PaymentModal payable={paying} onClose={() => setPaying(null)}
          onDone={() => { qc.invalidateQueries({ queryKey: ['schedule', ws.id] }); qc.invalidateQueries({ queryKey: ['costs', ws.id, paying.tour_id] }) }} />
      )}
      {billing && (
        <BillsModal tourId={billing.tour_id} payable={billing} onClose={() => setBilling(null)}
          onChanged={() => { qc.invalidateQueries({ queryKey: ['schedule', ws.id] }); qc.invalidateQueries({ queryKey: ['costs', ws.id, billing.tour_id] }) }} />
      )}
    </>
  )
}

function SumCard({ label, value, tone }: { label: string; value?: Record<string, number>; tone: 'red' | 'amber' | 'slate' }) {
  const color = { red: 'text-red-600', amber: 'text-amber-600', slate: 'text-slate-900' }[tone]
  return (
    <Card className="px-5 py-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={cn('mt-1 text-lg font-bold tabular-nums', color)}>{value ? moneyList(value) : '…'}</p>
    </Card>
  )
}
