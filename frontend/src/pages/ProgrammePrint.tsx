import { useQuery } from '@tanstack/react-query'
import { BedDouble, Car, Plane, Printer, Ticket, Utensils } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { PROGRAMME_KEY, type ProgrammeRequest } from '../components/ProgrammeDialog'
import { Button, FullPageSpinner } from '../components/ui'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'

interface PStep { time: string; end: string; text: string }
interface PLeg { start: string; end: string; km: number | null; drive: string }
interface PDay {
  number: number; date: string | null; title: string; route: string[]; km: number | null; drive: string; legs: PLeg[]; hotel: string
  meals: [string, string][]; activities: string[]; steps: PStep[]; flights: string[]; border: string; notes: string
}
interface Programme { title: string; subtitle: string; agency: string; lang: string; labels: Record<string, string>; days: PDay[]; total_km: number; warnings: string[] }

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
  const L = d.labels
  const date = (s: string | null) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString(d.lang === 'zh' ? 'zh-CN' : d.lang === 'ka' ? 'ka-GE' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'long' }) : '')
  return (
    <div lang={d.lang} className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end px-4 print:hidden">
        <Button onClick={() => window.print()}><Printer size={16} />{t('printPdf')}</Button>
      </div>
      <article className="mx-auto max-w-[210mm] bg-white p-12 text-[13px] leading-relaxed text-slate-800 shadow print:max-w-none print:p-0 print:shadow-none">
        <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">{d.agency}</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">{d.title}</h1>
        <p className="mt-1 text-slate-500">{d.subtitle}</p>
        <div className="mt-8 space-y-6">
          {d.days.map((day) => (
            <section key={day.number} className="break-inside-avoid border-l-4 border-sky-500 pl-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h2 className="text-lg font-bold text-slate-900">{day.title}</h2>
                {day.date && <span className="text-sm text-slate-500">{date(day.date)}</span>}
              </div>
              {(day.km || day.drive) && (
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-500">
                  <Car size={14} aria-hidden />
                  {[day.km && `${L.distance}: ${day.km} ${L.km}`, day.drive && `${L.driving}: ${day.drive}`].filter(Boolean).join(' · ')}
                </p>
              )}
              {day.legs.length > 1 && (
                <ul className="mt-1 space-y-0.5 pl-5 text-xs text-slate-500">
                  {day.legs.map((g, i) => (
                    <li key={i}>{g.start} → {g.end}{g.km ? ` · ${g.km} ${L.km}` : ''}{g.drive ? ` · ${g.drive}` : ''}</li>
                  ))}
                </ul>
              )}
              {day.flights.map((f) => <p key={f} className="mt-1 flex items-center gap-1.5 text-sm"><Plane size={14} aria-hidden />{f}</p>)}
              {day.steps.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {day.steps.map((s, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="w-24 shrink-0 tabular-nums text-slate-500">{s.time}{s.end && `–${s.end}`}</span>
                      <span>{s.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {day.activities.length > 0 && (
                <p className="mt-2 flex gap-1.5"><Ticket size={14} className="mt-1 shrink-0 text-pink-600" aria-hidden />
                  <span><b>{L.activities}:</b> {day.activities.join(', ')}</span></p>
              )}
              {day.meals.length > 0 && (
                <p className="mt-1 flex gap-1.5"><Utensils size={14} className="mt-1 shrink-0 text-emerald-600" aria-hidden />
                  <span><b>{L.meals}:</b> {day.meals.map(([a, b]) => `${a} – ${b}`).join('; ')}</span></p>
              )}
              {day.border && <p className="mt-1"><b>{L.border}:</b> {day.border}</p>}
              {day.hotel && (
                <p className="mt-1 flex gap-1.5"><BedDouble size={14} className="mt-1 shrink-0 text-sky-600" aria-hidden />
                  <span><b>{L.overnight}:</b> {day.hotel}</span></p>
              )}
              {day.notes && <p className="mt-1 italic text-slate-600">{day.notes}</p>}
            </section>
          ))}
        </div>
      </article>
    </div>
  )
}
