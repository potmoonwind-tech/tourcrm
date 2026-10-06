import { useMutation } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { Modal } from '../../components/tour'
import { Button, ErrorText, Input } from '../../components/ui'
import { api, type QuoteDoc, type QuoteItem, type QuoteNight } from '../../lib/api'
import { wsPath } from '../../lib/data'
import { today } from '../../lib/dates'
import { useI18n } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { money } from '../../lib/utils'

type Edit = (fn: (d: QuoteDoc) => void) => void
interface Filled { days: number; nights: QuoteNight[]; items: QuoteItem[]; fx: QuoteDoc['fx']; warnings: string[] }
interface Repriced {
  doc: QuoteDoc; warnings: string[]; unlinked: number
  changes: { kind: 'night' | 'item'; id: string; name: string; currency: string; before: number | null; after: number | null }[]
}

const Warnings = ({ list }: { list: string[] }) => list.length === 0 ? null : (
  <ul className="mt-3 max-h-48 list-inside list-disc overflow-y-auto rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
    {list.map((w) => <li key={w}>{w}</li>)}
  </ul>
)

/** Hotels, meals and day services from the route, priced from the catalog for a travel date.
 *  Catalog lines filled before are replaced; lines typed by hand stay. */
export function FillFromRoute({ doc, edit, onClose }: { doc: QuoteDoc; edit: Edit; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [meals, setMeals] = useState(true)
  const [extras, setExtras] = useState(true)
  const [onDate, setOnDate] = useState(doc.valid_from ?? today())
  const [warnings, setWarnings] = useState<string[] | null>(null)
  const fill = useMutation({
    mutationFn: () => api<Filled>(wsPath(ws.id, '/quotes/route-fill'), {
      method: 'POST',
      body: { series_id: doc.series_id, on_date: onDate, meals, extras, currency: doc.currency, pax_min: doc.pax_min, pax_max: doc.pax_max },
    }),
    onSuccess: (r) => {
      edit((d) => {
        d.days = r.days
        // The route's hotels and prices; a night that keeps its hotel keeps what the route can't know
        // (season prices, the quad price).
        d.nights = r.nights.map((n, i) => {
          const old = d.nights[i]
          return old && old.vendor_id && old.vendor_id === n.vendor_id
            ? { ...n, season_prices: old.season_prices, price_quad: n.price_quad ?? old.price_quad }
            : n
        })
        const replaced = (i: QuoteItem) => !!i.service_id && (i.category === 'meal' ? meals : extras)
        d.items = [...r.items, ...d.items.filter((i) => !replaced(i))]
        for (const [cur, rate] of Object.entries(r.fx)) if (!(cur in d.fx)) d.fx[cur] = rate
        if (!d.valid_from) d.valid_from = onDate
      })
      if (r.warnings.length) setWarnings(r.warnings)
      else onClose()
    },
  })
  return (
    <Modal title={t('fillFromRoute')} onClose={onClose}>
      <p className="text-sm text-slate-600">{t('fillFromRouteHelp')}</p>
      <label className="mt-4 flex items-center gap-3 text-sm">
        <span className="font-medium text-slate-700">{t('pricesForDate')}</span>
        <Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value || today())} className="w-44" />
      </label>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={meals} onChange={(e) => setMeals(e.target.checked)} />{t('includeMeals')}</label>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={extras} onChange={(e) => setExtras(e.target.checked)} />{t('includeDayServices')}</label>
      {warnings && <Warnings list={warnings} />}
      <ErrorText error={fill.error} />
      <div className="mt-4 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>{warnings ? t('done') : t('cancel')}</Button>
        {!warnings && <Button disabled={fill.isPending} onClick={() => fill.mutate()}>{t('fillFromRoute')}</Button>}
      </div>
    </Modal>
  )
}

/** Take every catalog price again for another travel date; shows what changes before applying. */
export function UpdatePrices({ doc, edit, onClose }: { doc: QuoteDoc; edit: Edit; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [onDate, setOnDate] = useState(doc.valid_from ?? today())
  const check = useMutation({
    mutationFn: () => api<Repriced>(wsPath(ws.id, '/quotes/reprice'), { method: 'POST', body: { doc, on_date: onDate } }),
    meta: { silent: true },
  })
  const r = check.data
  const apply = () => {
    edit((d) => {
      d.nights = r!.doc.nights
      d.items = r!.doc.items
      d.valid_from = onDate
      if (d.valid_to && d.valid_to < onDate) d.valid_to = null
    })
    onClose()
  }
  return (
    <Modal wide title={t('updatePrices')} onClose={onClose}>
      <p className="text-sm text-slate-600">{t('updatePricesHelp')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-slate-700">{t('pricesForDate')}</span>
        <Input type="date" value={onDate} onChange={(e) => { setOnDate(e.target.value || today()); check.reset() }} className="w-44" />
        <Button variant="secondary" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>{t('checkPrices')}</Button>
      </div>
      <ErrorText error={check.error} />
      {r && (
        <div className="mt-4 space-y-2">
          {r.changes.length === 0 ? <p className="text-sm text-emerald-700">{t('pricesUnchanged')}</p> : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-200">
                {r.changes.map((c) => {
                  const diff = (c.after ?? 0) - (c.before ?? 0)
                  return (
                    <tr key={c.kind + c.id}>
                      <td className="py-1.5 pr-3">{c.name}</td>
                      <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-slate-500">
                        {c.before === null ? '—' : money(c.before)} <ArrowRight size={12} className="inline" /> <b className="text-slate-900">{money(c.after ?? 0)}</b> {c.currency}
                      </td>
                      <td className={`w-20 py-1.5 text-right tabular-nums ${diff > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                        {diff > 0 ? '+' : ''}{money(diff)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {r.unlinked > 0 && <p className="text-xs text-slate-500">{t('unlinkedLines', { n: r.unlinked })}</p>}
          <Warnings list={r.warnings} />
        </div>
      )}
      <div className="mt-4 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        {r && r.changes.length > 0 && <Button onClick={apply}>{t('applyPrices')}</Button>}
      </div>
    </Modal>
  )
}
