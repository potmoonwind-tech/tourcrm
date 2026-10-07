/**
 * A tour's food, dish by dish: every lunch and dinner with its restaurant, set menu,
 * dishes (repeats marked), price per person, people eating and total — and every dish
 * across the tour with what it costs at each restaurant, so spreads stand out.
 * Prices are shown to managers only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, UtensilsCrossed } from 'lucide-react'
import { useState } from 'react'
import { Dialog, Label } from '../components/overlay'
import { SeatGrid, type SeatRow } from '../components/SeatGrid'
import { EmptyState } from '../components/tour'
import { Button, Card, ErrorText, Select, Spinner } from '../components/ui'
import { api, type DishSummary, type MealRow, type MealSeat, type Tour, type TourMeals } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money, moneyList } from '../lib/utils'

/** Price spread worth a look: the dearest place charges this much more than the cheapest. */
const SPREAD = 0.2

export function MealsTab({ tour, onTab }: { tour: Tour; onTab: (tab: string) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const q = useQuery({
    queryKey: ['meals', ws.id, tour.id],
    queryFn: () => api<TourMeals>(wsPath(ws.id, `/tours/${tour.id}/meals`)),
  })
  const [seating, setSeating] = useState<MealRow | null>(null)
  if (q.isLoading || !q.data) return <div className="flex justify-center py-10"><Spinner /></div>
  const { rows, dishes, totals, sees_prices, plate_share, agency_plate_share } = q.data
  if (!rows.length) {
    return (
      <EmptyState title={t('mealsEmpty')} hint={t('mealsEmptyHint')}
        action={<Button variant="secondary" onClick={() => onTab('itinerary')}>{t('openItinerary')}</Button>} />
    )
  }
  const repeats = rows.reduce((n, r) => n + r.dishes.filter((d) => d.same_day || d.prev_day).length, 0)
  const noMenu = rows.filter((r) => !r.menu_id).length
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('mealsCount')} value={String(rows.length)} hint={noMenu ? t('mealsNoMenu', { n: noMenu }) : t('mealsAllMenus')} warn={noMenu > 0} />
        <Stat label={t('dishRepeats')} value={String(repeats)} hint={repeats ? t('dishRepeatsHint') : t('dishRepeatsNone')} warn={repeats > 0} />
        {sees_prices && <Stat label={t('foodTotal')} value={moneyList(totals)} hint={t('foodTotalHint')} />}
      </div>

      <Card className="overflow-x-auto p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold">{t('mealsByDay')}</h2>
          <PlateShare tour={tour} value={plate_share ?? null} usual={agency_plate_share ?? 1} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Label tone="red" wide={false}>{t('dishSameDay')}</Label>
            <Label tone="orange" wide={false}>{t('dishPrevDay')}</Label>
            <Button size="sm" variant="secondary" onClick={() => onTab('itinerary')}>{t('changeMenus')}</Button>
          </div>
        </div>
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="px-4 py-2 font-medium">{t('day')}</th>
              <th className="px-2 py-2 font-medium">{t('restaurant')}</th>
              <th className="px-2 py-2 font-medium">{t('dishes')}</th>
              {sees_prices && <th className="px-2 py-2 text-right font-medium">{t('pricePerPerson')}</th>}
              <th className="px-2 py-2 text-right font-medium">{t('people')}</th>
              {sees_prices && <th className="px-4 py-2 text-right font-medium">{t('total')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => <Row key={i} r={r} first={i === 0 || rows[i - 1].day !== r.day} prices={sees_prices} onSeats={() => setSeating(r)} />)}
          </tbody>
        </table>
      </Card>

      {seating && <MealSeating tour={tour} row={rows.find((r) => r.day === seating.day && r.meal === seating.meal) ?? seating} onClose={() => setSeating(null)} />}
      {dishes.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="font-semibold">{t('dishesAcrossTour')}</h2>
            <p className="text-xs text-slate-500">{sees_prices ? t('dishesAcrossHelp') : t('dishesAcrossHelpNoPrices')}</p>
          </div>
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">{t('dish')}</th>
                <th className="px-2 py-2 font-medium">{t('days')}</th>
                <th className="px-2 py-2 font-medium">{t('whereServed')}</th>
                {sees_prices && <th className="px-4 py-2 text-right font-medium">{t('priceRange')}</th>}
              </tr>
            </thead>
            <tbody>{dishes.map((d) => <DishRow key={d.name} d={d} prices={sees_prices} />)}</tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <p className={cn('mt-0.5 text-xs', warn ? 'text-amber-700' : 'text-slate-500')}>{hint}</p>
    </Card>
  )
}

function Row({ r, first, prices, onSeats }: { r: MealRow; first: boolean; prices: boolean; onSeats: () => void }) {
  const { t, lang } = useI18n()
  // The menu price differs from the sum of its dishes: worth a look.
  const off = r.price_pp !== null && r.dish_sum !== null && Math.abs(r.price_pp - r.dish_sum) >= 0.01
  return (
    <tr className={cn('align-top', first && 'border-t border-slate-100')}>
      <td className="px-4 py-2 whitespace-nowrap">
        {first && <><b className="font-medium">{t('dayN', { n: r.day })}</b> <span className="text-xs text-slate-500">{fmt(r.date, lang)}</span></>}
        <span className="block text-xs text-slate-500">{t(r.meal)}</span>
      </td>
      <td className="px-2 py-2">
        <span className="font-medium">{r.vendor.name}</span>
        <span className={cn('block text-xs', r.menu_name ? 'text-slate-600' : 'text-amber-700')}>{r.menu_name ?? t('menuUsual')}</span>
        {r.shared && <span className="mt-0.5 inline-block rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-800">{t('mealShared')}</span>}
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap gap-1">
          {r.dishes.map((d) => (
            <span key={d.name} title={d.same_day ? t('dishTwiceToday') : d.prev_day ? t('dishPrevDay') : undefined}
              className={cn('rounded-full px-1.5 py-0.5 text-[11px]',
                d.same_day ? 'bg-red-100 font-medium text-red-700' : d.prev_day ? 'bg-orange-100 font-medium text-orange-800' : 'bg-amber-50 text-amber-900')}>
              {d.name}{r.shared && d.plates ? <b className="ml-1 font-semibold tabular-nums">×{d.plates}</b> : null}
              {prices && d.price !== null && <span className="ml-1 tabular-nums opacity-70">{d.price.toFixed(2)}</span>}
            </span>
          ))}
          {!r.dishes.length && <span className="text-xs text-slate-400">—</span>}
        </div>
      </td>
      {prices && (
        <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
          {r.price_pp !== null ? money(r.price_pp, r.currency ?? undefined) : <span className="text-xs text-amber-700">{t('noPrice')}</span>}
          {off && <span className={cn('block text-xs', r.price_pp! > r.dish_sum! ? 'text-amber-700' : 'text-slate-500')} title={t('dishSumDiffHelp')}>{t('dishSum')}: {money(r.dish_sum!)}</span>}
        </td>
      )}
      <td className="px-2 py-2 text-right tabular-nums">
        {/* Who sits where at this meal: "19 + 3" with a staff table. */}
        {r.seats?.length ? (
          <button type="button" onClick={onSeats} title={t('seatThisMeal')}
            className={cn('rounded-md px-1.5 py-0.5 hover:bg-slate-100', r.seats.some((s) => s.seat !== s.usual) && 'bg-amber-50 text-amber-900')}>
            {(r.tables ?? [r.people]).join(' + ')}<Users size={12} className="ml-1 inline text-slate-400" />
          </button>
        ) : r.people}
      </td>
      {prices && <td className="px-4 py-2 text-right font-medium whitespace-nowrap tabular-nums">{r.tourists_pay ? <span className="font-normal text-amber-700" title={t('mealTouristsHelp')}>{t('mealTourists')}</span> : r.total !== null ? money(r.total, r.currency ?? undefined) : '—'}</td>}
    </tr>
  )
}

function DishRow({ d, prices }: { d: DishSummary; prices: boolean }) {
  const { t } = useI18n()
  const spread = d.min_price !== null && d.max_price !== null && d.min_price > 0 && d.max_price / d.min_price - 1 >= SPREAD
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-4 py-2 font-medium">
        <UtensilsCrossed size={13} className="mr-1.5 inline text-slate-400" />{d.name}
        {d.servings > 1 && <span className="ml-1 text-xs font-normal text-slate-500">×{d.servings}</span>}
      </td>
      <td className="px-2 py-2 text-xs text-slate-600">{d.days.map((n) => t('dayN', { n })).join(', ')}</td>
      <td className="px-2 py-2">
        <ul className="space-y-0.5 text-xs">
          {d.places.map((p, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>{p.vendor.name} <span className="text-slate-500">· {p.menu_name}</span></span>
              {prices && (
                <span className={cn('tabular-nums', p.price === null ? 'text-slate-400'
                  : spread && p.price === d.max_price ? 'font-semibold text-red-700' : spread && p.price === d.min_price ? 'font-semibold text-emerald-700' : '')}>
                  {p.price !== null ? p.price.toFixed(2) : t('noPrice')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </td>
      {prices && (
        <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
          {d.min_price === null ? '—' : d.min_price === d.max_price ? d.min_price.toFixed(2) : `${d.min_price.toFixed(2)} – ${d.max_price!.toFixed(2)}`}
          {spread && <Label tone="orange" wide={false} className="ml-1.5 py-0.5">{t('priceSpread', { pct: Math.round((d.max_price! / d.min_price! - 1) * 100) })}</Label>}
        </td>
      )}
    </tr>
  )
}

/** How this group shares plates: the agency's usual, or its own (one plate per 2, 3, 4…). */
function PlateShare({ tour, value, usual }: { tour: Tour; value: number | null; usual: number }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (n: number) => api(wsPath(ws.id, `/tours/${tour.id}`), { method: 'PATCH', body: { plate_share: n } }),
    onSuccess: () => { for (const k of ['meals', 'tour', 'costs']) qc.invalidateQueries({ queryKey: [k, ws.id] }) },
  })
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <span>{t('plateShareTour')}</span>
      <Select className="h-8 w-48 text-sm" value={value ?? 0} disabled={save.isPending} onChange={(e) => save.mutate(Number(e.target.value))}>
        <option value={0}>{t('plateUsual', { what: usual === 1 ? t('plateOwn') : t('platePer', { n: usual }) })}</option>
        {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n === 1 ? t('plateOwn') : t('platePer', { n })}</option>)}
      </Select>
    </label>
  )
}


/** Who sits where at one meal: the usual (Staff tab) unless changed here. */
function MealSeating({ tour, row, onClose }: { tour: Tour; row: MealRow; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const seats = row.seats ?? []
  const save = useMutation({
    mutationFn: (map: Record<string, MealSeat>) =>
      api(wsPath(ws.id, `/tours/${tour.id}/days/${row.day}/seating/${row.meal}`), { method: 'PUT', body: { seats: map } }),
    onSuccess: () => { for (const k of ['meals', 'costs', 'bookings']) qc.invalidateQueries({ queryKey: [k, ws.id] }) },
  })
  const current = Object.fromEntries(seats.map((s) => [s.key, s.seat])) as Record<string, MealSeat>
  const rows: SeatRow[] = seats.map((s) => ({
    key: s.key, seat: s.seat, usual: s.usual,
    label: s.key === 'leader' ? t('seatLeaders', { n: s.count }) : s.name, sub: s.key === 'leader' ? undefined : t(`staffRole_${s.role}` as TKey),
  }))
  const changed = seats.some((s) => s.seat !== s.usual)
  return (
    <Dialog title={`${t('dayN', { n: row.day })} · ${t(row.meal)} · ${row.vendor.name}`} onClose={onClose}
      footer={<div className="flex justify-between gap-2">
        <Button variant="ghost" disabled={!changed || save.isPending} onClick={() => save.mutate({})}>{t('seatBackToUsual')}</Button>
        <Button onClick={onClose}>{t('done')}</Button>
      </div>}>
      <p className="mb-1 text-sm text-slate-600">{fmt(row.date, lang)} · {t('seatTables', { tables: (row.tables ?? [row.people]).join(' + ') })}</p>
      <p className="mb-3 text-xs text-slate-500">{t('seatMealHelp')}</p>
      <SeatGrid rows={rows} disabled={save.isPending} onChange={(key, seat) => save.mutate({ ...current, [key]: seat })} />
      <ErrorText error={save.error} />
    </Dialog>
  )
}
