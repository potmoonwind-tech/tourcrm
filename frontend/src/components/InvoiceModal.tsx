import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Drawer, Label, type Tone, ask, useGuardedClose, useUnsaved } from './overlay'
import { FileMinus, Plus, Printer, Trash2, Undo2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, type Invoice, type InvoiceDisplay, type PayMethod, type Tour, type TourSummary } from '../lib/api'
import { useClients, wsPath } from '../lib/data'
import { addDays, fmt, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { CURRENCIES } from '../pages/Onboarding'
import { CodeChip } from './tour'
import { Button, ErrorText, Field, Input, MiniField, Select } from './ui'

const DISPLAY_TONE: Record<InvoiceDisplay, Tone> = {
  draft: 'light', void: 'grey', unpaid: 'orange', partial: 'blue', paid: 'green', overdue: 'red',
  refund_due: 'purple', credit_note: 'dark',
}

export function InvoiceStatusPill({ status }: { status: InvoiceDisplay }) {
  const { t } = useI18n()
  return <Label tone={DISPLAY_TONE[status]}>{t(`inv_${status}`)}</Label>
}

type Line = { description: string; quantity: string; unit_price: string }

/** Create (optionally pre-filled from a tour), edit a draft, or work with an issued invoice. */
export function InvoiceModal({ invoiceId, fromTour, onClose }: { invoiceId?: string; fromTour?: TourSummary & Partial<Pick<Tour, 'price_pp' | 'price_currency'>>; onClose: () => void }) {
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const [id, setId] = useState(invoiceId)
  const inv = useQuery({
    queryKey: ['invoice', ws.id, id], enabled: !!id,
    queryFn: () => api<Invoice>(wsPath(ws.id, `/invoices/${id}`)),
  })
  const changed = (newId?: string) => {
    if (newId) setId(newId)
    qc.invalidateQueries({ queryKey: ['invoices', ws.id] })
    qc.invalidateQueries({ queryKey: ['invoice', ws.id] })
    qc.invalidateQueries({ queryKey: ['debts', ws.id] })
    qc.invalidateQueries({ queryKey: ['profit', ws.id] })
  }
  if (id && !inv.data) return null
  // key: after a payment the form starts again from the new balance
  if (inv.data && inv.data.status !== 'draft') {
    return <IssuedView key={`${inv.data.id}-${inv.data.paid}-${inv.data.credited}`} inv={inv.data} onClose={onClose}
      onChanged={() => changed()} onOpen={(next) => changed(next)} />
  }
  return <DraftForm inv={inv.data} fromTour={fromTour} onClose={onClose} onSaved={changed} />
}

function DraftForm({ inv, fromTour, onClose, onSaved }: {
  inv?: Invoice; fromTour?: TourSummary & Partial<Pick<Tour, 'price_pp' | 'price_currency'>>; onClose: () => void; onSaved: (id?: string) => void
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const clients = useClients()
  const tours = useQuery({ queryKey: ['tours', ws.id, 'all'], queryFn: () => api<TourSummary[]>(wsPath(ws.id, '/tours')) })
  const now = today()
  const [f, setF] = useState(() => inv ? {
    client_id: inv.client.id, tour_id: inv.tour?.id ?? '', issue_date: inv.issue_date, due_date: inv.due_date,
    currency: inv.currency, notes: inv.notes,
  } : {
    client_id: fromTour?.client_id ?? '', tour_id: fromTour?.id ?? '', issue_date: now,
    // Usually due a week before arrival, but never before today.
    due_date: fromTour && addDays(fromTour.start_date, -7) > now ? addDays(fromTour.start_date, -7) : addDays(now, 7),
    currency: fromTour?.price_currency ?? ws.base_currency, notes: '',
  })
  const [lines, setLines] = useState<Line[]>(() => inv
    ? inv.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), unit_price: l.unit_price.toFixed(2) }))
    : [{ description: fromTour ? `Tour ${fromTour.code} · ${fromTour.start_date} – ${fromTour.end_date}` : '',
         quantity: String(fromTour ? (fromTour.participant_count || fromTour.pax || 1) : 1),
         unit_price: fromTour?.price_pp != null ? fromTour.price_pp.toFixed(2) : '' }])
  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0)
  const guarded = useGuardedClose(useUnsaved({ f, lines }), onClose)
  // A credit note belongs to its invoice: client, tour and currency come from it.
  const isCN = inv?.kind === 'credit_note'
  const orig = useQuery({
    queryKey: ['invoice', ws.id, inv?.credits?.id], enabled: isCN,
    queryFn: () => api<Invoice>(wsPath(ws.id, `/invoices/${inv!.credits!.id}`)),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const body = () => ({ ...f, tour_id: f.tour_id || null, due_date: isCN ? f.issue_date : f.due_date,
    lines: lines.filter((l) => l.description.trim()) })
  const save = useMutation({
    mutationFn: async (andIssue: boolean) => {
      const saved = inv
        ? await api<Invoice>(wsPath(ws.id, `/invoices/${inv.id}`), { method: 'PUT', body: body() })
        : await api<Invoice>(wsPath(ws.id, '/invoices'), { method: 'POST', body: body() })
      if (andIssue) await api(wsPath(ws.id, `/invoices/${saved.id}/issue`), { method: 'POST' })
      return saved
    },
    onSuccess: (saved, andIssue) => { onSaved(saved.id); if (!andIssue) onClose() },
  })
  const del = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/invoices/${inv!.id}`), { method: 'DELETE' }),
    onSuccess: () => { onSaved(); onClose() },
  })

  return (
    <Drawer size="lg" title={inv ? `${isCN ? t('creditNote') : t('invoice')} · ${t('draftNumber')}` : t('newInvoice')} onClose={guarded}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(false) }} className="space-y-4">
        {isCN && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
            {t('cnCorrects', { number: inv?.credits?.number ?? '' })}
            {orig.data && ` ${t('cnLeft', { amount: money(orig.data.creditable, orig.data.currency) })}`}
          </p>
        )}
        <fieldset disabled={isCN} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('billTo')}>
            <Select required value={f.client_id} onChange={set('client_id')}>
              <option value="">—</option>
              {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label={t('tours')}>
            <Select value={f.tour_id} onChange={set('tour_id')}>
              <option value="">—</option>
              {tours.data?.map((x) => <option key={x.id} value={x.id}>{x.code}{x.client_name ? ` · ${x.client_name}` : ''}</option>)}
            </Select>
          </Field>
        </fieldset>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t('issueDate')}><Input type="date" required value={f.issue_date} onChange={set('issue_date')} /></Field>
          {!isCN && <Field label={t('dueDate')}><Input type="date" required min={f.issue_date} value={f.due_date} onChange={set('due_date')} /></Field>}
          <Field label={t('currency')}>
            <Select disabled={isCN} value={f.currency} onChange={set('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
        </div>

        <div className="space-y-2">
          <div className="hidden grid-cols-[1fr_6rem_8rem_8rem_2rem] gap-2 text-xs font-semibold uppercase text-slate-500 sm:grid">
            <span>{t('description')}</span><span className="text-right">{t('qty')}</span>
            <span className="text-right">{t('unitPrice')}</span><span className="text-right">{t('amount')}</span><span />
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_5rem_7rem_2rem] gap-2 sm:grid-cols-[1fr_6rem_8rem_8rem_2rem]">
              <Input className="col-span-4 sm:col-span-1" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
              <Input type="number" step="0.01" min="0.01" className="text-right" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
              <Input type="number" step="0.01" className="text-right" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} />
              <span className="hidden self-center text-right font-medium tabular-nums sm:block">
                {money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
              </span>
              <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}
                className="rounded-md p-2 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button type="button" size="sm" variant="secondary" onClick={() => setLines([...lines, { description: '', quantity: '1', unit_price: '' }])}>
              <Plus size={14} />{t('addLine')}
            </Button>
            <span className="text-lg font-bold tabular-nums">{t('total')}: {money(total, f.currency)}</span>
          </div>
        </div>
        <Field label={t('notes')}><Input value={f.notes} onChange={set('notes')} /></Field>
        <p className="text-xs text-slate-500">{isCN ? t('cnIssueHelp') : t('issueHelp')}</p>
        <ErrorText error={save.error || del.error} />
        <div className="flex flex-wrap items-center gap-3">
          {inv && <Button type="button" variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && del.mutate())}>{t('delete')}</Button>}
          <div className="flex-1" />
          <Button type="button" variant="secondary" onClick={guarded}>{t('cancel')}</Button>
          <Button type="submit" variant="secondary" disabled={save.isPending}>{t('saveDraft')}</Button>
          <Button type="button" disabled={save.isPending || total <= 0 || !f.client_id}
            onClick={() => void ask({ title: t('confirmIssue') }).then((ok) => ok && save.mutate(true))}>{isCN ? t('issueCreditNote') : t('issue')}</Button>
        </div>
      </form>
    </Drawer>
  )
}

function IssuedView({ inv, onClose, onChanged, onOpen }: {
  inv: Invoice; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const url = wsPath(ws.id, `/invoices/${inv.id}`)
  const [pay, setPay] = useState({ amount: inv.balance > 0 ? inv.balance.toFixed(2) : '', received_on: today(), method: 'bank' as PayMethod, reference: '' })
  const receive = useMutation({ mutationFn: () => api(`${url}/payments`, { method: 'POST', body: pay }), onSuccess: onChanged })
  const delPay = useMutation({ mutationFn: (pid: string) => api(`${url}/payments/${pid}`, { method: 'DELETE' }), onSuccess: onChanged })
  const voidIt = useMutation({ mutationFn: () => api(`${url}/void`, { method: 'POST' }), onSuccess: onChanged })
  const isCN = inv.kind === 'credit_note'
  const credit = useMutation({
    mutationFn: () => api<Invoice>(`${url}/credit-note`, { method: 'POST', body: {} }),
    onSuccess: (cn) => onOpen(cn.id),
  })
  const refundDue = inv.balance < 0 ? -inv.balance : 0
  const [refund, setRefund] = useState({ amount: refundDue ? refundDue.toFixed(2) : '', paid_on: today(), method: 'bank' as PayMethod, reference: '' })
  const doRefund = useMutation({ mutationFn: () => api(`${url}/refunds`, { method: 'POST', body: refund }), onSuccess: onChanged })

  return (
    <Drawer size="lg" title={`${isCN ? t('creditNote') : t('invoice')} ${inv.number ?? ''}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <InvoiceStatusPill status={inv.display_status} />
          <span className="font-semibold">{inv.client.name}</span>
          {inv.tour && <CodeChip code={inv.tour.code} color={inv.tour.color} />}
          <div className="flex-1" />
          <a href={`/w/${ws.id}/print/invoice/${inv.id}`} target="_blank" rel="noreferrer"
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Printer size={14} />{t('printPdf')}
          </a>
        </div>
        {isCN && inv.credits && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
            {t('cnCorrects', { number: inv.credits.number ?? '' })}{' '}
            <button type="button" className="font-semibold underline" onClick={() => onOpen(inv.credits!.id)}>{t('openInvoice')}</button>
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-4">
          <span>{t('issueDate')}<br /><b>{fmt(inv.issue_date, lang, { day: 'numeric', month: 'short', year: 'numeric' })}</b></span>
          {!isCN && <span>{t('dueDate')}<br /><b>{fmt(inv.due_date, lang, { day: 'numeric', month: 'short', year: 'numeric' })}</b></span>}
          <span>{isCN ? t('credited') : t('total')}<br /><b>{money(inv.total, inv.currency)}</b>
            {inv.credited > 0 && <span className="block text-xs text-rose-700">− {money(inv.credited)} {t('credited').toLowerCase()}</span>}</span>
          {!isCN && (refundDue > 0
            ? <span>{t('refundDue')}<br /><b className="text-violet-700">{money(refundDue, inv.currency)}</b></span>
            : <span>{t('balanceDue')}<br /><b className={cn(inv.balance > 0 && inv.display_status === 'overdue' && 'text-red-600')}>{money(inv.balance, inv.currency)}</b></span>)}
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td className="py-2">{l.description}</td>
                <td className="py-2 text-right tabular-nums text-slate-500">{l.quantity} × {money(l.unit_price)}</td>
                <td className="py-2 text-right font-medium tabular-nums">{money(l.amount, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {inv.payments.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('received')}</h3>
            <ul className="divide-y divide-slate-100 text-sm">
              {inv.payments.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-1.5">
                  <span className="w-24 text-slate-500">{fmt(p.received_on, lang)}</span>
                  <span className="flex-1 text-slate-500">{p.amount < 0 && <b className="mr-1 text-violet-700">{t('refund')}</b>}{t(`method_${p.method}`)}{p.reference && ` · ${p.reference}`}</span>
                  <span className="font-semibold tabular-nums">{money(p.amount, inv.currency)}</span>
                  <button type="button" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && delPay.mutate(p.id))}
                    className="rounded-md p-1 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!isCN && inv.status === 'issued' && inv.balance > 0 && (
          <form onSubmit={(e) => { e.preventDefault(); receive.mutate() }} className="rounded-lg border border-slate-200 p-3">
            <h3 className="mb-2 text-sm font-semibold">{t('receivePayment')}</h3>
            <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[8rem_10rem_8rem_1fr_auto]">
              <MiniField label={`${t('amount')} (${inv.currency})`}><Input type="number" step="0.01" min="0.01" required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></MiniField>
              <MiniField label={t('receivedOn')}><Input type="date" required value={pay.received_on} onChange={(e) => setPay({ ...pay, received_on: e.target.value })} /></MiniField>
              <MiniField label={t('method')}><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PayMethod })}>
                {(['bank', 'cash', 'card', 'other'] as const).map((m) => <option key={m} value={m}>{t(`method_${m}`)}</option>)}
              </Select></MiniField>
              <MiniField label={t('reference')}><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></MiniField>
              <Button type="submit" disabled={receive.isPending}>{t('add')}</Button>
            </div>
          </form>
        )}
        {refundDue > 0 && (
          <form onSubmit={(e) => { e.preventDefault(); doRefund.mutate() }} className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-violet-900"><Undo2 size={14} />{t('recordRefund')}</h3>
            <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[8rem_10rem_8rem_1fr_auto]">
              <MiniField label={`${t('amount')} (${inv.currency})`}><Input type="number" step="0.01" min="0.01" max={refundDue} required value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></MiniField>
              <MiniField label={t('paidOn')}><Input type="date" required value={refund.paid_on} onChange={(e) => setRefund({ ...refund, paid_on: e.target.value })} /></MiniField>
              <MiniField label={t('method')}><Select value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value as PayMethod })}>
                {(['bank', 'cash', 'card', 'other'] as const).map((m) => <option key={m} value={m}>{t(`method_${m}`)}</option>)}
              </Select></MiniField>
              <MiniField label={t('reference')}><Input value={refund.reference} onChange={(e) => setRefund({ ...refund, reference: e.target.value })} /></MiniField>
              <Button type="submit" disabled={doRefund.isPending}>{t('add')}</Button>
            </div>
          </form>
        )}
        {!isCN && inv.credit_notes.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('creditNotes')}</h3>
            <ul className="divide-y divide-slate-100 text-sm">
              {inv.credit_notes.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onOpen(c.id)} className="flex w-full items-center gap-3 py-1.5 text-left hover:bg-slate-50">
                    <span className="font-mono font-semibold">{c.number ?? t('draftNumber')}</span>
                    <span className="flex-1 text-slate-500">{c.status === 'draft' ? t('inv_draft') : ''}</span>
                    <span className="tabular-nums text-rose-700">− {money(c.total, inv.currency)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {inv.notes && <p className="text-sm text-slate-600">{inv.notes}</p>}
        <ErrorText error={receive.error || delPay.error || voidIt.error || credit.error || doRefund.error} />
        <div className="flex flex-wrap items-center gap-3">
          {inv.status === 'issued' && inv.payments.length === 0 && (
            <Button variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmVoid'), danger: true }).then((ok) => ok && voidIt.mutate())}>{isCN ? t('voidCreditNote') : t('voidInvoice')}</Button>
          )}
          {!isCN && inv.status === 'issued' && inv.creditable > 0 && (
            <Button variant="secondary" disabled={credit.isPending} onClick={() => credit.mutate()} title={t('creditNoteHelp')}>
              <FileMinus size={15} />{t('newCreditNote')}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{t('done')}</Button>
        </div>
      </div>
    </Drawer>
  )
}
