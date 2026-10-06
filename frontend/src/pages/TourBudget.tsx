import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, type Tone } from '../components/overlay'
import { ask } from '../components/overlay'
import { AlertTriangle, ClipboardList, Link2, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, ErrorText, Input, Select } from '../components/ui'
import { api, type Budget, type BudgetLine, type Tour } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'

export const budgetKey = (wsId: string, tourId: string) => ['budget', wsId, tourId]

export function useBudget(tourId: string) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: budgetKey(ws.id, tourId), queryFn: () => api<Budget>(wsPath(ws.id, `/tours/${tourId}/budget`)) })
}

const STATUS: Record<BudgetLine['status'], Tone> = { no_cost: 'light', on_budget: 'green', over: 'red', under: 'blue' }

/** The budget (the calculation frozen at the size sold) against the actual cost lines. */
export function BudgetPanel({ tour, onChanged }: { tour: Tour; onChanged: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const budget = useBudget(tour.id)
  const base = wsPath(ws.id, `/tours/${tour.id}/budget`)
  const done = (b: Budget) => { qc.setQueryData(budgetKey(ws.id, tour.id), b); onChanged() }
  const [size, setSize] = useState('')
  const take = useMutation({
    mutationFn: (tourists: number | null) => api<Budget>(base, { method: 'POST', body: { tourists } }),
    onSuccess: (b) => { done(b); setSize('') },
  })
  const addCosts = useMutation({
    mutationFn: (lineIds: string[] | null) => api<Budget>(`${base}/costs`, { method: 'POST', body: { line_ids: lineIds } }),
    onSuccess: done,
  })
  const b = budget.data
  if (!b || (!b.has_quote && !b.set)) return null
  const cur = b.currency
  const range = b.quote_range
  const inRange = (n: number) => !range || (n >= range[0] && n <= range[1])

  if (!b.set) {
    return (
      <Card className="flex flex-wrap items-center gap-3 px-5 py-4">
        <ClipboardList size={18} className="text-brand-600" />
        <p className="min-w-0 flex-1 text-sm">{t('budgetNotSet', { name: b.quote_name ?? '' })}</p>
        <Button size="sm" variant="secondary" disabled={take.isPending} onClick={() => take.mutate(null)}>{t('takeBudget')}</Button>
        <ErrorText error={take.error} />
      </Card>
    )
  }

  const tot = b.totals
  const uncosted = b.lines.filter((l) => l.status === 'no_cost')
  const groupChanged = b.tourists !== null && b.actual_tourists > 0 && b.actual_tourists !== b.tourists

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 px-5 py-3">
        <h3 className="font-semibold">{t('budgetVsActual')}</h3>
        <span className="text-sm text-slate-500">
          {b.quote_id ? <Link to={`/w/${ws.id}/calculations/${b.quote_id}`} className="text-brand-600 hover:underline">{b.source}</Link> : b.source}
          {b.set_at && ` · ${fmt(b.set_at.slice(0, 10), lang)}`}
        </span>
        <div className="flex-1" />
        {b.has_quote && (
          <span className="flex items-center gap-1.5">
            <Input type="number" min={range?.[0]} max={range?.[1]} value={size} onChange={(e) => setSize(e.target.value)}
              placeholder={String(b.tourists ?? '')} className="h-8 w-16 px-2 text-right" aria-label={t('tourists')} title={t('budgetSizeHelp')} />
            <Button size="sm" variant="secondary" disabled={take.isPending}
              onClick={() => void ask({ title: t('confirmRetakeBudget') }).then((ok) => ok && take.mutate(size ? Number(size) : null))}><RefreshCw size={14} />{t('takeBudgetAgain')}</Button>
          </span>
        )}
      </div>
      <ErrorText error={take.error || addCosts.error} />
      {groupChanged && (
        <p className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-2 text-sm text-amber-800">
          <AlertTriangle size={15} className="shrink-0" />
          {t('budgetGroupChanged', { now: b.actual_tourists, then: b.tourists ?? 0 })}
          {b.has_quote && inRange(b.actual_tourists) && (
            <button type="button" className="ml-auto shrink-0 font-semibold underline" disabled={take.isPending}
              onClick={() => take.mutate(b.actual_tourists)}>
              {t('budgetRetakeAt', { n: b.actual_tourists })}
            </button>
          )}
        </p>
      )}
      {b.warnings.length > 0 && (
        <ul className="list-inside list-disc border-b border-amber-100 bg-amber-50 px-5 py-2 text-sm text-amber-800">{b.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}

      <div className="grid grid-cols-2 gap-4 border-b border-slate-100 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label={t('plannedCost')} value={money(tot.planned, cur)} />
        <Metric label={t('actualCost')} value={money(tot.actual, cur)} />
        <Metric label={t('varianceOnCosted')} value={signed(tot.variance)} tone={tone(tot.variance)} hint={t('varianceHelp')} />
        <Metric label={t('notCostedYet')} value={money(tot.not_costed, cur)} tone={tot.not_costed ? 'text-slate-500' : undefined} hint={t('notCostedHelp')} />
        <Metric label={t('notInBudget')} value={money(tot.unbudgeted, cur)} tone={tot.unbudgeted ? 'text-amber-700' : undefined} />
        {b.incidents.length > 0 && <Metric label={t('incidents')} value={money(tot.incidents, cur)} tone="text-rose-700" hint={t('incidentsNetHelp')} />}
        {/* Before the first invoice there is no revenue to set the costs against: not a loss. */}
        <Metric label={t('profit')} value={tot.revenue_actual ? money(tot.profit_actual, cur) : '—'}
          hint={tot.revenue_actual ? `${t('planned')}: ${money(tot.profit_planned, cur)}` : `${t('budgetNoInvoiceYet')} · ${t('planned')}: ${money(tot.profit_planned, cur)}`}
          tone={tot.revenue_actual && tot.profit_actual < 0 ? 'text-red-600' : undefined} />
      </div>
      {b.missing_rates && <p className="flex items-center gap-2 px-5 pt-3 text-sm text-amber-700"><AlertTriangle size={15} /><span>{t('someRatesMissing')} <Link to={`/w/${ws.id}/settings/general`} className="font-medium underline">{t('setRatesNow')}</Link></span></p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
            <tr>
              <th className="px-4 py-2">{t('budgetLine')}</th>
              <th className="px-4 py-2 text-right">{t('planned')}</th><th className="px-4 py-2 text-right">{t('actual')}</th>
              <th className="px-4 py-2 text-right">{t('difference')}</th><th className="px-4 py-2" /><th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {b.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2">
                  {l.day && <span className="mr-1.5 text-xs text-slate-400">{t('day')} {l.day}</span>}
                  <span className="font-medium">{l.name}</span>
                  <span className="block text-xs text-slate-500">
                    {l.vendor?.name ?? t(`qcat_${l.category}` as TKey)} · {qtyText(l)}{l.costs > 1 && ` · ${t('nCostLines', { n: l.costs })}`}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{money(l.planned_base)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums">{l.actual_base === null ? '—' : money(l.actual_base)}</td>
                <td className={cn('whitespace-nowrap px-4 py-2 text-right tabular-nums', l.variance_base === null ? 'text-slate-300' : tone(l.variance_base))}>
                  {l.variance_base === null ? '—' : signed(l.variance_base)}
                </td>
                <td className="px-4 py-2">
                  <Label tone={STATUS[l.status]}>{t(`budget_${l.status}` as TKey)}</Label>
                </td>
                <td className="px-2 py-2 text-right">
                  {l.status === 'no_cost' && (
                    <button type="button" onClick={() => addCosts.mutate([l.id])} title={t('addPlannedCost')}
                      className="rounded p-1 text-brand-600 hover:bg-brand-50"><Plus size={15} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {uncosted.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-5 py-3">
          <p className="min-w-0 flex-1 text-xs text-slate-500">{t('addMissingHelp')}</p>
          <Button size="sm" variant="secondary" disabled={addCosts.isPending} onClick={() => addCosts.mutate(null)}>
            <Plus size={14} />{t('addMissingCosts', { n: uncosted.length })}
          </Button>
        </div>
      )}
      {b.incidents.length > 0 && (
        <div className="border-t border-rose-100 bg-rose-50/40">
          <h4 className="px-5 pt-3 text-sm font-semibold text-rose-900">{t('incidents')} · {b.incidents.length}</h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="text-right text-xs text-slate-500">
                <tr><th /><th className="px-4 py-1.5">{t('cost')}</th><th className="px-4 py-1.5">{t('vendorCredit')}</th>
                  <th className="px-4 py-1.5">{t('chargedToClient')}</th><th className="px-4 py-1.5">{t('effectOnProfit')}</th></tr>
              </thead>
              <tbody className="divide-y divide-rose-100 text-right tabular-nums">
                {b.incidents.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-1.5 text-left">{i.title} <span className="text-xs text-slate-500">· {t(`carried_${i.carried_by}` as TKey)}</span></td>
                    <td className="px-4 py-1.5">{money(i.cost)}</td>
                    <td className="px-4 py-1.5">{i.vendor_credit ? money(i.vendor_credit) : '—'}</td>
                    <td className="px-4 py-1.5">{i.client_charge ? money(i.client_charge) : '—'}{i.client_charge_draft > 0 && <span className="block text-xs text-slate-500">{t('draftAmount', { amount: money(i.client_charge_draft) })}</span>}</td>
                    <td className={cn('px-4 py-1.5 font-semibold', i.net < 0 ? 'text-red-600' : 'text-emerald-700')}>{i.net > 0 ? '+' : ''}{money(i.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {b.unbudgeted.length > 0 && <Unbudgeted budget={b} base={base} onDone={done} />}
    </Card>
  )

  function signed(x: number) { return `${x > 0 ? '+' : ''}${money(x)}` }
  function tone(x: number) { return Math.abs(x) < 0.5 ? 'text-slate-500' : x > 0 ? 'text-red-600' : 'text-emerald-700' }
  function qtyText(l: BudgetLine) {
    return l.kind === 'hotel' ? l.notes : `${Number(l.quantity.toFixed(2))} × ${money(l.unit_price)} ${l.currency}`
  }
}

/** Costs that belong to no budget line: tick them and choose where they belong. */
function Unbudgeted({ budget, base, onDone }: { budget: Budget; base: string; onDone: (b: Budget) => void }) {
  const { t, lang } = useI18n()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState('')
  const link = useMutation({
    mutationFn: () => api<Budget>(`${base}/link`, { method: 'POST', body: { cost_ids: [...picked], budget_line_id: target } }),
    onSuccess: (b) => { onDone(b); setPicked(new Set()); setTarget('') },
  })
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // Lines of the same kind first: a meal cost most likely belongs to a meal line.
  const cats = new Set<string>(budget.unbudgeted.filter((c) => picked.has(c.id)).map((c) => c.category))
  const options = [...budget.lines].sort((a, b) => Number(!cats.has(costCat(a.category))) - Number(!cats.has(costCat(b.category))))
  return (
    <div className="border-t border-amber-100 bg-amber-50/40">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <h4 className="text-sm font-semibold text-amber-900">{t('notInBudget')} · {budget.unbudgeted.length}</h4>
        <p className="min-w-0 flex-1 text-xs text-amber-800">{t('notInBudgetHelp')}</p>
        <Select value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 w-64 text-xs" disabled={!picked.size}>
          <option value="">{t('linkToLine')}</option>
          {options.map((l) => <option key={l.id} value={l.id}>{l.day ? `${t('day')} ${l.day} · ` : ''}{l.name}</option>)}
        </Select>
        <Button size="sm" variant="secondary" disabled={!picked.size || !target || link.isPending} onClick={() => link.mutate()}><Link2 size={14} />{t('linkN', { n: picked.size })}</Button>
      </div>
      <ErrorText error={link.error} />
      <ul className="divide-y divide-amber-100 text-sm">
        {budget.unbudgeted.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-center gap-3 px-5 py-1.5 hover:bg-amber-50">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="w-20 text-slate-500">{fmt(c.service_date, lang)}</span>
              <span className="min-w-0 flex-1 truncate">{c.vendor?.name && <b className="font-medium">{c.vendor.name} · </b>}{c.description}</span>
              <span className="tabular-nums">{money(c.amount, c.currency)}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

const COST_CAT: Record<string, string> = { activity: 'ticket', border: 'visa', tips: 'other' }
const costCat = (quoteCategory: string) => COST_CAT[quoteCategory] ?? quoteCategory

function Metric({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums', tone)}>{value}</p>
      {hint && hint.length < 40 && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  )
}
