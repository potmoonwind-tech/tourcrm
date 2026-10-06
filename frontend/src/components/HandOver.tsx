/**
 * Hand some of a person's days to someone else: Nino guides days 1–3, Aram days 4–5 in Armenia.
 * Shows what those days cost with each (their own day price), then splits the assignment; the
 * costs are worked out again and both people see the change. Server: app/routers/staff_change.py.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, ROLE_VENDOR_TYPES, type StaffAssignment, type Tour } from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { addDays, diffDays } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { awayDuring } from './GuideInfo'
import { Dialog } from './overlay'
import { VendorSelect } from './tour'
import { Button, ErrorText, Field, Input, Select } from './ui'

interface Preview {
  from_day: number; to_day: number; days: number; currency: string
  old_cost: number | null; new_cost: number | null; difference: number | null; missing_prices: string[]; changes: string[]
}

export function HandOver({ tour, staff, onClose, onDone }: { tour: Tour; staff: StaffAssignment; onClose: () => void; onDone: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const vendors = useVendors()
  const n = diffDays(tour.start_date, tour.end_date) + 1
  const first = staff.start_day, last = staff.end_day ?? n
  const days = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const [fromDay, setFromDay] = useState(Math.min(first + 1, last))
  const [toDay, setToDay] = useState(last)
  const [to, setTo] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const url = wsPath(ws.id, `/tours/${tour.id}/staff/${staff.id}/hand-over`)
  const body = (preview: boolean) => ({ vendor_id: to, from_day: fromDay, to_day: toDay, note, preview })
  const preview = useMutation({ mutationFn: () => api<Preview>(url, { method: 'POST', body: body(true) }), meta: { silent: true } })
  const confirm = useMutation({
    mutationFn: () => api<Preview>(url, { method: 'POST', body: body(false) }),
    onSuccess: () => {
      for (const k of ['changes', 'costs', 'alerts', 'bookings']) qc.invalidateQueries({ queryKey: [k] })
      onDone()
      onClose()
    },
  })
  useEffect(() => { if (to) preview.mutate() }, [to, fromDay, toDay]) // eslint-disable-line react-hooks/exhaustive-deps
  const p = preview.data
  const dateOf = (d: number) => addDays(tour.start_date, d - 1).slice(5).split('-').reverse().join('.')
  const dayLabel = (d: number) => `${t('day')} ${d} · ${dateOf(d)}${tour.days[d - 1]?.city ? ` · ${tour.days[d - 1].city}` : ''}`
  const from = addDays(tour.start_date, fromDay - 1), until = addDays(tour.start_date, toDay - 1)
  const name = vendors.data?.find((v) => v.id === to)?.name

  return (
    <Dialog title={t('handOverTitle', { name: staff.vendor.name })} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">{t('handOverHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('handOverFrom')}>
            <Select value={fromDay} onChange={(e) => { const v = Number(e.target.value); setFromDay(v); if (toDay < v) setToDay(v) }}>
              {days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
            </Select>
          </Field>
          <Field label={t('handOverTo')}>
            <Select value={toDay} onChange={(e) => setToDay(Number(e.target.value))}>
              {days.filter((d) => d >= fromDay).map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={t('handOverWho')}>
          <VendorSelect vendors={(vendors.data ?? []).filter((v) => v.id !== staff.vendor.id)} types={ROLE_VENDOR_TYPES[staff.role]} value={to} onChange={setTo}
            note={(v) => [v.languages?.length ? ` · ${v.languages.join(', ')}` : '', awayDuring(v, from, until) ? ` — ${t('notAvailableShort')}` : ''].join('')} />
        </Field>
        {p && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><p className="text-xs text-slate-500">{staff.vendor.name}</p><p className="font-semibold tabular-nums">{p.old_cost === null ? '—' : money(p.old_cost, p.currency)}</p></div>
              <div><p className="text-xs text-slate-500">{name}</p><p className="font-semibold tabular-nums">{p.new_cost === null ? '—' : money(p.new_cost, p.currency)}</p></div>
              <div><p className="text-xs text-slate-500">{t('changeHotelDiff')}</p>
                <p className={cn('font-bold tabular-nums', (p.difference ?? 0) > 0 ? 'text-red-600' : 'text-emerald-700')}>
                  {p.difference === null ? '—' : `${p.difference > 0 ? '+' : ''}${money(p.difference, p.currency)}`}</p>
              </div>
            </div>
            <p className="mt-2 text-center text-xs text-slate-500">{t('handOverDays', { n: p.days })}</p>
            {p.missing_prices.length > 0 && <ul className="mt-2 list-inside list-disc text-xs text-amber-800">{p.missing_prices.map((m) => <li key={m}>{m}</li>)}</ul>}
          </div>
        )}
        <Field label={t('notes')}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={t('handOverNotePh')} /></Field>
        <ErrorText error={preview.error || confirm.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button disabled={!to || confirm.isPending} onClick={() => confirm.mutate()}>{t('handOverConfirm')}</Button>
        </div>
      </div>
    </Dialog>
  )
}
