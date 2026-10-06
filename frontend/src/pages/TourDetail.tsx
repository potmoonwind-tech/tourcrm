import { toFields } from '../components/DayProgramme'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask, Drawer, Menu, useGuardedClose } from '../components/overlay'
import { ArrowLeft, Ban, Calculator, Check, Minus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CodeChip } from '../components/tour'
import { Button, Card, ErrorText, Field, FullPageSpinner, Input, Select, Textarea } from '../components/ui'
import { QuickClientDialog } from '../components/QuickAdd'
import { parseRooms, RoomsPicker, roomsText } from '../components/RoomsPicker'
import { api, atLeast, TOUR_STATUSES, type BusReturn, type DayFields, type QuoteOut, type Tour, type TourStatus, can } from '../lib/api'
import { useClients, wsPath } from '../lib/data'
import { addDays, diffDays, fmt, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, countWord, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'
import { CostsTab } from './TourCosts'
import { IncidentsTab } from './Incidents'
import { CancelTourModal } from './CancelTour'
import { AlertBars, useAlerts } from '../components/Alerts'
import { ItineraryBuilder } from '../components/ItineraryBuilder'
import { ClosePanel, LifecycleBar } from './TourClose'
import { ParticipantsTab, StaffTab } from './TourPeople'
import { CURRENCIES } from './Onboarding'
import { MealsTab } from './TourMeals'
import { BookingsTab } from './TourBookings'

export function TourDetailPage() {
  const ws = useWorkspace()!
  const { tourId } = useParams()
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const key = ['tour', ws.id, tourId]
  const tour = useQuery({ queryKey: key, queryFn: () => api<Tour>(wsPath(ws.id, `/tours/${tourId}`)) })
  const canEdit = atLeast(ws.role, 'staff') && !tour.data?.closed_at
  // Tab lives in the URL so a link (or reload) opens the same tab.
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') ?? 'itinerary') as 'itinerary' | 'bookings' | 'meals' | 'participants' | 'staff' | 'incidents' | 'costs'
  const seesMoney = can(ws, 'operations', 'finance')   // the tour's costs
  const [cancelling, setCancelling] = useState(false)
  const [editing, setEditing] = useState<{ focus: DetailField } | null>(null)   // the details drawer, at a field
  type Tab = typeof tab
  const setTab = (id: string) => setParams(id === 'itinerary' ? {} : { tab: id }, { replace: true })

  const del = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${tourId}`), { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tours', ws.id] }); navigate(`/w/${ws.id}/tours`) },
  })

  if (tour.isLoading) return <FullPageSpinner />
  if (!tour.data) return <div className="p-8"><ErrorText error={tour.error} /></div>
  const tr = tour.data
  const nights = diffDays(tr.start_date, tr.end_date)
  const tabs: [Tab, string, number | null][] = [
    ['itinerary', t('itinerary'), tr.days.length], ['bookings', t('bookings'), null], ['meals', t('meals'), null], ['participants', t('participants'), tr.participant_count],
    ['staff', t('staff'), tr.staff.length], ['incidents', t('incidents'), null], ...(seesMoney ? [['costs', t('costs'), null] as [Tab, string, null]] : []),
  ]

  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">
          <Link to={`/w/${ws.id}/tours`} className="text-slate-400 hover:text-slate-600"><ArrowLeft size={20} /></Link>
          <CodeChip code={tr.code} color={tr.color} className="text-base" />
          <span className="text-lg font-semibold text-slate-600">{tr.client_name}</span>
        </span>}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          {fmt(tr.start_date, lang)} – {fmt(tr.end_date, lang, { day: 'numeric', month: 'short', year: 'numeric' })}
          · {nights + 1} {countWord(nights + 1, t('dayWord'), t('daysWord'))} / {nights} {countWord(nights, t('nightWord'), t('nights'))} · {paxText(tr)} {t('pax').toLowerCase()}
        </span>}
        action={can(ws, 'operations', 'finance') && (
          <Menu items={[
            { label: t('cancelTour'), icon: <Ban size={16} />, onClick: () => setCancelling(true),
              hidden: tr.status === 'cancelled' || !!tr.closed_at || tr.end_date < today() },
            { label: t('deleteTour'), icon: <Trash2 size={16} />, danger: true, hidden: !!tr.closed_at,
              onClick: () => void ask({ title: t('confirmDeleteTour'), danger: true, confirmLabel: t('delete') }).then((ok) => ok && del.mutate()) },
          ]} />
        )}
      />
      <div className="space-y-6 p-4 md:p-8">
        <LifecycleBar tour={tr} />
        <ClosePanel tour={tr} onTab={setTab} />
        <AlertBars tourId={tr.id} onTab={setTab} />
        <TourSummary tour={tr} canEdit={canEdit} onEdit={(f) => setEditing({ focus: f })} />
        {editing && <TourDetailsDrawer tour={tr} focus={editing.focus} onClose={() => setEditing(null)} onSaved={(t2) => qc.setQueryData(key, t2)} />}
        <div role="tablist" aria-label={t('tourSections')}
          className="sticky top-0 z-30 -mx-4 flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/95 px-4 backdrop-blur md:-mx-8 md:px-8"
          onKeyDown={(e) => {
            // Arrow keys move between the tabs (the usual tab keyboard pattern).
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
            const i = tabs.findIndex(([id]) => id === tab)
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0]
            setTab(next)
            setTimeout(() => document.getElementById(`tourtab-${next}`)?.focus(), 0)
          }}>
          {tabs.map(([id, label, count]) => (
            <button type="button" key={id} id={`tourtab-${id}`} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
              aria-controls="tour-tabpanel" onClick={() => setTab(id)}
              className={cn('-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold',
                tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
              {label}{count !== null && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{count}</span>}
            </button>
          ))}
        </div>
        <div id="tour-tabpanel" role="tabpanel" aria-labelledby={`tourtab-${tab}`} className="space-y-6">
        {cancelling && <CancelTourModal tour={tr} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); setTab('costs') }} />}
        {tab === 'bookings' && <BookingsTab tour={tr} canEdit={canEdit} />}
        {tab === 'meals' && <MealsTab tour={tr} onTab={setTab} />}
        {tab === 'participants' && <ParticipantsTab tour={tr} />}
        {tab === 'staff' && <StaffTab tour={tr} />}
        {tab === 'incidents' && <IncidentsTab tour={tr} />}
        {tab === 'costs' && seesMoney && <CostsTab tour={tr} />}
        {tab === 'itinerary' && <ItineraryTab tour={tr} canEdit={canEdit} onSaved={(t2) => qc.setQueryData(key, t2)} />}
        </div>
      </div>
    </>
  )
}

type DetailField = 'client' | 'pax' | 'rooms' | 'leaders' | 'price' | 'dates' | null

/**
 * The tour at a glance — client, dates, people, rooms, free leaders, price — and the ways forward:
 * calculate the price, confirm an inquiry, edit the details (a drawer). Anything missing is a button
 * that opens the details right at that field.
 */
function TourSummary({ tour, canEdit, onEdit }: { tour: Tour; canEdit: boolean; onEdit: (f: DetailField) => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const seesPrice = can(ws, 'operations', 'finance', 'sales')
  const canCalc = canEdit && can(ws, 'operations', 'sales')
  const calc = useMutation({
    mutationFn: () => api<QuoteOut>(wsPath(ws.id, '/quotes'), { method: 'POST', body: { preset: 'blank', tour_id: tour.id } }),
    onSuccess: (q) => navigate(`/w/${ws.id}/calculations/${q.id}?for_tour=${tour.id}`, { state: { notices: q.notices ?? [] } }),
  })
  const confirm = useMutation({
    mutationFn: () => api<Tour>(wsPath(ws.id, `/tours/${tour.id}`), { method: 'PATCH', body: { status: 'confirmed' } }),
    onSuccess: (t2) => {
      qc.setQueryData(['tour', ws.id, tour.id], t2)
      for (const k of ['tours', 'bookings', 'tasks', 'alerts']) qc.invalidateQueries({ queryKey: [k, ws.id] })
    },
  })
  const has = tour.price_pp !== null && tour.price_pp > 0
  const days = diffDays(tour.start_date, tour.end_date) + 1
  const rooms = roomsText(parseRooms(tour.rooms ?? '')) || (tour.rooms ?? '').trim()
  // A missing fact: amber, and (when it can be edited) the way to fill it.
  const missing = (label: string, f: DetailField) => canEdit
    ? <button type="button" onClick={() => onEdit(f)} className="rounded font-medium text-amber-700 underline decoration-amber-300 underline-offset-2 hover:text-amber-900">{label}</button>
    : <span className="font-medium text-amber-700">{label}</span>
  const facts: { label: string; value: ReactNode }[] = [
    { label: t('client'), value: tour.client_name ? <span className="font-medium text-slate-800">{tour.client_name}</span> : missing(t('factChoose'), 'client') },
    { label: t('dates'), value: <span className="font-medium text-slate-800">{fmt(tour.start_date, lang)} – {fmt(tour.end_date, lang)} <span className="font-normal text-slate-500">· {days} {countWord(days, t('dayWord'), t('daysWord'))}</span></span> },
    { label: t('pax'), value: tour.pax ? <span className="font-medium text-slate-800">{paxText(tour)}{tour.pax_estimated && <span className="font-normal text-slate-500"> · {t('paxApproxShort')}</span>}</span> : missing(t('factNotKnown'), 'pax') },
    { label: t('rooms'), value: rooms ? <span className="font-medium text-slate-800">{rooms}</span> : missing(t('factSetRooms'), 'rooms') },
    { label: t('tourLeaders'), value: <span className="font-medium text-slate-800">{tour.leaders ? t('factFree', { n: tour.leaders }) : '—'}</span> },
    ...(seesPrice ? [{ label: t('pricePerPerson'), value: has
      ? <span className="font-medium text-slate-800">{tour.price_pp!.toLocaleString(undefined, { maximumFractionDigits: 2 })} {tour.price_currency ?? ws.base_currency}
          {' '}{tour.quote_id
            ? <Link to={`/w/${ws.id}/calculations/${tour.quote_id}`} className="font-normal text-brand-700 hover:underline">· {t('priceFromCalc')}</Link>
            : <span className="font-normal text-slate-500">· {t('priceTyped')}</span>}</span>
      : missing(t('noPriceYet'), 'price') }] : []),
  ]
  return (
    <Card className="p-4">
      <div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          {facts.map(({ label, value }) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs font-medium text-slate-500">{label}</dt>
              <dd className="mt-0.5 break-words text-sm">{value}</dd>
            </div>
          ))}
        </dl>
        {canEdit && (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
            {tour.status === 'inquiry' && (
              <Button variant="secondary" disabled={confirm.isPending} onClick={() => confirm.mutate()}><Check size={16} />{t('confirmTour')}</Button>
            )}
            {canCalc && seesPrice && (
              <Button variant={has || !['inquiry', 'confirmed'].includes(tour.phase) ? 'secondary' : 'primary'} disabled={calc.isPending} onClick={() => calc.mutate()} title={t('calcFromTourHelp')}>
                <Calculator size={16} />{has ? t('recalcFromTour') : t('calcFromTour')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => onEdit(null)}><Pencil size={16} />{t('editDetails')}</Button>
          </div>
        )}
      </div>
      {(tour.name || tour.notes) && (
        <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
          {tour.name && <span className="font-medium text-slate-800">{tour.name}</span>}{tour.name && tour.notes && ' · '}{tour.notes}
        </p>
      )}
      {(calc.error != null || confirm.error != null) && <div className="mt-2"><ErrorText error={calc.error ?? confirm.error} /></div>}
    </Card>
  )
}

/** The tour's details in a drawer: one place to change them, saved together. */
function TourDetailsDrawer({ tour, focus, onClose, onSaved }: { tour: Tour; focus: DetailField; onClose: () => void; onSaved: (t: Tour) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const clients = useClients()
  const [addingClient, setAddingClient] = useState(false)
  const init = () => ({
    code: tour.code, name: tour.name, client_id: tour.client_id ?? '', status: tour.status,
    start_date: tour.start_date, end_date: tour.end_date, pax: tour.pax ? String(tour.pax) : '', rooms: tour.rooms ?? '',
    pax_estimated: !!tour.pax_estimated, leaders: String(tour.leaders ?? 0), staff_table: !!tour.staff_table,
    notes: tour.notes, price_pp: tour.price_pp === null ? '' : String(tour.price_pp),
    price_currency: tour.price_currency ?? ws.base_currency,
  })
  const [form, setForm] = useState(init)
  const seesMoney = can(ws, 'operations', 'finance', 'sales')   // the price per person
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const dirty = JSON.stringify(form) !== JSON.stringify(init())
  const close = useGuardedClose(dirty, onClose)
  // Opened at a missing fact: that field, ready to type.
  useEffect(() => {
    if (!focus) return
    const id = setTimeout(() => {
      const el = document.getElementById(`tour-${focus}`)
      el?.scrollIntoView({ block: 'center' })
      ;(el?.matches('input,select') ? el : el?.querySelector('input,select') as HTMLElement | null)?.focus()
    }, 80)
    return () => clearTimeout(id)
  }, [focus])

  const save = useMutation({
    mutationFn: () => api<Tour>(wsPath(ws.id, `/tours/${tour.id}`), {
      method: 'PATCH',
      body: {
        ...form, pax: Number(form.pax) || 0, pax_estimated: !!form.pax && form.pax_estimated, status: form.status as TourStatus,
        leaders: Number(form.leaders) || 0,
        client_id: form.client_id || null,
        price_pp: seesMoney ? (form.price_pp === '' ? null : form.price_pp) : undefined,
        price_currency: seesMoney ? form.price_currency : undefined,
        // Send end_date only if the user changed it, so moving the start shifts the whole tour.
        end_date: form.end_date !== tour.end_date ? form.end_date : undefined,
      },
    }),
    onSuccess: (t2) => {
      onSaved(t2)
      // Price, pax and dates move the money and the bookings shown on the tabs.
      for (const k of ['tours', 'profit', 'schedule', 'bookings', 'tasks', 'meals', 'alerts']) qc.invalidateQueries({ queryKey: [k, ws.id] })
      onClose()
    },
  })

  return (
    <Drawer title={t('tourDetails')} subtitle={tour.code} onClose={close} size="lg"
      footer={<>
        <Button type="submit" form="tour-details" disabled={save.isPending || !dirty}>{t('save')}</Button>
        <Button variant="secondary" onClick={close}>{t('cancel')}</Button>
        <ErrorText error={save.error} />
      </>}>
      <form id="tour-details" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }} className="space-y-6">
        <section className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('tourCode')}><Input required value={form.code} onChange={set('code')} className="font-mono uppercase" /></Field>
            <Field label={t('status')}>
              <Select value={form.status} onChange={set('status')}>
                {TOUR_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={t('client')}>
            <Select id="tour-client" value={form.client_id} onChange={(e) => (e.target.value === '__new__' ? setAddingClient(true) : setForm({ ...form, client_id: e.target.value }))}>
              <option value="">{t('noClientYet')}</option>
              {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new__">{t('addNewOption')}</option>
            </Select>
          </Field>
          <Field label={t('name')} hint={t('tourNameHint')}><Input value={form.name} onChange={set('name')} /></Field>
        </section>
        <section className="grid gap-4 sm:grid-cols-2" id="tour-dates">
          <Field label={t('startDate')}><Input type="date" required value={form.start_date} onChange={set('start_date')} /></Field>
          <Field label={t('endDate')}><Input type="date" required min={form.start_date} value={form.end_date} onChange={set('end_date')} /></Field>
        </section>
        <section className="space-y-4 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-800">{t('tourGroupSection')}</h3>
          <div className="flex flex-wrap items-end gap-4">
            <Field label={t('pax')}>
              <Input id="tour-pax" type="number" min={0} value={form.pax} onChange={set('pax')} placeholder={t('paxUnknownPh')} className="w-28" />
            </Field>
            <label className="flex h-10 items-center gap-2 text-sm text-slate-600" title={t('paxApproxHelp')}>
              <input type="checkbox" checked={form.pax_estimated} disabled={!form.pax} onChange={(e) => setForm({ ...form, pax_estimated: e.target.checked })} className="h-4 w-4 accent-brand-600" />
              {t('paxApprox')}
            </label>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">{t('rooms')}</p>
            <RoomsPicker id="tour-rooms" value={form.rooms} pax={Number(form.pax) || 0} onChange={(rooms) => setForm((f) => ({ ...f, rooms }))} />
          </div>
          <div className="flex flex-wrap items-end gap-4" id="tour-leaders">
            <Field label={t('tourLeaders')} hint={t('tourLeadersHelp')}>
              <Input type="number" min={0} max={20} value={form.leaders} onChange={set('leaders')} className="w-28" />
            </Field>
            <label className="flex h-10 items-center gap-2 text-sm text-slate-600" title={t('staffTableHelp')}>
              <input type="checkbox" checked={form.staff_table} onChange={(e) => setForm({ ...form, staff_table: e.target.checked })} className="h-4 w-4 accent-brand-600" />
              {t('staffTableShort')}
            </label>
          </div>
        </section>
        {seesMoney && (
          <section className="space-y-4 border-t border-slate-100 pt-5" id="tour-price">
            <Field label={t('pricePerPerson')} hint={t('tourPriceHelp')}>
              <div className="flex gap-2">
                <Input type="number" min={0} step="0.01" value={form.price_pp} onChange={set('price_pp')} placeholder="0.00" className="text-right" />
                <Select value={form.price_currency} onChange={set('price_currency')} className="w-28" aria-label={t('currency')}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              </div>
            </Field>
          </section>
        )}
        <section className="border-t border-slate-100 pt-5">
          <Field label={t('notes')}><Textarea rows={3} value={form.notes} onChange={set('notes')} /></Field>
        </section>
      </form>
      {addingClient && <QuickClientDialog onCreated={(c) => setForm((f) => ({ ...f, client_id: c.id }))} onClose={() => setAddingClient(false)} />}
    </Drawer>
  )
}

/** The tour's days in the builder; changes are saved together (dates stay, content moves). */
function ItineraryTab({ tour, canEdit, onSaved }: { tour: Tour; canEdit: boolean; onSaved: (t: Tour) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const saved = tour.days.map(toFields)
  const [draft, setDraft] = useState<DayFields[] | null>(null)
  const [back, setBack] = useState<BusReturn | null | undefined>(undefined)   // undefined: as saved
  const alerts = useAlerts(tour.id)
  const days = draft ?? saved
  const busReturn = back === undefined ? tour.bus_return ?? null : back
  const dirty = (!!draft && JSON.stringify(draft) !== JSON.stringify(saved))
    || (back !== undefined && JSON.stringify(back) !== JSON.stringify(tour.bus_return ?? null))
  // Longer or shorter: the end date moves; new days come empty, the last day goes with its content.
  const resize = useMutation({
    mutationFn: (end_date: string) => api<Tour>(wsPath(ws.id, `/tours/${tour.id}`), { method: 'PATCH', body: { end_date } }),
    onSuccess: (t2) => { onSaved(t2); qc.invalidateQueries({ queryKey: ['alerts', ws.id] }) },
  })
  const save = useMutation({
    mutationFn: () => api<Tour>(wsPath(ws.id, `/tours/${tour.id}/itinerary`), { method: 'PUT', body: { days, bus_return: busReturn } }),
    onSuccess: (t2) => { onSaved(t2); setDraft(null); setBack(undefined); qc.invalidateQueries({ queryKey: ['alerts', ws.id] }) },
  })
  return (
    <div className="space-y-3">
      {dirty && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm shadow-md">
          <span className="min-w-0 flex-1 font-medium text-brand-900">{t('unsavedItinerary')}</span>
          <Button size="sm" variant="secondary" onClick={() => { setDraft(null); setBack(undefined) }}>{t('discard')}</Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>{t('saveChanges')}</Button>
        </div>
      )}
      <ErrorText error={save.error} />
      {tour.route_changed && tour.series_id && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          <span className="min-w-0 flex-1">{t('routeChangedSince', { code: tour.series_code ?? '' })}</span>
          <Link to={`/w/${ws.id}/routes?open=${tour.series_id}`} className="font-medium text-brand-700 hover:underline">{t('openRoute')}</Link>
        </p>
      )}
      <ItineraryBuilder days={days} dates={tour.days.map((d) => d.date)} fixedLength disabled={!canEdit}
        stickTop={dirty ? 'top-16' : 'top-0'}
        alerts={dirty ? [] : alerts.data ?? []} onChange={setDraft}
        busReturn={busReturn} onBusReturn={(b) => setBack(b)} />
      {canEdit && !tour.closed_at && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" disabled={dirty || resize.isPending} title={dirty ? t('saveFirst') : undefined}
            onClick={() => resize.mutate(addDays(tour.end_date, 1))}><Plus size={15} />{t('addDayEnd')}</Button>
          {tour.days.length > 1 && (
            <Button type="button" variant="ghost" disabled={dirty || resize.isPending} title={dirty ? t('saveFirst') : undefined}
              onClick={() => { const last = days[days.length - 1]; const filled = last.hotel_id || last.lunch_id || last.dinner_id || last.extras.length || last.notes
                void (filled ? ask({ title: t('removeLastDay'), message: t('removeLastDayMsg'), danger: true }) : Promise.resolve(true))
                  .then((ok) => ok && resize.mutate(addDays(tour.end_date, -1))) }}>
              <Minus size={15} />{t('removeLastDay')}
            </Button>
          )}
          <span className="text-xs text-slate-500">{t('resizeHelp')}</span>
          <ErrorText error={resize.error} />
        </div>
      )}
    </div>
  )
}
