import { useQuery } from '@tanstack/react-query'
import { BedDouble, Car, Coffee, Flag, MapPin, Plane, Printer, Sun, Ticket, Utensils, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { PROGRAMME_KEY, type ProgrammeRequest } from '../components/ProgrammeDialog'
import { Button, FullPageSpinner } from '../components/ui'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'

export interface PStep { time: string; end: string; text: string; drive?: PLeg | null; note?: string; kind?: string; meal?: string; map?: string }
export interface PLeg { start: string; end: string; km: number | null; drive: string; depart?: string; arrive?: string; map?: string }

// One small icon per kind of step, so the day reads at a glance.
export const ICON: Record<string, LucideIcon> = {
  breakfast: Coffee, meal: Utensils, visit: MapPin, checkin: BedDouble, checkout: BedDouble, flight: Plane, free: Sun, arrive: Flag,
}
export const span = (a?: string, b?: string) => (a && b ? `${a}–${b}` : a ?? '')
export interface PDay {
  number: number; date: string | null; title: string; route: string[]; km: number | null; drive: string; legs: PLeg[]; hotel: string
  meals: [string, string][]; activities: string[]; steps: PStep[]; flights: string[]; border: string; notes: string
  map?: string
}
export interface Programme { title: string; subtitle: string; agency: string; lang: string; labels: Record<string, string>; days: PDay[]; total_km: number; warnings: string[] }

const readRequest = (key: string): ProgrammeRequest | null => {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(`${PROGRAMME_KEY}:${key}`)
      if (raw) return JSON.parse(raw) as ProgrammeRequest
    } catch { /* private mode */ }
  }
  return null
}

/** The programme on A4 pages, in the chosen language; it opens the print dialog (Save as PDF) by itself. */
export function ProgrammePrintPage() {
  const { t } = useI18n()
  const { workspaceId } = useParams()
  const [params] = useSearchParams()
  const [req] = useState(() => readRequest(params.get('k') ?? ''))
  const p = useQuery({
    queryKey: ['programmePrint', workspaceId, params.get('k')], enabled: !!req, staleTime: Infinity,
    queryFn: () => api<Programme>(wsPath(workspaceId!, '/programme'), { method: 'POST', body: req }),
  })
  useEffect(() => {
    if (!p.data) return
    document.title = `${p.data.title} · ${p.data.agency}`
    try { localStorage.removeItem(`${PROGRAMME_KEY}:${params.get('k')}`) } catch { /* private mode */ }
    const h = setTimeout(() => window.print(), 400)     // after the fonts and layout settle
    return () => clearTimeout(h)
  }, [p.data, params])
  if (!req) return <p className="p-8 text-slate-600">{t('programmeExpired')}</p>
  if (!p.data) return <FullPageSpinner />
  const d = p.data
  return <ProgrammeDoc d={d} toolbar={<Button onClick={() => window.print()}><Printer size={16} />{t('printPdf')}</Button>} />
}



/** The programme as a document: day cards, one timeline per day (each drive with its time), a map for
 * each place. The print page prints it; the shared link shows it on any phone or computer. */
export function ProgrammeDoc({ d, toolbar }: { d: Programme; toolbar?: ReactNode }) {
  const L = d.labels
  const date = (s: string | null) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString(d.lang === 'zh' ? 'zh-CN' : d.lang === 'ka' ? 'ka-GE' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'long' }) : '')
  return (
    <div lang={d.lang} className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end gap-2 px-4 print:hidden">{toolbar}</div>
      <article className="mx-auto max-w-[210mm] bg-white p-5 text-[13px] sm:p-12 leading-relaxed text-slate-800 shadow print:max-w-none print:p-0 print:shadow-none">
        <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">{d.agency}</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">{d.title}</h1>
        <p className="mt-1 text-slate-500">{d.subtitle}</p>
        <div className="mt-8 space-y-5">
          {d.days.map((day) => (
            <section key={day.number} className="break-inside-avoid overflow-hidden rounded-lg border border-slate-200 print:rounded-none">
              {/* The day's heading: which day, the date, and the road in one line. */}
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 bg-sky-50 px-5 py-2.5">
                <h2 className="text-base font-bold text-slate-900">{day.title}</h2>
                <span className="text-sm text-slate-600">{date(day.date)}</span>
                {(day.km || day.drive) && (
                  <p className="flex w-full items-center gap-1.5 text-xs text-slate-500">
                    <Car size={13} aria-hidden />
                    {[day.km && `${L.distance}: ${day.km} ${L.km}`, day.drive && `${L.driving}: ${day.drive}`].filter(Boolean).join(' · ')}
                  </p>
                )}
              </header>
              <div className="px-5 py-3">
                {day.flights.map((f) => <p key={f} className="flex items-center gap-2 py-0.5"><Plane size={14} className="text-slate-500" aria-hidden />{f}</p>)}
                {/* Without a timed programme: place to place. */}
                {day.steps.length === 0 && day.legs.length > 1 && (
                  <ul className="space-y-0.5 text-xs text-slate-500">
                    {day.legs.map((g, i) => (
                      <li key={i}>{g.start} → {g.end}{g.km ? ` · ${g.km} ${L.km}` : ''}{g.drive ? ` · ${g.drive}` : ''}</li>
                    ))}
                  </ul>
                )}
                {day.steps.length > 0 && (
                  <ol>
                    {day.steps.map((s, i) => {
                      const Icon = ICON[s.kind ?? ''] ?? MapPin
                      const hop = s.drive && [s.drive.km && `${s.drive.km} ${L.km}`, s.drive.drive].filter(Boolean).join(' · ')
                      return (
                        <li key={i}>
                          {/* The drive that leads here, with its own time: the day as one timeline. */}
                          {hop && (
                            <div className="my-0.5 flex items-center gap-3 rounded bg-slate-50 py-0.5 text-xs text-slate-500">
                              <span className="w-[5.5rem] shrink-0 pl-1 tabular-nums sm:w-24">{span(s.drive!.depart, s.drive!.arrive)}</span>
                              <Car size={13} className="shrink-0" aria-hidden />
                              <span>↓ {hop}</span>
                              {s.drive!.map && <a href={s.drive!.map} target="_blank" rel="noopener noreferrer" className="ml-auto pr-2 text-sky-700 no-underline hover:underline print:hidden">{L.route}</a>}
                            </div>
                          )}
                          <div className="flex items-start gap-3 py-1">
                            <span className="w-[5.5rem] shrink-0 pl-1 font-semibold tabular-nums text-slate-700 sm:w-24">{span(s.time, s.end)}</span>
                            <Icon size={14} className="mt-[3px] shrink-0 text-sky-600" aria-hidden />
                            <span className="text-slate-900">{s.map
                              ? <a href={s.map} target="_blank" rel="noopener noreferrer" className="text-sky-800 no-underline hover:underline print:text-slate-900">{s.text}</a>
                              : s.text}
                              {s.note && <span className="block text-xs italic text-slate-500">{s.note}</span>}</span>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
                {/* What's included, at the end of the day. */}
                {(day.meals.length > 0 || day.activities.length > 0 || day.border || day.hotel) && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-slate-100 pt-2 text-xs">
                    {day.meals.length > 0 && <><dt className="font-semibold text-slate-500">{L.meals}</dt>
                      <dd>{day.steps.length ? day.meals.map(([a]) => a).join(', ') : day.meals.map(([a, b]) => `${a} – ${b}`).join('; ')}</dd></>}
                    {day.activities.length > 0 && <><dt className="font-semibold text-slate-500"><Ticket size={12} className="mr-1 inline" aria-hidden />{L.activities}</dt>
                      <dd>{day.activities.join(', ')}</dd></>}
                    {day.border && <><dt className="font-semibold text-slate-500">{L.border}</dt><dd>{day.border}</dd></>}
                    {day.hotel && <><dt className="font-semibold text-slate-500">{L.overnight}</dt><dd className="font-medium text-slate-800">{day.hotel}</dd></>}
                  </dl>
                )}
                {day.notes && <p className="mt-2 text-xs italic text-slate-600">{day.notes}</p>}
              </div>
            </section>
          ))}
        </div>
      </article>
    </div>
  )
}
