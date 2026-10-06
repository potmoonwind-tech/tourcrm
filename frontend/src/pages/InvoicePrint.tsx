import { useQuery } from '@tanstack/react-query'
import { useI18n } from '../lib/i18n'
import { Printer } from 'lucide-react'
import { useEffect } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { Button, FullPageSpinner } from '../components/ui'
import { api, type Client, type Invoice, can } from '../lib/api'
import { wsPath } from '../lib/data'
import { useMe } from '../lib/session'
import { money } from '../lib/utils'

/**
 * A clean A4 page for the browser's Print → Save as PDF. Always in English:
 * invoices go to foreign partner agencies.
 */
export function InvoicePrintPage() {
  const { t } = useI18n()
  const { workspaceId, invoiceId } = useParams()
  const { data: me } = useMe()
  const ws = me?.workspaces.find((w) => w.id === workspaceId)
  const allowed = can(ws, 'finance', 'sales')
  const inv = useQuery({
    queryKey: ['invoice', workspaceId, invoiceId], enabled: allowed,
    queryFn: () => api<Invoice>(wsPath(workspaceId!, `/invoices/${invoiceId}`)),
  })
  const client = useQuery({
    queryKey: ['client', workspaceId, inv.data?.client.id], enabled: !!inv.data,
    queryFn: () => api<Client>(wsPath(workspaceId!, `/clients/${inv.data!.client.id}`)),
  })
  useEffect(() => {
    if (inv.data) document.title = `${inv.data.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.data.number ?? 'draft'} · ${ws?.name ?? ''}`
  }, [inv.data, ws])

  if (!allowed) return <Navigate to="/" replace />
  if (!inv.data) return <FullPageSpinner />
  const i = inv.data
  const d = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end px-4 print:hidden">
        <Button onClick={() => window.print()}><Printer size={16} />{t('printPdf')}</Button>
      </div>
      <article className="mx-auto max-w-[210mm] bg-white p-12 text-[13px] leading-relaxed text-slate-800 shadow print:max-w-none print:p-0 print:shadow-none">
        <header className="flex items-start justify-between border-b-2 border-slate-900 pb-6">
          <div>
            <p className="text-2xl font-bold">{ws!.name}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-light uppercase tracking-widest text-slate-400">
              {i.status === 'draft' ? 'Draft' : i.kind === 'credit_note' ? 'Credit note' : 'Invoice'}
            </p>
            {i.kind === 'credit_note' && i.credits && <p className="mt-1 text-sm text-slate-600">Corrects invoice No. {i.credits.number}</p>}
            {i.number && <p className="mt-1 font-mono text-lg font-semibold">No. {i.number}</p>}
            {i.status === 'void' && <p className="mt-1 font-bold text-red-600">VOID</p>}
          </div>
        </header>

        <section className="mt-8 grid grid-cols-2 gap-8">
          <div>
            <p className="text-xs font-medium text-slate-500">Bill to</p>
            <p className="mt-1 text-base font-semibold">{i.client.name}</p>
            {client.data && (
              <div className="text-slate-600">
                {client.data.contact_person && <p>{client.data.contact_person}</p>}
                {client.data.country && <p>{client.data.country}</p>}
                {client.data.email && <p>{client.data.email}</p>}
              </div>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 self-start text-right">
            <dt className="text-slate-400">Issue date</dt><dd className="font-medium">{d(i.issue_date)}</dd>
            {i.kind !== 'credit_note' && <><dt className="text-slate-400">Due date</dt><dd className="font-medium">{d(i.due_date)}</dd></>}
            {i.tour && <><dt className="text-slate-400">Tour</dt><dd className="font-mono font-medium">{i.tour.code}</dd></>}
            <dt className="text-slate-400">Currency</dt><dd className="font-medium">{i.currency}</dd>
          </dl>
        </section>

        <table className="mt-10 w-full">
          <thead>
            <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Qty</th>
              <th className="py-2 text-right font-semibold">Unit price</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {i.lines.map((l, n) => (
              <tr key={n} className="border-b border-slate-100">
                <td className="py-3 pr-4">{l.description}</td>
                <td className="py-3 text-right tabular-nums">{l.quantity}</td>
                <td className="py-3 text-right tabular-nums">{money(l.unit_price)}</td>
                <td className="py-3 text-right font-medium tabular-nums">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 ml-auto w-72 space-y-1">
          <Row label={i.kind === 'credit_note' ? 'Total credited' : 'Total'} value={money(i.total, i.currency)} strong />
          {i.credited > 0 && <Row label="Credited" value={`− ${money(i.credited, i.currency)}`} />}
          {i.paid !== 0 && <Row label="Paid" value={`− ${money(i.paid, i.currency)}`} />}
          {i.kind !== 'credit_note' && (i.paid !== 0 || i.credited > 0) && (
            <Row label={i.balance < 0 ? 'To be refunded' : 'Balance due'} value={money(Math.abs(i.balance), i.currency)} strong />
          )}
        </div>

        {i.notes && <p className="mt-10 whitespace-pre-line border-t border-slate-200 pt-4 text-slate-600">{i.notes}</p>}
      </article>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-slate-300 pt-1 text-base font-bold' : 'text-slate-600'}`}>
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  )
}
