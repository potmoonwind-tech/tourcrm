import { useMutation, useQuery } from '@tanstack/react-query'
import { CalendarDays, Copy, FilePlus, Plus, Route, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CodeChip, EmptyState, Modal } from '../components/tour'
import { Button, ChoiceCard, ErrorText, Field, Input, Select } from '../components/ui'
import { api, type QuoteOut, type QuoteStatus, type QuoteSummary, type TourSummary } from '../lib/api'
import { useSeries, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, countWord } from '../lib/utils'
import { PageHeader } from './Dashboard'

const STATUS_STYLE: Record<QuoteStatus, string> = {
  draft: 'bg-slate-200 text-slate-700', sent: 'bg-sky-100 text-sky-800',
  accepted: 'bg-emerald-500 text-white', archived: 'bg-slate-100 text-slate-400',
}

/** "1,080–1,468 USD": from the biggest group (cheapest) to the smallest. */
const priceRange = (q: QuoteSummary) => q.price_from == null ? '—'
  : `${whole(q.price_from)}${q.price_to != null && q.price_to !== q.price_from ? `–${whole(q.price_to)}` : ''} ${q.currency}`
const whole = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function QuoteStatusPill({ status }: { status: QuoteStatus }) {
  const { t } = useI18n()
  return <span className={cn('inline-flex rounded-md px-2 py-1 text-xs font-semibold', STATUS_STYLE[status])}>{t(`status_q_${status}` as TKey)}</span>
}

export function CalculationsPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const quotes = useQuery({ queryKey: ['quotes', ws.id], queryFn: () => api<QuoteSummary[]>(wsPath(ws.id, '/quotes')) })
  return (
    <>
      <PageHeader title={t('calculations')} subtitle={t('calculationsHelp')}
        action={<Button onClick={() => setCreating(true)}><Plus size={16} />{t('newCalculation')}</Button>} />
      <div className="p-4 md:p-8">
        {quotes.isSuccess && quotes.data.length === 0 ? (
          <EmptyState title={t('noCalculations')} hint={t('noCalculationsHint')}
            action={<Button onClick={() => setCreating(true)}><Plus size={16} />{t('newCalculation')}</Button>} />
        ) : (
          <>
          <ul className="space-y-2 md:hidden">
            {quotes.data?.map((q) => (
              <li key={q.id}>
                <button type="button" onClick={() => navigate(q.id)} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm">
                  <div className="flex items-start gap-2">
                    {q.series_code && <CodeChip code={q.series_code} color={q.series_color ?? 'slate'} />}
                    <span className="min-w-0 flex-1 font-medium">{q.name}</span>
                    <QuoteStatusPill status={q.status} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm text-slate-600">
                    <span>{q.pax_min}–{q.pax_max}{q.leaders ? ` +${q.leaders}` : ''} · {q.days} {countWord(q.days, t('dayWord'), t('daysWord'))}</span>
                    <span className="font-semibold tabular-nums text-slate-900">{priceRange(q)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm md:block">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('name')}</th><th className="px-4 py-3">{t('route')}</th>
                  <th className="px-4 py-3">{t('client')}</th><th className="px-4 py-3">{t('groupSizes')}</th>
                  <th className="px-4 py-3 text-right">{t('pricePerPersonRange')}</th>
                  <th className="px-4 py-3">{t('dates')}</th><th className="px-4 py-3">{t('tours')}</th>
                  <th className="px-4 py-3 text-center">{t('status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {quotes.data?.map((q) => (
                  <tr key={q.id} onClick={() => navigate(q.id)} className="cursor-pointer hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{q.name}</td>
                    <td className="px-4 py-3">{q.series_code ? <CodeChip code={q.series_code} color={q.series_color ?? 'slate'} /> : '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{q.client_name ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums">{q.pax_min}–{q.pax_max}{q.leaders ? ` +${q.leaders}` : ''} · {q.days} {countWord(q.days, t('dayWord'), t('daysWord'))}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">{priceRange(q)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {q.valid_from ? fmt(q.valid_from, lang) : ''}{q.valid_to ? ` – ${fmt(q.valid_to, lang)}` : ''}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{q.tours || '—'}</td>
                    <td className="px-4 py-3 text-center"><QuoteStatusPill status={q.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
      {creating && <NewCalculation quotes={quotes.data ?? []} onClose={() => setCreating(false)} />}
    </>
  )
}

type StartKind = 'route' | 'tour' | 'copy' | 'blank' | 'sample'
const STARTS: { kind: StartKind; icon: typeof Plus; title: TKey; hint: TKey }[] = [
  { kind: 'route', icon: Route, title: 'startRoute', hint: 'startRouteHint' },
  { kind: 'tour', icon: CalendarDays, title: 'startTour', hint: 'startTourHint' },
  { kind: 'copy', icon: Copy, title: 'startCopy', hint: 'startCopyHint' },
  { kind: 'blank', icon: FilePlus, title: 'startBlank', hint: 'startBlankHint' },
  { kind: 'sample', icon: Sparkles, title: 'startSample', hint: 'startSampleHint' },
]

/** How to start a calculation, as choices you can see: from a route (the usual way), from a tour,
 * from another calculation, empty, or a worked example. */
function NewCalculation({ quotes, onClose }: { quotes: QuoteSummary[]; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const routes = useSeries()
  const tours = useQuery({ queryKey: ['tours', ws.id, 'all'], queryFn: () => api<TourSummary[]>(wsPath(ws.id, '/tours')) })
  const [kind, setKind] = useState<StartKind>('route')
  const [name, setName] = useState('')
  const [routeId, setRouteId] = useState('')
  const [onDate, setOnDate] = useState(today())
  const [tourId, setTourId] = useState('')
  const [copyId, setCopyId] = useState(quotes[0]?.id ?? '')
  const upcoming = (tours.data ?? []).filter((x) => x.end_date >= today() && x.status !== 'cancelled' && !x.closed_at)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
  const ready = kind === 'route' ? !!routeId : kind === 'tour' ? !!tourId : kind === 'copy' ? !!copyId : true
  const create = useMutation({
    mutationFn: () => {
      const body = kind === 'route' ? { preset: 'blank', series_id: routeId, on_date: onDate, name: name || null }
        : kind === 'tour' ? { preset: 'blank', tour_id: tourId, name: name || null }
        : kind === 'copy' ? { copy_of: copyId, name: name || null }
        : { preset: kind === 'sample' ? 'hm' : 'blank', name: name || null }
      return api<QuoteOut>(wsPath(ws.id, '/quotes'), { method: 'POST', body })
    },
    // Missing prices etc. found while building are shown once in the editor; from a tour, the price goes back to it.
    onSuccess: (q) => navigate(`/w/${ws.id}/calculations/${q.id}${kind === 'tour' ? `?for_tour=${tourId}` : ''}`, { state: { notices: q.notices ?? [] } }),
  })
  return (
    <Modal wide title={t('newCalculation')} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate() }} className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {STARTS.filter((x) => x.kind !== 'copy' || quotes.length > 0).map(({ kind: k, icon: Icon, title, hint }) => (
            <ChoiceCard key={k} selected={kind === k} onClick={() => setKind(k)} icon={<Icon size={20} />} title={t(title)} hint={t(hint)} />
          ))}
        </div>
        {kind === 'route' && (
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <Field label={t('route')}>
              <Select required value={routeId} onChange={(e) => {
                setRouteId(e.target.value)
                // Priced for the route's next departure, when it has one.
                const next = (tours.data ?? []).filter((x) => x.series_id === e.target.value && x.start_date >= today() && x.status !== 'cancelled')
                  .map((x) => x.start_date).sort()[0]
                if (next) setOnDate(next)
              }}>
                <option value="">—</option>
                {routes.data?.map((r) => <option key={r.id} value={r.id}>{r.name.toUpperCase().startsWith(r.code.toUpperCase()) ? r.name : `${r.code}${r.name ? ` · ${r.name}` : ''}`} ({r.days.length} {t('daysShort')})</option>)}
              </Select>
            </Field>
            <Field label={t('travelDate')} hint={t('travelDateHint')}><Input type="date" required value={onDate} onChange={(e) => setOnDate(e.target.value)} /></Field>
          </div>
        )}
        {kind === 'tour' && (
          <Field label={t('tour')} hint={t('startTourField')}>
            <Select required value={tourId} onChange={(e) => setTourId(e.target.value)}>
              <option value="">—</option>
              {upcoming.map((x) => <option key={x.id} value={x.id}>{x.code} · {fmt(x.start_date, lang)}{x.client_name ? ` · ${x.client_name}` : ''}</option>)}
            </Select>
          </Field>
        )}
        {kind === 'copy' && (
          <Field label={t('copyOf')}>
            <Select value={copyId} onChange={(e) => setCopyId(e.target.value)}>
              {quotes.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('name')}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'route' || kind === 'tour' ? t('nameFromRoute') : undefined} /></Field>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={create.isPending || !ready}>{t('create')}</Button>
        </div>
      </form>
    </Modal>
  )
}
