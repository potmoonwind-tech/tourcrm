import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask } from '../components/overlay'
import { AlertTriangle, Ban } from 'lucide-react'
import { useState } from 'react'
import { Modal } from '../components/tour'
import { Button, ErrorText, Field, Input } from '../components/ui'
import { api, type CancelPreview, type Tour } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useDebounced } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { money } from '../lib/utils'

/** Cancel a tour in one step: the client's penalty and refund, every vendor's penalty. */
export function CancelTourModal({ tour, onClose, onDone }: { tour: Tour; onClose: () => void; onDone: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const [on, setOn] = useState(today())
  const [clientPct, setClientPct] = useState('')
  const [vendorPct, setVendorPct] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const body = {
    on_date: on, client_percent: clientPct === '' ? null : clientPct, note,
    vendor_percents: Object.fromEntries(Object.entries(vendorPct).filter(([, v]) => v !== '')),
  }
  const key = useDebounced(JSON.stringify({ ...body, note: '' }), 300)
  const preview = useQuery({
    queryKey: ['cancelPreview', ws.id, tour.id, key],
    queryFn: () => api<CancelPreview>(wsPath(ws.id, `/tours/${tour.id}/cancellation/preview`), { method: 'POST', body: JSON.parse(key) }),
    placeholderData: (prev) => prev, retry: false,
  })
  const apply = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${tour.id}/cancel`), { method: 'POST', body }),
    onSuccess: () => {
      for (const k of ['tour', 'tours', 'costs', 'budget', 'invoices', 'incidents', 'profit', 'schedule', 'debts']) qc.invalidateQueries({ queryKey: [k, ws.id] })
      onDone()
    },
  })
  const p = preview.data
  const cur = ws.base_currency

  return (
    <Modal wide title={t('cancelTourTitle', { code: tour.code })} onClose={onClose}>
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
          <Field label={t('cancelledOn')}><Input type="date" value={on} max={tour.end_date} onChange={(e) => setOn(e.target.value || today())} /></Field>
          {p && (
            <p className="self-end pb-2 text-sm text-slate-600">
              {t('daysBeforeArrival', { n: p.days_left, date: fmt(tour.start_date, lang) })}
            </p>
          )}
        </div>
        <ErrorText error={preview.error} />
        {p && (
          <>
            <section className="space-y-2">
              <h3 className="font-semibold">{t('clientSide')}</h3>
              <p className="text-sm text-slate-600">
                {p.scale_source === 'client' ? t('scaleFromClient') : t('scaleFromAgency')}{' · '}
                {p.rule ? t('ruleApplies', { days: p.rule.within_days, pct: p.rule.percent }) : clientPct === '' ? t('noRuleApplies') : t('percentChanged')}
              </p>
              <label className="flex items-center gap-2 text-sm">
                {t('clientPays')}
                <Input type="number" min={0} max={100} step="0.01" value={clientPct} placeholder={String(p.percent)}
                  onChange={(e) => setClientPct(e.target.value)} className="h-8 w-20 px-2 text-right" />%
              </label>
              {p.client.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="text-right text-xs text-slate-500">
                      <tr><th className="py-1 text-left">{t('document')}</th><th className="py-1">{t('cancelBase')}</th><th className="py-1">{t('paid')}</th>
                        <th className="py-1">{t('cancelKeep')}</th><th className="py-1">{t('cancelCredit')}</th><th className="py-1">{t('refundDue')}</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-right tabular-nums">
                      {p.client.map((c, i) => (
                        <tr key={i}>
                          <td className="py-1.5 text-left">{c.new_invoice ? t('newPenaltyInvoice') : t('invoiceN', { n: c.number ?? '' })}</td>
                          <td className="py-1.5">{money(c.base, c.currency)}</td>
                          <td className="py-1.5">{money(c.paid)}</td>
                          <td className="py-1.5 font-semibold">{money(c.keep)}</td>
                          <td className="py-1.5 text-rose-700">{c.credit ? `− ${money(c.credit)}` : '—'}</td>
                          <td className="py-1.5 text-violet-700">{c.refund ? money(c.refund) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {p.drafts_removed.length > 0 && <p className="text-xs text-slate-500">{t('draftsRemoved', { list: p.drafts_removed.join(', ') })}</p>}
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">{t('vendorSide')}</h3>
              {p.vendors.length === 0 ? <p className="text-sm text-slate-500">{t('nothingBooked')}</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-sm">
                    <thead className="text-right text-xs text-slate-500">
                      <tr><th className="py-1 text-left">{t('vendor')}</th><th className="py-1">{t('booked')}</th><th className="py-1">{t('terms')}</th>
                        <th className="py-1">%</th><th className="py-1">{t('penalty')}</th><th className="py-1">{t('owesUsBack')}</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-right tabular-nums">
                      {p.vendors.map((v) => (
                        <tr key={v.vendor.id + v.currency}>
                          <td className="py-1.5 text-left">{v.vendor.name}<span className="block text-xs text-slate-500">{t('daysBeforeFirst', { n: v.days_left })}</span></td>
                          <td className="py-1.5">{money(v.booked, v.currency)}</td>
                          <td className="py-1.5 text-xs text-slate-500">{v.rule ? t('ruleShort', { days: v.rule.within_days, pct: v.rule.percent }) : t('free')}</td>
                          <td className="py-1.5">
                            <Input type="number" min={0} max={100} step="0.01" value={vendorPct[v.vendor.id] ?? ''} placeholder={String(v.percent)}
                              onChange={(e) => setVendorPct({ ...vendorPct, [v.vendor.id]: e.target.value })} className="h-7 w-16 px-1 text-right" aria-label="%" />
                          </td>
                          <td className="py-1.5 font-semibold">{money(v.penalty)}</td>
                          <td className="py-1.5 text-violet-700">{v.owes_back ? money(v.owes_back) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {p.free_lines > 0 && <p className="text-xs text-slate-500">{t('freeLinesDropped', { n: p.free_lines })}</p>}
            </section>

            <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
              <p className="font-semibold">{t('whenCancelled')}</p>
              <ul className="list-inside list-disc">
                <li>{t('cancelEffectStatus')}</li>
                {p.client.some((c) => c.credit > 0) && <li>{t('cancelEffectCredit')}</li>}
                {p.client.some((c) => c.new_invoice) && <li>{t('cancelEffectInvoice')}</li>}
                <li>{t('cancelEffectVendors', { amount: money(p.vendor_penalty_base, cur) })}</li>
                <li>{t('cancelEffectRecord')}</li>
              </ul>
            </div>
            {p.warnings.length > 0 && (
              <ul className="list-inside list-disc rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cancelReasonPh')} maxLength={500} />
          </>
        )}
        <ErrorText error={apply.error} />
        <div className="flex flex-wrap items-center gap-3">
          {p && !p.can_apply && <span className="flex items-center gap-1.5 text-sm text-amber-700"><AlertTriangle size={15} />{t('needsAdminShort')}</span>}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{t('keepTour')}</Button>
          <Button variant="danger" disabled={!p || !p.can_apply || apply.isPending}
            onClick={() => void ask({ title: t('confirmCancelTour'), danger: true }).then((ok) => ok && apply.mutate())}><Ban size={15} />{t('cancelTour')}</Button>
        </div>
      </div>
    </Modal>
  )
}

