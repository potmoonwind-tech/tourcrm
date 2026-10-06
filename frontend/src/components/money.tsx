import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Landmark } from 'lucide-react'
import { Label, type Tone } from './overlay'
import { useState, type FormEvent } from 'react'
import { api, type ExchangeRate, type Payable, type PayableStatus, type PayMethod, type Tour, can } from '../lib/api'
import { useMembers, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { CodeChip, Modal } from './tour'
import { Button, ErrorText, Field, Input, Select } from './ui'

interface RateSuggestion { source: string; on: string; base: string; rates: Record<string, number> }

/**
 * "Use the National Bank rate": fills rate boxes with today's official rates (National Bank of
 * Georgia, via the bank's public API) as a starting point. Nothing is saved until the agency
 * presses Save — the rate is theirs to decide.
 */
export function NbgButton({ currencies, onRates }: { currencies: string[]; onRates: (rates: Record<string, number>) => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const get = useMutation({
    mutationFn: () => api<RateSuggestion>(`/workspaces/${ws.id}/exchange-rates/suggest?currencies=${currencies.join(',')}`),
    onSuccess: (r) => onRates(r.rates),
    meta: { silent: true },
  })
  if (!currencies.length) return null
  const missing = get.data ? currencies.filter((c) => !(c in get.data.rates)) : []
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Button type="button" size="sm" variant="secondary" disabled={get.isPending} onClick={() => get.mutate()} title={t('nbgHelp')}>
        <Landmark size={14} />{t('useNbgRate')}
      </Button>
      {get.data && <span className="text-slate-600">{t('nbgFilled', { date: fmt(get.data.on, lang) })}{missing.length > 0 && ` · ${t('nbgNotQuoted', { list: missing.join(', ') })}`}</span>}
      {get.isError && <span className="text-red-700">{t('nbgUnavailable')}</span>}
    </span>
  )
}

/**
 * Totals need a rate for every currency used: prices can be in GEL, USD, EUR… and the agency
 * decides the rate itself ("1 USD = 2.70 GEL"). When some are missing, the total is not shown
 * as a fake 0 — this box asks for exactly those rates, right where the total is. Saving updates
 * the amounts already calculated.
 */
export function RatesNeeded({ currencies, compact }: { currencies: string[]; compact?: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [rates, setRates] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: async () => {
      const url = `/workspaces/${ws.id}/exchange-rates`
      const current = await api<ExchangeRate[]>(url)
      const merged = new Map(current.map((r) => [r.currency, String(r.rate)]))
      for (const [c, v] of Object.entries(rates)) if (Number(v) > 0) merged.set(c, v)
      return api(url, { method: 'PUT', body: [...merged].map(([currency, rate]) => ({ currency, rate })) })
    },
    onSuccess: () => { setRates({}); qc.invalidateQueries() },
  })
  if (!currencies.length) return null
  const canSet = can(ws, 'operations', 'finance')
  return (
    <div className={cn('rounded-lg border border-red-200 bg-red-50 text-sm text-red-900', compact ? 'px-3 py-2' : 'px-4 py-3')}>
      <p className="flex items-start gap-2 font-medium"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{t('ratesNeeded', { list: currencies.join(', '), base: ws.base_currency })}</p>
      {canSet ? (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {currencies.map((c) => {
            const v = Number(rates[c])
            return (
              <label key={c} className="flex items-center gap-1.5">
                <span className="whitespace-nowrap">1 {c} =</span>
                <Input type="number" step="0.000001" min="0" required value={rates[c] ?? ''} placeholder="0.00"
                  onChange={(e) => setRates({ ...rates, [c]: e.target.value })} className="h-8 w-28 text-right" aria-label={`1 ${c} = ? ${ws.base_currency}`} />
                <span className="font-medium">{ws.base_currency}</span>
                {v > 0 && <span className="text-xs text-red-800/70">(1 {ws.base_currency} = {(1 / v).toFixed(4)} {c})</span>}
              </label>
            )
          })}
          <Button type="submit" size="sm" disabled={save.isPending}>{t('saveRates')}</Button>
          <NbgButton currencies={currencies} onRates={(r) => setRates({ ...rates, ...Object.fromEntries(Object.entries(r).map(([c, v]) => [c, String(v)])) })} />
          <ErrorText error={save.error} />
        </form>
      ) : <p className="mt-1 text-xs">{t('ratesAskManager')}</p>}
      {!compact && <p className="mt-2 text-xs text-red-800/70">{t('ratesYourOwn')}</p>}
    </div>
  )
}

const STATUS_TONE: Record<PayableStatus, Tone> = { paid: 'green', partial: 'blue', unpaid: 'orange', overdue: 'red' }

export function PayStatusPill({ status }: { status: PayableStatus }) {
  const { t } = useI18n()
  return (
    <Label tone={STATUS_TONE[status]}>{t(`payStatus_${status}`)}</Label>
  )
}

/** Record money paid to a vendor for a tour; amount defaults to what is still open. */
export function PaymentModal({ payable, onClose, onDone }: { payable: Payable; onClose: () => void; onDone: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const [f, setF] = useState({
    amount: payable.balance > 0 ? payable.balance.toFixed(2) : '', paid_on: today(),
    method: 'bank' as PayMethod, reference: '', notes: '',
  })
  // Who handed over the money: the company account (""), a team member ("user:<id>") or a guide/driver
  // of this tour from the cash they hold ("staff:<vendor id>").
  const [by, setBy] = useState('')
  const members = useMembers()
  const tour = useQuery({ queryKey: ['tour', ws.id, payable.tour_id], queryFn: () => api<Tour>(wsPath(ws.id, `/tours/${payable.tour_id}`)) })
  const staff = [...new Map((tour.data?.staff ?? []).filter((s) => s.vendor.id !== payable.vendor.id).map((s) => [s.vendor.id, s])).values()]
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${payable.tour_id}/payments`), {
      method: 'POST', body: {
        ...f, vendor_id: payable.vendor.id, currency: payable.currency,
        paid_by_user_id: by.startsWith('user:') ? by.slice(5) : null, paid_by_vendor_id: by.startsWith('staff:') ? by.slice(6) : null,
      },
    }),
    onSuccess: () => { onDone(); onClose() },
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <Modal title={t('recordPayment')} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }} className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <div className="flex items-center gap-2"><CodeChip code={payable.tour_code} color={payable.tour_color} /><b>{payable.vendor.name}</b></div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-slate-600">
            <span>{t('total')}<br /><b className="text-slate-900">{money(payable.total, payable.currency)}</b></span>
            <span>{t('paid')}<br /><b className="text-slate-900">{money(payable.paid, payable.currency)}</b></span>
            <span>{t('due')}<br /><b className="text-slate-900">{payable.due_date ? fmt(payable.due_date, lang) : '—'}</b></span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`${t('amount')} (${payable.currency})`}>
            <Input type="number" step="0.01" min="0.01" required autoFocus value={f.amount} onChange={set('amount')} />
          </Field>
          <Field label={t('paidOn')}><Input type="date" required value={f.paid_on} onChange={set('paid_on')} /></Field>
          <Field label={t('method')}>
            <Select value={f.method} onChange={set('method')}>
              {(['bank', 'cash', 'card', 'other'] as const).map((m) => <option key={m} value={m}>{t(`method_${m}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('reference')}><Input value={f.reference} onChange={set('reference')} /></Field>
        </div>
        <Field label={t('paidWho')} hint={by.startsWith('staff:') ? t('paidByStaffHint') : t('paidByHint')}>
          <Select value={by} onChange={(e) => {
            setBy(e.target.value)
            if (e.target.value.startsWith('staff:')) setF({ ...f, method: 'cash' })
          }}>
            <option value="">{t('paidByCompany')}</option>
            {staff.length > 0 && (
              <optgroup label={t('paidByStaffGroup')}>
                {staff.map((s) => <option key={s.vendor.id} value={`staff:${s.vendor.id}`}>{s.vendor.name} · {t(`role_${s.role}` as TKey)}</option>)}
              </optgroup>
            )}
            {(members.data ?? []).length > 0 && (
              <optgroup label={t('paidByTeamGroup')}>
                {(members.data ?? []).map((m) => <option key={m.user_id} value={`user:${m.user_id}`}>{m.full_name || m.email}</option>)}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field label={t('notes')}><Input value={f.notes} onChange={set('notes')} /></Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={save.isPending}>{t('recordPayment')}</Button>
        </div>
      </form>
    </Modal>
  )
}
