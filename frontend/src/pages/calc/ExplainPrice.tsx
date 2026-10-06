import { ChevronDown } from 'lucide-react'
import { Drawer } from '../../components/overlay'
import { Spinner } from '../../components/ui'
import { useState, type ReactNode } from 'react'
import { QUOTE_CATEGORIES, type QuoteDoc } from '../../lib/api'
import { useI18n, type TKey } from '../../lib/i18n'
import { cn, money } from '../../lib/utils'
import { useBreakdown } from './ItemsTab'

const ENGINE_LABEL: Record<string, string> = {
  profit: 'Profit', markup: 'Markup', add_pp: 'Per person', add_group: 'Per group', commission: 'Commission', vat_margin: 'VAT on margin',
  vat: 'VAT', discount: 'Discount', relative: 'Share of another price', round: 'Rounding', formula: 'Formula',
}

/** "Explain this price": every step from cost lines to the rounded price, for one group size. */
export function ExplainPrice({ doc, tourists, season = '', onClose }: { doc: QuoteDoc; tourists: number; season?: string; onClose: () => void }) {
  const { t } = useI18n()
  const bd = useBreakdown(doc, tourists, season)
  const [lines, setLines] = useState(false)
  const b = bd.data
  if (!b) return <Drawer size="lg" title={t('explainPrice')} onClose={onClose}><div className="flex justify-center py-10"><Spinner /></div></Drawer>
  const s = b.steps
  const cur = doc.currency
  // The agency's own recipe (else the classic "best of three profits, then rounding").
  const recipe = !!doc.recipe?.length && !!s.recipe?.length
  const stepName = (r: { label: string; kind: string }) => (r.label === ENGINE_LABEL[r.kind] ? t(`step_${r.kind}` as TKey) : r.label)
  const nights = b.hotel_nights.length
  const profit = b.tier.profit_pp
  // Category subtotals for the group, largest first.
  const byCat = QUOTE_CATEGORIES.map((c) => ({ c, amount: b.items.filter((i) => i.category === c && i.included).reduce((x, i) => x + i.amount, 0) }))
    .filter((x) => x.amount !== 0).sort((a, z) => z.amount - a.amount)
  const maxCat = Math.max(1, ...byCat.map((x) => Math.abs(x.amount)))
  const modeLabel = t(`round_${s.rounding_mode}` as TKey).toLowerCase()
  // Composition of the DBL price: shared costs, hotels, profit (and what rounding took or added).
  const parts = [
    { label: t('exSplit', { n: tourists }), value: s.shared_pp, cls: 'bg-brand-500' },
    { label: t('calcHotels'), value: s.hotel_dbl_pp, cls: 'bg-sky-400' },
    { label: t('profit'), value: profit, cls: 'bg-emerald-500' },
  ]
  const totalParts = parts.reduce((x, p) => x + Math.max(p.value, 0), 0) || 1

  return (
    <Drawer size="lg" title={`${t('explainPrice')} · ${b.tier.label}`} onClose={onClose}>
      <div className="space-y-5 text-sm">
        {/* The answer first */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-slate-500">{t('exPriceDbl')}</p>
            <p className="text-[32px] font-semibold leading-10 tabular-nums text-brand-700">{money(b.tier.price_dbl, cur)}</p>
          </div>
          <div className="text-right">
            <p className="text-slate-500">{t('exPriceSgl')}</p>
            <p className="text-xl font-semibold tabular-nums">{money(b.tier.price_sgl, cur)}</p>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-500">{t('exComposition')}</p>
          <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
            {parts.map((p) => <div key={p.label} className={p.cls} style={{ width: `${(Math.max(p.value, 0) / totalParts) * 100}%` }} />)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {parts.map((p) => <span key={p.label} className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', p.cls)} />{p.label} {money(p.value)}</span>)}
          </div>
        </div>

        {/* Step by step */}
        <ol className="space-y-1">
          <Step label={t('exLines')} value={money(s.lines_total, cur)}>
            <div className="mt-2 space-y-1.5">
              {byCat.map(({ c, amount }) => (
                <div key={c} className="grid grid-cols-[8rem_1fr_7rem] items-center gap-2 text-xs">
                  <span className="text-slate-600">{t(`qcat_${c}` as TKey)}</span>
                  <span className="h-2 rounded-full bg-slate-100"><span className="block h-2 rounded-full bg-slate-400" style={{ width: `${(Math.abs(amount) / maxCat) * 100}%` }} /></span>
                  <span className="text-right tabular-nums">{money(amount)}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setLines(!lines)} className="mt-2 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
              <ChevronDown size={16} className={cn(lines && 'rotate-180')} />{lines ? t('exHideLines') : t('exShowLines')}
            </button>
            {lines && (
              <table className="mt-2 w-full text-xs">
                <tbody className="divide-y divide-slate-200">
                  {b.items.filter((i) => i.included && i.amount !== 0).map((i) => (
                    <tr key={i.index}><td className="py-1">{i.name}</td><td className="py-1 text-right tabular-nums">{money(i.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Step>
          {s.leader_room > 0 && <Step op="+" label={t('exLeaderRooms')} value={money(s.leader_room, cur)} />}
          {(s.staff_room ?? 0) > 0 && <Step op="+" label={t('exStaffRooms')} value={money(s.staff_room!, cur)} />}
          <Step op="=" label={t('exGroupCost')} value={money(s.lines_total + s.leader_room + (s.staff_room ?? 0), cur)} strong />
          {(b.people ?? []).some((p) => p.role !== 'pay') && (
            <li className="px-3 py-1 text-xs text-slate-500">
              {t('exWhoIsShared')}: {(b.people ?? []).filter((p) => p.role !== 'pay').map((p) => `${p.name} × ${p.count} ${money(p.for_others)}`).join(' · ')}
            </li>
          )}
          <Step op="÷" label={(b.people ?? []).filter((p) => p.role === 'pay').length > 1 ? t('exSplitPayers') : t('exSplit', { n: tourists })} value={money(s.shared_pp, cur)} />
          <Step op="+" label={t('exHotels', { n: nights })} value={money(s.hotel_dbl_pp, cur)} />
          <Step op="=" label={t('exCostPp')} value={money(b.tier.cost_dbl, cur)} strong />
          {recipe ? <>
            {s.recipe!.map((r, k) => (
              <Step key={k} op={r.amount >= 0 ? '+' : '−'} label={stepName(r)} value={money(Math.abs(r.amount), cur)} />
            ))}
            <Step op="=" label={t('stepPrice')} value={money(b.tier.price_dbl, cur)} strong accent />
          </> : <>
          <Step op="+" label={t('exProfit')} value={money(profit, cur)}>
            <ul className="mt-2 space-y-1 text-xs">
              <Candidate win={s.profit_rule === 'group'} label={t('exProfitGroup', { p: money(Number(doc.profit_group)), n: tourists })} value={s.profit_group_pp} />
              <Candidate win={s.profit_rule === 'minimum'} label={t('exProfitMin')} value={s.profit_min_pp} />
              <Candidate win={s.profit_rule === 'floor'} label={t('exProfitFloor', { pct: Number(doc.margin_floor_pct) })} value={s.profit_floor_pp} />
            </ul>
          </Step>
          <Step op="=" label={t('exBeforeRound')} value={money(s.unrounded_dbl, cur)} />
          <Step op="→" label={s.rounding_step ? t('exRounded', { mode: modeLabel, step: s.rounding_step }) : t('exNoRounding')}
            value={money(b.tier.price_dbl, cur)} strong accent />
          </>}
        </ol>
        {(b.tier.types?.length ?? 0) > 1 && (
          <ul className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {b.tier.types!.slice(1).map((x) => (
              <li key={x.id} className="flex justify-between"><span>{x.name} × {x.count}: {t('exCost')} {money(x.cost)}</span><b>{money(x.price, cur)}</b></li>
            ))}
          </ul>
        )}

        {/* Single room in one line */}
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {t('exPriceSgl')}: {money(s.shared_pp)} + {t('exHotelsSgl', { n: nights }).toLowerCase()} {money(s.hotel_sgl_pp)}
          {recipe ? (s.single_profit ? ` → ${t('exSameSteps')}` : ` (${t('exNoSglProfit')})`)
            : s.single_profit ? ` + ${t('profit').toLowerCase()} ${money(profit)}` : ` (${t('exNoSglProfit')})`}
          {recipe ? ' → ' : <>{' = '}{money(s.unrounded_sgl)} → </>}<b>{money(b.tier.price_sgl, cur)}</b>
        </p>
      </div>
    </Drawer>
  )
}

function Step({ op, label, value, strong, accent, children }: {
  op?: string; label: string; value: string; strong?: boolean; accent?: boolean; children?: ReactNode
}) {
  return (
    <li className={cn('rounded-lg px-3 py-2', strong && 'bg-slate-50')}>
      <div className="flex items-baseline gap-3">
        <span className="w-4 shrink-0 text-center font-mono text-slate-400">{op}</span>
        <span className={cn('flex-1', strong && 'font-semibold')}>{label}</span>
        <span className={cn('tabular-nums', strong && 'font-semibold', accent && 'text-base font-semibold text-brand-700')}>{value}</span>
      </div>
      {children && <div className="pl-7">{children}</div>}
    </li>
  )
}

function Candidate({ win, label, value }: { win: boolean; label: string; value: number }) {
  return (
    <li className={cn('flex items-baseline justify-between gap-3 rounded px-2 py-1', win ? 'bg-emerald-50 font-semibold text-emerald-800' : 'text-slate-500')}>
      <span>{win ? '✓ ' : ''}{label}</span><span className="tabular-nums">{money(value)}</span>
    </li>
  )
}
