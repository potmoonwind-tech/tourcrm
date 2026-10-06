import { toFields } from '../components/DayProgramme'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask, Menu } from '../components/overlay'
import { ArrowLeft, Ban, Calculator, ChevronDown, Minus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CodeChip } from '../components/tour'
import { Button, Card, ErrorText, Field, FullPageSpinner, Input, Select } from '../components/ui'
import { api, atLeast, TOUR_STATUSES, type DayFields, type QuoteOut, type Tour, type TourStatus, can } from '../lib/api'
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
  const [typing, setTyping] = useState(0)   // "Type a price": opens the details and focuses the price
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
        {can(ws, 'operations', 'finance', 'sales') && <TourPriceLine tour={tr} canEdit={canEdit} onType={() => setTyping((n) => n + 1)} />}
        <TourForm tour={tr} canEdit={canEdit} typing={typing} onSaved={(t2) => qc.setQueryData(key, t2)} />
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200">
          {tabs.map(([id, label, count]) => (
            <button type="button" key={id} onClick={() => setTab(id)}
              className={cn('-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold',
                tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
              {label}{count !== null && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{count}</span>}
            </button>
          ))}
        </nav>
        {cancelling && <CancelTourModal tour={tr} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); setTab('costs') }} />}
        {tab === 'bookings' && <BookingsTab tour={tr} canEdit={canEdit} />}
        {tab === 'meals' && <MealsTab tour={tr} onTab={setTab} />}
        {tab === 'participants' && <ParticipantsTab tour={tr} />}
        {tab === 'staff' && <StaffTab tour={tr} />}
        {tab === 'incidents' && <IncidentsTab tour={tr} />}
        {tab === 'costs' && seesMoney && <CostsTab tour={tr} />}
        {tab === 'itinerary' && <ItineraryTab tour={tr} canEdit={canEdit} onSaved={(t2) => qc.setQueryData(key, t2)} />}
      </div>
    </>
  )
}

/** The tour's selling price at a glance, where it came from, and the way to get one: calculate it from this
 * tour's own days (hotels as changed on the tour, its dates, its group) or type it. */
function TourPriceLine({ tour, canEdit, onType }: { tour: Tour; canEdit: boolean; onType: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const navigate = useNavigate()
  const canCalc = canEdit && can(ws, 'operations', 'sales')
  const calc = useMutation({
    mutationFn: () => api<QuoteOut>(wsPath(ws.id, '/quotes'), { method: 'POST', body: { preset: 'blank', tour_id: tour.id } }),
    onSuccess: (q) => navigate(`/w/${ws.id}/calculations/${q.id}?for_tour=${tour.id}`, { state: { notices: q.notices ?? [] } }),
  })
  const has = tour.price_pp !== null && tour.price_pp > 0
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
      {has ? (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-lg font-semibold tabular-nums text-slate-900">{tour.price_pp!.toLocaleString(undefined, { maximumFractionDigits: 2 })} {tour.price_currency ?? ws.base_currency}</span>
          <span className="text-slate-500">{t('perPersonShort')}</span>
          <span className="text-slate-400">·</span>
          {tour.quote_id
            ? <Link to={`/w/${ws.id}/calculations/${tour.quote_id}`} className="text-brand-700 hover:underline">{t('priceFromCalc')}</Link>
            : <span className="text-slate-500">{t('priceTyped')}</span>}
        </span>
      ) : (
        <span className="font-medium text-amber-700">{t('noPriceYet')}</span>
      )}
      {canCalc && (
        <span className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant={has ? 'secondary' : 'primary'} disabled={calc.isPending} onClick={() => calc.mutate()} title={t('calcFromTourHelp')}>
            <Calculator size={15} />{has ? t('recalcFromTour') : t('calcFromTour')}
          </Button>
          {!has && <Button size="sm" variant="secondary" onClick={onType}><Pencil size={15} />{t('typePrice')}</Button>}
        </span>
      )}
      {calc.error != null && <div className="w-full"><ErrorText error={calc.error} /></div>}
    </div>
  )
}

function TourForm({ tour, canEdit, typing, onSaved }: { tour: Tour; canEdit: boolean; typing: number; onSaved: (t: Tour) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const clients = useClients()
  const init = () => ({
    code: tour.code, name: tour.name, client_id: tour.client_id ?? '', status: tour.status,
    start_date: tour.start_date, end_date: tour.end_date, pax: tour.pax ? String(tour.pax) : '', rooms: tour.rooms,
    pax_estimated: !!tour.pax_estimated, leaders: String(tour.leaders ?? 0), staff_table: !!tour.staff_table,
    notes: tour.notes, price_pp: tour.price_pp === null ? '' : String(tour.price_pp),
    price_currency: tour.price_currency ?? ws.base_currency,
  })
  const [form, setForm] = useState(init)
  const seesMoney = can(ws, 'operations', 'finance', 'sales')   // the price per person
  // On a phone the details fold away so the tabs (the daily work) come first.
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768)
  useEffect(() => setForm(init()), [tour]) // eslint-disable-line react-hooks/exhaustive-deps
  const priceRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!typing) return
    setOpen(true)
    setTimeout(() => { priceRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); priceRef.current?.focus() }, 50)
  }, [typing])
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

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
      for (const k of ['tours', 'profit', 'schedule', 'bookings', 'tasks', 'meals']) qc.invalidateQueries({ queryKey: [k, ws.id] })
    },
  })
  const dirty = JSON.stringify(form) !== JSON.stringify(init())

  return (
    <Card className="p-5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold md:hidden">
        <span>{t('tourDetails')}{!open && <span className="ml-2 font-normal text-slate-500">{paxText(tour)} {t('pax').toLowerCase()}{tour.client_name ? ` · ${tour.client_name}` : ''}</span>}</span>
        <ChevronDown size={16} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }} className={cn(!open && 'hidden md:block', open && 'mt-3 md:mt-0')}>
        <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('tourCode')}><Input required value={form.code} onChange={set('code')} className="font-mono uppercase" /></Field>
          <Field label={t('client')}>
            <Select value={form.client_id} onChange={set('client_id')}>
              <option value="">—</option>
              {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label={t('startDate')}><Input type="date" required value={form.start_date} onChange={set('start_date')} /></Field>
          <Field label={t('endDate')}><Input type="date" required min={form.start_date} value={form.end_date} onChange={set('end_date')} /></Field>
          <Field label={t('status')}>
            <Select value={form.status} onChange={set('status')}>
              {TOUR_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('pax')}>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} value={form.pax} onChange={set('pax')} placeholder={t('paxUnknownPh')} className="w-24" />
              <label className="flex items-center gap-1.5 text-sm text-slate-600" title={t('paxApproxHelp')}>
                <input type="checkbox" checked={form.pax_estimated} disabled={!form.pax} onChange={(e) => setForm({ ...form, pax_estimated: e.target.checked })} />
                {t('paxApproxShort')}
              </label>
            </div>
          </Field>
          <Field label={t('rooms')}><Input value={form.rooms} onChange={set('rooms')} /></Field>
          <Field label={t('tourLeaders')} hint={t('tourLeadersHelp')}>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={20} value={form.leaders} onChange={set('leaders')} className="w-20" />
              <label className="flex items-center gap-1.5 text-sm text-slate-600" title={t('staffTableHelp')}>
                <input type="checkbox" checked={form.staff_table} onChange={(e) => setForm({ ...form, staff_table: e.target.checked })} />
                {t('staffTableShort')}
              </label>
            </div>
          </Field>
          <Field label={t('name')}><Input value={form.name} onChange={set('name')} /></Field>
          {seesMoney && (
            <Field label={t('pricePerPerson')} hint={t('tourPriceHelp')}>
              <div className="flex gap-2">
                <Input ref={priceRef} type="number" min={0} step="0.01" value={form.price_pp} onChange={set('price_pp')} placeholder="0.00" className="text-right" />
                <Select value={form.price_currency} onChange={set('price_currency')} className="w-24" aria-label={t('currency')}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              </div>
            </Field>
          )}
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label={t('notes')}><Input value={form.notes} onChange={set('notes')} /></Field>
          </div>
        </fieldset>
        <div className="mt-3"><ErrorText error={save.error} /></div>
        {canEdit && dirty && (
          <div className="mt-4 flex gap-3">
            <Button type="submit" disabled={save.isPending}>{t('save')}</Button>
            <Button type="button" variant="secondary" onClick={() => setForm(init())}>{t('cancel')}</Button>
          </div>
        )}
      </form>
    </Card>
  )
}

/** The tour's days in the builder; changes are saved together (dates stay, content moves). */
function ItineraryTab({ tour, canEdit, onSaved }: { tour: Tour; canEdit: boolean; onSaved: (t: Tour) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const saved = tour.days.map(toFields)
  const [draft, setDraft] = useState<DayFields[] | null>(null)
  const alerts = useAlerts(tour.id)
  const days = draft ?? saved
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
  // Longer or shorter: the end date moves; new days come empty, the last day goes with its content.
  const resize = useMutation({
    mutationFn: (end_date: string) => api<Tour>(wsPath(ws.id, `/tours/${tour.id}`), { method: 'PATCH', body: { end_date } }),
    onSuccess: (t2) => { onSaved(t2); qc.invalidateQueries({ queryKey: ['alerts', ws.id] }) },
  })
  const save = useMutation({
    mutationFn: () => api<Tour>(wsPath(ws.id, `/tours/${tour.id}/itinerary`), { method: 'PUT', body: { days } }),
    onSuccess: (t2) => { onSaved(t2); setDraft(null); qc.invalidateQueries({ queryKey: ['alerts', ws.id] }) },
  })
  return (
    <div className="space-y-3">
      {dirty && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm shadow-md">
          <span className="min-w-0 flex-1 font-medium text-brand-900">{t('unsavedItinerary')}</span>
          <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>{t('discard')}</Button>
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
        alerts={dirty ? [] : alerts.data ?? []} onChange={setDraft} />
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
