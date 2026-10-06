import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ScheduleOut, type Tour } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useDebounced } from '../lib/hooks'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { money } from '../lib/utils'
import { CURRENCIES } from '../pages/Onboarding'
import { Modal } from './tour'
import { Button, ErrorText, Field, Input, Select } from './ui'

/** Draft the client's invoices for a tour from their payment terms: deposit + balance, or one. */
export function ScheduleModal({ tour, onClose }: { tour: Tour; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const url = wsPath(ws.id, `/tours/${tour.id}/invoice-schedule`)
  const [f, setF] = useState<{ total: string; currency: string; description: string } | null>(null)
  const body = f ? { total: f.total || null, currency: f.currency, description: f.description } : {}
  const key = useDebounced(JSON.stringify(body), 300)
  const preview = useQuery({
    queryKey: ['schedule-preview', ws.id, tour.id, key],
    queryFn: () => api<ScheduleOut>(`${url}/preview`, { method: 'POST', body: JSON.parse(key) }),
    placeholderData: (prev) => prev,
  })
  const p = preview.data
  // Start from what the server suggests (the price the tour was sold at).
  useEffect(() => {
    if (p && !f) setF({ total: p.total ? String(p.total) : '', currency: p.currency, description: p.description })
  }, [p, f])
  const create = useMutation({
    mutationFn: () => api<ScheduleOut>(url, { method: 'POST', body }),
    onSuccess: () => {
      for (const k of ['invoices', 'invoice', 'profit', 'debts']) qc.invalidateQueries({ queryKey: [k, ws.id] })
      onClose()
    },
  })
  const terms = p?.terms
  return (
    <Modal wide title={t('paymentSchedule')} onClose={onClose}>
      <div className="space-y-4">
        {p && (
          <p className="text-sm text-slate-600">
            {p.client ? <b>{p.client.name}</b> : <span className="text-red-600">{t('tourHasNoClient')} · {t('tourHasNoClientFix')}</span>}
            {terms && <> · {p.source === 'client' ? t('termsOfClient') : t('termsOfAgency')}: {terms.deposit_percent > 0
              ? t('termsSummary', { pct: terms.deposit_percent, days: terms.deposit_days, before: terms.balance_days_before })
              : t('termsSummaryNoDeposit', { before: terms.balance_days_before })}</>}
          </p>
        )}
        {f && (
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem_6rem]">
            <Field label={t('description')}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <Field label={t('total')}><Input type="number" min="0.01" step="0.01" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} className="text-right" /></Field>
            <Field label={t('currency')}>
              <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
            </Field>
          </div>
        )}
        {p && p.parts.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {p.parts.map((x) => (
              <li key={x.kind} className="flex items-center gap-3 px-4 py-2.5">
                <CalendarClock size={16} className="text-brand-600" />
                <span className="min-w-0 flex-1 font-medium">{t(`part_${x.kind}` as TKey)}{x.kind !== 'full' && ` · ${x.percent}%`}</span>
                <span className="text-slate-500">{t('dueOn', { date: fmt(x.due_date, lang, { day: 'numeric', month: 'short', year: 'numeric' }) })}</span>
                <span className="w-32 text-right font-semibold tabular-nums">{money(x.amount, p.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {p && p.parts.length === 1 && terms && terms.deposit_percent > 0 && <p className="text-xs text-slate-500">{t('tooLateForDeposit')}</p>}
        {p && p.existing.length > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('alreadyInvoiced', { list: p.existing.map((x) => `${x.number ?? t('draftNumber')} (${money(x.total)})`).join(', ') })}
          </p>
        )}
        <ErrorText error={preview.error || create.error} />
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button disabled={!p?.client || !p.parts.length || create.isPending} onClick={() => create.mutate()}>
            {t((p?.parts.length ?? 0) === 1 ? 'createOneDraftInvoice' : 'createDraftInvoices', { n: p?.parts.length ?? 0 })}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
