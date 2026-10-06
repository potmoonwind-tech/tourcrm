/**
 * A tour's bookings: every supplier, what it is booked for (worked out from the itinerary and
 * staff), its status and confirmation number, who books it and by when, and how it is paid
 * (when / how / by the office or the guide in cash). Changes save as you make them.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRightLeft, BedDouble, Bus, CheckCircle2, ChevronDown, Mail, MapPin, Phone as PhoneIcon, Ticket, User, Utensils } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Label, type Tone } from '../components/overlay'
import { EmptyState } from '../components/tour'
import { Button, Card, Input, Select, Spinner } from '../components/ui'
import { Tooltip } from '../components/Tooltip'
import { ChangeHotel } from '../components/ChangeHotel'
import { EmailDialog, useMailLog } from '../components/EmailDialog'
import { api, BOOKING_STATUSES, type Booking, type BookingDetails, type BookingState, type Member, type Tour, type TourBookings, type WorkKind, can } from '../lib/api'
import { useMembers, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'

const KIND_ICON: Record<WorkKind, ReactNode> = {
  hotel: <BedDouble size={16} />, meal: <Utensils size={16} />, transport: <Bus size={16} />,
  guide: <User size={16} />, activity: <Ticket size={16} />, other: <MapPin size={16} />,
}
export const STATE_TONE: Record<BookingState, Tone> = {
  ok: 'green', to_book: 'grey', waiting: 'blue', changed: 'orange', cancel: 'red', problem: 'red', cancelled: 'light',
}

export function useBookings(tourId: string) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['bookings', ws.id, tourId], queryFn: () => api<TourBookings>(wsPath(ws.id, `/tours/${tourId}/bookings`)) })
}

/** "2 nights · 8 DBL + 2 SGL", "1 lunch, 2 dinners · 19 people", "guide days 1–3". */
const ROOM_WORD: Record<string, TKey> = { SGL: 'roomSingle', DBL: 'roomDouble', TWN: 'roomTwin', TRP: 'roomTriple', QUAD: 'roomQuad' }

export function useDetailsText() {
  const { t } = useI18n()
  const n = (count: number, one: TKey, many: TKey) => t(count === 1 ? one : many, { n: count })
  // A service still called by its price type ("Per day") reads better as "3 days".
  const plain = new Set((['day', 'person', 'group'] as const).map((k) => t(`rate_${k}`)))
  return (d: BookingDetails) => {
    const parts: string[] = []
    if (d.nights) {
      const rooms = d.rooms ? Object.entries(d.rooms).map(([k, c]) => `${c} ${ROOM_WORD[k] ? t(ROOM_WORD[k]).toLowerCase() : k}`).join(' + ') : t('roomsUnknown')
      parts.push(`${n(d.nights, 'oneNight', 'nNights')} · ${rooms}`)
    }
    const meals = [d.lunches ? n(d.lunches, 'oneLunch', 'nLunches') : '', d.dinners ? n(d.dinners, 'oneDinner', 'nDinners') : ''].filter(Boolean)
    if (meals.length) parts.push(`${meals.join(', ')} · ${t('nPeople', { n: d.people ?? 0 })}`)
    if (d.tourists_pay) parts.push(t('touristsPayN', { n: d.tourists_pay }))
    for (const [name, days] of Object.entries(d.services ?? {})) parts.push(plain.has(name) ? n(days, 'oneDay', 'nDays') : `${name} × ${days}`)
    for (const s of d.staff ?? []) parts.push(`${t(`staffRole_${s.role}` as TKey)} · ${s.from === s.to ? t('dayN', { n: s.from }) : t('daysRange', { from: s.from, to: s.to })}`)
    return parts.join(' · ')
  }
}

export function BookingsTab({ tour, canEdit }: { tour: Tour; canEdit: boolean }) {
  const { t } = useI18n()
  const q = useBookings(tour.id)
  const members = useMembers()
  if (!q.data) return <div className="flex justify-center py-10"><Spinner /></div>
  const { bookings, confirmed, total } = q.data
  if (!bookings.length) return <EmptyState title={t('noBookings')} hint={tour.status === 'cancelled' ? t('noBookingsCancelled') : t('noBookingsHint')} />
  const pct = total ? Math.round((confirmed / total) * 100) : 0
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold">{t('bookingsProgress', { done: confirmed, total })}</p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <p className="max-w-md text-xs text-slate-500">{t('bookingsHelp')}</p>
      </Card>
      <div className="space-y-3">
        {bookings.map((b) => <BookingCard key={b.id} tour={tour} b={b} members={members.data ?? []} canEdit={canEdit} />)}
      </div>
    </div>
  )
}

function BookingCard({ tour, b, members, canEdit }: { tour: Tour; b: Booking; members: Member[]; canEdit: boolean }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const text = useDetailsText()
  const [ref, setRef] = useState(b.reference)
  useEffect(() => setRef(b.reference), [b.reference])
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<TourBookings>(wsPath(ws.id, `/tours/${tour.id}/bookings/${b.id}`), { method: 'PATCH', body: patch }),
    onSuccess: (d) => { qc.setQueryData(['bookings', ws.id, tour.id], d); qc.invalidateQueries({ queryKey: ['tasks', ws.id] }) },
  })
  const late = b.state !== 'ok' && b.state !== 'cancelled' && b.book_by < today()
  const name = (id: string | null) => members.find((m) => m.user_id === id)?.full_name || members.find((m) => m.user_id === id)?.email
  const sel = 'h-8 text-xs'
  const ws2 = useWorkspace()!
  const canChange = can(ws2, 'operations') && !tour.closed_at
  const [changing, setChanging] = useState(false)
  const [emailing, setEmailing] = useState(false)
  // The booking's own fields fold away; they open by themselves when something needs doing there.
  const [open, setOpen] = useState(() => b.state === 'changed' || b.state === 'cancel')
  // The last email to this supplier about this tour.
  const lastMail = useMailLog(tour.id).data?.find((m) => m.vendor_id === b.vendor.id)
  return (
    <Card className={cn('p-4', !b.in_itinerary && 'border-dashed', b.state === 'ok' && 'bg-emerald-50/30')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">{KIND_ICON[b.kind]}</span>
        <div className="min-w-48 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">{b.vendor.name}
            {b.kind === 'hotel' && b.in_itinerary && canChange && (
              <Tooltip label={t('changeHotelTip')}>
                <Button size="sm" variant="secondary" onClick={() => setChanging(true)}><ArrowRightLeft size={14} aria-hidden />{t('changeHotelButton')}</Button>
              </Tooltip>
            )}
          </p>
          <p className="text-sm text-slate-600">
            {b.details.stays?.length ? (
              // A hotel reads check-in → check-out; two separate stays are shown as two.
              <span className="tabular-nums">
                {b.details.stays.map((s, i) => (
                  <span key={i} className={cn(b.details.stays!.length > 1 && 'font-semibold text-slate-800')}>
                    {i > 0 && ' + '}{fmt(s.check_in, lang)} → {fmt(s.check_out, lang)}
                  </span>
                ))}
                {b.details.stays.length > 1 && <span className="text-amber-700"> ({t('separateStays', { n: b.details.stays.length })})</span>} ·{' '}
              </span>
            ) : b.first_date && <span className="tabular-nums">{fmt(b.first_date, lang)}{b.last_date && b.last_date !== b.first_date && ` – ${fmt(b.last_date, lang)}`} · </span>}
            {b.in_itinerary ? text(b.details) : t('notInItinerary')}
          </p>
          {(b.vendor.phone || b.vendor.email) && (
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
              {b.vendor.contact_person && <span>{b.vendor.contact_person}</span>}
              {b.vendor.phone && <a href={`tel:${b.vendor.phone}`} className="inline-flex items-center gap-1 hover:text-brand-700"><PhoneIcon size={12} />{b.vendor.phone}</a>}
              {b.vendor.email && <a href={`mailto:${b.vendor.email}`} className="hover:text-brand-700">{b.vendor.email}</a>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The status picker says where it stands; the badge only when the plan moved under it. */}
          {(b.state === 'changed' || b.state === 'cancel') && <Label tone={STATE_TONE[b.state]} wide={false}>{t(`bstate_${b.state}` as TKey)}</Label>}
          <Select className="h-8 w-36 text-xs" value={b.status} disabled={!canEdit || save.isPending} aria-label={`${t('status')} · ${b.vendor.name}`}
            onChange={(e) => save.mutate({ status: e.target.value as Booking['status'] })}>
            {BOOKING_STATUSES.map((s) => <option key={s} value={s}>{t(`bstatus_${s}` as TKey)}</option>)}
          </Select>
          {canEdit && (
            <Tooltip label={b.vendor.email ? t('emailBookingTip', { email: b.vendor.email }) : t('emailBookingTipNoAddress')}>
              <Button size="sm" variant="secondary" onClick={() => setEmailing(true)}><Mail size={14} aria-hidden />{t('emailButton')}</Button>
            </Tooltip>
          )}
        </div>
      </div>
      {lastMail && (
        <p className={cn('mt-2 flex flex-wrap items-center gap-1.5 text-xs', lastMail.error ? 'text-red-700' : 'text-slate-600')}>
          <Mail size={13} aria-hidden />
          {lastMail.error ? t('emailFailedOn', { date: fmt(lastMail.sent_at.slice(0, 10), lang), error: lastMail.error })
            : t('emailSentOn', { date: fmt(lastMail.sent_at.slice(0, 10), lang), time: lastMail.sent_at.slice(11, 16), to: lastMail.to })}
        </p>
      )}
      {(b.state === 'changed' || b.state === 'cancel' || late) && (
        <p className={cn('mt-2 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
          b.state === 'cancel' || late ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800')}>
          <AlertTriangle size={14} />{b.state === 'changed' ? t('bstateChangedHelp') : b.state === 'cancel' ? t('bstateCancelHelp') : t('bookingLate', { date: fmt(b.book_by, lang) })}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
        {b.book_by && <span className={cn(late && 'font-medium text-red-700')}>{t('bookBy')}: {fmt(b.book_by, lang)}</span>}
        <span>{t('whoBooks')}: {name(b.assignee_id ?? b.default_assignee_id) ?? t('nobodyYet')}</span>
        {b.reference && <span>{t('confirmationNo')}: <span className="font-medium text-slate-800">{b.reference}</span></span>}
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={`booking-${b.id}`}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded px-1.5 font-medium text-brand-700 hover:bg-brand-50">
          {t('bookingDetails')}<ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {open && <fieldset id={`booking-${b.id}`} disabled={!canEdit || save.isPending} className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Mini label={t('confirmationNo')}>
          <Input className={sel} value={ref} placeholder="—" onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
            onBlur={() => ref !== b.reference && save.mutate({ reference: ref })} />
        </Mini>
        <Mini label={t('whoBooks')}>
          <Select className={sel} value={b.assignee_id ?? ''} onChange={(e) => save.mutate({ assignee_id: e.target.value || null })}>
            <option value="">{b.default_assignee_id ? t('defaultPerson', { name: name(b.default_assignee_id) ?? '' }) : t('nobodyYet')}</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
          </Select>
        </Mini>
        <Mini label={t('bookBy')}>
          <Input type="date" className={cn(sel, late && 'border-red-400 text-red-700')} value={b.book_by}
            onChange={(e) => save.mutate({ book_by: e.target.value || null })} />
        </Mini>
        <Mini label={t('payWhen')}>
          <Select className={sel} value={b.pay_when} onChange={(e) => save.mutate({ pay_when: e.target.value as Booking['pay_when'] })}>
            {(['', 'asap', 'before', 'after', 'on_site'] as const).map((w) => <option key={w} value={w}>{t(`payWhen_${w || 'terms'}` as TKey)}</option>)}
          </Select>
        </Mini>
        <Mini label={t('payHow')}>
          <div className="flex gap-1">
            <Select className={sel} value={b.pay_method} onChange={(e) => save.mutate({ pay_method: e.target.value as Booking['pay_method'] })}>
              {(['transfer', 'cash', 'card'] as const).map((m) => <option key={m} value={m}>{t(`payMethod_${m}` as TKey)}</option>)}
            </Select>
            <Select className={sel} value={b.paid_by} onChange={(e) => save.mutate({ paid_by: e.target.value as Booking['paid_by'] })} aria-label={t('paidBy')}>
              <option value="office">{t('paidBy_office')}</option>
              <option value="guide">{t('paidBy_guide')}</option>
            </Select>
          </div>
        </Mini>
      </fieldset>}
      {b.state === 'ok' && b.confirmed_at && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700"><CheckCircle2 size={13} />{t('confirmedOn', { date: fmt(b.confirmed_at.slice(0, 10), lang) })}</p>
      )}
      {changing && <ChangeHotel tour={tour} hotelId={b.vendor.id} hotelName={b.vendor.name} onClose={() => setChanging(false)} />}
      {emailing && <EmailDialog tourId={tour.id} bookingId={b.id} supplier={b.vendor.name} onClose={() => setEmailing(false)}
        startKind={b.state === 'cancel' ? 'booking_cancel' : b.state === 'changed' ? 'booking_change' : undefined} />}
    </Card>
  )
}

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  )
}
