/**
 * The phone page a guide or driver opens from the office's private link (/f/<token>), no login.
 * One card per day of their part of the tour: where, hotel and restaurants with a map button and
 * a call button, km, notes. Guides also get the group list and the set menus. Today's day is
 * opened and scrolled to. Big tap targets, readable in a bus.
 */
import { useQuery } from '@tanstack/react-query'
import { BedDouble, Cake, Car, ChevronDown, ChevronRight, MapPin, Navigation, Phone as PhoneIcon, Plane, Ticket, Users, Utensils } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { fmt, today, weekday } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { cn } from '../lib/utils'
import { MoneyTab } from './FieldMoney'
import { ICON, type PDay, type PDish, type PStep } from './ProgrammePrint'

interface Place { name: string; address: string; city: string; phone: string; menu: string | null; dishes: string[] }
interface FieldDay {
  number: number; date: string; city: string; stops?: string[]; km: number | null; breakfast_mode?: string; lunch_mode?: string; dinner_mode?: string;
  flights?: { direction: string; number: string; time: string; airport: string; other: string }[];
  schedule?: { id: string; kind: string; time: string; end: string; title: string; ref: string | null; place: string }[]; border: string; notes: string
  hotel: Place | null; breakfast?: Place | null; lunch: Place | null; dinner: Place | null; extras: string[]
  birthdays?: string[]      // whose birthday it is today (guides)
}
interface FieldView {
  agency: string; office_phone: string; team: { role: string; name: string; phone: string; days: string }[]; tour_code: string; start_date: string; end_date: string; role: string; person: string
  changes?: { id: string; day: number | null; text: string; at: string }[]
  days: FieldDay[]; pax: number | null; group: { name: string; room: string; phone: string; notes: string; birthday?: string | null }[] | null
  timeline?: PDay[]; meals?: MealOrder[]
}
/** What was ordered at a meal (guides): the menu, each dish with its plates and price, the total. */
interface MealOrder {
  day: number; meal: string; menu_name: string | null; people: number; price_pp: number | null; currency: string | null; total: number | null
  tourists_pay: boolean; shared: boolean; dishes: { name: string; price: number | null; per_plate: number; plates: number }[]
}

const mapUrl = (p: Place) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.address, p.city].filter(Boolean).join(', '))}`

export function FieldPage() {
  const { token } = useParams()
  const { t, lang, setLang } = useI18n()
  const page = useQuery({ queryKey: ['field', token, lang], queryFn: () => api<FieldView>(`/field/${token}?lang=${lang === 'ka' ? 'ka' : 'en'}`), retry: false, placeholderData: (x) => x })
  const [tab, setTab] = useState<'days' | 'group' | 'money'>('days')
  const now = today()
  const todayDay = page.data?.days.find((d) => d.date === now)?.number
  const [open, setOpen] = useState<number | null>(null)
  const shown = open ?? todayDay ?? page.data?.days[0]?.number ?? null
  useEffect(() => {
    if (todayDay) document.getElementById(`fday-${todayDay}`)?.scrollIntoView({ block: 'start' })
  }, [todayDay])

  if (page.isLoading) return <div className="p-6 text-center text-slate-500">…</div>
  if (!page.data) {
    return (
      <div className="mx-auto max-w-md p-6 pt-20 text-center">
        <p className="text-lg font-semibold text-slate-800">{t('fieldLinkDead')}</p>
        <p className="mt-2 text-sm text-slate-500">{t('fieldLinkDeadHint')}</p>
      </div>
    )
  }
  const v = page.data
  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 pb-2 pt-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-slate-500">{v.agency}</p>
            <h1 className="truncate text-lg font-semibold text-slate-900">{v.tour_code} · {v.person}</h1>
            <p className="text-sm text-slate-500">{fmt(v.start_date, lang)} – {fmt(v.end_date, lang)} · {t(`staffRole_${v.role}` as never)}</p>
          </div>
          {v.office_phone && (
            <a href={`tel:${v.office_phone.replace(/\s/g, '')}`}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white active:bg-emerald-700">
              <PhoneIcon size={14} />{t('fieldOffice')}
            </a>
          )}
          <button type="button" onClick={() => setLang(lang === 'ka' ? 'en' : 'ka')}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600">{lang === 'ka' ? 'EN' : 'ქარ'}</button>
        </div>
        {v.group && (
          <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
            {(['days', 'group', 'money'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                className={cn('rounded-lg py-2', tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>
                {k === 'days' ? t('fieldDays') : k === 'money' ? t('fieldMoney') : `${t('fieldGroup')} · ${v.pax ?? v.group!.length}`}
              </button>
            ))}
          </div>
        )}
      </header>

      {(v.changes?.length ?? 0) > 0 && (
        <section className="m-3 mb-0 rounded-2xl border-2 border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">{t('fieldChanged')}</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-amber-900">{v.changes!.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
          <button type="button" onClick={() => void fetch(`/api/field/${token}/ack`, { method: 'POST' }).then(() => page.refetch())}
            className="mt-2 w-full rounded-xl bg-amber-600 py-2.5 text-sm font-semibold text-white active:bg-amber-700">{t('fieldGotIt')}</button>
        </section>
      )}
      {tab === 'money' ? <MoneyTab token={token!} days={v.days} /> : tab === 'days' ? (
        <main className="space-y-3 p-3">
          {v.team.length > 0 && (
            <section className="rounded-2xl border border-slate-200 bg-white">
              <p className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-slate-500">{t('fieldTeam')}</p>
              <ul className="divide-y divide-slate-100">
                {v.team.map((m, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">{m.name}</span>
                      <span className="block text-sm text-slate-500">{t(`staffRole_${m.role}` as never)} · {t('fieldTeamDays', { days: m.days })}</span>
                    </span>
                    {m.phone && <CallButton phone={m.phone} />}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {v.days.map((d) => {
            const isOpen = shown === d.number
            const isToday = d.date === now
            return (
              <article key={d.number} id={`fday-${d.number}`} className={cn('scroll-mt-32 overflow-hidden rounded-2xl border bg-white', isToday ? 'border-brand-400 ring-2 ring-brand-100' : 'border-slate-200')}>
                <button type="button" onClick={() => setOpen(isOpen ? -1 : d.number)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', isToday ? 'bg-brand-600 text-white' : 'bg-slate-800 text-white')}>{d.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold text-slate-900">{[...(d.stops ?? []), d.city].filter(Boolean).join(' → ') || '—'}</span>
                    <span className="block text-sm text-slate-500">
                      {isToday ? <b className="text-brand-700">{t('today')}</b> : weekday(d.date, lang)} · {fmt(d.date, lang)}
                      {d.km ? ` · ${d.km} km` : ''}
                    </span>
                  </span>
                  <ChevronDown size={20} className={cn('shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-180')} />
                </button>
                {isOpen && (
                  <div className="space-y-2 border-t border-slate-100 p-3">
                    {(() => {
                      const day = v.timeline?.find((x) => x.number === d.number)
                      return day && day.steps.length > 0
                        ? <Timeline day={day} orders={(v.meals ?? []).filter((m) => m.day === d.number)} />
                        : null
                    })()}
                    {!v.timeline?.find((x) => x.number === d.number)?.steps.length && (d.schedule?.length ?? 0) > 0 && (
                      <ol className="divide-y divide-slate-200 rounded-xl bg-slate-50 px-3 text-base" aria-label={t('dayProgramme')}>
                        {d.schedule!.map((x) => (
                          <li key={x.id} className="flex gap-3 py-2">
                            <span className="w-14 shrink-0 font-bold tabular-nums text-slate-900">{x.time || '—'}
                              {x.end && <span className="block text-sm font-normal text-slate-600">{t('progUntilShort', { time: x.end })}</span>}</span>
                            <span className="min-w-0 flex-1 text-slate-900">{stepText(x, d, t)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {(d.flights ?? []).map((f, i) => (
                      <p key={i} className="flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-900">
                        <Plane size={16} className={f.direction === 'arrival' ? 'rotate-90' : ''} />
                        {t(f.direction === 'arrival' ? 'flightArrival' : 'flightDeparture')} {f.number}{f.time && ` · ${f.time}`}{f.airport && ` · ${f.airport}`}{f.other && ` ${f.direction === 'arrival' ? '←' : '→'} ${f.other}`}
                      </p>
                    ))}
                    {d.border && <Note icon={<Car size={16} />}>{t('border')}: {d.border}</Note>}
                    {d.km ? <Note icon={<Car size={16} />}>{t('fieldKmToday', { km: d.km })}</Note> : null}
                    {d.breakfast && <PlaceCard icon={<Utensils size={16} />} label={t('breakfast') + (d.breakfast_mode === 'tourists' ? ` · ${t('mealTourists')}` : '')} place={d.breakfast} />}
                    <PlaceCard icon={<Utensils size={16} />} label={t('lunch') + (d.lunch_mode === 'tourists' ? ` · ${t('mealTourists')}` : '')} place={d.lunch} />
                    {d.lunch_mode === 'own' && <Note icon={<Utensils size={16} />}>{t('lunch')}: {t('mealOwn')}</Note>}
                    <PlaceCard icon={<Utensils size={16} />} label={t('dinner') + (d.dinner_mode === 'tourists' ? ` · ${t('mealTourists')}` : '')} place={d.dinner} />
                    {d.dinner_mode === 'own' && <Note icon={<Utensils size={16} />}>{t('dinner')}: {t('mealOwn')}</Note>}
                    <PlaceCard icon={<BedDouble size={16} />} label={t('hotel')} place={d.hotel} />
                    {d.extras.length > 0 && <Note icon={<Ticket size={16} />}>{d.extras.join(' · ')}</Note>}
                    {(d.birthdays?.length ?? 0) > 0 && (
                      <p className="flex items-center gap-2 rounded-xl bg-pink-50 px-3 py-2 text-sm font-medium text-pink-900"><Cake size={16} />{t('birthdayToday', { names: d.birthdays!.join(', ') })}</p>
                    )}
                    {d.notes && <p className="whitespace-pre-line rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.notes}</p>}
                    {!d.hotel && !d.lunch && !d.dinner && !d.notes && !d.extras.length && !d.border && (
                      <p className="px-1 py-2 text-sm text-slate-500">{t('fieldNothingPlanned')}</p>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </main>
      ) : (
        <main className="p-3">
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {v.group!.map((p, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3">
                <span className="w-6 shrink-0 text-right text-sm tabular-nums text-slate-400">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-900">{p.name}
                    {p.birthday && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-pink-50 px-2 py-0.5 text-xs font-medium text-pink-800"><Cake size={12} />{fmt(p.birthday, lang)}</span>}</span>
                  {(p.room || p.notes) && <span className="block text-sm text-slate-500">{[p.room, p.notes].filter(Boolean).join(' · ')}</span>}
                </span>
                {p.phone && <CallButton phone={p.phone} />}
              </li>
            ))}
            {v.group!.length === 0 && <li className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500"><Users size={16} />{t('fieldNoNames', { n: v.pax ?? 0 })}</li>}
          </ul>
        </main>
      )}
    </div>
  )
}

/** The day hour by hour, as in the programme file: each drive with its time and km and a route button,
 * each place with a map button, and under each meal what was ordered (plates and prices). */
/** "4 plates · 1 / 4" (a plate for 4) or "13 portions": how much of a dish, in the page's words. */
export type PortionWords = { plates: string; portions: string }
export const portionText = (x: { plates: number | null; per_plate: number }, w: PortionWords) =>
  [x.plates != null && (x.per_plate > 1 ? w.plates : w.portions).replace('{n}', String(x.plates)),
    x.per_plate > 1 && `1 / ${x.per_plate}`].filter(Boolean).join(' · ')

export function DishList({ dishes, words }: { dishes: PDish[]; words: PortionWords }) {
  return (
    <span className="mt-1 block rounded-lg bg-amber-50 px-2.5 py-1.5 text-sm text-slate-800">
      {dishes.map((x) => (
        <span key={x.name} className="flex gap-2 py-0.5">
          <span className="min-w-0 flex-1">{x.name}</span>
          <span className="shrink-0 tabular-nums text-slate-500">{portionText(x, words)}</span>
        </span>
      ))}
    </span>
  )
}

export function Timeline({ day, orders, words, onMenu }: {
  day: PDay; orders: MealOrder[]; words?: { route: string; map: string; menu?: string } & PortionWords
  onMenu?: (meal: string) => void      // the dishes are on the Menu tab: a "Menu ›" link instead of the list
}) {
  const { t } = useI18n()
  const w = words ?? { route: t('route'), map: t('fieldMap'), plates: t('fieldPlates'), portions: t('fieldPortions') }
  return (
    <ol className="overflow-hidden rounded-xl border border-slate-200" aria-label={t('dayProgramme')}>
      {(day.km || day.drive) && (
        <li className="flex items-center gap-2 bg-sky-50 px-3 py-2 text-sm text-slate-700">
          <Car size={15} className="text-slate-500" />{[day.km && `${day.km} km`, day.drive].filter(Boolean).join(' · ')}
        </li>
      )}
      {day.steps.map((s, i) => (
        <li key={i} className="border-t border-slate-100 first:border-t-0">
          {s.drive && (s.drive.km || s.drive.drive) && (
            <div className="flex items-center gap-3 bg-slate-50 px-3 py-1.5 text-sm text-slate-600">
              <span className="w-14 shrink-0 tabular-nums leading-tight">{s.drive.depart}
                {s.drive.arrive && <span className="block">–{s.drive.arrive}</span>}</span>
              <span className="min-w-0 flex-1">↓ {[s.drive.km && `${s.drive.km} km`, s.drive.drive].filter(Boolean).join(' · ')}
                <span className="block truncate text-xs text-slate-500">{s.drive.start} → {s.drive.end}</span></span>
              {s.drive.map && (
                <a href={s.drive.map} target="_blank" rel="noopener noreferrer" aria-label={w.route}
                  className="flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 active:bg-slate-100">
                  <Navigation size={14} />{w.route}
                </a>
              )}
            </div>
          )}
          <Step s={s} order={s.meal ? orders.find((o) => o.meal === s.meal) : undefined} mapLabel={w.map} words={w}
            menu={onMenu && s.meal && s.dishes?.length ? { label: w.menu ?? t('menu'), open: () => onMenu(s.meal!) } : undefined} />
        </li>
      ))}
    </ol>
  )
}

function Step({ s, order, mapLabel, words, menu }: {
  s: PStep; order?: MealOrder; mapLabel: string; words: PortionWords; menu?: { label: string; open: () => void }
}) {
  const { t } = useI18n()
  const Icon = ICON[s.kind ?? ''] ?? MapPin
  const money = (n: number | null) => (n == null ? '' : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${order?.currency ?? ''}`.trim())
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <span className="w-14 shrink-0 font-bold tabular-nums text-slate-900">{s.time || '—'}
        {s.end && <span className="block text-sm font-normal text-slate-500">–{s.end}</span>}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1.5 text-base text-slate-900"><Icon size={16} className="mt-1 shrink-0 text-sky-600" />{s.text}</span>
        {order && (order.dishes.length > 0 || order.total != null) ? (
          <span className="mt-1.5 block rounded-lg bg-amber-50 px-2.5 py-2 text-sm text-slate-800">
            <span className="block text-xs font-semibold uppercase tracking-wide text-amber-800">
              {t('fieldOrdered')}{order.menu_name ? ` · ${order.menu_name}` : ''} · {t('peopleTotal', { n: order.people })}
            </span>
            {order.dishes.map((x) => {
              // Plates per table (group / staff) from the programme, when the staff eat apart.
              const own = s.dishes?.find((y) => y.name === x.name)
              const split = (s.tables?.length ?? 0) > 1 && own?.plates_at
              return (
              <span key={x.name} className="flex gap-2 py-0.5">
                <span className="min-w-0 flex-1">{x.name}{x.per_plate > 1 && <span className="ml-1.5 text-xs font-semibold text-amber-800">1 / {x.per_plate}</span>}</span>
                <span className="shrink-0 tabular-nums text-slate-500">{split
                  ? s.tables!.map((tb, k) => `${tb.who === 'staff' ? t('fieldStaffTable') : t('fieldGroupTable')} ${own!.plates_at![k]}`).join(' · ')
                  : portionText(own ?? x, words)}</span>
                {x.price != null && <span className="shrink-0 tabular-nums text-slate-600">{money(x.price)}</span>}
              </span>
              )
            })}
            {(order.total != null || order.price_pp != null) && (
              <span className="mt-1 block border-t border-amber-200 pt-1 tabular-nums">
                {order.price_pp != null && !order.shared
                  ? <span className="text-slate-600">{money(order.price_pp)} × {order.people} = </span>
                  : <span className="text-slate-600">{t('total')}: </span>}
                {order.total != null && <b className="whitespace-nowrap">{money(order.total)}</b>}
                {order.tourists_pay && <span className="block text-xs text-slate-500">{t('mealTourists')}</span>}
              </span>
            )}
          </span>
        ) : menu ? (
          <button type="button" onClick={menu.open} className="mt-0.5 flex items-center gap-1 text-sm font-medium text-brand-700 active:text-brand-800">
            {s.menu || menu.label}<ChevronRight size={14} />
          </button>
        ) : s.dishes?.length ? <DishList dishes={s.dishes} words={words} />
          : s.note ? <span className="mt-0.5 block text-sm italic text-slate-500">{s.note}</span> : null}
      </span>
      <span className="flex shrink-0 flex-col gap-1.5">
        {s.map && (
          <a href={s.map} target="_blank" rel="noopener noreferrer" aria-label={mapLabel}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white active:bg-brand-700"><MapPin size={16} /></a>
        )}
        {s.phone && (
          <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} aria-label={`${t('fieldCall')} ${s.phone}`}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-700 active:bg-slate-100"><PhoneIcon size={16} /></a>
        )}
      </span>
    </div>
  )
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <p className="flex items-center gap-2 px-1 text-sm text-slate-700"><span className="text-slate-400">{icon}</span>{children}</p>
}

function PlaceCard({ icon, label, place }: { icon: ReactNode; label: string; place: Place | null }) {
  const { t } = useI18n()
  if (!place) return null
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">{icon}{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-900">{place.name}</p>
      {(place.address || place.city) && <p className="text-sm text-slate-600">{[place.address, place.city].filter(Boolean).join(', ')}</p>}
      {place.menu && (
        <p className="mt-1 text-sm text-slate-700">{place.menu}{place.dishes.length > 0 && <span className="text-slate-500"> — {place.dishes.join(', ')}</span>}</p>
      )}
      <div className="mt-2 flex gap-2">
        <a href={mapUrl(place)} target="_blank" rel="noopener noreferrer"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white active:bg-brand-700">
          <MapPin size={16} />{t('fieldMap')}
        </a>
        {place.phone && <CallButton phone={place.phone} wide />}
      </div>
    </div>
  )
}

function CallButton({ phone, wide }: { phone: string; wide?: boolean }) {
  const { t } = useI18n()
  return (
    <a href={`tel:${phone.replace(/\s/g, '')}`} aria-label={`${t('fieldCall')} ${phone}`}
      className={cn('flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700 active:bg-slate-100',
        wide ? 'flex-1 py-2.5' : 'h-10 w-10 shrink-0')}>
      <PhoneIcon size={16} />{wide && t('fieldCall')}
    </a>
  )
}

/** A programme step in words, from the day's own content when it points at it. */
function stepText(x: { kind: string; title: string; ref: string | null }, d: FieldDay, t: (k: TKey) => string): string {
  const r = x.ref ?? ''
  if (r === 'breakfast') {
    if (d.breakfast_mode === 'own') return `${t('breakfast')}: ${t('mealOwn')}`
    return d.breakfast ? `${t('breakfast')}: ${d.breakfast.name}${d.breakfast_mode === 'tourists' ? ` (${t('mealTourists')})` : ''}` : t('progBreakfast')
  }
  if (r === 'hotel') return `${t('progCheckin')}: ${d.hotel?.name ?? ''}`
  if (r === 'lunch' || r === 'dinner') {
    const mode = r === 'lunch' ? d.lunch_mode : d.dinner_mode
    const place = r === 'lunch' ? d.lunch : d.dinner
    return `${t(r)}: ${mode === 'own' ? t('mealOwn') : place?.name ?? ''}${mode === 'tourists' ? ` (${t('mealTourists')})` : ''}`
  }
  if (r.startsWith('flight:')) {
    const f = (d.flights ?? [])[Number(r.slice(7))]
    return f ? `${t(f.direction === 'arrival' ? 'flightArrival' : 'flightDeparture')} ${f.number}` : ''
  }
  if (r.startsWith('extra:')) return x.title || d.extras.join(', ')
  return x.title || t(`prog_${x.kind}` as TKey)
}
