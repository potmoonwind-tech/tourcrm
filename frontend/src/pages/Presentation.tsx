/**
 * A tour's presentation for the client (/present/<token>): no login. A cover with the tour's best photo, the
 * route on a map, a page per day (its photos, the day hour by hour, the night's hotel), the hotels, what's
 * included, the price if the agency chose to show it, and the photos' credits. "Save as PDF" prints it with a
 * page per section. In the language the link was made in.
 */
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { BedDouble, Check, Download, MapPin } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { decode } from '../components/TripMap'
import { FullPageSpinner } from '../components/ui'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'

interface Photo { id: string; url: string; thumb: string; credit: string; link: string; source: string }
interface Subject { kind: 'town' | 'sight' | 'hotel'; name: string; photo: Photo | null }
interface Step { time: string; end: string; text: string; kind: string }
interface Day { number: number; date: string | null; route: string[]; km: number | null; drive: string; hotel: string; steps: Step[]; flights: string[]; subjects: Subject[] }
interface Pres {
  title: string; start: string | null; end: string | null; agency: string; client: string; people: number | null; lang: string
  labels: Record<string, string>; cover: Photo | null; points: { name: string; lat: number; lon: number; day: number }[]; roads: string[]
  days: Day[]; hotels: { name: string; nights: number; photo: Photo | null }[]; included: string[]; price: string; total_km: number
}

const LOCALE: Record<string, string> = { en: 'en-GB', ka: 'ka-GE', zh: 'zh-CN' }
const say = (s: string, n: number | string) => s.replace('{n}', String(n))

export function PresentationPage() {
  const { token } = useParams()
  const { t } = useI18n()
  const p = useQuery({
    queryKey: ['presentation', token], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/shared/presentation/${encodeURIComponent(token ?? '')}`)
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as Pres
    },
  })
  if (p.isLoading) return <FullPageSpinner />
  if (!p.data) return <div className="mx-auto max-w-md p-6 pt-20 text-center"><p className="text-lg font-semibold text-slate-800">{t('shareLinkDead')}</p></div>
  return <Presentation d={p.data} />
}

function Presentation({ d }: { d: Pres }) {
  const Lb = d.labels
  const date = (s: string | null, o: Intl.DateTimeFormatOptions) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString(LOCALE[d.lang] ?? 'en-GB', o) : '')
  useEffect(() => { document.title = `${d.title} · ${d.agency}`; document.documentElement.lang = d.lang }, [d])
  const nights = Math.max(d.days.length - 1, 0)
  const nightsOf = (n: number) => (n === 1 && Lb.night ? Lb.night : say(Lb.nights, n))
  const towns = d.days.map((x) => x.route[x.route.length - 1]).filter((x, i, a) => x && x !== a[i - 1])
  const credits = [d.cover, ...d.days.flatMap((x) => x.subjects.map((s) => s.photo)), ...d.hotels.map((h) => h.photo)]
    .filter((x): x is Photo => !!x && !!x.credit).filter((x, i, a) => a.findIndex((y) => y.credit === x.credit) === i)
  return (
    <div className="pres min-h-screen bg-white text-slate-900">
      <button type="button" onClick={() => window.print()}
        className="pres-noprint fixed right-4 top-4 z-[500] flex items-center gap-2 rounded-full bg-white/95 px-4 py-2 text-sm font-semibold text-slate-800 shadow-lg ring-1 ring-slate-200 hover:bg-white">
        <Download size={16} />{Lb.save_pdf}
      </button>

      {/* The cover: the tour's best photo, its name and dates. */}
      <header className="pres-cover relative flex min-h-[78vh] items-end overflow-hidden bg-slate-900">
        {d.cover && <img src={d.cover.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
        <div className="relative mx-auto w-full max-w-5xl px-6 pb-12 text-white sm:px-10">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80">{d.agency}</p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-6xl">{d.title}</h1>
          <p className="mt-4 text-lg text-white/90">
            {[date(d.start, { day: 'numeric', month: 'long' }) + (d.end ? ` – ${date(d.end, { day: 'numeric', month: 'long', year: 'numeric' })}` : ''),
              say(Lb.days, d.days.length), nights ? nightsOf(nights) : '', d.people ? say(Lb.people, d.people) : ''].filter(Boolean).join(' · ')}
          </p>
          {d.client && <p className="mt-2 text-white/75">{Lb.for.replace('{client}', d.client)}</p>}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 sm:px-10">
        {/* The route: the map, and the towns in order. */}
        {d.points.length > 1 && (
          <section className="pres-page py-14">
            <h2 className="text-3xl font-semibold">{Lb.route}</h2>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 text-slate-600">
              {towns.map((x, i) => <span key={i} className="flex items-center gap-2">{i > 0 && <span className="text-slate-300">→</span>}{x}</span>)}
              {d.total_km > 0 && <span className="text-slate-400">· {say(Lb.km, d.total_km.toLocaleString())}</span>}
            </p>
            <RouteMap points={d.points} roads={d.roads} />
          </section>
        )}

        {/* A page per day. */}
        {d.days.map((day) => {
          const pics = day.subjects.filter((s) => s.kind !== 'hotel' && s.photo)
          const main = pics.find((s) => s.kind === 'sight') ?? pics[0]
          const more = pics.filter((s) => s !== main).slice(0, 2)
          const hotel = day.subjects.find((s) => s.kind === 'hotel')
          return (
            <article key={day.number} className="pres-page grid gap-8 border-t border-slate-100 py-14 md:grid-cols-5">
              <div className="space-y-3 md:col-span-3">
                {main ? <Figure s={main} big /> : <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-slate-100 text-slate-300"><MapPin size={40} /></div>}
                {more.length > 0 && <div className="grid grid-cols-2 gap-3">{more.map((s) => <Figure key={s.name} s={s} />)}</div>}
              </div>
              <div className="md:col-span-2">
                <p className="text-sm font-semibold uppercase tracking-[0.15em] text-brand-700">
                  {say(Lb.day, day.number)}{day.date && <span className="font-normal normal-case tracking-normal text-slate-500"> · {date(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>}
                </p>
                <h2 className="mt-2 text-2xl font-semibold leading-snug">{day.route.join(' → ')}</h2>
                {(day.km || day.drive) && <p className="mt-1 text-sm text-slate-500">{[day.km ? say(Lb.km, day.km) : '', day.drive].filter(Boolean).join(' · ')}</p>}
                <ol className="mt-5 space-y-2.5">
                  {day.steps.map((s, i) => (
                    <li key={i} className="flex gap-3 text-[15px] leading-snug">
                      <span className="w-12 shrink-0 tabular-nums text-slate-400">{s.time}</span>
                      <span className={cn(s.kind === 'visit' ? 'font-medium text-slate-900' : 'text-slate-700')}>{s.text}</span>
                    </li>
                  ))}
                </ol>
                {hotel && (
                  <div className="mt-6 flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                    {hotel.photo ? <img src={hotel.photo.thumb} alt="" className="h-14 w-20 shrink-0 rounded-lg object-cover" />
                      : <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-white text-slate-400"><BedDouble size={20} /></span>}
                    <span className="min-w-0">
                      <span className="block text-xs uppercase tracking-wide text-slate-500">{Lb.overnight}</span>
                      <span className="block font-medium">{hotel.name}</span>
                    </span>
                  </div>
                )}
              </div>
            </article>
          )
        })}

        {/* The hotels, what's included, the price. */}
        <section className="pres-page border-t border-slate-100 py-14">
          {d.hotels.length > 0 && <>
            <h2 className="text-3xl font-semibold">{Lb.hotels}</h2>
            {/* With a photo: a card; without one: a plain line (no empty grey boxes). */}
            <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {d.hotels.filter((h) => h.photo).map((h) => (
                <div key={h.name} className="overflow-hidden rounded-2xl border border-slate-100">
                  <img src={h.photo!.url} alt={h.name} className="aspect-[4/3] w-full object-cover" />
                  <div className="p-4"><p className="font-semibold">{h.name}</p><p className="text-sm text-slate-500">{nightsOf(h.nights)}</p></div>
                </div>
              ))}
            </div>
            <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {d.hotels.filter((h) => !h.photo).map((h) => (
                <li key={h.name} className="flex items-center gap-3 text-[15px]">
                  <BedDouble size={18} className="shrink-0 text-slate-400" /><span className="font-medium">{h.name}</span>
                  <span className="text-slate-500">· {nightsOf(h.nights)}</span>
                </li>
              ))}
            </ul>
          </>}
          {d.included.length > 0 && <>
            <h2 className="mt-14 text-3xl font-semibold">{Lb.included}</h2>
            <ul className="mt-5 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {d.included.map((x) => <li key={x} className="flex gap-2 text-[15px]"><Check size={18} className="mt-0.5 shrink-0 text-emerald-600" />{x}</li>)}
            </ul>
          </>}
          {d.price && (
            <div className="mt-12 inline-flex flex-col rounded-2xl bg-slate-900 px-8 py-6 text-white">
              <span className="text-sm uppercase tracking-[0.15em] text-white/70">{Lb.price}</span>
              <span className="mt-1 text-4xl font-semibold tabular-nums">{d.price}</span>
            </div>
          )}
        </section>

        <footer className="border-t border-slate-100 py-8 text-xs text-slate-400">
          <p className="font-medium text-slate-500">{d.agency}</p>
          {credits.length > 0 && (
            <p className="mt-2">{Lb.photos}: {credits.map((c, i) => (
              <span key={c.id}>{i > 0 && ' · '}{c.link ? <a href={c.link} target="_blank" rel="noreferrer" className="hover:underline">{c.credit}</a> : c.credit}</span>
            ))} · Wikimedia Commons</p>
          )}
        </footer>
      </main>
    </div>
  )
}

function Figure({ s, big }: { s: Subject; big?: boolean }) {
  return (
    <figure className="overflow-hidden rounded-2xl bg-slate-100">
      <img src={big ? s.photo!.url : s.photo!.thumb} alt={s.name} className={cn('w-full object-cover', big ? 'aspect-[4/3]' : 'aspect-[3/2]')} />
      <figcaption className="px-3 py-1.5 text-xs text-slate-500">{s.name}</figcaption>
    </figure>
  )
}

/** The whole route: the roads in the brand colour, and each day's town numbered. */
function RouteMap({ points, roads }: { points: Pres['points']; roads: string[] }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!el.current) return
    const m = L.map(el.current, { zoomControl: false, scrollWheelZoom: false, attributionControl: true })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18, className: 'tm-tiles' }).addTo(m)
    const brand = getComputedStyle(document.documentElement).getPropertyValue('--color-brand-600').trim() || '#2563eb'
    for (const r of roads) L.polyline(decode(r), { color: brand, weight: 4, opacity: 0.85 }).addTo(m)
    // The day numbers at the town where each day ends; days ending in the same town share one mark ("1 · 2 · 4").
    const last = new Map<number, Pres['points'][number]>()
    for (const pt of points) last.set(pt.day, pt)
    const at = new Map<string, { pt: Pres['points'][number]; days: number[] }>()
    for (const [day, pt] of last) {
      const k = `${pt.lat.toFixed(3)},${pt.lon.toFixed(3)}`
      const x = at.get(k) ?? { pt, days: [] }
      x.days.push(day)
      at.set(k, x)
    }
    for (const { pt, days } of at.values()) {
      L.marker([pt.lat, pt.lon], { icon: L.divIcon({ className: '', html: `<span class="pres-pin">${days.join(' · ')}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), title: pt.name }).addTo(m)
    }
    m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number])), { padding: [36, 36] })
    const id = setTimeout(() => { m.invalidateSize(); m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number])), { padding: [36, 36] }) }, 200)
    return () => { clearTimeout(id); m.remove() }
  }, [points, roads])
  return <div ref={el} className="mt-6 h-[440px] overflow-hidden rounded-2xl border border-slate-100" />
}
