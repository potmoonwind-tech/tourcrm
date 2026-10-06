/**
 * A calculation for a whole series, from the calculation's side:
 * - "Create departures": new tours of its route, each with this calculation as budget and price;
 * - "Apply to departures": give it to tours of the route that already exist.
 * Each tour gets the price tier of its own group size (or one size for all).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from '../../components/tour'
import { Button, ErrorText, Field, Input } from '../../components/ui'
import { api, type QuoteDoc, type TourSummary } from '../../lib/api'
import { wsPath } from '../../lib/data'
import { fmt, today } from '../../lib/dates'
import { useI18n } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn, paxText } from '../../lib/utils'

export interface SeriesResult { tour_id: string | null; code: string | null; start_date: string | null; error: string; notes: string[] }

export function SeriesResults({ results, onDone }: { results: SeriesResult[]; onDone: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const ok = results.filter((r) => r.tour_id && !r.error).length
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{t('seriesDone', { ok, total: results.length })}</p>
      <ul className="max-h-96 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 text-sm">
        {results.map((r, i) => (
          <li key={i} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              {r.error ? <X size={16} className="text-red-600" /> : <Check size={16} className="text-emerald-600" />}
              {r.tour_id ? <Link to={`/w/${ws.id}/tours/${r.tour_id}`} className="font-mono font-medium hover:underline">{r.code}</Link> : <span className="font-mono">{r.code}</span>}
              {r.start_date && <span className="text-slate-500">{fmt(r.start_date, lang)}</span>}
              {r.error && <span className="text-red-700">{r.error}</span>}
            </div>
            {r.notes.length > 0 && <ul className="ml-6 list-disc text-xs text-amber-800">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          </li>
        ))}
      </ul>
      <div className="flex justify-end"><Button type="button" onClick={onDone}>{t('done')}</Button></div>
    </div>
  )
}

export function ApplyToDepartures({ quoteId, doc, onClose }: { quoteId: string; doc: QuoteDoc; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const tours = useQuery({ queryKey: ['tours', ws.id, 'all'], queryFn: () => api<TourSummary[]>(wsPath(ws.id, '/tours')) })
  // Departures of this calculation's route that can still take it, soonest first.
  const list = useMemo(() => (tours.data ?? [])
    .filter((x) => x.series_id === doc.series_id && x.status !== 'cancelled' && !x.closed_at && x.end_date >= today())
    .sort((a, b) => a.start_date.localeCompare(b.start_date)), [tours.data, doc.series_id])
  const [off, setOff] = useState<Set<string>>(new Set())
  const [size, setSize] = useState('')       // '' = each tour's own size
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [results, setResults] = useState<SeriesResult[] | null>(null)
  const picked = list.filter((x) => !off.has(x.id))
  const inRange = (d: string) => (!doc.valid_from || d >= doc.valid_from) && (!doc.valid_to || d <= doc.valid_to)
  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      setResults(await api<SeriesResult[]>(wsPath(ws.id, `/quotes/${quoteId}/apply`), {
        method: 'POST', body: { tour_ids: picked.map((x) => x.id), tourists: size ? Number(size) : null },
      }))
      qc.invalidateQueries({ queryKey: ['tours', ws.id] })
    } catch (e) {
      setError(e)
    }
    setBusy(false)
  }
  return (
    <Modal wide title={t('applyToDepartures')} onClose={onClose}>
      {results ? <SeriesResults results={results} onDone={onClose} /> : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t('applyToDeparturesHelp')}</p>
          {list.length === 0 ? <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">{t('applyNoTours')}</p> : (
            <ul className="max-h-80 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 text-sm">
              {list.map((x) => (
                <li key={x.id} className="flex items-center gap-3 px-3 py-1.5">
                  <input type="checkbox" checked={!off.has(x.id)} aria-label={x.code}
                    onChange={() => setOff((o) => { const n = new Set(o); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n })} />
                  <span className="w-24 font-mono font-medium">{x.code}</span>
                  <span className={cn('tabular-nums', !inRange(x.start_date) && 'text-amber-700')} title={!inRange(x.start_date) ? t('outsideCalcDates') : undefined}>
                    {fmt(x.start_date, lang)} – {fmt(x.end_date, lang)}
                  </span>
                  <span className="text-slate-500">{paxText(x)} {t('pax').toLowerCase()}</span>
                  <span className="ml-auto text-xs text-slate-500">
                    {x.quote_id === quoteId ? t('hasThisCalc') : x.quote_id ? t('hasOtherCalc') : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Field label={t('applySize')} hint={t('applySizeHint', { min: doc.pax_min, max: doc.pax_max })}>
            <Input type="number" min={doc.pax_min} max={doc.pax_max} value={size} onChange={(e) => setSize(e.target.value)}
              placeholder={t('applyOwnSize')} className="w-48" />
          </Field>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
            <Button disabled={busy || !picked.length} onClick={apply}>{t('applyN', { n: picked.length })}</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
