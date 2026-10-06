/**
 * Many departures of one route at once — a group series like ZK (every Sunday, October–March).
 * Dates are the GROUP's dates (they name the code: ZK-1025); when another agency runs the first
 * days, our part starts on the group's day N. A preview shows every tour before it is made.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorText, Field, Input, Select } from '../components/ui'
import { api, type QuoteSummary, type Series, type TourStatus, can } from '../lib/api'
import { useClients, useVendors, wsPath } from '../lib/data'
import { DepartureGrid } from './DepartureGrid'
import { addDays, fmt } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { CURRENCIES } from './Onboarding'
import { SeriesResults, type SeriesResult } from './calc/ApplyToDepartures'

interface Result { code: string | null; start_date: string; tour_id: string | null; error: string }
interface Row { code: string; group: string; start: string; end: string }

/** "2026-10-25", "25.10.2026", "25/10/2026", with or without a code on the same line. */
function parseLines(text: string): { code: string | null; date: string }[] | string {
  const out: { code: string | null; date: string }[] = []
  for (const raw of text.split(/\n/)) {
    const line = raw.trim()
    if (!line) continue
    const iso = line.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
    const eu = line.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/)
    const m = iso ? [iso[1], iso[2], iso[3]] : eu ? [eu[3], eu[2], eu[1]] : null
    if (!m) return line
    const date = `${m[0]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
    const code = line.replace(iso?.[0] ?? eu?.[0] ?? '', '').replace(/[,;\t]/g, ' ').trim().split(/\s+/)[0] || null
    out.push({ code: code && /[A-Za-z]/.test(code) ? code.toUpperCase() : null, date })
  }
  return out
}

export function DeparturesForm({ series, onDone, quoteId }: {
  series: Series[]; onDone: () => void
  quoteId?: string     // opened from a calculation: its route, its prices
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const clients = useClients()
  const vendors = useVendors()
  const manager = can(ws, 'operations', 'finance', 'sales')   // sets prices
  const quotes = useQuery({ queryKey: ['quotes', ws.id], enabled: manager, queryFn: () => api<QuoteSummary[]>(wsPath(ws.id, '/quotes')) })
  const fixed = quotes.data?.find((q) => q.id === quoteId)
  const [f, setF] = useState({
    quote_id: quoteId ?? '', tourists: '', singles: '0',
    series_id: series.length === 1 ? series[0].id : '', how: 'repeat' as 'repeat' | 'paste',
    first: '', last: '', every: '7', paste: '', offset: '1',
    client_id: '', pax: '', pax_estimated: true, rooms: '', status: 'inquiry' as TourStatus,
    price_pp: '', price_currency: ws.base_currency,
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const routeId = fixed?.series_id ?? f.series_id
  const route = series.find((s) => s.id === routeId)
  // A calculation of this route (optional): the tours get its budget and price per person.
  const calcs = (quotes.data ?? []).filter((q) => q.series_id && q.series_id === routeId && q.status !== 'archived')
  const calc = calcs.find((q) => q.id === f.quote_id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  const [calcResults, setCalcResults] = useState<SeriesResult[] | null>(null)

  // Group dates → our tours. Code = given on the line, else route code + the GROUP's date (ZK-1025).
  const rows = useMemo((): Row[] | string => {
    if (!route) return []
    const skip = Math.max(0, (Number(f.offset) || 1) - 1)
    const days = route.days.length
    let groups: { code: string | null; date: string }[] = []
    if (f.how === 'repeat') {
      const every = Math.max(1, Number(f.every) || 7)
      if (!f.first || !f.last || f.last < f.first) return []
      for (let d = f.first; d <= f.last && groups.length < 60; d = addDays(d, every)) groups.push({ code: null, date: d })
    } else {
      const parsed = parseLines(f.paste)
      if (typeof parsed === 'string') return parsed
      groups = parsed.slice(0, 60)
    }
    return groups.map((g) => {
      const start = addDays(g.date, skip)
      return { code: g.code ?? `${route.code}-${g.date.slice(5, 7)}${g.date.slice(8, 10)}`, group: g.date, start, end: addDays(start, Math.max(days, 1) - 1) }
    })
  }, [route, f.how, f.first, f.last, f.every, f.paste, f.offset])

  const list = typeof rows === 'string' ? [] : rows
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!route || !list.length) return
    setBusy(true)
    setError(null)
    try {
      if (calc) {
        setCalcResults(await api<SeriesResult[]>(wsPath(ws.id, `/quotes/${calc.id}/departures`), {
          method: 'POST',
          body: { departures: list.map((x) => ({ code: x.code, start_date: x.start })), tourists: Number(f.tourists),
            singles: Number(f.singles) || 0, client_id: f.client_id || null, status: f.status },
        }))
        qc.invalidateQueries({ queryKey: ['tours', ws.id] })
        setBusy(false)
        return
      }
      const r = await api<Result[]>(wsPath(ws.id, '/tours/departures'), {
        method: 'POST',
        body: {
          series_id: route.id, departures: list.map((x) => ({ code: x.code, start_date: x.start })),
          client_id: f.client_id || null, pax: Number(f.pax) || 0, pax_estimated: !!f.pax && f.pax_estimated,
          rooms: f.rooms, status: f.status,
          ...(can(ws, 'operations', 'finance', 'sales') && f.price_pp ? { price_pp: f.price_pp, price_currency: f.price_currency } : {}),
        },
      })
      setResults(r)
      qc.invalidateQueries({ queryKey: ['tours', ws.id] })
    } catch (err) {
      setError(err)
    }
    setBusy(false)
  }

  if (calcResults) return <SeriesResults results={calcResults} onDone={onDone} />
  if (results) {
    const ok = results.filter((r) => r.tour_id).length
    return (
      <div className="space-y-4">
        <p className="text-sm font-medium">{t('departuresMade', { ok, total: results.length })}</p>
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
          {results.map((r, i) => (
            <li key={i} className="flex items-center gap-2 px-3 py-1.5">
              {r.tour_id ? <Check size={15} className="text-emerald-600" /> : <X size={15} className="text-red-600" />}
              {r.tour_id ? <Link to={`/w/${ws.id}/tours/${r.tour_id}`} className="font-mono font-medium hover:underline">{r.code}</Link> : <span className="font-mono">{r.code}</span>}
              <span className="text-slate-500">{fmt(r.start_date, lang)}</span>
              {r.error && <span className="text-red-700">{r.error}</span>}
            </li>
          ))}
        </ul>
        <div className="flex justify-end"><Button type="button" onClick={onDone}>{t('done')}</Button></div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {fixed ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm">{t('route')}: <b>{fixed.series_code}</b> · {t('calculation')}: <b>{fixed.name}</b></p> : (
      <Field label={t('route')}>
        <Select required value={f.series_id} onChange={(e) => setF({ ...f, series_id: e.target.value, quote_id: '' })}>
          <option value="">—</option>
          {series.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name} ({s.days.length} {t('daysWord')})</option>)}
        </Select>
      </Field>
      )}
      {!fixed && manager && calcs.length > 0 && (
        <Field label={t('calculation')} hint={t('depCalcHint')}>
          <Select value={f.quote_id} onChange={set('quote_id')}>
            <option value="">{t('depNoCalc')}</option>
            {calcs.map((q) => <option key={q.id} value={q.id}>{q.name} · {q.pax_min}–{q.pax_max} {t('pax').toLowerCase()}</option>)}
          </Select>
        </Field>
      )}
      {!fixed && (
        <DepartureGrid route={route} routes={series} vendors={vendors.data ?? []}
          onUse={(lines, offset) => setF((x) => ({ ...x, how: 'paste', paste: lines, offset: offset ? String(offset) : x.offset }))}
          onRoute={(id) => setF((x) => ({ ...x, series_id: id, quote_id: '' }))} />
      )}
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
        {(['repeat', 'paste'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setF({ ...f, how: k })}
            className={cn('flex-1 rounded-md py-1.5', f.how === k ? 'bg-white shadow-sm' : 'text-slate-500')}>{t(k === 'repeat' ? 'depRepeat' : 'depPaste')}</button>
        ))}
      </div>
      {f.how === 'repeat' ? (
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('depFirst')}><Input type="date" required value={f.first} onChange={set('first')} /></Field>
          <Field label={t('depLast')}><Input type="date" required min={f.first} value={f.last} onChange={set('last')} /></Field>
          <Field label={t('depEvery')}><Input type="number" min={1} max={60} value={f.every} onChange={set('every')} /></Field>
        </div>
      ) : (
        <>
        <Field label={t('depPasteLabel')} hint={t('depPasteHint')}>
          <textarea value={f.paste} onChange={set('paste')} rows={6} placeholder={'ZK-1025  2026-10-25\nZK-1101  2026-11-01\n…'}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-brand-600 focus:outline-none" />
        </Field>
        </>
      )}
      <Field label={t('depOffset')} hint={t('depOffsetHint')}>
        <Input type="number" min={1} max={30} value={f.offset} onChange={set('offset')} className="w-24" />
      </Field>

      {typeof rows === 'string' ? <p className="text-sm text-red-700">{t('depBadLine', { line: rows })}</p> : list.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-medium">{t('depPreview', { n: list.length })}</p>
          <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
            {list.map((r) => (
              <li key={r.code + r.group} className="flex gap-3 px-3 py-1.5 tabular-nums">
                <span className="w-24 font-mono font-medium">{r.code}</span>
                <span className="text-slate-500">{t('depGroup')} {fmt(r.group, lang)}</span>
                <span className="ml-auto">{fmt(r.start, lang)} – {fmt(r.end, lang)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {calc ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('tourists')} hint={t('depTouristsHint', { min: calc.pax_min, max: calc.pax_max, leaders: calc.leaders })}>
            <Input type="number" required min={calc.pax_min} max={calc.pax_max} value={f.tourists} onChange={set('tourists')} />
          </Field>
          <Field label={t('singlesBooked')}><Input type="number" min={0} value={f.singles} onChange={set('singles')} /></Field>
        </div>
      ) : (
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('pax')}><Input type="number" min={0} value={f.pax} onChange={set('pax')} placeholder={t('paxUnknownPh')} /></Field>
        <div className="col-span-2"><Field label={t('rooms')}><Input value={f.rooms} onChange={set('rooms')} placeholder={t('roomsPh')} /></Field></div>
        {!!f.pax && (
          <label className="col-span-3 -mt-1 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.pax_estimated} onChange={(e) => setF({ ...f, pax_estimated: e.target.checked })} />{t('paxApprox')}
          </label>
        )}
      </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('client')}>
          <Select value={f.client_id} onChange={set('client_id')}>
            <option value="">{t('noClientYet')}</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label={t('status')}>
          <Select value={f.status} onChange={set('status')}>
            <option value="inquiry">{t('status_inquiry')}</option>
            <option value="confirmed">{t('status_confirmed')}</option>
          </Select>
        </Field>
      </div>
      {manager && !calc && (
        <Field label={t('pricePerPerson')}>
          <div className="flex gap-2">
            <Input type="number" min={0} step="0.01" value={f.price_pp} onChange={set('price_pp')} placeholder="0.00" className="text-right" />
            <Select value={f.price_currency} onChange={set('price_currency')} className="w-28" aria-label={t('currency')}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </div>
        </Field>
      )}
      <ErrorText error={error} />
      <div className="flex justify-end gap-3">
        <Button type="submit" disabled={busy || !route || !list.length}>{t('depCreate', { n: list.length })}</Button>
      </div>
    </form>
  )
}
