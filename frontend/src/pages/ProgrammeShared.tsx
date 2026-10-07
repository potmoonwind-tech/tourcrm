/**
 * A programme shared by link (/p/<token>), as a web page for the phone: no login, no PDF. The guide's
 * phone page without the group and money: one card per day (today's opened), the day hour by hour with
 * each drive's time and km, a map for every place and for the whole day, and a Menu tab with what is
 * served at each meal. In the programme's language (English, Georgian or Chinese).
 */
import { useQuery } from '@tanstack/react-query'
import { BedDouble, Car, ChevronDown, Map as MapIcon, MapPin, Phone, Plane, Ticket } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { FullPageSpinner } from '../components/ui'
import { today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Timeline } from './Field'
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
                    ? <Timeline day={day} orders={[]} words={{ route: L.route, map: L.map, menu: L.tab_menu, plates: L.plates, portions: L.portions }}
                        onMenu={(meal) => { setTab('menu'); setTimeout(() => document.getElementById(`menu-${day.number}-${meal}`)?.scrollIntoView({ block: 'start' }), 50) }} />
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
        }) : (
          <>
            {/* Jump to a day: the menus of a long tour are a long page. */}
            <nav aria-label={L.jump} className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1">
              {d.days.filter((day) => day.steps.some((s) => s.meal) || day.meals.length).map((day) => (
                <button key={day.number} type="button" onClick={() => document.getElementById(`menu-day-${day.number}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className={cn('shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium', day.date === now ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-700')}>
                  {L.day.replace('{n}', String(day.number))}
                </button>
              ))}
            </nav>
            <div className="space-y-5">
              {d.days.map((day) => <MenuDay key={day.number} day={day} labels={L} isToday={!!day.date && day.date === now} date={date(day.date, { weekday: 'short', day: 'numeric', month: 'short' })} />)}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/** One day on the Menu tab: each meal as a card - which meal and when, the restaurant (map, call), the set
 * menu's name, and its dishes with how much for the group ("16 portions", "4 plates · 1 / 4"). */
function MenuDay({ day, labels: L, date, isToday }: { day: PDay; labels: Record<string, string>; date: string; isToday: boolean }) {
  const meals = day.steps.filter((s) => s.meal)
  if (!meals.length && !day.meals.length) return null
  return (
    <section id={`menu-day-${day.number}`} className="scroll-mt-36">
      <h2 className="mb-1.5 flex items-baseline gap-2 px-1">
        <span className={cn('flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold text-white', isToday ? 'bg-brand-600' : 'bg-slate-800')}>{day.number}</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-slate-900">{day.route[day.route.length - 1] ?? day.title}</span>
        <span className="shrink-0 text-sm text-slate-500">{isToday ? <b className="text-brand-700">{L.today}</b> : date}</span>
      </h2>
      <div className="space-y-2">
        {meals.length ? meals.map((s, i) => {
          const tables = s.tables ?? []
          const people = tables.reduce((n, x) => n + x.people, 0)
          const split = tables.length > 1
          const unit = (x: PDish) => (x.per_plate > 1 ? L.plates_word : L.portions_word)
          return (
            <article key={i} id={`menu-${day.number}-${s.meal}`} className="scroll-mt-36 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <header className="flex items-start gap-3 px-4 pt-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-amber-700">
                    {L[s.meal!] ?? s.meal}{s.time && ` · ${s.time}`}
                  </span>
                  <span className="block text-base font-semibold text-slate-900">{s.place || s.text}</span>
                  {(s.menu || people > 0) && (
                    <span className="block text-sm text-slate-500">{[s.menu, people > 0 && L.people.replace('{n}', String(people))].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
                {s.map && <IconLink href={s.map} label={L.map}><MapPin size={16} /></IconLink>}
                {s.phone && <IconLink href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} label={s.phone}><Phone size={16} /></IconLink>}
              </header>
              {s.dishes?.length ? (
                <table className="mt-2 w-full border-t border-slate-100 text-sm">
                  {split && (
                    // Two tables: the group's, and the staff's (tour leader, guide, driver) - plates for each.
                    <thead>
                      <tr className="text-xs text-slate-500">
                        <th className="px-4 py-1.5 text-left font-normal" />
                        {tables.map((x) => (
                          <th key={x.who} className="w-20 px-2 py-1.5 text-right font-semibold" title={x.roles?.join(', ') || undefined}>
                            {x.who === 'staff' ? L.table_staff : L.table_group}<span className="block font-normal">{L.people.replace('{n}', String(x.people))}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody className="divide-y divide-slate-100">
                    {s.dishes.map((x) => (
                      <tr key={x.name}>
                        <td className="px-4 py-2 text-slate-800">
                          {x.name}
                          {x.per_plate > 1 && <span className="ml-2 rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-amber-800">1 / {x.per_plate}</span>}
                        </td>
                        {split
                          ? (x.plates_at ?? []).map((n, k) => (
                            <td key={k} className="w-20 px-2 py-2 text-right tabular-nums"><b className="text-slate-900">{n}</b> <span className="text-xs text-slate-500">{unit(x)}</span></td>
                          ))
                          : x.plates != null && (
                            <td className="w-28 px-4 py-2 text-right tabular-nums"><b className="text-slate-900">{x.plates}</b> <span className="text-xs text-slate-500">{unit(x)}</span></td>
                          )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="px-4 pb-3 pt-1 text-sm italic text-slate-400">{L.no_menu}</p>}
              {split && s.dishes?.length && tables[1].roles?.length
                ? <p className="border-t border-slate-100 px-4 py-1.5 text-xs text-slate-500">{L.table_staff}: {tables[1].roles.join(', ')}</p> : null}
              {s.dishes?.length && !split ? <div className="h-1" /> : null}
            </article>
          )
        }) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {day.meals.map(([a, b]) => <li key={a} className="px-4 py-2.5 text-sm"><b className="text-slate-900">{a}</b> <span className="text-slate-600">{b}</span></li>)}
          </ul>
        )}
      </div>
    </section>
  )
}

function IconLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 active:bg-slate-100">{children}</a>
  )
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <p className="flex items-start gap-2 px-1 text-sm text-slate-700"><span className="mt-0.5 text-slate-400">{icon}</span><span>{children}</span></p>
}
