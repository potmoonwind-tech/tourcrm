/**
 * A route as a series: its upcoming departures, and each supplier's bookings across all of them.
 * A series hotel is contracted once (an allotment), so it is confirmed, given to one person and
 * given its payment terms for every departure at once — or for the ticked ones.
 */
import { SeriesEmailDialog } from '../components/EmailDialog'
import { RouteStaff } from '../components/RouteStaff'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ask, Label } from '../components/overlay'
import { CodeChip, EmptyState } from '../components/tour'
import { Button, Card, ErrorText, Input, Select, Spinner } from '../components/ui'
import { api, BOOKING_STATUSES, type Booking, type BookingState, type TourSummary, can } from '../lib/api'
import { useMembers, useSeries, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'
import { STATE_TONE, useDetailsText } from './TourBookings'

interface SeriesTourBooking {
  tour_id: string; code: string; start_date: string; booking_id: string; status: Booking['status']; state: BookingState
  reference: string; details: Booking['details']; assignee_id: string | null; book_by: string
}
interface SeriesSupplier { vendor: Booking['vendor']; kind: string; tours: SeriesTourBooking[]; confirmed: number; total: number }

export function SeriesPage() {
  const ws = useWorkspace()!
  const { seriesId } = useParams()
  const { t, lang } = useI18n()
  const routes = useSeries()
  const route = routes.data?.find((s) => s.id === seriesId)
  const tours = useQuery({ queryKey: ['tours', ws.id, 'all'], queryFn: () => api<TourSummary[]>(wsPath(ws.id, '/tours')) })
  const mine = (tours.data ?? []).filter((x) => x.series_id === seriesId).sort((a, b) => a.start_date.localeCompare(b.start_date))
  const key = ['seriesBookings', ws.id, seriesId]
  const book = useQuery({ queryKey: key, queryFn: () => api<SeriesSupplier[]>(wsPath(ws.id, `/series/${seriesId}/bookings`)) })
  const qc = useQueryClient()
  const manager = can(ws, 'operations')
  const upcoming = mine.filter((x) => x.status !== 'cancelled' && !x.closed_at && x.end_date >= today())
  // The partner changed the programme: copy the route's days to the departures again.
  const push = useMutation({
    mutationFn: () => api<{ tour_id: string; code: string; error: string; confirmed: number }[]>(wsPath(ws.id, `/series/${seriesId}/push`),
      { method: 'POST', body: { tour_ids: upcoming.map((x) => x.id) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['tours', ws.id] }) },
  })
  const [params] = useSearchParams()
  const focus = params.get('vendor')
  useEffect(() => {
    if (focus && book.data) document.getElementById(`sup-${focus}`)?.scrollIntoView({ block: 'start' })
  }, [focus, book.data])
  if (!route) return <div className="flex justify-center py-10"><Spinner /></div>
  return (
    <>
      <PageHeader crumbs={[{ label: t('catalog'), to: `/w/${ws.id}/routes` }]} title={<span className="flex items-center gap-3">
        <CodeChip code={route.code} color={route.color} />{route.name}
      </span>} subtitle={t('seriesHelp')} />
      <div className="space-y-6 p-4 md:p-8">
        <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-600">{t('seriesDepartures', { n: mine.length })}</h2>
            <div className="flex-1" />
            {manager && upcoming.length > 0 && (
              <Button size="sm" variant="secondary" disabled={push.isPending} title={t('pushHelp')}
                onClick={() => void ask({ title: t('pushTitle', { n: upcoming.length }), message: t('pushMsg') }).then((ok) => ok && push.mutate())}>
                {t('pushButton')}
              </Button>
            )}
          </div>
          {push.data && <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {t('pushDone', { ok: push.data.filter((r) => !r.error).length, total: push.data.length })}
            {push.data.some((r) => r.confirmed) && ` ${t('pushReconfirm')}`}
          </p>}
          {mine.length === 0 ? <EmptyState title={t('seriesNoDepartures')} hint={t('seriesNoDeparturesHint')} /> : (
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <tbody className="divide-y divide-slate-100">
                  {mine.map((x) => (
                    <tr key={x.id}>
                      <td className="px-4 py-2"><Link to={`/w/${ws.id}/tours/${x.id}`} className="font-mono font-medium hover:underline">{x.code}</Link></td>
                      <td className="px-4 py-2 tabular-nums text-slate-600">{fmt(x.start_date, lang)} – {fmt(x.end_date, lang)}</td>
                      <td className="px-4 py-2 tabular-nums">{paxText(x)} {t('pax').toLowerCase()}</td>
                      <td className="px-4 py-2 text-slate-600">{x.client_name ?? '—'}</td>
                      <td className="px-4 py-2">{t(`status_${x.status}` as TKey)}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{x.quote_id ? t('hasCalc') : t('noCalcYet')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
        <RouteStaff key={route.id} route={route} canEdit={manager} tourIds={upcoming.map((x) => x.id)} />
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-600">{t('seriesBookings')}</h2>
          {book.isLoading ? <Spinner /> : (book.data ?? []).length === 0 ? <p className="text-sm text-slate-500">{t('seriesNoBookings')}</p> : (
            <div className="space-y-3">
              {book.data!.map((g) => <Supplier key={g.vendor.id} g={g} seriesId={seriesId!} seriesCode={route?.code ?? ''} open={g.vendor.id === focus} />)}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function Supplier({ g, seriesId, seriesCode, open: openFirst }: { g: SeriesSupplier; seriesId: string; seriesCode: string; open: boolean }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const members = useMembers()
  const text = useDetailsText()
  const [open, setOpen] = useState(openFirst)
  const [emailing, setEmailing] = useState(false)
  const [f, setF] = useState({ status: '', reference: '', assignee_id: '', pay_when: '' })
  const save = useMutation({
    mutationFn: () => api<SeriesSupplier[]>(wsPath(ws.id, `/series/${seriesId}/bookings`), {
      method: 'POST',
      body: {
        vendor_id: g.vendor.id,
        ...(f.status ? { status: f.status } : {}), ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
        ...(f.assignee_id ? { assignee_id: f.assignee_id === '-' ? null : f.assignee_id } : {}), ...(f.pay_when ? { pay_when: f.pay_when === '-' ? '' : f.pay_when } : {}),
      },
    }),
    onSuccess: (d) => {
      qc.setQueryData(['seriesBookings', ws.id, seriesId], d)
      qc.invalidateQueries({ queryKey: ['tasks', ws.id] })
      setF({ status: '', reference: '', assignee_id: '', pay_when: '' })
    },
  })
  const changed = !!(f.status || f.reference.trim() || f.assignee_id || f.pay_when)
  const all = g.confirmed === g.total
  return (
    <div id={`sup-${g.vendor.id}`} className="scroll-mt-4">
    <Card className={cn(openFirst && 'ring-2 ring-brand-300')}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown size={16} className={cn('shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
          <span className="truncate font-semibold">{g.vendor.name}</span>
          <span className="text-xs text-slate-500">{t(`work_${g.kind}` as TKey)}</span>
        </button>
        <Label tone={all ? 'green' : g.confirmed ? 'orange' : 'grey'} wide={false}>{t('seriesConfirmedOf', { n: g.confirmed, total: g.total })}</Label>
        {/* One email for every departure: each group with its tour number, dates and people. */}
        <Button size="sm" variant="secondary" onClick={() => setEmailing(true)}><Mail size={14} aria-hidden />{t('seriesEmail')}</Button>
      </div>
      {emailing && <SeriesEmailDialog seriesId={seriesId} vendorId={g.vendor.id} supplier={g.vendor.name} seriesCode={seriesCode} onClose={() => setEmailing(false)} />}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-sm">
        <span className="text-xs font-medium text-slate-500">{t('seriesForAll', { n: g.total })}</span>
        <Select className="h-8 w-36 text-xs" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label={t('status')}>
          <option value="">{t('status')}…</option>
          {BOOKING_STATUSES.map((s) => <option key={s} value={s}>{t(`bstatus_${s}` as TKey)}</option>)}
        </Select>
        <Input className="h-8 w-40 text-xs" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder={t('seriesReferencePh')} />
        <Select className="h-8 w-36 text-xs" value={f.assignee_id} onChange={(e) => setF({ ...f, assignee_id: e.target.value })} aria-label={t('assignTo')}>
          <option value="">{t('assignTo')}…</option>
          <option value="-">{t('nobodyYet')}</option>
          {members.data?.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
        </Select>
        <Select className="h-8 w-40 text-xs" value={f.pay_when} onChange={(e) => setF({ ...f, pay_when: e.target.value })} aria-label={t('payWhen')}>
          <option value="">{t('payWhen')}…</option>
          {(['-', 'asap', 'before', 'after', 'on_site'] as const).map((w) => <option key={w} value={w}>{t(`payWhen_${w === '-' ? 'terms' : w}` as TKey)}</option>)}
        </Select>
        <Button size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>{t('seriesApplyAll', { n: g.total })}</Button>
        <ErrorText error={save.error} />
      </div>
      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
          {g.tours.map((x) => (
            <li key={x.booking_id} className="flex flex-wrap items-center gap-3 px-4 py-2">
              <Link to={`/w/${ws.id}/tours/${x.tour_id}?tab=bookings`} className="w-24 font-mono font-medium hover:underline">{x.code}</Link>
              <span className="min-w-0 flex-1 text-xs text-slate-600">{text(x.details)}</span>
              {x.reference && <span className="font-mono text-xs text-slate-500">{x.reference}</span>}
              <span className="text-xs text-slate-500">{t('bookByShort', { date: fmt(x.book_by, lang) })}</span>
              <Label tone={STATE_TONE[x.state]} wide={false}>{t(`bstate_${x.state}` as TKey)}</Label>
            </li>
          ))}
        </ul>
      )}
    </Card>
    </div>
  )
}
