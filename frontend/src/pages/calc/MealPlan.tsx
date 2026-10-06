/**
 * How meals are priced: each restaurant's own price (the lines on the days), or a flat price per meal
 * by region, the way a spreadsheet does it ("Georgia 12.20 × 14 meals, Armenia 15 × 4, everyone eats").
 *
 * The flat price is ordinary lines and inputs, so the engine, scenarios and "who uses what" treat it like
 * anything else:  meals:main   price × (days × meals_per_day − meals_free − the other regions)
 *                 meals:<k>    price × meals_<k>
 *                 meals:staff  the driver and guide on free meals (guests pay their own; we feed them)
 * While it's on, the restaurant meals stay on the board but aren't counted.
 */
import { Plus, Utensils, X } from 'lucide-react'
import { useState } from 'react'
import { Dialog } from '../../components/overlay'
import { Button, ChoiceCard, Field, IconButton, Input, Select, Stepper } from '../../components/ui'
import type { QuoteDoc, QuoteItem } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/utils'
import { CURRENCIES } from '../Onboarding'
import { newItem } from './ItemsTab'
import type { EditFn } from './undo'

interface Region { key: string; name: string; price: string; currency: string; count: number }
interface Plan { perDay: number; free: number; regions: Region[]; staffPrice: string; staffCurrency: string }

const isPlanLine = (i: QuoteItem) => i.id.startsWith('meals:')
const isRestaurantMeal = (i: QuoteItem) => i.category === 'meal' && !isPlanLine(i)
const regionName = (i: QuoteItem) => i.name.includes(' · ') ? i.name.slice(i.name.indexOf(' · ') + 3) : i.name

function planOf(doc: QuoteDoc): Plan | null {
  const main = doc.items.find((i) => i.id === 'meals:main')
  if (!main) return null
  const v = doc.variables
  const staff = doc.items.find((i) => i.id === 'meals:staff')
  const others = doc.items.filter((i) => /^meals:\d+$/.test(i.id))
  const plan: Plan = {
    perDay: Number(v.meals_per_day ?? 2), free: Number(v.meals_free ?? 0),
    regions: [main, ...others].map((i) => {
      const key = i === main ? 'main' : i.id.slice(6)
      return { key, name: regionName(i), price: String(i.unit_price), currency: i.currency, count: key === 'main' ? 0 : Number(v[`meals_${key}`] ?? 0) }
    }),
    staffPrice: staff ? String(staff.unit_price) : '', staffCurrency: staff?.currency ?? doc.currency,
  }
  plan.regions[0].count = mainCount(doc.days, plan)
  return plan
}

const mainCount = (days: number, p: Plan) => Math.max(0, days * p.perDay - p.free - p.regions.slice(1).reduce((s, r) => s + r.count, 0))

/** One line in the trip: how meals are priced now, and a way to change it. */
export function MealsLine({ doc, edit }: { doc: QuoteDoc; edit: EditFn<QuoteDoc> }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const plan = planOf(doc)
  const restaurants = doc.items.filter((i) => isRestaurantMeal(i) && i.included).length
  const text = plan
    ? plan.regions.map((r) => `${r.name} ${r.count} × ${money(Number(r.price))} ${r.currency}`).join('  ·  ') + (plan.free ? `  ·  ${t('mealsFreeShort', { n: plan.free })}` : '')
    : t('nMealLines', { n: restaurants })
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 py-1 pl-3 pr-1 text-sm">
      <Utensils size={16} className="shrink-0 text-slate-500" aria-hidden />
      <span className="font-medium text-slate-800">{plan ? t('mealsFlat') : t('mealsByRestaurant')}</span>
      <span className="min-w-0 flex-1 text-slate-600">{text}</span>
      <Button variant="tertiary" size="sm" onClick={() => setOpen(true)} title={plan ? t('changeMeals') : t('useFlatPrice')}>{t('changeWord')}</Button>
      {open && <MealsDialog doc={doc} edit={edit} onClose={() => setOpen(false)} />}
    </div>
  )
}

function MealsDialog({ doc, edit, onClose }: { doc: QuoteDoc; edit: EditFn<QuoteDoc>; onClose: () => void }) {
  const { t } = useI18n()
  const current = planOf(doc)
  const [flat, setFlat] = useState(true)
  const [p, setP] = useState<Plan>(() => current ?? {
    perDay: 2, free: 0, staffPrice: '', staffCurrency: doc.currency,
    regions: [{ key: 'main', name: t('mealsAll'), price: '', currency: doc.currency, count: 0 }],
  })
  const restaurants = doc.items.filter(isRestaurantMeal).length
  const hasStaff = (doc.people ?? []).some((x) => x.role === 'staff' && x.count) || (!doc.people?.length && doc.staff > 0)
  const set = (patch: Partial<Plan>) => setP((x) => ({ ...x, ...patch }))
  const setRegion = (i: number, patch: Partial<Region>) => setP((x) => ({ ...x, regions: x.regions.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const rest = mainCount(doc.days, p)
  const total = doc.days * p.perDay - p.free

  const apply = () => edit((d) => {
    const old = new Map(d.items.filter(isPlanLine).map((i) => [i.id, i]))
    d.items = d.items.filter((i) => !isPlanLine(i))
    d.variables = Object.fromEntries(Object.entries(d.variables).filter(([k]) => !/^meals_/.test(k)))
    const notes = Object.fromEntries(Object.entries(d.variable_notes ?? {}).filter(([k]) => !/^meals_/.test(k)))
    if (!flat) {
      d.items.forEach((i) => { if (isRestaurantMeal(i)) i.included = true })
      d.variable_notes = notes
      return
    }
    const regions = p.regions.filter((r, k) => k === 0 || r.name.trim() || Number(r.price))
    const others = regions.slice(1).map((r, k) => ({ ...r, key: String(k + 2) }))
    d.variables = { ...d.variables, meals_per_day: String(p.perDay), meals_free: String(p.free),
      ...Object.fromEntries(others.map((r) => [`meals_${r.key}`, String(r.count)])) }
    d.variable_notes = { ...notes, meals_per_day: t('mealsPerDay'), meals_free: t('mealsFree'),
      ...Object.fromEntries(others.map((r) => [`meals_${r.key}`, `${t('mealsNum')} · ${r.name}`])) }
    // Keep what was set on the old lines (children half, staff none…): same id, new numbers.
    const lineFor = (id: string, name: string, price: string, currency: string, qty: string, who: QuoteItem['who']): QuoteItem => ({
      ...(old.get(id) ?? newItem(currency, 'meal')), id, category: 'meal', name, unit_price: price || '0', currency, quantity: qty,
      basis: 'per_person', who, day: null, included: true, optional: false,
    })
    const main = regions[0]
    d.items.push(lineFor('meals:main', `${t('meals')} · ${main.name || t('mealsAll')}`, main.price, main.currency,
      ['days * meals_per_day - meals_free', ...others.map((r) => `meals_${r.key}`)].join(' - '), 'everyone'))
    others.forEach((r) => d.items.push(lineFor(`meals:${r.key}`, `${t('meals')} · ${r.name}`, r.price, r.currency, `meals_${r.key}`, 'everyone')))
    if (hasStaff && Number(p.staffPrice) > 0) {
      d.items.push(lineFor('meals:staff', t('staffOnFreeLine'), p.staffPrice, p.staffCurrency, 'meals_free', 'staff'))
    }
    d.items.forEach((i) => { if (isRestaurantMeal(i)) i.included = false })
  }, true)

  return (
    <Dialog wide title={t('mealsHow')} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        <Button onClick={() => { apply(); onClose() }}>{t('apply')}</Button>
      </>}>
      <div className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard selected={!flat} onClick={() => setFlat(false)} icon={<Utensils size={20} />} title={t('mealsByRestaurant')} hint={t('mealsByRestaurantHint')} />
          <ChoiceCard selected={flat} onClick={() => setFlat(true)} icon={<span className="text-base font-semibold leading-5">×</span>} title={t('mealsFlat')} hint={t('mealsFlatHint')} />
        </div>

        {!flat ? (
          <p className="text-sm text-slate-600">{current ? t('mealsRestaurantsBack') : t('nMealLines', { n: restaurants })}</p>
        ) : <>
          <Field label={t('mealsPerDay')} hint={t('mealsPerDayHint', { days: doc.days, n: doc.days * p.perDay })}>
            <span className="inline-flex rounded border border-slate-300"><Stepper size="md" value={p.perDay} min={1} max={5} label={t('mealsPerDay')} onChange={(v) => set({ perDay: v })} /></span>
          </Field>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">{t('mealsPrices')}</legend>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead><tr className="text-left text-xs text-slate-500">
                  <th className="pb-1 font-medium">{t('mealsRegion')}</th><th className="w-36 pb-1 font-medium">{t('mealsPricePer')}</th>
                  <th className="w-24 pb-1 font-medium">{t('currency')}</th><th className="w-28 pb-1 font-medium">{t('mealsNum')}</th><th className="w-10" />
                </tr></thead>
                <tbody>
                  {p.regions.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1 pr-2"><Input size="sm" value={r.name} onChange={(e) => setRegion(i, { name: e.target.value })} aria-label={t('mealsRegion')} /></td>
                      <td className="py-1 pr-2"><Input size="sm" type="number" min={0} step="any" value={r.price} onChange={(e) => setRegion(i, { price: e.target.value })} className="text-right" aria-label={`${t('mealsPricePer')} · ${r.name}`} /></td>
                      <td className="py-1 pr-2"><Select size="sm" value={r.currency} onChange={(e) => setRegion(i, { currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></td>
                      <td className="py-1 pr-2">
                        {i === 0
                          ? <span className="flex h-8 items-center justify-end whitespace-nowrap px-2 tabular-nums text-slate-700" title={t('mealsRestHelp')}>{t('mealsRest', { n: rest })}</span>
                          : <Input size="sm" type="number" min={0} value={r.count} onChange={(e) => setRegion(i, { count: Math.max(0, Number(e.target.value) || 0) })} className="text-right" aria-label={`${t('mealsNum')} · ${r.name}`} />}
                      </td>
                      <td className="py-1">{i > 0 && <IconButton size="sm" tone="danger" label={`${t('delete')}: ${r.name}`} onClick={() => setP((x) => ({ ...x, regions: x.regions.filter((_, j) => j !== i) }))}><X size={16} /></IconButton>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button variant="tertiary" size="sm" className="mt-1" onClick={() => setP((x) => ({ ...x, regions: [...x.regions, { key: '', name: '', price: '', currency: x.regions[0].currency, count: 0 }] }))}>
              <Plus size={16} />{t('addRegion')}
            </Button>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('mealsFree')} hint={t('mealsFreeHint')}>
              <Input type="number" min={0} value={p.free} onChange={(e) => set({ free: Math.max(0, Number(e.target.value) || 0) })} className="w-28 text-right" />
            </Field>
            {hasStaff && (
              <Field label={t('staffOnFree')} hint={t('staffOnFreeHint')}>
                <div className="flex gap-2">
                  <Input type="number" min={0} step="any" value={p.staffPrice} placeholder="0" onChange={(e) => set({ staffPrice: e.target.value })} className="w-28 text-right" />
                  <Select value={p.staffCurrency} onChange={(e) => set({ staffCurrency: e.target.value })} className="w-28">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
                </div>
              </Field>
            )}
          </div>

          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {t('mealsTotalLine', { n: Math.max(0, total) })}: {p.regions.map((r, i) => `${r.name || '—'} ${i === 0 ? rest : r.count}`).join(' · ')}. {t('mealsEveryone')}
          </p>
          {restaurants > 0 && !current && <p className="text-sm text-slate-500">{t('mealsRestaurantsKept', { n: restaurants })}</p>}
        </>}
      </div>
    </Dialog>
  )
}
