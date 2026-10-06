import { useQuery } from '@tanstack/react-query'
import { cn, paxText } from '../lib/utils'
import { CityDay } from '../components/CityDay'
import { AlertOctagon, BedDouble, Bus, ChevronLeft, ChevronRight, Flag, MapPin, Ticket, User, Utensils } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CodeChip, EmptyState, Phone } from '../components/tour'
import { Button, Card, Input } from '../components/ui'
import { api, type DayViewRow, type Incident, type VendorRef } from '../lib/api'
import { useServiceList, wsPath } from '../lib/data'
import { addDays, diffDays, fmtLong, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { PageHeader } from './Dashboard'
import { useIncidents } from './Incidents'

export function DayViewPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const [params, setParams] = useSearchParams()
  const day = params.get('date') || today()
  const byCity = params.get('view') === 'city'
  const go = (d: string, city = byCity) => setParams({ ...(d === today() ? {} : { date: d }), ...(city ? { view: 'city' } : {}) }, { replace: true })

  const rows = useQuery({
    queryKey: ['day', ws.id, day],
    queryFn: () => api<DayViewRow[]>(wsPath(ws.id, `/day/${day}`)),
    placeholderData: (prev) => prev,
  })
  const data = rows.data ?? []
  const pax = data.reduce((s, r) => s + r.tour.pax, 0)
  const crossings = data.filter((r) => r.day.border_crossing)
  const incidents = useIncidents('status=open')

  return (
    <>
      <PageHeader section="tours" title={t('tours')}
        subtitle={<span className="capitalize">{fmtLong(day, lang)} · {data.length} / {pax} {t('touristsTotal')}</span>}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => go(addDays(day, -1))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
            <Input type="date" value={day} onChange={(e) => e.target.value && go(e.target.value)} className="w-40" />
            <Button variant="secondary" onClick={() => go(addDays(day, 1))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
            {day !== today() && <Button variant="secondary" onClick={() => go(today())}>{t('today')}</Button>}
          </div>
        } />
      <div className="space-y-4 p-4 md:p-8">
        {crossings.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
            <Flag size={16} className="text-amber-600" />
            <span className="font-semibold text-amber-900">{t('border')}:</span>
            {crossings.map((r) => (
              <span key={r.tour.id} className="rounded-md bg-white px-2 py-0.5 text-amber-900 shadow-sm">
                <b>{r.tour.code}</b> → {r.day.border_crossing} ({paxText(r.tour)})
              </span>
            ))}
          </div>
        )}
        {data.length > 0 && (
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm" role="tablist">
            {([false, true] as const).map((c) => (
              <button key={String(c)} type="button" role="tab" aria-selected={byCity === c} onClick={() => go(day, c)}
                className={cn('rounded-md px-3 py-1 font-medium', byCity === c ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                {t(c ? 'dayByCity' : 'dayByGroup')}
              </button>
            ))}
          </div>
        )}
        {rows.isSuccess && data.length === 0 && <EmptyState title={t('noGroupsDay')} />}
        {byCity ? <CityDay date={day} rows={data} /> : <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {data.map((r) => <GroupCard key={r.tour.id} row={r}
            incidents={(incidents.data ?? []).filter((i) => i.tour_id === r.tour.id && (i.day === null || i.day === r.day.day_number))} />)}
        </div>}
      </div>
    </>
  )
}

function GroupCard({ row: { tour, day, staff_today, is_first_day, is_last_day }, incidents }: { row: DayViewRow; incidents: Incident[] }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const total = diffDays(tour.start_date, tour.end_date) + 1
  const services = useServiceList()
  const extras = day.extras.map((x) => services.data?.find((s) => s.id === x.service_id)).filter((s) => !!s)
  return (
    <Card className="overflow-hidden">
      <Link to={`/w/${ws.id}/tours/${tour.id}`} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-50">
        <CodeChip code={tour.code} color={tour.color} className="text-sm" />
        <span className="min-w-0 flex-1 truncate font-medium">{tour.client_name}</span>
        <span className="text-sm font-semibold tabular-nums">{paxText(tour)} <span className="font-normal text-slate-400">{t('pax').toLowerCase()}</span></span>
      </Link>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-xs">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">{t('day')} {day.day_number}/{total}</span>
        {is_first_day && <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">{t('arrival')}</span>}
        {is_last_day && <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-800">{t('departure')}</span>}
        {tour.status === 'inquiry' && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">{t('status_inquiry')}</span>}
      </div>
      <dl className="space-y-2 p-4 text-sm">
        <Line icon={<MapPin size={15} />} label={t('city')}><b>{day.city || '—'}</b></Line>
        <Line icon={<BedDouble size={15} />} label={t('hotel')}><VendorLine v={day.hotel} /></Line>
        {day.breakfast && <Line icon={<Utensils size={15} />} label={t('breakfast')}><VendorLine v={day.breakfast} /><MenuLine id={day.breakfast_menu_id ?? null} /></Line>}
        <Line icon={<Utensils size={15} />} label={t('lunch')}><VendorLine v={day.lunch} /><MenuLine id={day.lunch_menu_id} /></Line>
        <Line icon={<Utensils size={15} />} label={t('dinner')}><VendorLine v={day.dinner} /><MenuLine id={day.dinner_menu_id} /></Line>
        {extras.map((s, i) => (
          <Line key={`${s.id}-${i}`} icon={<Ticket size={15} />} label={s.name}><VendorLine v={s.vendor} /></Line>
        ))}
        {staff_today.length === 0 && <Line icon={<User size={15} />} label={t('staff')}><span className="text-slate-400">—</span></Line>}
        {staff_today.map((a) => (
          <Line key={a.id} icon={a.role === 'transport' || a.role === 'driver' ? <Bus size={15} /> : <User size={15} />}
            label={t(`staffRole_${a.role}`)}>
            <VendorLine v={a.vendor} />
          </Line>
        ))}
        {day.border_crossing && (
          <Line icon={<Flag size={15} className="text-amber-600" />} label={t('border')}>
            <b className="text-amber-700">{day.border_crossing}</b>
          </Line>
        )}
        {day.notes && <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">{day.notes}</p>}
        {incidents.map((i) => (
          <Link key={i.id} to={`/w/${ws.id}/tours/${tour.id}?tab=incidents`}
            className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 hover:bg-amber-100">
            <AlertOctagon size={15} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{i.title}</span>
            <span className="text-xs">{t('incident_open')}</span>
          </Link>
        ))}
      </dl>
    </Card>
  )
}

function Line({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="flex w-28 shrink-0 items-center gap-2 text-slate-500">{icon}{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

function VendorLine({ v }: { v: VendorRef | null }) {
  if (!v) return <span className="text-slate-400">—</span>
  return <span className="flex flex-wrap gap-x-2"><span className="font-medium">{v.name}</span><Phone phone={v.phone} /></span>
}

/** The set menu chosen at the restaurant, and its dishes. */
function MenuLine({ id }: { id: string | null }) {
  const services = useServiceList()
  const m = id ? services.data?.find((s) => s.id === id) : undefined
  if (!m) return null
  return (
    <span className="mt-0.5 block text-xs text-slate-600">
      <b className="font-medium">{m.name}</b>{m.dishes.length > 0 && `: ${m.dishes.map((d) => d.name).join(', ')}`}
    </span>
  )
}
