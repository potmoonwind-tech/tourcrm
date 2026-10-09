/**
 * A lunch or dinner in the tour builder, all in one place: the menu's dishes (changed here for this tour
 * only, or kept as the restaurant's menu), how many people share a plate ("1 / 5"), who sits at which
 * table - the group's, and the staff's (tour leaders, guide, driver) by default; tap a person to move
 * them, add a guest - and so how many plates of each dish go on each table.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus, Undo2, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { api, type DayFields, type Dish, type MealSeat, type ServiceBrief, type StaffAssignment } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { toast } from './overlay'
import { Input } from './ui'

/** What the builder knows of a tour's people: the group, its free tour leaders, and the staff. */
export interface Crew { pax: number; leaders: number; leaderSeat?: MealSeat | null; staff: StaffAssignment[]; share: number }

type Meal = 'lunch' | 'dinner'
type Extra = { name: string; seat: 'group' | 'staff' }
interface Seat { key: string; label: string; seat: MealSeat; usual: MealSeat; extra?: number }

const EATING = ['guide', 'driver', 'assistant', 'transport']
const SHARES = [1, 2, 3, 4, 5, 6, 8]
const plates = (people: number, per: number) => (people > 0 ? Math.ceil(people / Math.max(per, 1)) : 0)

export function MealPlan({ meal, day, dayNumber, menu, crew, disabled, twice, onSet }: {
  meal: Meal; day: DayFields; dayNumber: number
  menu: ServiceBrief | undefined          // the chosen set menu, else the restaurant's usual
  crew?: Crew                              // a tour's people (a route has none: no tables)
  disabled?: boolean; twice: Set<string>
  onSet: (p: Partial<DayFields>) => void
}) {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const vendorId = meal === 'lunch' ? day.lunch_id : day.dinner_id
  const own = day.meal_dishes?.[meal]
  const dishes: Dish[] = own ?? menu?.dishes ?? []
  const share = crew?.share ?? ws.plate_share ?? 1
  const [newDish, setNewDish] = useState('')
  // The restaurant's own dish list (Catalogue → its menu builder): suggested when adding a dish here.
  const own_list = useQuery({
    queryKey: ['restaurant-dishes', ws.id, vendorId], enabled: !!vendorId && !disabled, retry: false, staleTime: 60_000, meta: { silent: true },
    queryFn: () => api<{ id: string; name: string; price: string | null; currency: string; per_plate: number | null }[]>(wsPath(ws.id, `/vendors/${vendorId}/dishes`)),
  })
  const [guest, setGuest] = useState<string | null>(null)

  // --- the dishes: any change makes this tour's own list (the restaurant's menu stays as it is)
  const setDishes = (list: Dish[]) => onSet({ meal_dishes: { ...(day.meal_dishes ?? {}), [meal]: list } })
  const useMenu = () => { const next = { ...(day.meal_dishes ?? {}) }; delete next[meal]; onSet({ meal_dishes: next }) }
  const keep = useMutation({
    mutationFn: () => api<{ id: string; name: string }>(wsPath(ws.id, `/vendors/${vendorId}/menu`), {
      method: 'POST', body: { meal, menu_id: menu && !menu.code ? menu.id : null, dishes: own },
    }),
    onSuccess: (m) => {
      const next = { ...(day.meal_dishes ?? {}) }
      delete next[meal]
      onSet({ meal_dishes: next, [`${meal}_menu_id`]: m.id } as Partial<DayFields>)
      void qc.invalidateQueries({ queryKey: ['services', ws.id] })
      toast('mpSaved')
    },
  })

  // --- who sits where at this meal: the tour's usual, unless moved here
  const here = (day.seating?.[meal] ?? {}) as Record<string, unknown>
  const extras = ((here._extra as Extra[] | undefined) ?? []).filter((x) => x && (x.seat === 'group' || x.seat === 'staff'))
  const seats: Seat[] = []
  if (crew) {
    if (crew.leaders > 0) {
      const usual = crew.leaderSeat ?? 'staff'
      seats.push({ key: 'leader', label: t('mpLeaders', { n: crew.leaders }), usual, seat: (here.leader as MealSeat) ?? usual })
    }
    for (const a of crew.staff) {
      if (!EATING.includes(a.role) || a.start_day > dayNumber || (a.end_day !== null && a.end_day < dayNumber)) continue
      const usual: MealSeat = a.meal_seat ?? (a.role === 'transport' ? 'none' : 'staff')
      seats.push({ key: a.id, label: `${a.vendor.name} · ${t(`staffRole_${a.role}` as TKey)}`, usual, seat: (here[a.id] as MealSeat) ?? usual })
    }
    extras.forEach((x, i) => seats.push({ key: `_extra:${i}`, label: x.name, seat: x.seat, usual: x.seat, extra: i }))
  }
  const saveSeating = (next: Record<string, unknown>) => onSet({ seating: { ...(day.seating ?? {}), [meal]: next } })
  const move = (s: Seat, to: MealSeat) => {
    if (s.extra !== undefined) {
      const list = extras.map((x, i) => (i === s.extra ? { ...x, seat: to as Extra['seat'] } : x)).filter((_, i) => i !== s.extra || to !== 'none')
      saveSeating({ ...here, _extra: list })
      return
    }
    const next = { ...here }
    if (to === s.usual) delete next[s.key]
    else next[s.key] = to
    saveSeating(next)
  }
  const addGuest = () => {
    const name = (guest ?? '').trim()
    if (!name) return
    saveSeating({ ...here, _extra: [...extras, { name, seat: 'staff' }] })
    setGuest(null)
  }

  const tourists = crew ? crew.pax : 0      // Pax are the guests; the tour leaders come on top (19+1)

  const count = (where: MealSeat) => seats.filter((s) => s.seat === where).reduce((n, s) => n + (s.key === 'leader' ? crew!.leaders : 1), 0)
  const tables = crew ? [tourists + count('group'), count('staff')] : []
  const twoTables = tables[1] > 0

  if (!vendorId) return null
  return (
    <div className="mt-2 space-y-2">
      {/* The dishes, how many share a plate, and the plates on each table. */}
      {(dishes.length > 0 || !disabled) && (
        <table className="w-full text-xs">
          {dishes.length > 0 && (
            <thead>
              <tr className="text-[11px] text-slate-500">
                <th className="py-1 text-left font-medium">{t('mpDish')}</th>
                <th className="w-16 py-1 text-left font-medium" title={t('mpShareHelp')}>{t('mpShare')}</th>
                {crew && <th className="w-10 py-1 text-right font-medium">{twoTables ? t('mpGroupShort') : t('mpPlates')}</th>}
                {crew && twoTables && <th className="w-10 py-1 text-right font-medium">{t('mpStaffShort')}</th>}
                {!disabled && <th className="w-5" />}
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-slate-100">
            {dishes.map((x, i) => {
              const per = x.per_plate ?? share
              return (
                <tr key={`${x.name}-${i}`}>
                  <td className={cn('py-1 pr-1', twice.has(x.name.toLowerCase()) && 'font-medium text-red-700')}
                    title={twice.has(x.name.toLowerCase()) ? t('dishTwiceToday') : undefined}>{x.name}</td>
                  <td className="py-0.5">
                    <select disabled={disabled} value={per} aria-label={`${x.name}: ${t('mpShare')}`}
                      onChange={(e) => setDishes(dishes.map((y, j) => (j === i ? { ...y, per_plate: Number(e.target.value) } : y)))}
                      className={cn('h-6 w-14 rounded-md border border-slate-200 bg-white px-1 text-xs tabular-nums', per > 1 && 'border-amber-300 bg-amber-50 text-amber-900')}>
                      {SHARES.map((n) => <option key={n} value={n}>1 / {n}</option>)}
                    </select>
                  </td>
                  {crew && <td className="py-1 text-right font-semibold tabular-nums text-slate-900">{plates(tables[0], per)}</td>}
                  {crew && twoTables && <td className="py-1 text-right font-semibold tabular-nums text-slate-900">{plates(tables[1], per)}</td>}
                  {!disabled && (
                    <td className="py-1 text-right">
                      <button type="button" aria-label={`${t('delete')} ${x.name}`} onClick={() => setDishes(dishes.filter((_, j) => j !== i))}
                        className="rounded-md p-0.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><X size={12} /></button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {!disabled && (
        <form className="flex gap-1" onSubmit={(e) => {
          e.preventDefault()
          const n = newDish.trim()
          if (!n) return
          // A dish from the restaurant's list comes with its price and how it's shared.
          const known = (own_list.data ?? []).find((x) => x.name.toLowerCase() === n.toLowerCase())
          setDishes([...dishes, known ? { name: known.name, price: known.price === null ? null : Number(known.price), per_plate: known.per_plate, dish_id: known.id } as Dish
            : { name: n, price: null, per_plate: null }])
          setNewDish('')
        }}>
          <Input value={newDish} onChange={(e) => setNewDish(e.target.value)} placeholder={t('mpDishPh')} className="h-7 text-xs" aria-label={t('mpAddDish')}
            list={`dishes-${vendorId}`} />
          <datalist id={`dishes-${vendorId}`}>
            {(own_list.data ?? []).map((x) => <option key={x.id} value={x.name}>{x.price ? `${x.price} ${x.currency}` : ''}</option>)}
          </datalist>
          <button type="submit" className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-50">
            <Plus size={12} />{t('mpAddDish')}
          </button>
        </form>
      )}
      {own && (
        // Changed for this tour: keep it as the restaurant's menu, or go back to it.
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          <span className="flex-1">{t('mpOwn')}</span>
          {!disabled && own.length > 0 && (
            <button type="button" disabled={keep.isPending} onClick={() => keep.mutate()} className="flex items-center gap-1 font-semibold text-brand-700 hover:underline">
              <Check size={12} />{t('mpSaveMenu')}
            </button>
          )}
          {!disabled && menu && (
            <button type="button" onClick={useMenu} className="flex items-center gap-1 text-slate-600 hover:underline"><Undo2 size={12} />{t('mpUseMenu')}</button>
          )}
        </div>
      )}

      {/* The tables: who sits where (tap a person to move them). */}
      {crew && (
        <div className="space-y-1 rounded-md border border-slate-100 bg-slate-50/60 p-2 text-[11px]">
          <TableRow label={t('mpTableGroup', { n: tables[0] })}>
            <span className="rounded-full bg-white px-2 py-0.5 text-slate-700 ring-1 ring-slate-200">{t('mpTourists', { n: tourists })}</span>
            {seats.filter((s) => s.seat === 'group').map((s) => <Person key={s.key} s={s} disabled={disabled} onMove={(to) => move(s, to)} />)}
          </TableRow>
          <TableRow label={t('mpTableStaff', { n: tables[1] })}>
            {seats.filter((s) => s.seat === 'staff').map((s) => <Person key={s.key} s={s} disabled={disabled} onMove={(to) => move(s, to)} />)}
            {!seats.some((s) => s.seat === 'staff') && <span className="text-slate-400">{t('mpNobody')}</span>}
          </TableRow>
          {seats.some((s) => s.seat === 'none') && (
            <TableRow label={t('mpNotEating')}>
              {seats.filter((s) => s.seat === 'none').map((s) => (
                <button key={s.key} type="button" disabled={disabled} onClick={() => move(s, 'staff')} title={t('mpSeatBack')}
                  className="rounded-full px-2 py-0.5 text-slate-500 line-through ring-1 ring-slate-200 hover:bg-white">{s.label}</button>
              ))}
            </TableRow>
          )}
          {!disabled && (guest === null ? (
            <button type="button" onClick={() => setGuest('')} className="flex items-center gap-1 text-brand-700 hover:underline"><UserPlus size={12} />{t('mpAddPerson')}</button>
          ) : (
            <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); addGuest() }}>
              <Input autoFocus value={guest} onChange={(e) => setGuest(e.target.value)} placeholder={t('mpPersonPh')} className="h-7 text-xs" aria-label={t('mpAddPerson')} />
              <button type="submit" className="h-7 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs">{t('add')}</button>
              <button type="button" onClick={() => setGuest(null)} aria-label={t('cancel')} className="h-7 shrink-0 px-1 text-slate-400"><X size={12} /></button>
            </form>
          ))}
          {seats.length > 0 && !disabled && <p className="text-slate-400">{t('mpTapToMove')}</p>}
        </div>
      )}
    </div>
  )
}

function TableRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-full font-medium text-slate-600 sm:w-auto sm:min-w-28">{label}</span>
      {children}
    </div>
  )
}

/** A person at a table: tap to move to the other table; × = not eating with us (a guest: removed). */
function Person({ s, disabled, onMove }: { s: Seat; disabled?: boolean; onMove: (to: MealSeat) => void }) {
  const { t } = useI18n()
  const moved = s.extra === undefined && s.seat !== s.usual
  return (
    <span className={cn('inline-flex items-center rounded-full bg-white ring-1', moved ? 'ring-amber-300' : 'ring-slate-200')}>
      <button type="button" disabled={disabled} onClick={() => onMove(s.seat === 'group' ? 'staff' : 'group')}
        title={t('mpTapToMove')} className="rounded-l-full px-2 py-0.5 text-slate-800 hover:bg-slate-50">{s.label}</button>
      {!disabled && (
        <button type="button" onClick={() => onMove('none')} aria-label={`${s.label}: ${t('mpNotEating')}`}
          className="rounded-r-full py-0.5 pl-0.5 pr-1.5 text-slate-300 hover:text-red-600"><X size={11} /></button>
      )}
    </span>
  )
}
