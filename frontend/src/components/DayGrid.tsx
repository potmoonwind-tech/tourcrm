/**
 * "Check": every day of the tour on one screen, as compact cards in a grid, read-only - to see at a glance what is
 * done and what still needs doing, and to compare days (every card lists the same things in the same order).
 * A card's top line says how complete the day is; missing things are amber, problems red. Tap a card to open
 * that day.
 */
import { AlertTriangle, BedDouble, Check, CircleDashed, Clock, Coffee, Ticket, User, Utensils } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DayFields, ServiceBrief, TourAlert, Vendor } from '../lib/api'
import { fmt, weekday } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { cn, townKey } from '../lib/utils'
import type { Crew } from './MealPlan'

type State = 'ok' | 'todo' | 'soft' | 'none'      // done · missing · worth a look · not needed
interface Line { icon: ReactNode; label: string; text: string; state: State; sub?: string; wrap?: boolean }

export function DayGrid({ days, dates, byId, menus, alerts, crew, onOpen }: {
  days: DayFields[]; dates?: string[]; byId: Map<string, Vendor>; menus: ServiceBrief[]; alerts: TourAlert[]
  crew?: Crew; onOpen: (i: number) => void
}) {
  const { t, lang } = useI18n()
  const name = (id: string | null | undefined) => (id ? byId.get(id)?.name ?? '?' : '')
  const menuOf = (d: DayFields, meal: 'lunch' | 'dinner') => {
    const id = meal === 'lunch' ? d.lunch_menu_id : d.dinner_menu_id
    if (d.meal_dishes?.[meal]) return t('gridOwnMenu')
    return id ? menus.find((m) => m.id === id)?.name ?? '' : ''
  }

  const lines = (d: DayFields, i: number): Line[] => {
    const last = i === days.length - 1
    const out: Line[] = []
    // The night
    out.push(last ? { icon: <BedDouble size={13} />, label: t('hotel'), text: t('gridNoNight'), state: 'none' }
      : d.hotel_id ? { icon: <BedDouble size={13} />, label: t('hotel'), text: name(d.hotel_id), state: 'ok' }
        : { icon: <BedDouble size={13} />, label: t('hotel'), text: t('gridMissing'), state: 'todo' })
    // Breakfast
    const bm = d.breakfast_mode ?? 'hotel'
    out.push(i === 0 && bm === 'hotel' ? { icon: <Coffee size={13} />, label: t('breakfast'), text: '—', state: 'none' }
      : bm === 'own' ? { icon: <Coffee size={13} />, label: t('breakfast'), text: t('mealOwn'), state: 'none' }
        : bm === 'hotel' ? { icon: <Coffee size={13} />, label: t('breakfast'), text: t('gridAtHotel'), state: 'ok' }
          : d.breakfast_id ? { icon: <Coffee size={13} />, label: t('breakfast'), text: name(d.breakfast_id), state: 'ok' }
            : { icon: <Coffee size={13} />, label: t('breakfast'), text: t('gridMissing'), state: 'todo' })
    // Lunch and dinner: the place, and its menu
    for (const meal of ['lunch', 'dinner'] as const) {
      const mode = (meal === 'lunch' ? d.lunch_mode : d.dinner_mode) ?? 'included'
      const id = meal === 'lunch' ? d.lunch_id : d.dinner_id
      if (mode === 'own') { out.push({ icon: <Utensils size={13} />, label: t(meal), text: `${t('mealOwn')}${d.meal_tbd?.[meal] ? ` · ${d.meal_tbd[meal]}` : ''}`, state: 'none' }); continue }
      if (!id && d.meal_tbd?.[meal]) { out.push({ icon: <Utensils size={13} />, label: t(meal), text: t('mealTbdShort', { town: d.meal_tbd[meal]! }), state: 'soft' }); continue }
      if (!id) { out.push({ icon: <Utensils size={13} />, label: t(meal), text: t('gridMissing'), state: 'todo' }); continue }
      const menu = menuOf(d, meal)
      out.push({ icon: <Utensils size={13} />, label: t(meal), text: name(id), sub: menu || t('gridNoMenu'), state: menu ? 'ok' : 'soft' })
    }
    // What they do: the places with activities and the free visits of the day's timeline - as "what they do" shows it.
    const paid = d.extras.map((x) => menus.find((s) => s.id === x.service_id)?.vendor.name)
    const free = (d.schedule ?? []).filter((x) => x.kind === 'visit' && !x.ref && x.title.trim()).map((x) => x.title.trim())
    const extras = [...new Set([...paid, ...free].filter((x): x is string => !!x))]
    out.push({ icon: <Ticket size={13} />, label: t('gridActivities'), text: extras.length ? extras.join(', ') : '—', state: extras.length ? 'ok' : 'none', wrap: true })
    // The day hour by hour
    const timed = (d.schedule ?? []).some((x) => x.time)
    out.push({ icon: <Clock size={13} />, label: t('gridProgramme'), text: timed ? t('gridTimed', { n: d.schedule!.length }) : t('gridSuggested'), state: timed ? 'ok' : 'none' })
    // Who works that day
    if (crew) {
      const n = i + 1
      const team = crew.staff.filter((a) => ['guide', 'driver', 'transport'].includes(a.role) && a.start_day <= n && (a.end_day === null || a.end_day >= n))
      out.push({ icon: <User size={13} />, label: t('gridTeam'), text: team.length ? team.map((a) => a.vendor.name).join(', ') : t('gridNobody'), state: team.length ? 'ok' : 'todo' })
    }
    return out
  }

  // The day's way: from last night's town (when it changes), through the stops, to tonight's.
  const route = (i: number) => {
    const d = days[i]
    const from = i > 0 ? days[i - 1].city.trim() : ''
    const out = [from, ...(d.stops ?? []), d.city].map((x) => x.trim()).filter(Boolean)
    return out.filter((x, k) => k === 0 || townKey(x) !== townKey(out[k - 1]))
  }
  const cards = days.map((d, i) => {
    const ls = lines(d, i)
    const dayAlerts = alerts.filter((a) => a.day === i + 1)
    const todo = ls.filter((l) => l.state === 'todo').length + dayAlerts.filter((a) => a.severity === 'error').length
    const soft = ls.filter((l) => l.state === 'soft').length + dayAlerts.filter((a) => a.severity === 'warning').length
    return { d, i, ls, todo, soft, dayAlerts }
  })
  const ready = cards.filter((c) => !c.todo).length       // nothing missing (a menu not picked yet is only worth a look)
  const missing = cards.filter((c) => c.todo)

  return (
    <div className="space-y-3">
      {/* The tour in one line: ready days, and which need work. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
        <span className="font-semibold text-slate-900">{t('gridReady', { n: ready, total: days.length })}</span>
        {missing.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 text-amber-800">
            <AlertTriangle size={14} aria-hidden />{t('gridNeedWork')}
            {missing.map((c) => (
              <button key={c.i} type="button" onClick={() => onOpen(c.i)}
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold hover:bg-amber-200">{t('dayN', { n: c.i + 1 })}</button>
            ))}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <Legend state="ok" label={t('gridLegendDone')} /><Legend state="soft" label={t('gridLegendLook')} /><Legend state="todo" label={t('gridLegendMissing')} />
        </span>
      </div>

      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
        {cards.map(({ d, i, ls, todo, soft, dayAlerts }) => (
          <button key={i} type="button" onClick={() => onOpen(i)}
            className={cn('flex flex-col overflow-hidden rounded-xl border bg-white text-left transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300',
              todo ? 'border-amber-300' : 'border-emerald-200')}>
            <span className={cn('flex items-center gap-2 px-3 py-2', todo ? 'bg-amber-50' : 'bg-emerald-50')}>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-900">{route(i).join(' → ') || '—'}</span>
                {dates?.[i] && <span className="block text-[11px] text-slate-500">{weekday(dates[i], lang)} · {fmt(dates[i], lang)}{d.km ? ` · ${d.km} km` : ''}</span>}
              </span>
              {soft > 0 && <span className="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-800" title={t('gridLegendLook')}>{soft}</span>}
              <span className={cn('flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                todo ? 'bg-amber-200 text-amber-900' : 'bg-emerald-200 text-emerald-900')}>
                {todo ? t('gridMissingN', { n: todo }) : <><Check size={12} aria-hidden />{t('gridReadyShort')}</>}
              </span>
            </span>
            {/* Three columns for the whole card: the label column as wide as its longest label (Georgian
                labels are longer), so nothing runs into the value and the rows stay aligned. */}
            <ul className="grid flex-1 grid-cols-[auto_max-content_minmax(0,1fr)] content-start gap-x-1.5 px-3 py-1 text-xs">
              {ls.map((l, k) => (
                <li key={k} className="contents">
                  <span className={cn('py-1 pt-[0.3rem]', k > 0 && 'border-t border-slate-100',
                    l.state === 'ok' ? 'text-emerald-600' : l.state === 'todo' ? 'text-amber-600' : l.state === 'soft' ? 'text-sky-600' : 'text-slate-300')}>{l.icon}</span>
                  <span className={cn('whitespace-nowrap py-1 text-slate-500', k > 0 && 'border-t border-slate-100')}>{l.label}</span>
                  <span className={cn('min-w-0 py-1', k > 0 && 'border-t border-slate-100')} title={l.sub ? `${l.text} · ${l.sub}` : l.text}>
                    <span className={cn('block', l.wrap ? 'line-clamp-2' : 'truncate', l.state === 'todo' ? 'font-semibold text-amber-800' : l.state === 'none' ? 'text-slate-400' : 'text-slate-800')}>{l.text}</span>
                    {l.sub && <span className={cn('block truncate text-[11px]', l.state === 'soft' ? 'text-sky-700' : 'text-slate-500')}>{l.sub}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {(dayAlerts.length > 0 || d.notes) && (
              <span className="border-t border-slate-100 px-3 py-1.5 text-[11px]">
                {dayAlerts.length > 0 && <span className="flex items-center gap-1 font-medium text-red-700"><AlertTriangle size={11} />{t('gridAlerts', { n: dayAlerts.length })}</span>}
                {d.notes && <span className="block truncate italic text-slate-500">{d.notes}</span>}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

function Legend({ state, label }: { state: State; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {state === 'ok' ? <Check size={12} className="text-emerald-600" /> : <CircleDashed size={12} className={state === 'todo' ? 'text-amber-600' : 'text-sky-600'} />}
      {label}
    </span>
  )
}
