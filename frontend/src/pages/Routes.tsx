import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SetupNudge } from '../components/GetStarted'
import { Drawer, Menu, ask, askText } from '../components/overlay'
import { Bookmark, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { blankDay, ItineraryBuilder } from '../components/ItineraryBuilder'
import { ProgrammeDialog } from '../components/ProgrammeDialog'
import { COLOR, CodeChip, EmptyState } from '../components/tour'
import { Button, Card, ErrorText, Field, Input } from '../components/ui'
import { api, SERIES_COLORS, type DayFields, type DayTemplate, type Series, type TourSummary, can } from '../lib/api'
import { useOpenFromUrl, useSeries, wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { today } from '../lib/dates'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../lib/session'
import { cn, countWord } from '../lib/utils'
import { PageHeader } from './Dashboard'

/** A short code from a route name, e.g. "Tbilisi weekend" → "TW", "Georgia & Armenia classic" → "GAC". */
const KA_LATIN: Record<string, string> = {
  ა: 'A', ბ: 'B', გ: 'G', დ: 'D', ე: 'E', ვ: 'V', ზ: 'Z', თ: 'T', ი: 'I', კ: 'K', ლ: 'L', მ: 'M', ნ: 'N', ო: 'O', პ: 'P', ჟ: 'J',
  რ: 'R', ს: 'S', ტ: 'T', უ: 'U', ფ: 'P', ქ: 'K', ღ: 'G', ყ: 'Q', შ: 'S', ჩ: 'C', ც: 'C', ძ: 'D', წ: 'T', ჭ: 'C', ხ: 'K', ჯ: 'J', ჰ: 'H',
}
const suggestCode = (name: string) =>
  name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 3).map((w) => KA_LATIN[w[0]] ?? w[0]).join('').toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

/** "Tbilisi → Kazbegi → Tbilisi", collapsing consecutive nights in one city. */
const path = (days: DayFields[]) =>
  days.map((d) => d.city).filter((c, i, a) => c && c !== a[i - 1]).join(' → ')

export function RoutesPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const series = useSeries()
  const [editing, setEditing] = useState<Series | 'new' | null>(null)
  useOpenFromUrl(series.data, setEditing)
  const canEdit = can(ws, 'operations')
  const navigate = useNavigate()
  // Upcoming departures per route: a route with several is a series (its own page).
  const tours = useQuery({ queryKey: ['tours', ws.id, 'all'], queryFn: () => api<TourSummary[]>(wsPath(ws.id, '/tours')) })
  const departures = new Map<string, number>()
  for (const x of tours.data ?? []) if (x.series_id && x.status !== 'cancelled' && x.end_date >= today()) departures.set(x.series_id, (departures.get(x.series_id) ?? 0) + 1)

  return (
    <>
      <PageHeader section="catalog" title={t('catalog')} subtitle={t('routeHelp')}
        action={canEdit && <Button onClick={() => setEditing('new')}><Plus size={16} />{t('newRoute')}</Button>} />
      <div className="space-y-4 p-4 md:p-8">
        <SetupNudge step="routes" />
        {series.isSuccess && series.data.length === 0 ? (
          <EmptyState title={t('emptyRoutes')} hint={t('emptyRoutesHint')}
            action={canEdit && <Button onClick={() => setEditing('new')}><Plus size={16} />{t('newRoute')}</Button>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {series.data?.map((s) => (
              <button type="button" key={s.id} onClick={() => setEditing(s)} className="text-left">
                <Card className="h-full overflow-hidden transition-shadow hover:shadow-md">
                  <div className={cn('h-1.5', COLOR[s.color].bar)} />
                  <div className="p-4">
                    <div className="flex items-center gap-3">
                      <CodeChip code={s.code} color={s.color} className="text-sm" />
                      <span className="font-semibold">{s.name}</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-500">{s.days.length} {countWord(s.days.length, t('dayWord'), t('daysWord'))} · {s.days.length - 1} {countWord(s.days.length - 1, t('nightWord'), t('nights'))}</p>
                    <p className="mt-2 text-sm text-slate-700">{path(s.days) || '—'}</p>
                    {(departures.get(s.id) ?? 0) > 0 && (
                      <span role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); navigate(`/w/${ws.id}/series/${s.id}`) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); navigate(`/w/${ws.id}/series/${s.id}`) } }}
                        className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">
                        {t(departures.get(s.id) === 1 ? 'seriesLinkOne' : 'seriesLink', { n: departures.get(s.id) ?? 0 })}
                      </span>
                    )}
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}
        <SavedDaysList canEdit={canEdit} />
      </div>
      {editing && <RouteEditor series={editing === 'new' ? null : editing} canEdit={canEdit} onClose={() => setEditing(null)} />}
    </>
  )
}


function RouteEditor({ series, canEdit, onClose }: { series: Series | null; canEdit: boolean; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const initial = () => ({
    code: series?.code ?? '', name: series?.name ?? '', color: series?.color ?? 'indigo', notes: series?.notes ?? '',
    days: series?.days.map(({ day_number: _, ...d }) => d) ?? [blankDay()],
    bus_return: series?.bus_return ?? null,
  })
  const [f, setF] = useState(initial)
  const [exporting, setExporting] = useState(false)
  const [start] = useState(() => JSON.stringify(initial()))
  // Closing with unsaved changes asks first (Esc, ×, the backdrop and Cancel).
  const close = () => {
    if (!canEdit || JSON.stringify(f) === start) return onClose()
    void ask({ title: t('discardChanges'), message: t('discardChangesMsg'), confirmLabel: t('discard'), danger: true }).then((ok) => ok && onClose())
  }
  const done = () => { qc.invalidateQueries({ queryKey: ['series', ws.id] }); onClose() }
  const save = useMutation({
    mutationFn: () => series
      ? api(wsPath(ws.id, `/series/${series.id}`), { method: 'PUT', body: f })
      : api(wsPath(ws.id, '/series'), { method: 'POST', body: f }),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: () => api(wsPath(ws.id, `/series/${series!.id}`), { method: 'DELETE' }), onSuccess: done })

  const [codeTouched, setCodeTouched] = useState(false)
  const n = f.days.length
  const km = f.days.reduce((s, d) => s + (d.km ?? 0), 0)
  // Save, Cancel and the route's size stay in view however long the itinerary gets.
  const footer = canEdit && (
    <>
      {series && <Button type="button" variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && remove.mutate())}>{t('delete')}</Button>}
      <span className="text-sm text-slate-500">
        {n} {countWord(n, t('dayWord'), t('daysWord'))} · {Math.max(n - 1, 0)} {countWord(n - 1, t('nightWord'), t('nights'))}{km > 0 && ` · ${km.toLocaleString('en-US')} km`}
      </span>
      <div className="flex-1" />
      <ErrorText error={save.error || remove.error} />
      <Button type="button" variant="secondary" onClick={close}>{t('cancel')}</Button>
      <Button type="submit" form="route-form" disabled={save.isPending}>{series ? t('save') : t('create')}</Button>
    </>
  )
  return (
    <Drawer size="full" title={series ? series.name : t('newRoute')} onClose={close} footer={footer}
      subtitle={path(f.days) || undefined}>
      <form id="route-form" onSubmit={(e: FormEvent) => {
        e.preventDefault()
        if (e.target === e.currentTarget) save.mutate()    // not a quick-add dialog's own form
      }}>
        <fieldset disabled={!canEdit} className="space-y-5">
          {/* Name, code and colour on one line: the days are what this screen is for. */}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <Field label={t('routeName')} className="min-w-[16rem] flex-1">
              <Input required autoFocus={!series} value={f.name} placeholder={t('routeNamePh')}
                onChange={(e) => setF({ ...f, name: e.target.value, code: series || codeTouched ? f.code : suggestCode(e.target.value) })} />
            </Field>
            <Field label={t('code')} className="w-28">
              <Input required value={f.code} title={t('routeCodeHelp')} onChange={(e) => { setCodeTouched(true); setF({ ...f, code: e.target.value }) }} className="font-mono uppercase" />
            </Field>
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">{t('color')}</p>
              <div className="flex h-10 items-center gap-1.5">
                {SERIES_COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setF({ ...f, color: c })} aria-label={c} title={c} aria-pressed={f.color === c}
                    className={cn('h-6 w-6 rounded-full', COLOR[c].bar, f.color === c && 'ring-2 ring-slate-900 ring-offset-2')} />
                ))}
              </div>
            </div>
          </div>
          {exporting && <ProgrammeDialog title={f.name || f.code} days={f.days} onClose={() => setExporting(false)} />}
          <ItineraryBuilder onDownload={() => setExporting(true)} days={f.days} disabled={!canEdit} onChange={(days) => setF({ ...f, days })}
            busReturn={f.bus_return} onBusReturn={(bus_return) => setF({ ...f, bus_return })} />
        </fieldset>
        {!canEdit && <ErrorText error={save.error || remove.error} />}
      </form>
    </Drawer>
  )
}

/** Saved days ("Kutaisi day"), made from a tour's day ("⋯ → Save this day as a template"): used from a day's
 *  city in any tour; renamed or deleted here. */
function SavedDaysList({ canEdit }: { canEdit: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['day-templates', ws.id], queryFn: () => api<DayTemplate[]>(wsPath(ws.id, '/day-templates')) })
  const done = () => qc.invalidateQueries({ queryKey: ['day-templates', ws.id] })
  const rename = async (d: DayTemplate) => {
    const name = await askText({ title: t('savedDayRename'), confirmLabel: t('save'), input: { value: d.name, required: true } })
    if (name?.trim()) { await api(wsPath(ws.id, `/day-templates/${d.id}`), { method: 'PATCH', body: { name: name.trim() } }); void done() }
  }
  const remove = async (d: DayTemplate) => {
    if (!(await ask({ title: t('savedDayDeleteQ', { name: d.name }), confirmLabel: t('delete'), danger: true }))) return
    await api(wsPath(ws.id, `/day-templates/${d.id}`), { method: 'DELETE' }); void done()
  }
  return (
    <section className="pt-4">
      <h2 className="text-base font-semibold text-slate-800">{t('savedDays')}</h2>
      <p className="mt-0.5 text-sm text-slate-500">{t('savedDaysHelp')}</p>
      {list.isSuccess && list.data.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">{t('savedDaysEmpty')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {list.data?.map((d) => {
            const steps = d.data.schedule?.length ?? 0
            return (
              <li key={d.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Bookmark size={15} aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">{d.name}</span>
                  <span className="block truncate text-xs text-slate-500">{[d.city, steps ? t('progSteps', { n: steps }) : ''].filter(Boolean).join(' · ')}</span>
                </span>
                {canEdit && (
                  <Menu kind="icon" label={t('moreActions')} items={[
                    { label: t('savedDayRename'), icon: <Pencil size={16} />, onClick: () => void rename(d) },
                    { label: t('delete'), icon: <Trash2 size={16} />, onClick: () => void remove(d), danger: true },
                  ]} />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
