/**
 * Rooms by night: every hotel × every night, how many rooms all our groups need there —
 * the season block to ask the hotel for, instead of adding up tour by tour.
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Drawer, Label, type Tone } from '../components/overlay'
import { CodeChip, EmptyState } from '../components/tour'
import { Button, Select } from '../components/ui'
import { api, type BookingStatus, type SeriesColor, type VendorRef } from '../lib/api'
import { wsPath } from '../lib/data'
import { addDays, diffDays, fmt, parse, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { PageHeader } from './Dashboard'

interface GroupStay {
  tour_id: string; code: string; color: SeriesColor; status: string; client_name: string | null
  nights: string[]; check_in: string; check_out: string; rooms: Record<string, number>; rooms_total: number
  guessed: boolean; pax: number; pax_estimated: boolean; staff: number; booking: BookingStatus
}
interface Night { date: string; rooms: number; maybe: number; groups: number; guessed: boolean }
interface HotelRooms { vendor: VendorRef; city: string; nights: Night[]; groups: GroupStay[]; rooms: number }
interface RoomsData { date_from: string; date_to: string; hotels: HotelRooms[] }

const SPAN = 28 // days visible
const COL = 48 // px per night
const LABEL = 200 // px, sticky hotel column
const BOOKING_TONE: Record<BookingStatus, Tone> = { to_book: 'grey', requested: 'blue', confirmed: 'green', problem: 'red', cancelled: 'light' }
const ORDER = ['DBL', 'TWN', 'SGL', 'TRP', 'QUAD']

/** Monday of the week containing the date. */
const monday = (s: string) => addDays(s, -((new Date(parse(s)).getUTCDay() + 6) % 7))

/** "9 DBL + 2 SGL" for the groups that are sure; guessed groups as a separate count. */
function sumRooms(groups: GroupStay[]) {
  const by: Record<string, number> = {}
  let guessed = 0
  for (const g of groups) {
    if (g.guessed) guessed += g.rooms_total
    else for (const [k, n] of Object.entries(g.rooms)) by[k] = (by[k] ?? 0) + n
  }
  const text = Object.entries(by).sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b)).map(([k, n]) => `${n} ${k}`).join(' + ')
  return { text, guessed }
}

export function RoomsByNightPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const [from, setFrom] = useState(() => monday(today()))
  const [city, setCity] = useState('')
  const [open, setOpen] = useState<{ hotel: HotelRooms; date: string } | null>(null)
  const to = addDays(from, SPAN - 1)
  const days = Array.from({ length: SPAN }, (_, i) => addDays(from, i))
  const now = today()

  const q = useQuery({
    queryKey: ['rooms-by-night', ws.id, from],
    queryFn: () => api<RoomsData>(wsPath(ws.id, `/rooms-by-night?date_from=${from}&date_to=${to}`)),
    placeholderData: (prev) => prev,
  })
  const all = useMemo(() => q.data?.hotels ?? [], [q.data])
  const cities = useMemo(() => [...new Set(all.map((h) => h.city).filter(Boolean))].sort(), [all])
  const hotels = city ? all.filter((h) => h.city === city) : all

  return (
    <>
      <PageHeader section="tours" title={t('roomsByNight')}
        subtitle={`${t('rbnSub')} · ${fmt(from, lang)} – ${fmt(to, lang)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {cities.length > 1 && (
              <Select value={city} onChange={(e) => setCity(e.target.value)} aria-label={t('rbnCity')} className="w-44">
                <option value="">{t('rbnAllCities')}</option>
                {cities.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
            <Button variant="secondary" size="sm" onClick={() => setFrom(addDays(from, -14))} aria-label={t('previous')} title={t('previous')}><ChevronLeft size={16} /></Button>
            <Button variant="secondary" size="sm" onClick={() => setFrom(monday(today()))}>{t('today')}</Button>
            <Button variant="secondary" size="sm" onClick={() => setFrom(addDays(from, 14))} aria-label={t('next')} title={t('next')}><ChevronRight size={16} /></Button>
          </div>
        } />
      <div className="p-4 md:p-8">
        {q.isSuccess && hotels.length === 0 ? <EmptyState title={t('rbnEmpty')} hint={t('rbnEmptyHint')} /> : (
          <>
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="border-collapse text-sm" style={{ width: LABEL + SPAN * COL + 80 }}>
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" style={{ width: LABEL }} className="sticky left-0 z-20 border-r border-slate-200 bg-white px-3 py-2 text-left font-medium text-slate-600">{t('rbnHotel')}</th>
                    {days.map((d) => {
                      const dow = new Date(parse(d)).getUTCDay()
                      return (
                        <th key={d} scope="col" style={{ width: COL }}
                          className={cn('px-0 py-1 text-center text-xs font-normal leading-tight text-slate-600',
                            (dow === 0 || dow === 6) && 'bg-slate-50', d === now && 'bg-brand-600 font-bold text-white')}>
                          <div className={d === now ? '' : 'text-slate-500'}>{fmt(d, lang, { weekday: 'short' })}</div>
                          <div className="text-sm">{Number(d.slice(8))}{(d.endsWith('-01') || d === from) && <span className="ml-0.5 text-xs">{fmt(d, lang, { month: 'short' })}</span>}</div>
                        </th>
                      )
                    })}
                    <th scope="col" className="px-2 text-right text-xs font-medium text-slate-600">{t('rbnRoomNights')}</th>
                  </tr>
                </thead>
                <tbody>
                  {hotels.map((h) => {
                    const by = Object.fromEntries(h.nights.map((n) => [n.date, n]))
                    return (
                      <tr key={h.vendor.id} className="border-b border-slate-100">
                        <th scope="row" style={{ width: LABEL }} className="sticky left-0 z-10 border-r border-slate-200 bg-white px-3 py-1.5 text-left font-normal">
                          <div className="truncate font-medium text-slate-800" title={h.vendor.name}>{h.vendor.name}</div>
                          {h.city && <div className="truncate text-xs text-slate-500">{h.city}</div>}
                        </th>
                        {days.map((d) => {
                          const n = by[d]
                          const dow = new Date(parse(d)).getUTCDay()
                          if (!n) return <td key={d} className={cn('border-r border-slate-100', (dow === 0 || dow === 6) && 'bg-slate-50/70')} />
                          return (
                            <td key={d} className="border-r border-slate-100 p-0.5">
                              <button type="button" onClick={() => setOpen({ hotel: h, date: d })}
                                aria-label={t('rbnCell', { hotel: h.vendor.name, date: fmt(d, lang), n: n.rooms + n.maybe, g: n.groups })}
                                className={cn('flex h-11 w-full flex-col items-center justify-center rounded-md leading-tight transition-colors hover:ring-2 hover:ring-brand-400',
                                  n.rooms ? 'bg-brand-50 text-brand-900' : 'bg-slate-50 text-slate-600',
                                  n.groups > 1 && 'bg-brand-100')}>
                                <span className="font-semibold tabular-nums">{n.guessed && '~'}{n.rooms || (n.maybe ? '' : 0)}</span>
                                {n.maybe > 0 && <span className="text-xs tabular-nums text-slate-600">+{n.maybe}</span>}
                              </button>
                            </td>
                          )
                        })}
                        <td className="px-2 text-right tabular-nums text-slate-700">{h.rooms}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <ul className="mt-3 space-y-0.5 text-sm text-slate-600">
              <li>{t('rbnLegendRooms')}</li>
              <li>{t('rbnLegendGuess')}</li>
              <li>{t('rbnLegendMaybe')}</li>
            </ul>
          </>
        )}
      </div>
      {open && <NightDrawer hotel={open.hotel} date={open.date} onClose={() => setOpen(null)} />}
    </>
  )
}

function NightDrawer({ hotel, date, onClose }: { hotel: HotelRooms; date: string; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const [copied, setCopied] = useState(false)
  const groups = hotel.groups.filter((g) => g.nights.includes(date))
  const sure = groups.filter((g) => g.status !== 'inquiry')
  const maybe = groups.filter((g) => g.status === 'inquiry').reduce((s, g) => s + g.rooms_total, 0)
  const sum = sumRooms(sure)
  const lines = [sum.text, sum.guessed ? t('rbnAskGuess', { n: sum.guessed }) : ''].filter(Boolean)
  const copy = async () => {
    const text = t('rbnRequestText', { hotel: hotel.vendor.name, date: fmt(date, lang, { day: 'numeric', month: 'long', year: 'numeric' }), rooms: lines.join(', ') })
    try { await navigator.clipboard.writeText(text); setCopied(true) } catch { /* clipboard blocked: nothing to do */ }
  }
  return (
    <Drawer size="md" onClose={onClose}
      title={t('rbnNightTitle', { hotel: hotel.vendor.name, date: fmt(date, lang, { weekday: 'short', day: 'numeric', month: 'short' }) })}
      subtitle={[hotel.city, t('rbnTotalGroups', { n: groups.length })].filter(Boolean).join(' · ')}>
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h3 className="text-sm font-medium text-slate-600">{t('rbnAsk')}</h3>
        <div className="mt-1 text-xl font-semibold text-slate-900">{lines.join(' · ') || '—'}</div>
        {maybe > 0 && <div className="mt-1 text-sm text-slate-600">{t('rbnMaybe', { n: maybe })}</div>}
        <Button variant="secondary" size="sm" className="mt-3" onClick={copy}><Copy size={14} /> {copied ? t('rbnCopied') : t('rbnCopy')}</Button>
      </section>
      <ul className="mt-4 divide-y divide-slate-100">
        {groups.map((g) => (
          <li key={g.tour_id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
            <CodeChip code={g.code} color={g.color} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800">
                {g.guessed ? `~${g.rooms_total}` : Object.entries(g.rooms).map(([k, n]) => `${n} ${k}`).join(' + ')}
                {g.staff > 0 && <span className="ml-2 text-sm font-normal text-slate-600">{t('rbnStaff', { n: g.staff })}</span>}
              </div>
              <div className="text-sm text-slate-600">
                {g.pax_estimated ? '~' : ''}{g.pax} {t('pax').toLowerCase()}
                {g.guessed && ` · ${t('rbnGuessed', { pax: g.pax })}`}
                {g.client_name && ` · ${g.client_name}`}
              </div>
              <div className="text-sm text-slate-500">
                {t(diffDays(g.check_in, g.check_out) === 1 ? 'rbnStay1' : 'rbnStay', { in: fmt(g.check_in, lang), out: fmt(g.check_out, lang), n: diffDays(g.check_in, g.check_out) })}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {g.status === 'inquiry' && <Label tone="purple" wide={false}>{t('status_inquiry')}</Label>}
              <Label tone={BOOKING_TONE[g.booking]} wide={false}>{t(`bstatus_${g.booking}` as TKey)}</Label>
              <Link to={`/w/${ws.id}/tours/${g.tour_id}?tab=bookings`} className="text-sm font-medium text-brand-700 hover:underline">{t('rbnOpen')}</Link>
            </div>
          </li>
        ))}
      </ul>
    </Drawer>
  )
}
