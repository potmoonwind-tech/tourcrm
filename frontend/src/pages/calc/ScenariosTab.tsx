import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Drawer, ask } from '../../components/overlay'
import { AlertTriangle, CheckCircle2, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '../../components/tour'
import { Button, Card, ErrorText, Field, Input, Select } from '../../components/ui'
import {
  api, type CompareOut, type QuoteDoc, type QuoteOut, type Scenario, type ScenarioPatch, type ScenarioResult,
} from '../../lib/api'
import { wsPath } from '../../lib/data'
import { useDebounced } from '../../lib/hooks'
import { useI18n, type TKey } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn, money } from '../../lib/utils'
import { ChangeList } from './changes'

const emptyPatch = (): ScenarioPatch => ({ settings: {}, variables: {}, fx: {}, items: {}, nights: {} })

/** What-if variants of the saved calculation, priced side by side. */
export function ScenariosTab({ doc, quoteId, dirty, onApplied }: {
  doc: QuoteDoc; quoteId: string; dirty: boolean; onApplied: (q: QuoteOut) => void
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const base = wsPath(ws.id, `/quotes/${quoteId}`)
  const scenarios = useQuery({ queryKey: ['scenarios', ws.id, quoteId], queryFn: () => api<Scenario[]>(`${base}/scenarios`) })
  const cmp = useQuery({ queryKey: ['compare', ws.id, quoteId], queryFn: () => api<CompareOut>(`${base}/compare`) })
  const [editing, setEditing] = useState<Scenario | 'new' | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['scenarios', ws.id, quoteId] })
    qc.invalidateQueries({ queryKey: ['compare', ws.id, quoteId] })
  }
  const del = useMutation({ mutationFn: (id: string) => api(`${base}/scenarios/${id}`, { method: 'DELETE' }), onSuccess: refresh })
  const apply = useMutation({
    mutationFn: (id: string) => api<QuoteOut>(`${base}/scenarios/${id}/apply`, { method: 'POST' }),
    onSuccess: (q) => { onApplied(q); refresh(); qc.invalidateQueries({ queryKey: ['quoteVersions', ws.id, quoteId] }) },
  })
  const separate = useMutation({
    mutationFn: (sc: Scenario) => api<QuoteOut>(wsPath(ws.id, '/quotes'), {
      method: 'POST', body: { copy_of: quoteId, scenario_id: sc.id, name: `${doc.name} · ${sc.name}` },
    }),
    onSuccess: (q) => { qc.invalidateQueries({ queryKey: ['quotes', ws.id] }); navigate(`/w/${ws.id}/calculations/${q.id}`) },
  })

  if (dirty) return <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">{t('saveFirstScenarios')}</p>
  const list = scenarios.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-slate-500">{t('scenariosHelp')}</p>
        <Button variant="secondary" onClick={() => setEditing('new')}><Plus size={16} />{t('newScenario')}</Button>
      </div>
      <ErrorText error={apply.error || separate.error || del.error} />

      {scenarios.isSuccess && list.length === 0 ? (
        <EmptyState title={t('noScenarios')} hint={t('noScenariosHint')} />
      ) : (
        <>
          {cmp.data && <CompareTable cmp={cmp.data} currency={doc.currency} />}
          <div className="grid gap-4 lg:grid-cols-2">
            {list.map((sc) => (
              <Card key={sc.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{sc.name}</h3>
                  <div className="flex shrink-0 gap-1">
                    <IconBtn title={t('edit')} onClick={() => setEditing(sc)}><Pencil size={16} /></IconBtn>
                    <IconBtn title={t('asSeparate')} onClick={() => separate.mutate(sc)}><Copy size={16} /></IconBtn>
                    <IconBtn title={t('delete')} danger onClick={() => void ask({ title: t('confirmDelete'), danger: true }).then((ok) => ok && del.mutate(sc.id))}><Trash2 size={16} /></IconBtn>
                  </div>
                </div>
                {sc.stale.length > 0 && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-amber-700"><AlertTriangle size={16} />{t('staleRefs', { n: sc.stale.length })}</p>
                )}
                <div className="mt-2 flex-1"><ChangeList changes={sc.changes} /></div>
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <Button size="sm" variant="secondary" disabled={apply.isPending}
                    onClick={() => void ask({ title: t('confirmApply', { name: sc.name }) }).then((ok) => ok && apply.mutate(sc.id))}>
                    <CheckCircle2 size={16} />{t('applyScenario')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
      {editing && <ScenarioEditor doc={doc} quoteId={quoteId} scenario={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className={cn('rounded-md p-1.5 text-slate-400', danger ? 'hover:bg-red-50 hover:text-red-600' : 'hover:bg-slate-100 hover:text-slate-700')}>
      {children}
    </button>
  )
}

/** Group sizes down, calculation + scenarios across: DBL price and the difference. */
function CompareTable({ cmp, currency }: { cmp: CompareOut; currency: string }) {
  const { t } = useI18n()
  const cols: ScenarioResult[] = cmp.scenarios
  const byN = (r: CompareOut['base']) => Object.fromEntries(r.tiers.map((x) => [x.tourists, x]))
  const baseRows = cmp.base.tiers
  const maps = cols.map((c) => byN(c.result))
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[560px] text-sm tabular-nums">
        <thead className="border-b border-slate-200 bg-slate-50 text-right text-xs font-medium text-slate-500">
          <tr>
            <th className="px-4 py-3 text-left">{t('groupSizes')}</th>
            <th className="px-4 py-3 text-brand-700">{t('base')} <span className="normal-case">({currency})</span></th>
            {cols.map((c) => <th key={c.id} className="max-w-48 px-4 py-3 normal-case">{c.name}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 text-right">
          {baseRows.map((b) => (
            <tr key={b.tourists}>
              <td className="px-4 py-2 text-left font-semibold">{b.label}</td>
              <td className="px-4 py-2 font-semibold text-brand-700">{money(b.price_dbl)}</td>
              {maps.map((m, i) => {
                const x = m[b.tourists]
                if (!x) return <td key={i} className="px-4 py-2 text-slate-300">—</td>
                const d = x.price_dbl - b.price_dbl
                return (
                  <td key={i} className="px-4 py-2">
                    {money(x.price_dbl)}{' '}
                    <span className={cn('text-xs', d === 0 ? 'text-slate-300' : d > 0 ? 'text-red-600' : 'text-emerald-700')}>
                      {d === 0 ? '±0' : `${d > 0 ? '+' : ''}${money(d)}`}
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Tab = 'settings' | 'lines' | 'hotels'

function ScenarioEditor({ doc, quoteId, scenario, onClose, onSaved }: {
  doc: QuoteDoc; quoteId: string; scenario: Scenario | null; onClose: () => void; onSaved: () => void
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const base = wsPath(ws.id, `/quotes/${quoteId}`)
  const [name, setName] = useState(scenario?.name ?? '')
  const [patch, setPatch] = useState<ScenarioPatch>(() => structuredClone(scenario?.patch ?? emptyPatch()))
  const [tab, setTab] = useState<Tab>('settings')
  const [filter, setFilter] = useState('')
  const edit = (fn: (p: ScenarioPatch) => void) => setPatch((cur) => { const next = structuredClone(cur); fn(next); return next })
  const debounced = useDebounced(patch)
  const preview = useQuery({
    queryKey: ['scenarioPreview', ws.id, quoteId, JSON.stringify(debounced)],
    queryFn: () => api<ScenarioResult>(`${base}/scenarios/preview`, { method: 'POST', body: { name: name || '·', patch: debounced } }),
    placeholderData: (prev) => prev, retry: false,
  })
  const save = useMutation({
    mutationFn: () => scenario
      ? api(`${base}/scenarios/${scenario.id}`, { method: 'PUT', body: { name, patch } })
      : api(`${base}/scenarios`, { method: 'POST', body: { name, patch } }),
    onSuccess: () => { onSaved(); onClose() },
  })
  // Sample sizes for the live preview: smallest, a middle one, largest.
  const sizes = [...new Set([doc.pax_min, Math.min(Math.max(19, doc.pax_min), doc.pax_max), doc.pax_max])]

  // A value that equals the calculation's own is not a change: drop it from the patch.
  const setSetting = <K extends keyof ScenarioPatch['settings']>(k: K, v: ScenarioPatch['settings'][K] | undefined) =>
    edit((p) => { if (v === undefined || String(v) === String(doc[k])) delete p.settings[k]; else p.settings[k] = v })
  const setVar = (k: string, v: string) => edit((p) => { if (v === '' || Number(v) === Number(doc.variables[k])) delete p.variables[k]; else p.variables[k] = v })
  const setItem = (id: string, k: 'included' | 'unit_price', v: boolean | string | undefined) => edit((p) => {
    const cur = { ...(p.items[id] ?? {}) }
    const orig = doc.items.find((i) => i.id === id)!
    if (v === undefined || v === '' || (k === 'included' ? v === orig.included : Number(v) === Number(orig.unit_price))) delete cur[k]
    else (cur as Record<string, unknown>)[k] = v
    if (Object.keys(cur).length) p.items[id] = cur; else delete p.items[id]
  })
  const setNight = (id: string, k: 'hotel_name' | 'price_dbl' | 'price_sgl', v: string) => edit((p) => {
    const cur = { ...(p.nights[id] ?? {}) }
    const orig = doc.nights.find((n) => n.id === id)!
    const same = k === 'hotel_name' ? v === orig.hotel_name : Number(v) === Number(orig[k])
    if (v === '' || same) delete cur[k]; else cur[k] = v
    if (Object.keys(cur).length) p.nights[id] = cur; else delete p.nights[id]
  })

  const numField = (k: 'days' | 'leaders' | 'staff' | 'profit_group' | 'profit_min_pp' | 'margin_floor_pct', label: string) => (
    <Field label={label}>
      <Input type="number" step="any" placeholder={String(doc[k])} value={patch.settings[k] ?? ''}
        className={cn(patch.settings[k] !== undefined && 'border-brand-400 bg-brand-50')}
        onChange={(e) => setSetting(k, e.target.value === '' ? undefined : (['days', 'leaders', 'staff'].includes(k) ? Number(e.target.value) : e.target.value) as never)} />
    </Field>
  )
  const lines = doc.items.filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()))
  const changed = preview.data?.changes.length ?? 0

  return (
    <Drawer size="lg" title={scenario ? t('editScenario') : t('newScenario')} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="space-y-4">
        <Field label={t('scenarioName')}><Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <nav className="flex gap-1 border-b border-slate-200 text-sm">
          {([['settings', 'scSettings'], ['lines', 'scLines'], ['hotels', 'scHotels']] as [Tab, TKey][]).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={cn('-mb-px border-b-2 px-3 py-2 font-semibold', tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500')}>
              {t(label)}
            </button>
          ))}
        </nav>

        {tab === 'settings' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              {numField('days', t('f_days'))}
              {/* A calculation with its own people / recipe prices from those, not from these fields. */}
              {!doc.people?.length && numField('leaders', t('f_leaders'))}
              {!doc.people?.length && numField('staff', t('f_staff'))}
              {!doc.recipe?.length && numField('profit_group', t('f_profit_group'))}
              {!doc.recipe?.length && numField('profit_min_pp', t('f_profit_min_pp'))}
              {!doc.recipe?.length && numField('margin_floor_pct', t('f_margin_floor_pct'))}
            </div>
            {Object.keys(doc.variables).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-500">{t('variables')}</p>
                {Object.entries(doc.variables).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[1fr_7rem] items-center gap-2 text-sm sm:grid-cols-[1fr_6rem_7rem]">
                    <span className="min-w-0 truncate">{doc.variable_notes?.[k] || k} <span className="font-mono text-xs text-slate-400">{k}</span></span>
                    <span className="hidden text-right tabular-nums text-slate-400 sm:block">{Number(v)}</span>
                    <Input type="number" step="any" placeholder={String(Number(v))} value={patch.variables[k] ?? ''}
                      className={cn('h-9 text-right', patch.variables[k] !== undefined && 'border-brand-400 bg-brand-50')}
                      onChange={(e) => setVar(k, e.target.value)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'lines' && (
          <div className="space-y-2">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('filterLines')} />
            <ul className="max-h-[45vh] divide-y divide-slate-200 overflow-y-auto">
              {lines.map((it) => {
                const p = patch.items[it.id] ?? {}
                const inc = p.included ?? it.included
                return (
                  <li key={it.id} className="grid grid-cols-[1fr_8rem] items-center gap-2 py-2 text-sm sm:grid-cols-[1fr_9rem_8rem]">
                    <span className={cn('min-w-0 truncate', !inc && 'text-slate-400 line-through')}>{it.name}</span>
                    <Select className={cn('h-9', p.included !== undefined && 'border-brand-400 bg-brand-50')}
                      value={p.included === undefined ? '' : p.included ? 'in' : 'out'}
                      onChange={(e) => setItem(it.id, 'included', e.target.value === '' ? undefined : e.target.value === 'in')}>
                      <option value="">{t('sameAsBase')} ({it.included ? t('include') : t('exclude')})</option>
                      <option value="in">{t('include')}</option>
                      <option value="out">{t('exclude')}</option>
                    </Select>
                    <Input type="number" step="any" placeholder={`${Number(it.unit_price)} ${it.currency}`} value={p.unit_price ?? ''}
                      className={cn('col-span-2 h-9 text-right sm:col-span-1', p.unit_price !== undefined && 'border-brand-400 bg-brand-50')}
                      onChange={(e) => setItem(it.id, 'unit_price', e.target.value)} />
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {tab === 'hotels' && (
          <ul className="max-h-[45vh] divide-y divide-slate-200 overflow-y-auto">
            {doc.nights.map((n, i) => {
              const p = patch.nights[n.id] ?? {}
              return (
                <li key={n.id} className="grid gap-2 py-2 text-sm sm:grid-cols-[6rem_1fr_6rem_6rem] sm:items-center">
                  <span className="text-slate-500">{i + 1}. {n.city}</span>
                  <Input placeholder={n.hotel_name} value={p.hotel_name ?? ''} className={cn('h-9', p.hotel_name !== undefined && 'border-brand-400 bg-brand-50')}
                    onChange={(e) => setNight(n.id, 'hotel_name', e.target.value)} />
                  <Input type="number" step="any" placeholder={`DBL ${n.price_dbl !== null ? Number(n.price_dbl) : '—'}`} value={p.price_dbl ?? ''}
                    className={cn('h-9 text-right', p.price_dbl !== undefined && 'border-brand-400 bg-brand-50')} onChange={(e) => setNight(n.id, 'price_dbl', e.target.value)} />
                  <Input type="number" step="any" placeholder={`SGL ${n.price_sgl !== null ? Number(n.price_sgl) : '—'}`} value={p.price_sgl ?? ''}
                    className={cn('h-9 text-right', p.price_sgl !== undefined && 'border-brand-400 bg-brand-50')} onChange={(e) => setNight(n.id, 'price_sgl', e.target.value)} />
                </li>
              )
            })}
          </ul>
        )}

        {/* Live: what this scenario does to prices */}
        <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm">
          <p className="text-xs font-medium text-slate-500">{t('inScenario')} · {t('changesN', { n: changed })}</p>
          <div className="mt-1 flex flex-wrap gap-3 tabular-nums">
            {preview.data?.result.errors.length ? <span className="text-red-700">{preview.data.result.errors[0]}</span>
              : sizes.map((n) => {
                  const x = preview.data?.result.tiers.find((r) => r.tourists === n)
                  return <span key={n}>{x?.label ?? n}: <b>{x ? money(x.price_dbl, doc.currency) : '…'}</b></span>
                })}
          </div>
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={save.isPending || !name.trim()}>{t('save')}</Button>
        </div>
      </form>
    </Drawer>
  )
}
