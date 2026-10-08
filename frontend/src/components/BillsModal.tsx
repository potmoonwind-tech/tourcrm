import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Drawer, Label, type Tone, ask, askText } from './overlay'
import { Check, Flag, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, type BillState, type Payable, type TourBills } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { Button, ErrorText, Input, MiniField } from './ui'

const STATE_TONE: Record<Exclude<BillState, ''>, Tone> = { no_bill: 'light', matched: 'green', difference: 'orange', disputed: 'red' }

export function BillStatePill({ state }: { state: BillState }) {
  const { t } = useI18n()
  if (!state) return null
  return <Label tone={STATE_TONE[state]}>{t(`bill_${state}`)}</Label>
}

/** One vendor's bills on a tour: record them, compare with what we expected, accept or dispute. */
export function BillsModal({ tourId, payable, onClose, onChanged }: {
  tourId: string; payable: Payable; onClose: () => void; onChanged: () => void
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const url = wsPath(ws.id, `/tours/${tourId}/bills`)
  const key = ['bills', ws.id, tourId]
  const data = useQuery({ queryKey: key, queryFn: () => api<TourBills>(url) })
  const done = (out: TourBills) => { qc.setQueryData(key, out); onChanged() }
  const vid = payable.vendor.id
  const cur = payable.currency
  const [f, setF] = useState({ number: '', bill_date: today(), due_date: '', amount: '' })
  const add = useMutation({
    mutationFn: () => api<TourBills>(url, { method: 'POST', body: { vendor_id: vid, currency: cur, ...f, due_date: f.due_date || null } }),
    onSuccess: (out) => { done(out); setF({ number: '', bill_date: today(), due_date: '', amount: '' }) },
  })
  const act = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: string; body?: unknown }) =>
      api<TourBills>(wsPath(ws.id, path), { method, body }),
    onSuccess: done,
  })
  const g = data.data?.payables.find((p) => p.vendor.id === vid && p.currency === cur) ?? payable
  const bills = (data.data?.bills ?? []).filter((b) => b.vendor.id === vid && b.currency === cur)

  return (
    <Drawer size="lg" title={t('vendorBills', { vendor: payable.vendor.name })} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-sm">
          <span>{t('expected')}<br /><b className="tabular-nums">{money(g.total, cur)}</b></span>
          <span>{t('billed')}<br /><b className="tabular-nums">{money(g.billed, cur)}</b></span>
          <span>{t('difference')}<br />
            <b className={cn('tabular-nums', g.bill_state === 'difference' && 'text-amber-700')}>{g.bill_difference > 0 ? '+' : ''}{money(g.bill_difference)}</b>{' '}
            <BillStatePill state={g.bill_state} />
          </span>
        </div>
        {g.bill_state === 'difference' && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="min-w-0 flex-1">{g.bill_difference > 0 ? t('billedMore', { amount: money(g.bill_difference, cur) }) : t('billedLess', { amount: money(-g.bill_difference, cur) })}</span>
            <Button size="sm" disabled={act.isPending}
              onClick={() => void ask({ title: t('confirmAcceptBill'), message: t('confirmAcceptBillMsg', { amount: money(g.bill_difference, cur) }) })
                .then((ok) => ok && act.mutate({ path: `/tours/${tourId}/bills/accept`, method: 'POST', body: { vendor_id: vid, currency: cur } }))}>
              <Check size={14} />{t('acceptDifference')}
            </Button>
          </div>
        )}
        {bills.length > 0 && (
          <ul className="divide-y divide-slate-100 text-sm">
            {bills.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-24 text-slate-500">{fmt(b.bill_date, lang)}</span>
                <span className="min-w-0 flex-1">
                  <b className="font-mono">{b.number || '—'}</b>
                  {b.due_date && <span className="ml-2 text-xs text-slate-500">{t('dueOn', { date: fmt(b.due_date, lang) })}</span>}
                  {b.disputed && <span className="block text-xs text-red-700">{t('disputedBecause', { why: b.dispute_note })}</span>}
                </span>
                <span className="font-semibold tabular-nums">{money(b.amount, cur)}</span>
                {b.disputed
                  ? <Button size="sm" variant="secondary" onClick={() => act.mutate({ path: `/bills/${b.id}/resolve`, method: 'POST' })}>{t('resolve')}</Button>
                  : <Button size="sm" variant="ghost" title={t('dispute')}
                      onClick={() => void askText({ title: t('disputeWhy'), confirmLabel: t('dispute') }).then((why) => why && act.mutate({ path: `/bills/${b.id}/dispute`, method: 'POST', body: { note: why } }))}>
                      <Flag size={14} />{t('dispute')}
                    </Button>}
                <button type="button" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && act.mutate({ path: `/bills/${b.id}`, method: 'DELETE' }))} aria-label={t('delete')}
                  className="rounded-md p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(e) => { e.preventDefault(); add.mutate() }} className="rounded-lg border border-slate-200 p-3">
          <h3 className="mb-2 text-sm font-semibold">{t('recordBill')}</h3>
          <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_9.5rem_9.5rem_8rem_auto]">
            <MiniField label={t('billNumber')}><Input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></MiniField>
            <MiniField label={`${t('billDate')} *`}><Input type="date" required value={f.bill_date} onChange={(e) => setF({ ...f, bill_date: e.target.value })} /></MiniField>
            <MiniField label={t('dueDate')}><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></MiniField>
            <MiniField label={`${t('amount')} (${cur}) *`}><Input type="number" step="0.01" min="0" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="text-right" /></MiniField>
            <Button type="submit" disabled={add.isPending}>{t('add')}</Button>
          </div>
        </form>
        <p className="text-xs text-slate-500">{t('billsHelp', { pct: data.data?.tolerance_pct ?? 1 })}</p>
        <ErrorText error={add.error || act.error} />
      </div>
    </Drawer>
  )
}
