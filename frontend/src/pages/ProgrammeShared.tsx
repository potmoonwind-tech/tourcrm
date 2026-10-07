/**
 * A programme shared by link (/p/<token>), as a web page for the phone: no login, no PDF. The guide's
 * phone page without the group and money: one card per day (today's opened), the day hour by hour with
 * each drive's time and km, a map for every place and for the whole day, and a Menu tab with what is
 * served at each meal. In the programme's language (English, Georgian or Chinese).
 */
import { useQuery } from '@tanstack/react-query'
import { BedDouble, Car, ChevronDown, Map as MapIcon, Plane, Ticket, Utensils } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { FullPageSpinner } from '../components/ui'
import { today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { DishList, Timeline } from './Field'
import type { PDay, PDish, Programme } from './ProgrammePrint'

const LOCALE: Record<string, string> = { en: 'en-GB', ka: 'ka-GE', zh: 'zh-CN' }

export function ProgrammeSharedPage() {
  const { token } = useParams()
  const { t } = useI18n()
  const p = useQuery({
    queryKey: ['sharedProgramme', token], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/shared/programme/${encodeURIComponent(token ?? '')}`)
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as Programme
    },
  })
  const [tab, setTab] = useState<'days' | 'menu'>('days')
  const [open, setOpen] = useState<number | null>(null)
  const now = today()
  const todayDay = p.data?.days.find((d) => d.date === now)?.number
  const shown = open ?? todayDay ?? p.data?.days[0]?.number ?? null
  useEffect(() => {
    if (!p.data) return
    document.title = `${p.data.title} · ${p.data.agency}`
    document.documentElement.lang = p.data.lang
  }, [p.data])
  useEffect(() => {
    if (todayDay) document.getElementById(`pday-${todayDay}`)?.scrollIntoView({ block: 'start' })
  }, [todayDay])

  if (p.isLoading) return <FullPageSpinner />
  if (!p.data) {
    return (
      <div className="mx-auto max-w-md p-6 pt-20 text-center">
        <p className="text-lg font-semibold text-slate-800">{t('shareLinkDead')}</p>
      </div>
    )
  }
  const d = p.data
  const L = d.labels
  const date = (s: string | null, opts: Intl.DateTimeFormatOptions) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString(LOCALE[d.lang] ?? 'en-GB', opts) : '')
  return (
    <div lang={d.lang} className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 pb-2 pt-3">
        <div className="mx-auto max-w-2xl">
          <p className="truncate text-xs text-slate-500">{d.agency}</p>
          <h1 className="truncate text-lg font-semibold text-slate-900">{d.title}</h1>
          <p className="text-sm text-slate-500">{[
            d.days[0]?.date && `${date(d.days[0].date, { day: 'numeric', month: 'short' })} – ${date(d.days[d.days.length - 1].date, { day: 'numeric', month: 'short' })}`,
            L.days.replace('{n}', String(d.days.length)),
            d.total_km ? `${d.total_km} ${L.km}` : '',
          ].filter(Boolean).join(' · ')}</p>
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
            {(['days', 'menu'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                className={cn('rounded-lg py-2', tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>
                {k === 'days' ? L.tab_days : L.tab_menu}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-3 p-3">
        {tab === 'days' ? d.days.map((day) => {
          const isOpen = shown === day.number
          const isToday = !!day.date && day.date === now
          return (
            <article key={day.number} id={`pday-${day.number}`}
              className={cn('scroll-mt-36 overflow-hidden rounded-2xl border bg-white', isToday ? 'border-brand-400 ring-2 ring-brand-100' : 'border-slate-200')}>
              <button type="button" onClick={() => setOpen(isOpen ? -1 : day.number)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white', isToday ? 'bg-brand-600' : 'bg-slate-800')}>{day.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-slate-900">{day.route.join(' → ') || day.title}</span>
                  <span className="block text-sm text-slate-500">
                    {isToday ? <b className="text-brand-700">{L.today}</b> : date(day.date, { weekday: 'short' })}{day.date && ` · ${date(day.date, { day: 'numeric', month: 'short' })}`}
                    {day.km ? ` · ${day.km} ${L.km}` : ''}{day.drive ? ` · ${day.drive}` : ''}
                  </span>
                </span>
                <ChevronDown size={20} className={cn('shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-180')} />
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-slate-100 p-3">
                  {day.map && (
                    <a href={day.map} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white active:bg-brand-700">
                      <MapIcon size={16} />{L.day_map}
                    </a>
                  )}
                  {day.flights.map((f) => <Line key={f} icon={<Plane size={16} />}>{f}</Line>)}
                  {day.steps.length > 0
                    ? <Timeline day={day} orders={[]} words={{ route: L.route, map: L.map, plates: L.plates, portions: L.portions, per_plate: L.per_plate }} />
                    : day.legs.length > 0 && (
                      <ul className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
                        {day.legs.map((g, i) => <li key={i}>{g.start} → {g.end}{g.km ? ` · ${g.km} ${L.km}` : ''}{g.drive ? ` · ${g.drive}` : ''}</li>)}
                      </ul>
                    )}
                  {day.activities.length > 0 && <Line icon={<Ticket size={16} />}>{day.activities.join(' · ')}</Line>}
                  {day.border && <Line icon={<Car size={16} />}>{L.border}: {day.border}</Line>}
                  {day.hotel && <Line icon={<BedDouble size={16} />}><b>{L.overnight}:</b> {day.hotel}</Line>}
                  {day.notes && <p className="whitespace-pre-line rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{day.notes}</p>}
                </div>
              )}
            </article>
          )
        }) : d.days.map((day) => <MenuDay key={day.number} day={day} labels={L} date={date(day.date, { weekday: 'short', day: 'numeric', month: 'short' })} />)}
      </main>
    </div>
  )
}

/** One day's meals: where, and what is served (the set menu's dishes). */
function MenuDay({ day, labels: L, date }: { day: PDay; labels: Record<string, string>; date: string }) {
  // From the timeline when there is one (each meal with its menu under it), else the day's meals list.
  const meals: [string, string, PDish[]][] = day.steps.length
    ? day.steps.filter((s) => s.meal).map((s) => [s.text, s.note ?? '', s.dishes ?? []])
    : day.meals.map(([a, b]) => { const [place, ...menu] = b.split(': '); return [`${a}: ${place}`, menu.join(': '), []] })
  if (!meals.length) return null
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <p className="flex items-baseline justify-between gap-3 bg-sky-50 px-4 py-2">
        <b className="truncate text-slate-900">{L.day.replace('{n}', String(day.number))}{day.route.length ? ` · ${day.route[day.route.length - 1]}` : ''}</b>
        <span className="shrink-0 text-sm text-slate-500">{date}</span>
      </p>
      <ul className="divide-y divide-slate-100">
        {meals.map(([what, menu, dishes], i) => (
          <li key={i} className="flex gap-3 px-4 py-2.5">
            <Utensils size={16} className="mt-1 shrink-0 text-sky-600" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-slate-900">{what}</span>
              {dishes.length > 0
                ? <DishList dishes={dishes} words={{ plates: L.plates, portions: L.portions, per_plate: L.per_plate }} />
                : <span className={cn('block text-sm', menu ? 'text-slate-600' : 'italic text-slate-400')}>{menu || L.no_menu}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <p className="flex items-start gap-2 px-1 text-sm text-slate-700"><span className="mt-0.5 text-slate-400">{icon}</span><span>{children}</span></p>
}
