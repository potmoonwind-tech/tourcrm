/**
 * The groups in one city on one day, side by side: a timeline of their programmes, a warning when two
 * groups are at the same restaurant, sight or hotel at the same time, and each group's programme to
 * move a time or the order right here. Saving goes through the tour's day, so the change is recorded
 * and its guide and driver see it (app/changes.py).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, MapPin } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, atLeast, type DayViewRow, type ScheduleItem, type ServiceBrief, type Vendor } from '../lib/api'
import { useServiceList, useVendors, wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, paxText } from '../lib/utils'
import { DayProgramme, suggest, toFields } from './DayProgramme'
import { CodeChip } from './tour'
import { InfoTip, Tooltip } from './Tooltip'
import { Card } from './ui'

const FROM = 7 * 60, TO = 23 * 60
const LENGTH: Record<string, number> = { meal: 90, visit: 90, breakfast: 60, free: 60, transfer: 60, checkin: 30, checkout: 30, flight: 30, other: 60 }
const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

interface Slot { row: DayViewRow; item: ScheduleItem; start: number; end: number; key: string | null; name: string }

/** The programme of a group's day (saved, or the suggested one) with times and where each step is. */
function slots(row: DayViewRow, services: ServiceBrief[], byId: Map<string, Vendor>, factor = 1.25): Slot[] {
  const day = toFields(row.day)
  const items = day.schedule?.length ? day.schedule : suggest(day, row.day.day_number - 1, row.is_last_day, services, factor)
  const out: Slot[] = []
  for (const item of items) {
    if (!item.time) continue
    const start = mins(item.time)
    const end = item.end ? Math.max(mins(item.end), start + 15) : start + (LENGTH[item.kind] ?? 60)
    const r = item.ref ?? ''
    let vendor: string | null = null
    if (r === 'hotel') vendor = day.hotel_id
    else if (r === 'breakfast' && ['included', 'tourists'].includes(day.breakfast_mode ?? 'hotel')) vendor = day.breakfast_id ?? null
    else if (r === 'lunch' && day.lunch_mode !== 'own') vendor = day.lunch_id
    else if (r === 'dinner' && day.dinner_mode !== 'own') vendor = day.dinner_id
    else if (r.startsWith('extra:')) {
      const slot = day.extras.find((e) => e.id === r.slice(6))
      vendor = services.find((s) => s.id === slot?.service_id)?.vendor.id ?? null
    }
    const typed = (item.place || (r ? '' : item.title)).trim()
    const key = vendor ? `v:${vendor}` : typed && !['breakfast', 'free', 'flight', 'transfer'].includes(item.kind) ? `p:${typed.toLowerCase()}` : null
    const name = vendor ? byId.get(vendor)?.name ?? '' : typed || item.title
    out.push({ row, item, start, end, key, name })
  }
  return out
}

/** Places two or more groups share at overlapping times. */
function clashes(all: Slot[]) {
  const out: { key: string; name: string; at: Slot[] }[] = []
  const byKey = new Map<string, Slot[]>()
  for (const s of all) if (s.key) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s])
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.start - b.start)
    let group: Slot[] = []
    let until = -1
    const flush = () => { if (new Set(group.map((g) => g.row.tour.id)).size > 1) out.push({ key, name: group[0].name, at: group }) }
    for (const s of sorted) {
      if (s.start < until) { group.push(s); until = Math.max(until, s.end) } else { flush(); group = [s]; until = s.end }
    }
    flush()
  }
  return out
}

export function CityDay({ date, rows }: { date: string; rows: DayViewRow[] }) {
  const { t } = useI18n()
  const services = useServiceList()
  const vendors = useVendors()
  const factor = useWorkspace()?.drive_factor ?? 1.25
  const list = services.data ?? []
  const byId = new Map((vendors.data ?? []).map((v) => [v.id, v]))
  const cities = new Map<string, DayViewRow[]>()
  for (const r of rows) {
    const c = r.day.city || '—'
    cities.set(c, [...(cities.get(c) ?? []), r])
  }
  const order = [...cities.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  return (
    <div className="space-y-6">
      <p className="flex items-start gap-1 text-sm text-slate-600">{t('cityHelp')}<InfoTip label={t('cityHelpTip')} className="-mt-1" /></p>
      {order.map(([city, group]) => {
        const all = group.flatMap((r) => slots(r, list, byId, factor))
        const clash = clashes(all)
        const clashed = new Set(clash.flatMap((c) => c.at.map((s) => s.item.id)))
        return (
          <section key={city} className="space-y-3">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold"><MapPin size={18} aria-hidden className="text-slate-500" />{city}
              <span className="text-sm font-normal text-slate-600">{t('cityGroups', { n: group.length, pax: group.reduce((s, r) => s + r.tour.pax, 0) })}</span>
            </h2>
            {clash.map((c) => (
              <div key={c.key + c.at[0].start} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{t('cityClash', { place: c.name })}{' '}
                  {c.at.map((s) => `${s.row.tour.code} ${hhmm(s.start)}–${hhmm(s.end)} (${paxText(s.row.tour)})`).join(' · ')}
                </span>
              </div>
            ))}
            <Timeline group={group} all={all} clashed={clashed} />
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {group.map((r) => <Column key={r.tour.id} date={date} row={r} services={list} byId={byId} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// Colours with enough contrast for white text (WCAG AA); each also has a name in the legend and tooltip.
const BLOCK = { meal: 'bg-teal-700', visit: 'bg-brand-600', other: 'bg-slate-500', clash: 'bg-red-700' }
const blockKind = (k: string) => (k === 'meal' || k === 'breakfast' ? 'meal' : k === 'visit' ? 'visit' : 'other')

function Timeline({ group, all, clashed }: { group: DayViewRow[]; all: Slot[]; clashed: Set<string> }) {
  const { t } = useI18n()
  const pos = (n: number) => `${((Math.min(Math.max(n, FROM), TO) - FROM) / (TO - FROM)) * 100}%`
  const hours = Array.from({ length: (TO - FROM) / 60 + 1 }, (_, i) => FROM + i * 60)
  return (
    <Card className="p-3">
      <div className="overflow-x-auto">
        <div className="min-w-[720px]" role="list" aria-label={t('cityTimeline')}>
          <div className="relative ml-28 h-5 text-xs font-medium text-slate-500" aria-hidden>
            {hours.map((h) => <span key={h} className="absolute -translate-x-1/2 tabular-nums" style={{ left: pos(h) }}>{String(h / 60).padStart(2, '0')}</span>)}
          </div>
          {group.map((r) => (
            <div key={r.tour.id} className="flex items-center gap-2 py-1" role="listitem" aria-label={r.tour.code}>
              <CodeChip code={r.tour.code} color={r.tour.color} className="w-26 shrink-0 justify-center text-sm" />
              <div className="relative h-9 flex-1 rounded-md bg-slate-50">
                {hours.map((h) => <span key={h} aria-hidden className="absolute inset-y-0 w-px bg-slate-200" style={{ left: pos(h) }} />)}
                {all.filter((s) => s.row.tour.id === r.tour.id).map((s) => {
                  const clash = clashed.has(s.item.id)
                  const text = `${hhmm(s.start)}–${hhmm(s.end)} · ${s.name || t(`prog_${s.item.kind}` as never)}${clash ? ` · ${t('cityClashShort')}` : ''}`
                  return (
                    <Tooltip key={s.item.id} label={text}>
                      <span tabIndex={0} aria-label={text}
                        className={cn('absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded-md px-1.5 text-xs font-medium leading-none whitespace-nowrap text-white',
                          clash ? `${BLOCK.clash} ring-2 ring-red-300` : BLOCK[blockKind(s.item.kind)])}
                        style={{ left: pos(s.start), width: `calc(${pos(s.end)} - ${pos(s.start)})` }}>
                        {clash && <AlertTriangle size={13} aria-hidden className="shrink-0" />}<span className="truncate">{s.name}</span>
                      </span>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {all.length === 0 ? <p className="mt-1 px-1 text-sm text-slate-500">{t('cityNoTimes')}</p> : (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label={t('cityLegend')}>
          {([['meal', t('cityLegendMeal')], ['visit', t('cityLegendVisit')], ['other', t('cityLegendOther')], ['clash', t('cityClashShort')]] as const).map(([k, word]) => (
            <li key={k} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('flex h-3.5 w-5 items-center justify-center rounded-sm text-white', BLOCK[k])}>{k === 'clash' && <AlertTriangle size={10} />}</span>{word}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Column({ date, row, services, byId }: { date: string; row: DayViewRow; services: ServiceBrief[]; byId: Map<string, Vendor> }) {
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const key = ['day', ws.id, date]
  const save = useMutation({
    mutationFn: (schedule: ScheduleItem[]) => api(wsPath(ws.id, `/tours/${row.tour.id}/days/${row.day.id}`), { method: 'PATCH', body: { schedule } }),
    onMutate: (schedule) => qc.setQueryData<DayViewRow[]>(key, (rows) => rows?.map((r) => (r.day.id === row.day.id ? { ...r, day: { ...r.day, schedule } } : r))),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ['changes', ws.id, row.tour.id] })
      qc.invalidateQueries({ queryKey: ['tour', ws.id, row.tour.id] })
    },
  })
  return (
    <Card className="p-3">
      <Link to={`/w/${ws.id}/tours/${row.tour.id}`} className="mb-2 flex items-center gap-2 hover:underline">
        <CodeChip code={row.tour.code} color={row.tour.color} className="text-xs" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.tour.client_name}</span>
        <span className="text-xs tabular-nums text-slate-500">{paxText(row.tour)}</span>
      </Link>
      <DayProgramme day={toFields(row.day)} index={row.day.day_number - 1} last={row.is_last_day} byId={byId} services={services}
        fromHotel={row.prev_hotel?.id ?? null}
        disabled={!atLeast(ws.role, 'staff')} startOpen onChange={(s) => save.mutate(s)} />
    </Card>
  )
}
