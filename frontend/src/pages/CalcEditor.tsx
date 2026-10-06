import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask, askText, Dialog, Drawer, Menu, toast } from '../components/overlay'
import { AlertTriangle, Calculator, Check as CheckIcon, ChevronDown, CloudOff, Copy, Download, Eye, FileSpreadsheet, History, Layers, Loader2, Plus, Printer, Redo2, RefreshCw, Settings2, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Modal } from '../components/tour'
import { NbgButton } from '../components/money'
import { Button, Card, ErrorText, Field, FullPageSpinner, Input, Select, Spinner, IconButton, Chip, Textarea } from '../components/ui'
import {
  api, can, type PriceListData, type QuoteDoc, type QuoteOut, type QuoteResult, type QuoteStatus, type Tour,
} from '../lib/api'
import { useClients, useSeries, wsPath } from '../lib/data'
import { today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { ExplainPrice } from './calc/ExplainPrice'
import { HistoryModal } from './calc/HistoryModal'
import { ItemsTab } from './calc/ItemsTab'
import { HotelsTable } from './calc/HotelsTable'
import { BuildTab, PriceStrip, switchCurrency } from './calc/BuildTab'
import { ScenariosTab } from './calc/ScenariosTab'
import { FillFromRoute, UpdatePrices } from './calc/RouteTools'
import { ApplyToDepartures, type SeriesResult } from './calc/ApplyToDepartures'
import { DeparturesForm } from './NewDepartures'
import { useDebounced, useLeaveGuard } from '../lib/hooks'
import { UndoContext, useUndoDoc, type EditFn } from './calc/undo'
import { QuoteStatusPill } from './Calculations'
import { PageHeader } from './Dashboard'
import { CURRENCIES } from './Onboarding'

/**
 * Three places, in the order the work goes: Build the price (who travels, the trip, how we price - or the
 * same lines and hotels as tables), Compare it (every group size, season and what-if), Send it (the price
 * list for the client, the calculation file for the team). The calculation's details (name, route, client,
 * dates, currency, rates) open from the header; "Use this price" turns it into tours and departures.
 */
type Tab = 'build' | 'lines' | 'hotels' | 'compare' | 'send'
const TABS: [Tab, TKey][] = [['build', 'calcBuild'], ['lines', 'calcItems'], ['hotels', 'calcHotels'], ['compare', 'calcCompare'], ['send', 'calcSend']]
// Links saved before (bookmarks, other pages) still land in the right place.
const OLD_TABS: Record<string, [Tab]> = {
  settings: ['build'], items: ['lines'], prices: ['compare'], scenarios: ['compare'], pricelist: ['send'],
}

const strip = (q: QuoteOut): QuoteDoc => {
  const { id: _i, updated_at: _u, version: _v, result: _r, ...doc } = q
  return doc
}

export function CalcEditorPage() {
  const ws = useWorkspace()!
  const { quoteId } = useParams()
  const { t } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab') ?? 'build'
  const tab: Tab = OLD_TABS[rawTab]?.[0] ?? (TABS.some(([id]) => id === rawTab) ? rawTab as Tab : 'build')
  const [details, setDetails] = useState(rawTab === 'settings')
  useEffect(() => {
    const old = OLD_TABS[rawTab]
    if (old) setParams((p) => { p.set('tab', old[0]); return p }, { replace: true })
  }, [rawTab, setParams])
  const go = (next: { tab: Tab }) => setParams((p) => { p.set('tab', next.tab); return p }, { replace: true })
  const forTour = params.get('for_tour')   // opened from a tour ("Calculate the price")
  const url = wsPath(ws.id, `/quotes/${quoteId}`)
  const saved = useQuery({ queryKey: ['quote', ws.id, quoteId], queryFn: () => api<QuoteOut>(url) })
  const { doc, load: setDoc, edit: rawEdit, undo, redo, canUndo, canRedo } = useUndoDoc<QuoteDoc>()
  // A price the client already has (sent / accepted): changes save by themselves, so the first change asks
  // whether to change it or work on a copy. The change shows at once; only saving waits for the answer.
  // Once answered, this visit edits freely.
  const sentToClient = saved.data?.status === 'sent' || saved.data?.status === 'accepted'
  const [unlocked, setUnlocked] = useState(false)
  const [asking, setAsking] = useState(false)
  const before = useRef<QuoteDoc | null>(null)
  const edit: EditFn<QuoteDoc> = (fn, checkpoint) => {
    if (sentToClient && !unlocked && !asking) { before.current = doc; setAsking(true) }
    rawEdit(fn, checkpoint)
  }
  // What was last stored, as the editor holds it: changed since = not saved yet (saved by itself a moment later).
  const [savedJson, setSavedJson] = useState<string | null>(null)
  useEffect(() => {
    if (saved.data && !doc) { const d = strip(saved.data); setSavedJson(JSON.stringify(d)); setDoc(d) }
  }, [saved.data, doc, setDoc])
  const docJson = doc ? JSON.stringify(doc) : ''
  const dirty = !!doc && savedJson !== null && docJson !== savedJson
  const canSave = can(ws, 'operations', 'sales')

  // Live prices while editing; nothing is stored until Save.
  const debounced = useDebounced(doc)
  const preview = useQuery({
    queryKey: ['quotePreview', ws.id, JSON.stringify(debounced)], enabled: !!debounced,
    queryFn: () => api<QuoteResult>(wsPath(ws.id, '/quotes/preview'), { method: 'POST', body: debounced }),
    placeholderData: (prev) => prev,
  })
  const [history, setHistory] = useState(false)
  const [repricing, setRepricing] = useState(false)
  const open = saved.data && ['draft', 'sent'].includes(saved.data.status)
  const priceCheck = useQuery({
    queryKey: ['priceCheck', ws.id, quoteId, saved.data?.version], enabled: !!open,
    queryFn: () => api<{ changes: unknown[] }>(wsPath(ws.id, '/quotes/reprice'),
      { method: 'POST', body: { doc: strip(saved.data!), on_date: saved.data!.valid_from ?? today() } }),
    staleTime: 60_000, retry: false,
  })
  const [priceNoteOff, setPriceNoteOff] = useState(false)
  const moved = !dirty && !priceNoteOff ? priceCheck.data?.changes.length ?? 0 : 0
  // Problems found while building it from a route (missing prices…), passed on from the create dialog.
  const location = useLocation()
  const [notices, setNotices] = useState<string[]>((location.state as { notices?: string[] } | null)?.notices ?? [])
  // After a save, restore or applied scenario: the server's state becomes the editor's.
  const replaced = (q: QuoteOut) => {
    qc.setQueryData(['quote', ws.id, quoteId], q)
    setSavedJson(JSON.stringify(strip(q)))
    setDoc(strip(q))
    qc.invalidateQueries({ queryKey: ['quotes', ws.id] })
    qc.invalidateQueries({ queryKey: ['quoteVersions', ws.id, quoteId] })
    qc.invalidateQueries({ queryKey: ['compare', ws.id, quoteId] })
    qc.invalidateQueries({ queryKey: ['scenarios', ws.id, quoteId] })
  }
  // Saved by itself a moment after the last change (the server keeps one version per sitting); Ctrl+S saves
  // at once as a version of its own. The editor keeps what's on screen: typing on while it saves loses nothing.
  const save = useMutation({
    mutationFn: ({ body, auto }: { body: QuoteDoc; auto: boolean }) => api<QuoteOut>(`${url}${auto ? '?autosave=true' : ''}`, { method: 'PUT', body }),
    onSuccess: (q, { body }) => {
      setSavedJson(JSON.stringify(body))
      qc.setQueryData(['quote', ws.id, quoteId], q)
      qc.invalidateQueries({ queryKey: ['quotes', ws.id] })
      qc.invalidateQueries({ queryKey: ['quoteVersions', ws.id, quoteId] })
      qc.invalidateQueries({ queryKey: ['compare', ws.id, quoteId] })
    },
  })
  const failed = save.isError && !!save.variables && JSON.stringify(save.variables.body) === docJson
  useEffect(() => {
    if (!dirty || !canSave || save.isPending || failed || !doc || asking || (sentToClient && !unlocked)) return
    const h = setTimeout(() => save.mutate({ body: doc, auto: true }), 1200)
    return () => clearTimeout(h)
  }, [docJson, dirty, canSave, save.isPending, failed, asking, unlocked, sentToClient])   // eslint-disable-line react-hooks/exhaustive-deps
  const del = useMutation({
    mutationFn: () => api(url, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['quotes', ws.id] }); navigate(`/w/${ws.id}/calculations`) },
  })
  const copyWithChange = useMutation({
    mutationFn: async () => {
      const c = await api<QuoteOut>(wsPath(ws.id, '/quotes'), { method: 'POST', body: { copy_of: quoteId } })
      return api<QuoteOut>(wsPath(ws.id, `/quotes/${c.id}`), { method: 'PUT', body: { ...doc, name: c.name, status: 'draft' } })
    },
    onSuccess: (q) => { setAsking(false); qc.invalidateQueries({ queryKey: ['quotes', ws.id] }); setDoc(null); navigate(`/w/${ws.id}/calculations/${q.id}`) },
  })
  const copy = useMutation({
    // The copy starts from what's on screen: the last few changes are saved first.
    mutationFn: async () => {
      if (dirty && doc) await api<QuoteOut>(url, { method: 'PUT', body: doc })
      return api<QuoteOut>(wsPath(ws.id, '/quotes'), { method: 'POST', body: { copy_of: quoteId } })
    },
    onSuccess: (q) => { setDoc(null); navigate(`/w/${ws.id}/calculations/${q.id}`) },
  })
  useLeaveGuard(dirty, t('leaveUnsaved'), t('leaveUnsavedCalc'))
  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) undo and redo the calculation - text boxes keep their own; Ctrl+S saves.
  const keys = { undo, redo, save: () => { if (dirty && doc && canSave && !save.isPending) save.mutate({ body: doc, auto: false }) } }
  const keysRef = useRef(keys)
  useEffect(() => { keysRef.current = keys })
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 's') { e.preventDefault(); keysRef.current.save(); return }
      const typing = (e.target as HTMLElement).matches?.('input:not([type=checkbox]):not([type=range]), textarea, [contenteditable]')
      if (typing || (k !== 'z' && k !== 'y')) return
      e.preventDefault()
      if (k === 'y' || e.shiftKey) keysRef.current.redo(); else keysRef.current.undo()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  if (!doc) return <FullPageSpinner />
  const result = preview.data

  return (
    <>
      <PageHeader crumbs={[{ label: t('calculations'), to: `/w/${ws.id}/calculations` }]}
        title={<span className="flex flex-wrap items-center gap-3">
          {doc.name}<QuoteStatusPill status={doc.status} />
        </span>}
        action={<div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center">
            <IconButton size="lg" label={`${t('undo')} (Ctrl+Z)`} disabled={!canUndo} onClick={undo}><Undo2 size={18} /></IconButton>
            <IconButton size="lg" label={`${t('redo')} (Ctrl+Shift+Z)`} disabled={!canRedo} onClick={redo}><Redo2 size={18} /></IconButton>
          </span>
          <Button variant="secondary" onClick={() => setDetails(true)} title={t('calcDetailsHelp')}><Settings2 size={16} />{t('calcDetails')}</Button>
          {result && <UsePriceMenu doc={doc} quoteId={quoteId!} result={result} ready={!dirty && result.errors.length === 0} />}
          <Menu items={[
            { label: t('updatePrices'), icon: <RefreshCw size={16} />, onClick: () => setRepricing(true) },
            { label: t('duplicate'), icon: <Copy size={16} />, onClick: () => copy.mutate() },
            { label: t('delete'), icon: <Trash2 size={16} />, danger: true,
              onClick: () => void ask({ title: t('confirmDelete'), danger: true, confirmLabel: t('delete') }).then((ok) => ok && del.mutate()) },
          ]} />
          <SaveState state={!canSave ? 'readonly' : failed ? 'failed' : save.isPending ? 'saving' : dirty && (asking || (sentToClient && !unlocked)) ? 'held' : dirty ? 'saving' : 'saved'}
            onRetry={() => doc && save.mutate({ body: doc, auto: false })} onHistory={() => setHistory(true)} />
        </div>} />
      <div className="space-y-4 p-4 md:p-8">
        <ErrorText error={save.error} />
        {moved > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
            <RefreshCw size={16} className="shrink-0" />
            <span className="min-w-0 flex-1">{t('catalogPricesMoved', { n: moved })}</span>
            <Button size="sm" variant="secondary" onClick={() => setRepricing(true)}>{t('reviewPrices')}</Button>
            <IconButton size="sm" label={t('close')} onClick={() => setPriceNoteOff(true)}><X size={16} /></IconButton>
          </div>
        )}
        {notices.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="flex items-center gap-2 font-semibold"><AlertTriangle size={16} />{t('builtWithNotices')}
              <IconButton size="sm" label={t('cancel')} className="ml-auto" onClick={() => setNotices([])}><X size={16} /></IconButton></p>
            <ul className="mt-1 list-inside list-disc">{notices.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
        {result && result.errors.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <p className="flex items-center gap-2 font-semibold"><AlertTriangle size={16} />{t('calcErrors')}</p>
            <CalcRatesNeeded errors={result.errors} currency={doc.currency} onRate={(cur, perOne) => edit((d) => { d.fx = { ...d.fx, [cur]: perOne } })} />
            <ul className="mt-1 list-inside list-disc">{result.errors.filter((e) => !NO_RATE.test(e)).map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
        <ErrorText error={preview.error} />
        {forTour && <ForTourBar tourId={forTour} quoteId={quoteId!} ready={!dirty && !!result && result.errors.length === 0} />}
        <div className="border-b border-slate-200">
          <nav role="tablist" aria-label={doc.name} className="no-scrollbar -mb-px flex gap-1 overflow-x-auto">
            {TABS.map(([id, label]) => (
              <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => go({ tab: id })}
                className={cn('relative shrink-0 whitespace-nowrap px-4 py-2.5 text-sm font-semibold transition-colors duration-200 after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-brand-600 after:transition-transform after:duration-300 after:ease-[cubic-bezier(0.2,0,0,1)]',
                  tab === id ? 'text-brand-700 after:scale-x-100' : 'text-slate-500 after:scale-x-0 hover:text-slate-700')}>
                {t(label)}{id === 'lines' && ` · ${doc.items.length}`}{id === 'hotels' && ` · ${doc.nights.length}`}
              </button>
            ))}
          </nav>
        </div>
        <PriceStrip doc={doc} result={result} saved={saved.data?.result} dirty={dirty} wideHidden={tab === 'build'} />
        <UndoContext.Provider value={undo}>
        <div key={tab} className="animate-reveal">
        {tab === 'build' && <BuildTab doc={doc} debounced={debounced ?? doc} result={result} edit={edit} />}
        {tab === 'lines' && <ItemsTab doc={doc} debounced={debounced ?? doc} edit={edit} result={result} />}
        {tab === 'hotels' && <HotelsTable doc={doc} edit={edit} />}
        {tab === 'compare' && (
          <div className="space-y-8">
            <PricesTab doc={doc} result={result} />
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-800">{t('calcScenarios')}</h2>
              <ScenariosTab doc={doc} quoteId={quoteId!} dirty={dirty} onApplied={replaced} />
            </section>
          </div>
        )}
        {tab === 'send' && (
          <div className="space-y-8">
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-800">{t('sendPriceListTitle')}</h2>
              <PriceListTab doc={doc} edit={edit} quoteId={quoteId!} dirty={dirty} />
            </section>
            <CalcFileCard quoteId={quoteId!} disabled={dirty || !!result?.errors.length} />
          </div>
        )}
        </div>
        </UndoContext.Provider>
      </div>
      {asking && (
        <Dialog top title={t('sentGuardTitle', { status: t(`status_q_${saved.data?.status ?? 'sent'}` as TKey) })}
          onClose={() => { if (before.current) setDoc(before.current); setAsking(false) }}
          footer={<div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => { if (before.current) setDoc(before.current); setAsking(false) }}>{t('cancel')}</Button>
            <Button variant="secondary" disabled={copyWithChange.isPending} onClick={() => copyWithChange.mutate()}><Copy size={16} />{t('sentGuardCopy')}</Button>
            <Button onClick={() => { setUnlocked(true); setAsking(false) }}>{t('sentGuardChange')}</Button>
          </div>}>
          <p className="text-sm text-slate-600">{t('sentGuardText')}</p>
          <ErrorText error={copyWithChange.error} />
        </Dialog>
      )}
      {details && <DetailsDrawer doc={doc} edit={edit} onClose={() => setDetails(false)} />}
      {repricing && <UpdatePrices doc={doc} edit={edit} onClose={() => setRepricing(false)} />}
      {history && <HistoryModal quoteId={quoteId!} dirty={dirty} onRestored={replaced} onClose={() => setHistory(false)} />}
    </>
  )
}

type EditProps = { doc: QuoteDoc; edit: (fn: (d: QuoteDoc) => void) => void }

/** Where the saving is, in the header's corner: saving…, saved, not saved (try again), or view only. */
function SaveState({ state, onRetry, onHistory }: { state: 'saving' | 'saved' | 'held' | 'failed' | 'readonly'; onRetry: () => void; onHistory: () => void }) {
  const { t } = useI18n()
  return (
    <span aria-live="polite" title={state === 'readonly' ? undefined : t('autosaveTipHistory')}
      className={cn('inline-flex h-10 items-center gap-1.5 px-2 text-sm', state === 'failed' ? 'text-red-700' : 'text-slate-500')}>
      {state === 'saving' && <><Loader2 size={16} className="animate-spin" aria-hidden />{t('autosaveSaving')}</>}
      {state === 'held' && <><CloudOff size={16} aria-hidden />{t('autosaveHeld')}</>}
      {state === 'saved' && (
        <button type="button" onClick={onHistory} className="inline-flex h-8 items-center gap-1.5 rounded px-2 hover:bg-slate-100 hover:text-slate-800">
          <CheckIcon size={16} className="animate-check text-emerald-600" aria-hidden />{t('autosaveSaved')}<History size={14} aria-hidden /><span className="sr-only">· {t('history')}</span>
        </button>
      )}
      {state === 'readonly' && <button type="button" onClick={onHistory} className="inline-flex h-8 items-center gap-1.5 rounded px-2 hover:bg-slate-100"><Eye size={16} aria-hidden />{t('autosaveViewOnly')} · {t('history')}</button>}
      {state === 'failed' && <>
        <CloudOff size={16} aria-hidden />{t('autosaveFailed')}
        <Button size="sm" variant="secondary" onClick={onRetry}>{t('autosaveRetry')}</Button>
      </>}
    </span>
  )
}

// --- details --------------------------------------------------------------------------

/** What the calculation is about (name, route, client, dates, currency, rates) - set once, out of the way
 * of the building. Who travels and the profit are on Build. */
function DetailsDrawer({ doc, edit, onClose }: EditProps & { onClose: () => void }) {
  const { t } = useI18n()
  const series = useSeries()
  const clients = useClients()
  const [filling, setFilling] = useState(false)
  const num = (v: string) => (v === '' ? 0 : Number(v))
  return (
    <Drawer title={t('calcDetails')} subtitle={t('calcDetailsHelp')} onClose={onClose} size="md"
      footer={<div className="flex w-full justify-end"><Button onClick={onClose}>{t('done')}</Button></div>}>
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label={t('name')}><Input value={doc.name} onChange={(e) => edit((d) => { d.name = e.target.value })} /></Field></div>
        <Field label={t('status')}>
          <Select value={doc.status} onChange={(e) => edit((d) => { d.status = e.target.value as QuoteStatus })}>
            {(['draft', 'sent', 'accepted', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`status_q_${s}` as TKey)}</option>)}
          </Select>
        </Field>
        <Field label={t('currency')}>
          <Select value={doc.currency} onChange={async (e) => {
            const to = e.target.value
            // The rate the calculation already has (1 GEL = 0.37 USD), else ask once.
            let rate = Number(doc.fx[to])
            if (!rate) {
              const typed = await askText({ title: t('currencyRateAsk', { from: doc.currency, to }), message: t('currencyRateHelp'), input: { placeholder: '0.37', required: true } })
              rate = Number((typed ?? '').replace(',', '.'))
              if (!(rate > 0)) return
            }
            edit((d) => switchCurrency(d, to, rate))
            toast('currencySwitched')
          }}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
        </Field>
        <div className="sm:col-span-2"><Field label={t('route')}>
          <div className="flex flex-wrap gap-2">
            <Select value={doc.series_id ?? ''} onChange={(e) => edit((d) => { d.series_id = e.target.value || null })} className="min-w-0 flex-1">
              <option value="">—</option>
              {series.data?.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </Select>
            {doc.series_id && <Button type="button" variant="secondary" title={t('fillFromRouteHelp')} onClick={() => setFilling(true)}><Layers size={16} />{t('fillFromRoute')}</Button>}
          </div>
        </Field></div>
        <div className="sm:col-span-2"><Field label={t('client')}>
          <Select value={doc.client_id ?? ''} onChange={(e) => edit((d) => { d.client_id = e.target.value || null })}>
            <option value="">—</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field></div>
        <Field label={`${t('dates')} ·  ${t('dateFrom').toLowerCase()}`}><Input type="date" value={doc.valid_from ?? ''} onChange={(e) => edit((d) => { d.valid_from = e.target.value || null })} /></Field>
        <Field label={t('dateTo')}><Input type="date" value={doc.valid_to ?? ''} onChange={(e) => edit((d) => { d.valid_to = e.target.value || null })} /></Field>
        <Field label={t('days')}><Input type="number" min={1} max={60} value={doc.days} onChange={(e) => edit((d) => { d.days = num(e.target.value) })} /></Field>
        <Field label={t('groupSizes')}>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} value={doc.pax_min} onChange={(e) => edit((d) => { d.pax_min = num(e.target.value) })} />–
            <Input type="number" min={1} value={doc.pax_max} onChange={(e) => edit((d) => { d.pax_max = num(e.target.value) })} />
          </div>
        </Field>
      </div>
        <KeyValues title={t('exchangeRates')} hint={t('fxHelp', { cur: doc.currency, ex: doc.currency === 'USD' ? 'GEL' : 'USD', rate: doc.currency === 'USD' ? '2.70' : doc.currency === 'GEL' ? '0.37' : '1.08' })} values={doc.fx} keyPlaceholder="GEL"
          normalizeKey={(k) => k.toUpperCase().slice(0, 3)} onChange={(fx) => edit((d) => { d.fx = fx })} />
      <Field label={t('notes')}><Textarea rows={3} value={doc.notes} onChange={(e) => edit((d) => { d.notes = e.target.value })} /></Field>
      {filling && <FillFromRoute doc={doc} edit={edit} onClose={() => setFilling(false)} />}
    </div>
    </Drawer>
  )
}

function KeyValues({ title, hint, values, notes, keyPlaceholder, normalizeKey, onChange }: {
  title: string; hint: string; values: Record<string, string>; notes?: Record<string, string>; keyPlaceholder: string
  normalizeKey: (k: string) => string; onChange: (v: Record<string, string>, notes: Record<string, string>) => void
}) {
  const { t } = useI18n()
  // Edit as a list so renaming a key doesn't reorder or lose rows mid-typing.
  type Row = [string, string, string]
  const [rows, setRows] = useState<Row[]>(() => Object.entries(values).map(([k, v]) => [k, v, notes?.[k] ?? '']))
  const push = (next: Row[]) => {
    setRows(next)
    const kept = next.filter(([k]) => k)
    onChange(Object.fromEntries(kept.map(([k, v]) => [k, v])), Object.fromEntries(kept.filter((r) => r[2]).map(([k, , n]) => [k, n])))
  }
  return (
    <Card className="p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">{hint}</p>
      <div className="space-y-2">
        {rows.map(([k, v, n], i) => (
          <div key={i} className="flex flex-wrap gap-2 sm:flex-nowrap">
            <Input value={k} placeholder={keyPlaceholder} className="font-mono sm:w-48" onChange={(e) => push(rows.map((r, j) => (j === i ? [normalizeKey(e.target.value), r[1], r[2]] : r)))} />
            <Input type="number" step="any" value={v} className="w-28 text-right" onChange={(e) => push(rows.map((r, j) => (j === i ? [r[0], e.target.value, r[2]] : r)))} />
            {notes && <Input value={n} placeholder={t('variableNote')} className="min-w-0 flex-1" onChange={(e) => push(rows.map((r, j) => (j === i ? [r[0], r[1], e.target.value] : r)))} />}
            <IconButton label={t('remove')} tone="danger" onClick={() => push(rows.filter((_, j) => j !== i))}><X size={16} /></IconButton>
          </div>
        ))}
      </div>
      <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => setRows([...rows, ['', '0', '']])}><Plus size={16} />{t('add')}</Button>
    </Card>
  )
}

// --- prices --------------------------------------------------------------------------------

function PricesTab({ doc, result }: { doc: QuoteDoc; result?: QuoteResult }) {
  const { t } = useI18n()
  const [open, setOpen] = useState<number | null>(null)
  const [season, setSeason] = useState('')
  if (!result) return <div className="flex justify-center py-10"><Spinner /></div>
  const tiers = (season ? result.seasons?.find((x) => x.id === season)?.tiers : undefined) ?? result.tiers
  const trp = tiers.some((x) => x.price_trp !== null)
  const quad = tiers.some((x) => x.price_quad != null)
  const kinds = [...new Map(tiers.flatMap((x) => (x.types ?? []).slice(1).map((k) => [k.id, k.name] as const))).entries()]
  const curs = [...new Set(tiers.flatMap((x) => (x.other ?? []).map((o) => o.currency)))]
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500">{t('hotelsPerPerson')}: <b className="text-slate-900">{money(result.hotel_dbl_pp, doc.currency)}</b> · {result.nights_priced} {t('nights')}</span>
      </div>
      {(result.seasons?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {[{ id: '', name: t('basePrices') }, ...result.seasons!].map((sn) => (
            <Chip key={sn.id} on={season === sn.id} onClick={() => setSeason(sn.id)}>{sn.name}</Chip>
          ))}
        </div>
      )}
      {result.errors.length > 0 && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">{t('fixErrorsForPrice')}</p>}
      <p className="text-sm text-slate-500">{t('pricesInPerPerson', { cur: doc.currency })}</p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-right text-xs font-medium text-slate-500">
            <tr>
              <th className="px-4 py-3 text-left">{t('groupSizes')}</th><th className="px-4 py-3">{t('costPp')}</th>
              <th className="px-4 py-3" title={t('addedPpHelp')}>{t('addedPp')}</th><th className="px-4 py-3 text-brand-700">{t('priceDbl')}</th>
              <th className="px-4 py-3">{t('priceSgl')}</th><th className="px-4 py-3">{t('supplement')}</th>
              {trp && <th className="px-4 py-3">{t('priceTrp')}</th>}
              {quad && <th className="px-4 py-3">{t('roomQuad')}</th>}
              {kinds.map(([id, name]) => <th key={id} className="px-4 py-3">{name}</th>)}
              {curs.map((c) => <th key={c} className="px-4 py-3">{t('priceDbl')} · {c}</th>)}
              <th className="px-4 py-3 text-left">{t('vehicle')}</th><th className="px-4 py-3">{t('groupCost')}</th><th className="px-4 py-3">{t('groupRevenue')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-right tabular-nums">
            {tiers.map((r) => (
              <tr key={r.tourists} onClick={() => setOpen(r.tourists)} className="cursor-pointer hover:bg-slate-50">
                <td className="px-4 py-2 text-left font-semibold">{r.label}</td>
                <td className="px-4 py-2 text-slate-500">{money(r.cost_dbl)}</td>
                <td className="px-4 py-2 text-emerald-700">{money(r.profit_pp)}</td>
                <td className="px-4 py-2 text-base font-semibold text-brand-700">{money(r.price_dbl)}</td>
                <td className="px-4 py-2 font-semibold">{money(r.price_sgl)}</td>
                <td className="px-4 py-2 text-slate-500">{money(r.single_supplement)}</td>
                {trp && <td className="px-4 py-2">{r.price_trp !== null ? money(r.price_trp) : '—'}</td>}
                {quad && <td className="px-4 py-2">{r.price_quad != null ? money(r.price_quad) : '—'}</td>}
                {kinds.map(([id]) => { const k = r.types?.find((x) => x.id === id); return <td key={id} className="px-4 py-2 font-semibold">{k ? money(k.price) : '—'}</td> })}
                {curs.map((c) => { const o = r.other?.find((x) => x.currency === c); return <td key={c} className="px-4 py-2">{o ? money(o.price_dbl) : '—'}</td> })}
                <td className="px-4 py-2 text-left text-slate-600">{r.vehicle}</td>
                <td className="px-4 py-2 text-slate-500">{money(r.group_cost)}</td>
                <td className="px-4 py-2 text-slate-500">{money(r.group_revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open !== null && <ExplainPrice doc={doc} tourists={open} season={season} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** Where the price goes next, in one place: a new tour, new departures of the route, or departures that exist. */
function UsePriceMenu({ doc, quoteId, result, ready }: { doc: QuoteDoc; quoteId: string; result: QuoteResult; ready: boolean }) {
  const { t } = useI18n()
  const routes = useSeries()
  const [creating, setCreating] = useState(false)
  const [seriesMode, setSeriesMode] = useState<'create' | 'apply' | null>(null)
  return (
    <>
      <Menu label={t('useThisPrice')}
        triggerClassName="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
        trigger={<><CheckIcon size={16} />{t('useThisPrice')}<ChevronDown size={16} className="text-slate-500" /></>}
        items={[
          { label: t('useThisPriceSaveFirst'), icon: <AlertTriangle size={16} />, disabled: true, hidden: ready, onClick: () => {} },
          { label: t('createTour'), icon: <Plus size={16} />, disabled: !ready, onClick: () => setCreating(true) },
          { label: t('createDepartures'), icon: <Plus size={16} />, disabled: !ready, hidden: !doc.series_id, onClick: () => setSeriesMode('create') },
          { label: t('applyToDepartures'), icon: <RefreshCw size={16} />, disabled: !ready, hidden: !doc.series_id, onClick: () => setSeriesMode('apply') },
        ]} />
      {creating && <CreateTourModal doc={doc} quoteId={quoteId} result={result} onClose={() => setCreating(false)} />}
      {seriesMode === 'apply' && <ApplyToDepartures quoteId={quoteId} doc={doc} onClose={() => setSeriesMode(null)} />}
      {seriesMode === 'create' && (
        <Modal wide title={t('createDepartures')} onClose={() => setSeriesMode(null)}>
          <DeparturesForm series={routes.data ?? []} quoteId={quoteId} onDone={() => setSeriesMode(null)} />
        </Modal>
      )}
    </>
  )
}

/** The calculation as an Excel file (every line and formula), at the group size being looked at. */
function CalcFileCard({ quoteId, disabled }: { quoteId: string; disabled: boolean }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const [params] = useSearchParams()
  const n = Number(params.get('n')) || 19
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-800">{t('sendCalcTitle')}</h2>
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <FileSpreadsheet size={20} className="shrink-0 text-emerald-700" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-slate-600">{t('sendCalcHelp')}</p>
        {disabled ? <Button variant="secondary" disabled title={t('downloadCalcSaveFirst')}><Download size={16} />{t('downloadCalc')}</Button> : (
          <a href={`/api${wsPath(ws.id, `/quotes/${quoteId}/calculation.xlsx?lang=${lang === 'ka' ? 'ka' : 'en'}&tourists=${n}`)}`} download
            className="inline-flex h-10 items-center gap-2 rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100">
            <Download size={16} />{t('downloadCalc')}
          </a>
        )}
      </Card>
    </section>
  )
}

function CreateTourModal({ doc, quoteId, result, onClose }: { doc: QuoteDoc; quoteId: string; result: QuoteResult; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const navigate = useNavigate()
  const clients = useClients()
  const [f, setF] = useState({
    tourists: Math.min(Math.max(19, doc.pax_min), doc.pax_max), start_date: today(), client_id: doc.client_id ?? '',
    code: '', singles: 0, with_invoice: true,
  })
  // Priced in the season the tour travels (the server does the same).
  const inSeason = doc.seasons?.find((sn) => (sn.from_date || sn.to_date) && (!sn.from_date || sn.from_date <= f.start_date) && (!sn.to_date || f.start_date <= sn.to_date))
  const tiers = (inSeason ? result.seasons?.find((x) => x.id === inSeason.id)?.tiers : undefined) ?? result.tiers
  const tier = tiers.find((x) => x.tourists === f.tourists)
  const others = (tier?.types ?? []).slice(1).filter((x) => x.count > 0)
  const create = useMutation({
    mutationFn: () => api<{ tour_id: string; tour_code: string; hotel_changes: string[]; warnings: string[] }>(wsPath(ws.id, `/quotes/${quoteId}/create-tour`), {
      method: 'POST', body: { ...f, client_id: f.client_id || null, code: f.code || null },
    }),
    onSuccess: (r) => { if (!r.hotel_changes.length && !r.warnings.length) navigate(`/w/${ws.id}/tours/${r.tour_id}`) },
  })
  const made = create.data
  if (made && (made.hotel_changes.length || made.warnings.length)) {
    return (
      <Modal title={t('tourCreatedCode', { code: made.tour_code })} onClose={() => navigate(`/w/${ws.id}/tours/${made.tour_id}`)}>
        <div className="space-y-4 text-sm">
          {made.hotel_changes.length > 0 && (
            <div>
              <p className="font-medium text-slate-800">{t('hotelsFromCalc')}</p>
              <ul className="mt-1 list-inside list-disc text-slate-600">{made.hotel_changes.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
          {made.warnings.length > 0 && (
            <ul className="list-inside list-disc rounded-lg bg-amber-50 px-3 py-2 text-amber-900">{made.warnings.map((x) => <li key={x}>{x}</li>)}</ul>
          )}
          <div className="flex justify-end">
            <Button onClick={() => navigate(`/w/${ws.id}/tours/${made.tour_id}`)}>{t('openTour')}</Button>
          </div>
        </div>
      </Modal>
    )
  }
  return (
    <Modal title={t('createTour')} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="space-y-4">
        <p className="text-sm text-slate-600">{t('createTourHelp')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('tourists')}>
            <Select value={f.tourists} onChange={(e) => setF({ ...f, tourists: Number(e.target.value) })}>
              {tiers.map((x) => <option key={x.tourists} value={x.tourists}>{x.label} · {money(x.price_dbl, doc.currency)}</option>)}
            </Select>
          </Field>
          <Field label={t('singlesBooked')}><Input type="number" min={0} max={f.tourists} value={f.singles} onChange={(e) => setF({ ...f, singles: Number(e.target.value) || 0 })} /></Field>
          <Field label={t('startDate')}><Input type="date" required value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
          <Field label={t('tourCode')} hint={t('codeAuto')}><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="font-mono uppercase" /></Field>
        </div>
        <Field label={t('client')}>
          <Select value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })}>
            <option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.with_invoice} disabled={!f.client_id} onChange={(e) => setF({ ...f, with_invoice: e.target.checked })} />{t('withInvoice')}</label>
        {tier && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
            {inSeason && <span className="mr-1 rounded bg-amber-100 px-1.5 text-xs text-amber-900">{inSeason.name}</span>}
            {f.tourists} × {money(tier.price_dbl, doc.currency)}{f.singles > 0 && ` + ${f.singles} × ${money(tier.single_supplement, doc.currency)}`}
            {others.map((x) => ` + ${x.count} × ${money(x.price)} (${x.name})`).join('')}
            {' = '}<b>{money(f.tourists * tier.price_dbl + f.singles * tier.single_supplement + others.reduce((s, x) => s + x.count * x.price, 0), doc.currency)}</b>
          </p>
        )}
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={create.isPending}>{t('createTour')}</Button>
        </div>
      </form>
    </Modal>
  )
}

// --- price list ------------------------------------------------------------------------------

const TEXT_KEYS: [string, TKey][] = [['title', 'plTitle'], ['meals', 'plMeals'], ['included', 'plIncluded'], ['not_included', 'plNotIncluded'], ['notes', 'plNotes']]
const LABEL_KEYS = ['col_group', 'col_dbl', 'col_sgl', 'col_supplement', 'col_vehicle', 'col_city', 'col_hotel']

function PriceListTab({ doc, edit, quoteId, dirty }: EditProps & { quoteId: string; dirty: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [lang, setLang] = useState(doc.languages[0] ?? 'en')
  const [newLang, setNewLang] = useState('')
  const texts = doc.texts[lang] ?? {}
  const setText = (k: string, v: string) => edit((d) => { d.texts[lang] = { ...(d.texts[lang] ?? {}), [k]: v } })
  const addLang = () => {
    const code = newLang.trim().toLowerCase()
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(code) || doc.languages.includes(code)) return
    edit((d) => { d.languages.push(code); d.texts[code] = { ...(d.texts.en ?? {}) } })
    setLang(code)
    setNewLang('')
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">{t('languagesHelp')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {doc.languages.map((l) => (
          <span key={l} className="inline-flex items-center gap-1">
            <Chip on={l === lang} onClick={() => setLang(l)}><span className="uppercase">{l}</span></Chip>
            {doc.languages.length > 1 && <IconButton size="sm" label={`${t('remove')} ${l.toUpperCase()}`} tone="danger" onClick={() => { edit((d) => { d.languages = d.languages.filter((x) => x !== l) }); if (l === lang) setLang(doc.languages.find((x) => x !== l) ?? 'en') }}><X size={16} /></IconButton>}
          </span>
        ))}
        <Input size="sm" value={newLang} onChange={(e) => setNewLang(e.target.value)} placeholder="ru" className="w-20" onKeyDown={(e) => e.key === 'Enter' && addLang()} />
        <Button size="sm" variant="secondary" onClick={addLang}><Plus size={16} />{t('addLanguage')}</Button>
        <div className="flex-1" />
        <a href={`/w/${ws.id}/print/quote/${quoteId}?lang=${lang}`} target="_blank" rel="noreferrer"
          className={cn('inline-flex h-8 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50', dirty && 'pointer-events-none opacity-50')}>
          <Printer size={16} />{t('printPdf')}
        </a>
        <a href={`/api${wsPath(ws.id, `/quotes/${quoteId}/price-list.xlsx?lang=${lang}`)}`} download
          className={cn('inline-flex h-8 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50', dirty && 'pointer-events-none opacity-50')}>
          <Download size={16} />{t('downloadExcel')}
        </a>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex-1 font-semibold">{t('plTexts')}</h3>
          <Button size="sm" variant="secondary" onClick={() => {
            const filled = autoTexts(doc, lang)
            edit((d) => { d.texts[lang] = { ...filled, ...Object.fromEntries(Object.entries(d.texts[lang] ?? {}).filter(([, v]) => v)) } })
            toast('plFilled')
          }}><Sparkles size={16} />{t('plFillFromCalc')}</Button>
        </div>
        {TEXT_KEYS.map(([k, label]) => (
          <Field key={k} label={t(label)}>
            {k === 'title' ? <Input value={texts[k] ?? ''} onChange={(e) => setText(k, e.target.value)} />
              : <Textarea value={texts[k] ?? ''} onChange={(e) => setText(k, e.target.value)} rows={2} />}
          </Field>
        ))}
      </Card>
      <details className="rounded-xl border border-slate-200 bg-white p-5">
        <summary className="cursor-pointer text-sm font-semibold">{t('plLabels')}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {LABEL_KEYS.map((k) => (
            <Field key={k} label={t(`pl_${k}` as Parameters<typeof t>[0])}><Input value={texts[k] ?? ''} placeholder="—" onChange={(e) => setText(k, e.target.value)} /></Field>
          ))}
        </div>
      </details>
      </div>
      <PriceListPreview quoteId={quoteId} lang={lang} dirty={dirty} />
      </div>
    </div>
  )
}

/** What the partner will get, as it is saved: the tables per season and currency, and the extras. */
function PriceListPreview({ quoteId, lang, dirty }: { quoteId: string; lang: string; dirty: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const pl = useQuery({
    queryKey: ['priceListPreview', ws.id, quoteId, lang, dirty],
    queryFn: () => api<PriceListData>(wsPath(ws.id, `/quotes/${quoteId}/price-list?lang=${lang}`)),
  })
  const d = pl.data
  return (
    <Card className="self-start overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <span className="font-semibold">{t('plPreview')}</span>
        {dirty && <span className="text-xs text-amber-700">{t('plPreviewSaved')}</span>}
      </div>
      {!d ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <div className="space-y-4 p-4 text-sm">
          <div>
            <p className="text-lg font-semibold">{d.title}</p>
            <p className="text-slate-500">{d.labels.currency?.replace('{currency}', d.currency)}</p>
          </div>
          {d.errors.length > 0 && <p className="rounded bg-red-50 px-3 py-2 text-red-800">{t('fixErrorsForPrice')}</p>}
          {(d.sections ?? []).map((sec, i) => (
            <div key={i} className="overflow-x-auto">
              {sec.title && <p className="mb-1 font-semibold">{sec.title}</p>}
              <table className="w-full text-xs">
                <thead><tr className="bg-slate-800 text-left text-white">{sec.columns.map((c, j) => <th key={j} className="px-2 py-1.5 font-semibold">{c}</th>)}</tr></thead>
                <tbody>
                  {sec.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-slate-200 even:bg-slate-50">
                      {row.map((x, j) => <td key={j} className={cn('px-2 py-1', j > 0 && j < row.length - 1 && 'text-right tabular-nums')}>{typeof x === 'number' ? money(x) : x ?? '—'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {(d.extras?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 font-semibold">{d.labels.extras}</p>
              <ul>{d.extras!.map((x) => <li key={x.name} className="flex justify-between border-b border-slate-200 py-0.5"><span>{x.name}</span><span className="tabular-nums">{x.from === x.to ? money(x.from) : `${money(x.from)}–${money(x.to)}`}</span></li>)}</ul>
            </div>
          )}
          {(['meals', 'included', 'not_included'] as const).filter((k) => d.texts[k]).map((k) => (
            <div key={k}><p className="font-semibold text-slate-500">{d.labels[k]}</p><p className="whitespace-pre-line">{d.texts[k]}</p></div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** Price-list texts from what the calculation contains, in the list's language (English otherwise). */
function autoTexts(doc: QuoteDoc, lang: string): Record<string, string> {
  const ka = lang === 'ka'
  const inc = doc.items.filter((i) => i.included)
  const has = (c: string) => inc.some((i) => i.category === c && !i.travel && !i.kind)
  const tickets = inc.filter((i) => i.travel).map((i) => {
    const legs = i.travel!.legs.filter((l) => l.from_place || l.to_place).map((l) => `${l.from_place} → ${l.to_place}`).join(', ')
    const word = ka ? ({ flight: 'ავიაბილეთი', train: 'მატარებლის ბილეთი', ferry: 'ბორანი', coach: 'ავტობუსის ბილეთი', other: 'ბილეთი' }[i.travel!.mode])
      : ({ flight: 'Flight', train: 'Train', ferry: 'Ferry', coach: 'Coach', other: 'Ticket' }[i.travel!.mode])
    const more = [Number(i.travel!.taxes) ? (ka ? 'მოსაკრებლებით' : 'taxes included') : '', i.travel!.baggage].filter(Boolean).join(', ')
    return `${word}${legs ? ` ${legs}` : ''}${more ? ` (${more})` : ''}`
  })
  const own = inc.filter((i) => i.kind && !i.travel).map((i) => i.name)
  const meals = inc.filter((i) => i.category === 'meal')
  const lunches = meals.filter((i) => /^(lunch|სადილი)/i.test(i.name)).length
  const dinners = meals.filter((i) => /^(dinner|ვახშამი)/i.test(i.name)).length
  const nights = doc.nights.filter((n) => n.price_dbl !== null).length
  const included = [
    nights ? (ka ? `${nights} ღამე სასტუმროებში (ორადგილიანი ნომრები, საუზმით)` : `${nights} nights in hotels (double rooms, breakfast)`) : '',
    meals.length ? (ka ? 'კვება პროგრამის მიხედვით' : 'Meals as in the programme') : '',
    has('transport') || doc.transport ? (ka ? 'ტრანსპორტი მთელი ტურის განმავლობაში' : 'Transport for the whole tour') : '',
    has('guide') ? (ka ? 'გიდის მომსახურება' : 'Guide services') : '',
    has('ticket') || has('activity') ? (ka ? 'შესასვლელი ბილეთები პროგრამის მიხედვით' : 'Entrance tickets as in the programme') : '',
    has('tips') ? (ka ? 'ჩაის ფული' : 'Tips') : '',
    ...tickets, ...own,
  ].filter(Boolean).join('\n')
  const extras = doc.items.filter((i) => i.optional && !i.included).map((i) => i.name)
  return {
    title: doc.name,
    meals: lunches || dinners
      ? (ka ? `${lunches} სადილი და ${dinners} ვახშამი` : `${lunches} lunches and ${dinners} dinners`)
      : meals.length ? (ka ? `${meals.length} კვება` : `${meals.length} meals`) : '',
    included,
    not_included: [...extras, ka ? 'ავიაბილეთები, ვიზები, პირადი ხარჯები' : 'Flights, visas, personal expenses'].join('\n'),
  }
}

const NO_RATE = /no exchange rate for ([A-Z]{3})/

/** "No exchange rate for USD" on ten lines is one missing rate: ask for it once, the way people
 * say it ("1 USD = 2.70 GEL"), or take the National Bank's. The calculation keeps it as
 * 1 GEL = 0.37 USD (its own currency first). */
/** Opened from a tour: give it this calculation's price (its group's tier) and budget, then go back to it. */
function ForTourBar({ tourId, quoteId, ready }: { tourId: string; quoteId: string; ready: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const tour = useQuery({ queryKey: ['tour', ws.id, tourId], queryFn: () => api<Tour>(wsPath(ws.id, `/tours/${tourId}`)) })
  const [notes, setNotes] = useState<string[]>([])
  const apply = useMutation({
    mutationFn: () => api<SeriesResult[]>(wsPath(ws.id, `/quotes/${quoteId}/apply`), { method: 'POST', body: { tour_ids: [tourId] } }),
    onSuccess: (res) => {
      const r = res[0]
      if (r?.error) { setNotes([r.error]); return }
      for (const k of ['tour', 'tours', 'profit', 'budget']) qc.invalidateQueries({ queryKey: [k, ws.id] })
      navigate(`/w/${ws.id}/tours/${tourId}?tab=costs`)
    },
  })
  const code = tour.data?.code ?? '…'
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-900">
      <Calculator size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {t('forTourCalc')} <Link to={`/w/${ws.id}/tours/${tourId}`} className="font-mono font-semibold hover:underline">{code}</Link>
        {!ready && <span className="ml-2 opacity-80">· {t('forTourSaveFirst')}</span>}
      </span>
      <Button size="sm" disabled={!ready || apply.isPending} onClick={() => apply.mutate()}><CheckIcon size={16} />{t('useForTour')}</Button>
      {notes.length > 0 && <ul className="w-full list-inside list-disc text-red-700">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {apply.error != null && <div className="w-full"><ErrorText error={apply.error} /></div>}
    </div>
  )
}

function CalcRatesNeeded({ errors, currency, onRate }: { errors: string[]; currency: string; onRate: (cur: string, perOne: string) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const counts = new Map<string, number>()
  for (const e of errors) { const m = e.match(NO_RATE); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1) }
  const [typed, setTyped] = useState<Record<string, string>>({})
  if (!counts.size) return null
  const set = (cur: string, inBase: number) => { if (inBase > 0) onRate(cur, (1 / inBase).toFixed(6)) }
  return (
    <div className="mt-2 space-y-2 rounded-md bg-white/70 p-2.5 text-slate-800">
      {[...counts].map(([cur, n]) => (
        <form key={cur} className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); set(cur, Number(typed[cur])) }}>
          <span className="font-medium">{t('calcNoRate', { cur, n })}</span>
          <span className="tabular-nums">1 {cur} =</span>
          <Input size="sm" type="number" min={0} step="0.0001" className="w-28 text-right" aria-label={`1 ${cur} = ? ${currency}`}
      value={typed[cur] ?? ''} onChange={(e) => setTyped({ ...typed, [cur]: e.target.value })} />
          <span>{currency}</span>
          <Button type="submit" size="sm" disabled={!(Number(typed[cur]) > 0)}>{t('use')}</Button>
        </form>
      ))}
      {currency === ws.base_currency && (
        <NbgButton currencies={[...counts.keys()]} onRates={(rates) => {
          setTyped(Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, String(v)])))
          for (const [k, v] of Object.entries(rates)) set(k, v)
        }} />
      )}
    </div>
  )
}

