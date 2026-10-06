import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { CodeChip, EmptyState, Modal, PhaseLabel } from '../components/tour'
import { useGuardedClose, useUnsaved } from '../components/overlay'
import { QuickClientDialog } from '../components/QuickAdd'
import { Button, ButtonLink, ErrorText, Field, Input, Select } from '../components/ui'
import { SetupNudge, useSetup } from '../components/GetStarted'
import { api, atLeast, TOUR_STATUSES, type Tour, type TourStatus, type TourSummary, can } from '../lib/api'
import { CURRENCIES } from './Onboarding'
import { useClients, useSeries, wsPath } from '../lib/data'
import { addDays, diffDays, fmt, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, countWord, paxText } from '../lib/utils'
import { PageHeader } from './Dashboard'
import { DeparturesForm } from './NewDepartures'

type Range = 'current' | 'past' | 'all'

export function ToursPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [range, setRange] = useState<Range>('current')
  const [status, setStatus] = useState<TourStatus | ''>('')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const setup = useSetup()

  const params = new URLSearchParams()
  if (range === 'current') params.set('date_from', today())
  if (range === 'past') params.set('date_to', today())
  if (status) params.set('status', status)
  if (q.trim()) params.set('q', q.trim())
  const tours = useQuery({
    queryKey: ['tours', ws.id, params.toString()],
    queryFn: () => api<TourSummary[]>(wsPath(ws.id, `/tours?${params}`)),
    placeholderData: (prev) => prev,
  })
  // Past tours read most naturally newest-first.
  const rows = range === 'past' ? [...(tours.data ?? [])].reverse() : tours.data ?? []
  const totalPax = rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.pax, 0)

  return (
    <>
      <PageHeader section="tours" title={t('tours')} subtitle={`${rows.length} · ${totalPax} ${t('touristsTotal')}`}
        action={atLeast(ws.role, 'staff') && <Button onClick={() => setCreating(true)}><Plus size={16} />{t('newTour')}</Button>} />
      <div className="space-y-4 p-4 md:p-8">
        <SetupNudge step="tours" />
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
            {(['current', 'past', 'all'] as Range[]).map((r) => (
              <button type="button" key={r} onClick={() => setRange(r)}
                className={cn('shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 font-medium', range === r ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                {r === 'current' ? `${t('phase_running')} + ${t('phase_upcoming').toLowerCase()}` : r === 'past' ? t('phase_finished') : t('all')}
              </button>
            ))}
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value as TourStatus | '')} className="w-44">
            <option value="">{t('status')}: {t('all')}</option>
            {TOUR_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
          </Select>
          <div className="relative min-w-48 flex-1">
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="pl-9" />
          </div>
        </div>

        {tours.isSuccess && rows.length === 0 ? (
          setup.data?.tours === 0 ? (
            <EmptyState title={t('noToursYet')} hint={t('noToursHint')} action={atLeast(ws.role, 'staff') && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setCreating(true)}><Plus size={16} />{t('newTour')}</Button>
                <ButtonLink to="../routes" relative="path">{t('setUpRoute')}</ButtonLink>
              </div>
            )} />
          ) : (
            <EmptyState title={t('noTours')} hint={t('noToursMatchHint')}
              action={(status || q || range !== 'all') && <Button variant="secondary" onClick={() => { setStatus(''); setQ(''); setRange('all') }}>{t('showAllTours')}</Button>} />
          )
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('tourCode')}</th>
                  <th className="px-4 py-3">{t('client')}</th>
                  <th className="px-4 py-3">{t('dates')}</th>
                  <th className="px-4 py-3 text-right">{t('pax')}</th>
                  <th className="px-4 py-3">{t('guide')}</th>
                  <th className="px-4 py-3 text-center">{t('stage')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => navigate(r.id)} className={cn('cursor-pointer hover:bg-slate-50', r.status === 'cancelled' && 'opacity-60')}>
                    <td className="px-4 py-3"><CodeChip code={r.code} color={r.color} /></td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{r.client_name ?? '—'}</p>
                      {r.name && <p className="text-xs text-slate-500">{r.name}</p>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {fmt(r.start_date, lang)} – {fmt(r.end_date, lang)}
                      <span className="ml-2 text-xs text-slate-400">{diffDays(r.start_date, r.end_date) + 1} {countWord(diffDays(r.start_date, r.end_date) + 1, t('dayWord'), t('daysWord'))}</span>
                    </td>
                    <td className={cn('px-4 py-3 text-right font-semibold tabular-nums', (!r.pax || r.pax_estimated) && 'text-amber-700')}
                      title={!r.pax ? t('paxUnknown') : r.pax_estimated ? t('paxApprox') : undefined}>{paxText(r)}</td>
                    <td className="px-4 py-3 text-slate-600">{r.staff.filter((s) => s.role === 'guide').map((s) => s.vendor.name).join(', ') || '—'}</td>
                    <td className="px-4 py-3 text-center"><PhaseLabel phase={r.phase} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewTourModal onClose={() => setCreating(false)} />}
    </>
  )
}

function NewTourModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const series = useSeries()
  const clients = useClients()
  const [addingClient, setAddingClient] = useState(false)
  const [many, setMany] = useState(false)     // a series: many departures at once (NewDepartures.tsx)
  const [form, setForm] = useState({
    // With a single route (the usual start), it is the obvious choice.
    series_id: series.data?.length === 1 ? series.data[0].id : '',
    code: '', start_date: today(), end_date: '', client_id: '', pax: '', rooms: '', status: 'confirmed' as TourStatus,
    days: '3', pax_estimated: false,
    price_pp: '', price_currency: ws.base_currency,
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  // The only route is the obvious choice — also when the routes arrive after the form opened.
  const [routeTouched, setRouteTouched] = useState(false)
  const only = series.data?.length === 1 ? series.data[0].id : ''
  useEffect(() => {
    if (only && !routeTouched && !form.series_id) setForm((f) => ({ ...f, series_id: only }))
  }, [only]) // eslint-disable-line react-hooks/exhaustive-deps
  const picked = series.data?.find((s) => s.id === form.series_id)
  const guarded = useGuardedClose(useUnsaved(form), onClose)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const tour = await api<Tour>(wsPath(ws.id, '/tours'), {
        method: 'POST',
        body: {
          series_id: form.series_id || null, code: form.code || null, start_date: form.start_date,
          // Without a route the tour is as long as asked: start + number of days.
          end_date: picked ? null : addDays(form.start_date, Math.max(1, Number(form.days) || 1) - 1), client_id: form.client_id || null,
          pax: Number(form.pax) || 0, pax_estimated: !!form.pax && form.pax_estimated, rooms: form.rooms, status: form.status,
          ...(can(ws, 'operations', 'finance', 'sales') && form.price_pp ? { price_pp: form.price_pp, price_currency: form.price_currency } : {}),
        },
      })
      qc.invalidateQueries({ queryKey: ['tours', ws.id] })
      navigate(`/w/${ws.id}/tours/${tour.id}`)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Modal title={t('newTour')} onClose={guarded} wide={many}>
      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
        {[false, true].map((k) => (
          <button key={String(k)} type="button" onClick={() => setMany(k)}
            className={cn('flex-1 rounded-md py-1.5', many === k ? 'bg-white shadow-sm' : 'text-slate-500')}>{t(k ? 'severalDepartures' : 'oneTour')}</button>
        ))}
      </div>
      {many ? <DeparturesForm series={series.data ?? []} onDone={onClose} /> : (
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('route')}>
          <Select value={form.series_id} onChange={(e) => { setRouteTouched(true); set('series_id')(e) }}>
            <option value="">{t('emptyDays')}</option>
            {series.data?.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name} ({s.days.length} {countWord(s.days.length, t('dayWord'), t('daysWord'))})</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('startDate')}>
            <Input type="date" required value={form.start_date} onChange={set('start_date')} />
          </Field>
          {picked ? (
            <Field label={t('endDate')} hint={t('endDateAuto')}>
              <Input type="date" disabled value={addDays(form.start_date, picked.days.length - 1)} />
            </Field>
          ) : (
            <Field label={t('numberOfDays')} hint={t('endsOn', { date: fmt(addDays(form.start_date, Math.max(1, Number(form.days) || 1) - 1), lang) })}>
              <Input type="number" required min={1} max={60} value={form.days} onChange={set('days')} />
            </Field>
          )}
        </div>
        <Field label={t('tourCode')} hint={t('codeAuto')}>
          <Input value={form.code} onChange={set('code')} className="font-mono uppercase" />
        </Field>
        <Field label={t('client')}>
          <Select value={form.client_id} onChange={(e) => (e.target.value === '__new__' ? setAddingClient(true) : setForm({ ...form, client_id: e.target.value }))}>
            <option value="">{t('noClientYet')}</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="__new__">{t('addNewOption')}</option>
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('pax')} hint={form.pax ? undefined : t('paxLater')}>
            <Input type="number" min={0} value={form.pax} onChange={set('pax')} placeholder={t('paxUnknownPh')} />
          </Field>
          <div className="col-span-2"><Field label={t('rooms')}><Input value={form.rooms} onChange={set('rooms')} placeholder={t('roomsPh')} /></Field></div>
          {!!form.pax && (
            <label className="col-span-3 -mt-1 flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={form.pax_estimated} onChange={(e) => setForm({ ...form, pax_estimated: e.target.checked })} />
              {t('paxApprox')}
            </label>
          )}
        </div>
        {can(ws, 'operations', 'finance', 'sales') && (
          <Field label={t('pricePerPerson')} hint={t('tourPriceHelp')}>
            <div className="flex gap-2">
              <Input type="number" min={0} step="0.01" value={form.price_pp} onChange={set('price_pp')} placeholder="0.00" className="text-right" />
              <Select value={form.price_currency} onChange={set('price_currency')} className="w-28" aria-label={t('currency')}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </Select>
            </div>
          </Field>
        )}
        <Field label={t('status')}>
          <Select value={form.status} onChange={set('status')}>
            {TOUR_STATUSES.filter((s) => s !== 'cancelled').map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
          </Select>
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={guarded}>{t('cancel')}</Button>
          <Button type="submit" disabled={busy}>{t('create')}</Button>
        </div>
      </form>
      )}
      {addingClient && <QuickClientDialog onCreated={(c) => setForm({ ...form, client_id: c.id })} onClose={() => setAddingClient(false)} />}
    </Modal>
  )
}
