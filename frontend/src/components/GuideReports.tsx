/**
 * Office side of guide money (tour → Costs): give a cash advance, and approve or reject what the
 * guide reported from the phone page. Approved = a locked cost line for the guide, so the guide's
 * row in Payables shows who owes whom (negative = the guide returns cash).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banknote, Check, Image as ImageIcon, RotateCcw, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, type StaffAssignment, type Tour } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { money } from '../lib/utils'
import { CURRENCIES } from '../pages/Onboarding'
import { Dialog, Label } from './overlay'
import { Button, Card, ErrorText, Field, Input, Select } from './ui'

export interface FieldEntry {
  id: string; kind: 'expense' | 'extra'; category: string; day: number | null; description: string
  amount: string; currency: string; status: 'pending' | 'approved' | 'rejected'; office_note: string
  has_receipt: boolean; created_at: string
}
interface OfficeEntry extends FieldEntry { staff_id: string; person: string; role: string }

const REPORTS = ['guide', 'tour_leader', 'assistant']
export const STATUS_TONE = { pending: 'orange', approved: 'green', rejected: 'red' } as const

export function GuideReports({ tour, onChanged }: { tour: Tour; onChanged: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const base = wsPath(ws.id, `/tours/${tour.id}`)
  const key = ['fieldExpenses', ws.id, tour.id]
  const rows = useQuery({ queryKey: key, queryFn: () => api<OfficeEntry[]>(`${base}/field-expenses`) })
  const [advanceFor, setAdvanceFor] = useState<StaffAssignment | null>(null)
  const [rejecting, setRejecting] = useState<OfficeEntry | null>(null)
  const done = () => { qc.invalidateQueries({ queryKey: key }); onChanged() }
  const decide = useMutation({
    mutationFn: ({ id, approve, note = '' }: { id: string; approve: boolean; note?: string }) =>
      api(`${base}/field-expenses/${id}/decide`, { method: 'POST', body: { approve, note } }),
    onSuccess: () => { setRejecting(null); done() },
  })
  const reopen = useMutation({ mutationFn: (id: string) => api(`${base}/field-expenses/${id}/reopen`, { method: 'POST' }), onSuccess: done })
  const guides = tour.staff.filter((s) => REPORTS.includes(s.role))
  if (!guides.length) return null
  const list = rows.data ?? []
  const pending = list.filter((x) => x.status === 'pending').length
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
        <h3 className="text-sm font-semibold">{t('guideReports')}</h3>
        {pending > 0 && <Label tone="orange" wide={false}>{t('guideReportsWaiting', { n: pending })}</Label>}
        <div className="flex-1" />
        {guides.map((g) => (
          <Button key={g.id} size="sm" variant="secondary" onClick={() => setAdvanceFor(g)} disabled={!!tour.closed_at}>
            <Banknote size={14} />{t('cashAdvanceFor', { name: g.vendor.name })}
          </Button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">{t('guideReportsEmpty')}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              {x.has_receipt ? (
                <a href={`/api${base}/field-expenses/${x.id}/receipt`} target="_blank" rel="noopener noreferrer" title={t('receipt')}
                  className="block h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                  <img src={`/api${base}/field-expenses/${x.id}/receipt`} alt={t('receipt')} className="h-full w-full object-cover" loading="lazy" />
                </a>
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-200 text-slate-300" title={t('noReceipt')}><ImageIcon size={18} /></span>
              )}
              <span className="min-w-48 flex-1">
                <span className="block font-medium">{x.kind === 'extra' ? `${t('extraPay')}: ` : ''}{x.description}</span>
                <span className="block text-xs text-slate-500">
                  {x.person}{x.day ? ` · ${t('day')} ${x.day}` : ''}{x.kind === 'expense' ? ` · ${t(`cat_${x.category}` as TKey)}` : ''} · {fmt(x.created_at.slice(0, 10), lang)}
                  {x.office_note && ` · “${x.office_note}”`}
                </span>
              </span>
              <span className="w-28 text-right font-semibold tabular-nums">{money(Number(x.amount), x.currency)}</span>
              <Label tone={STATUS_TONE[x.status]} wide={false}>{t(`fieldStatus_${x.status}` as TKey)}</Label>
              {x.status === 'pending' ? (
                <span className="flex gap-1">
                  <Button size="sm" disabled={decide.isPending || !!tour.closed_at} onClick={() => decide.mutate({ id: x.id, approve: true })}><Check size={14} />{t('approve')}</Button>
                  <Button size="sm" variant="secondary" disabled={!!tour.closed_at} onClick={() => setRejecting(x)}><X size={14} />{t('reject')}</Button>
                </span>
              ) : (
                <button type="button" title={t('undoDecision')} aria-label={t('undoDecision')} disabled={reopen.isPending || !!tour.closed_at}
                  onClick={() => reopen.mutate(x.id)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><RotateCcw size={15} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="px-5"><ErrorText error={decide.error || reopen.error} /></div>
      {advanceFor && <AdvanceDialog tour={tour} staff={advanceFor} onClose={() => setAdvanceFor(null)} onDone={done} />}
      {rejecting && <RejectDialog entry={rejecting} busy={decide.isPending} onClose={() => setRejecting(null)}
        onReject={(note) => decide.mutate({ id: rejecting.id, approve: false, note })} />}
    </Card>
  )
}

function AdvanceDialog({ tour, staff, onClose, onDone }: { tour: Tour; staff: StaffAssignment; onClose: () => void; onDone: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [f, setF] = useState({ amount: '', currency: ws.base_currency, paid_on: today() })
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${tour.id}/staff/${staff.id}/advance`), { method: 'POST', body: f }),
    onSuccess: () => { onDone(); onClose() },
  })
  return (
    <Dialog title={t('cashAdvanceFor', { name: staff.vendor.name })} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
        <p className="text-sm text-slate-600">{t('cashAdvanceHelp')}</p>
        <div className="grid grid-cols-[1fr_7rem_10rem] gap-3">
          <Field label={t('amount')}><Input required autoFocus type="number" min="0.01" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label={t('currency')}>
            <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {[...new Set([ws.base_currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label={t('paidOn')}><Input type="date" required value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={save.isPending}>{t('save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

function RejectDialog({ entry, busy, onClose, onReject }: { entry: OfficeEntry; busy: boolean; onClose: () => void; onReject: (note: string) => void }) {
  const { t } = useI18n()
  const [note, setNote] = useState('')
  return (
    <Dialog title={t('rejectReport', { what: entry.description })} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); onReject(note) }}>
        <Field label={t('rejectWhy')} hint={t('rejectWhyHint')}><Input autoFocus maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" variant="danger" disabled={busy}>{t('reject')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
