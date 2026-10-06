/**
 * Formulas without being afraid of them. Three ways to the same formula:
 *  - Ready-made: the formulas agencies actually use, as a sentence to fill in
 *    ("[3] % of [all costs]", "one for every [7] [people]", "if [crossings] is [2] use [558], otherwise [316]").
 *  - Blocks: click pieces (group size, days, all costs, your inputs, + − × ÷, a number); nothing typed.
 *  - Text: type it, with suggestions (FormulaText).
 * Under every way: what it reads as, in words, and what it comes to for a small, middle and large group.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowDownToLine, ArrowUpToLine, Check, ChevronLeft, Delete, Divide, Minus, Percent, Shield, Split, Users, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, IconButton, Input, SegmentedControl, Select } from '../../components/ui'
import { api, type FormulaCheck, type QuoteDoc } from '../../lib/api'
import { wsPath } from '../../lib/data'
import { useDebounced } from '../../lib/hooks'
import { useI18n, type TKey } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn } from '../../lib/utils'
import { FormulaText } from './FormulaInput'
import { useKinds } from './kinds'

type Mode = 'ready' | 'blocks' | 'text'
type Opt = [string, string]   // [name in the formula, what people call it]

const PEOPLE = ['group', 'tourists', 'persons', 'everyone', 'leaders', 'staff', 'crew']
const TRIP = ['days', 'nights']
const OPS: [string, TKey][] = [['==', 'op_is'], ['>', 'op_more'], ['>=', 'op_atLeast'], ['<', 'op_less'], ['<=', 'op_atMost']]

const num = (s: string) => s.replace(',', '.').replace(/[^\d.]/g, '')
const trim = (x: number) => String(+x.toFixed(6))

/** The words for every name a formula can use. */
function useNames(doc: QuoteDoc) {
  const { t } = useI18n()
  const K = useKinds()
  const costKinds = ['hotel', 'meal', 'transport', 'guide', 'ticket', 'activity', ...K.kinds.map((k) => k.id)]
  const label = (n: string): string => {
    if (n === 'cost_total') return t('nm_cost_total')
    if (n.startsWith('cost_')) return t('nm_costOf', { what: K.nameOf(n.slice(5)).toLowerCase() })
    if ([...PEOPLE, ...TRIP].includes(n)) return t(`nm_${n}` as TKey)
    return doc.variable_notes?.[n] || n
  }
  const inputs: Opt[] = Object.keys(doc.variables).map((k) => [k, label(k)])
  return {
    label,
    people: PEOPLE.map((n) => [n, label(n)] as Opt),
    trip: TRIP.map((n) => [n, label(n)] as Opt),
    costs: ['cost_total', ...costKinds.map((k) => `cost_${k}`)].map((n) => [n, label(n)] as Opt),
    inputs,
  }
}

// --- ready-made formulas ---------------------------------------------------------------------------

interface Ready { id: string; title: TKey; example: TKey; icon: ReactNode; parse: (f: string) => string[] | null; make: (v: string[]) => string; start: string[] }
const READY: Ready[] = [
  { id: 'pct', title: 'rf_pct', example: 'rf_pct_ex', icon: <Percent size={20} />, start: ['3', 'total'],
    parse: (f) => { const m = /^cost_([a-z0-9_]+)\s*\*\s*([\d.]+)$/i.exec(f); return m ? [trim(Number(m[2]) * 100), m[1]] : null },
    make: ([p, of]) => `cost_${of} * ${trim(Number(p || 0) / 100)}` },
  { id: 'per', title: 'rf_per', example: 'rf_per_ex', icon: <Users size={20} />, start: ['7', 'persons', '0'],
    parse: (f) => { const m = /^ceil\(\(?\s*([a-z_][a-z0-9_]*)(?:\s*\+\s*(\d+))?\s*\)?\s*\/\s*([\d.]+)\s*\)$/i.exec(f); return m ? [m[3], m[1], m[2] ?? '0'] : null },
    make: ([n, who, more]) => (Number(more) ? `ceil((${who} + ${Number(more)}) / ${n || 1})` : `ceil(${who} / ${n || 1})`) },
  { id: 'times', title: 'rf_times', example: 'rf_times_ex', icon: <X size={20} />, start: ['2', 'days'],
    parse: (f) => { const m = /^([a-z_][a-z0-9_]*)(?:\s*\*\s*([\d.]+))?$/i.exec(f); return m && !m[1].startsWith('cost_') ? [m[2] ?? '1', m[1]] : null },
    make: ([k, what]) => (Number(k) === 1 ? what : `${what} * ${k || 0}`) },
  { id: 'minus', title: 'rf_minus', example: 'rf_minus_ex', icon: <Minus size={20} />, start: ['2', 'days', ''],
    parse: (f) => { const m = /^([a-z_][a-z0-9_]*)\s*\*\s*([\d.]+)\s*-\s*([a-z_][a-z0-9_]*)$/i.exec(f); return m ? [m[2], m[1], m[3]] : null },
    make: ([k, what, less]) => `${what} * ${k || 0}${less ? ` - ${less}` : ''}` },
  { id: 'if', title: 'rf_if', example: 'rf_if_ex', icon: <Split size={20} />, start: ['', '==', '2', '558', '316'],
    parse: (f) => { const m = /^([\d.]+)\s+if\s+([a-z_][a-z0-9_]*)\s*(==|>=|<=|>|<)\s*([\d.]+)\s+else\s+([\d.]+)$/i.exec(f); return m ? [m[2], m[3], m[4], m[1], m[5]] : null },
    make: ([name, op, val, yes, no]) => `${yes || 0} if ${name || 'group'} ${op} ${val || 0} else ${no || 0}` },
  { id: 'least', title: 'rf_least', example: 'rf_least_ex', icon: <Shield size={20} />, start: ['12', 'tourists', '150'],
    parse: (f) => { const m = /^max\(\s*([\d.]+)\s*,\s*([a-z_][a-z0-9_]*)\s*\*\s*([\d.]+)\s*\)$/i.exec(f); return m ? [m[3], m[2], m[1]] : null },
    make: ([k, who, min]) => `max(${min || 0}, ${who} * ${k || 0})` },
]
const readyOf = (f: string) => { for (const r of READY) { const v = r.parse(f.trim()); if (v) return { r, v } } return null }

function Num({ value, onChange, label, w = 'w-20' }: { value: string; onChange: (v: string) => void; label: string; w?: string }) {
  return <Input size="sm" inputMode="decimal" value={value} onChange={(e) => onChange(num(e.target.value))} aria-label={label} className={cn(w, 'text-right font-medium tabular-nums')} />
}
function Pick({ value, options, onChange, label }: { value: string; options: Opt[]; onChange: (v: string) => void; label: string }) {
  const known = options.some(([v]) => v === value)
  return (
    <Select size="sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="w-auto max-w-[16rem] font-medium">
      {!known && <option value={value}>{value || '—'}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </Select>
  )
}

function ReadyMade({ value, onChange, doc }: { value: string; onChange: (v: string) => void; doc: QuoteDoc }) {
  const { t } = useI18n()
  const N = useNames(doc)
  const found = readyOf(value)
  const [picked, setPicked] = useState<string | null>(found?.r.id ?? null)
  const r = READY.find((x) => x.id === picked)
  if (!r) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {READY.map((x) => (
          <button key={x.id} type="button" onClick={() => { setPicked(x.id); onChange(x.make(x.id === 'if' ? [N.inputs[0]?.[0] ?? 'group', ...x.start.slice(1)] : x.start)) }}
            className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-brand-600 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
            <span className="mt-0.5 text-brand-600">{x.icon}</span>
            <span><span className="block text-sm font-semibold text-slate-800">{t(x.title)}</span><span className="block text-sm text-slate-500">{t(x.example)}</span></span>
          </button>
        ))}
      </div>
    )
  }
  const v = found && found.r.id === r.id ? found.v : r.start
  const put = (i: number, x: string) => onChange(r.make(v.map((old, j) => (j === i ? x : old))))
  const counts = [...N.people, ...N.trip, ...N.inputs]
  const word = 'text-sm text-slate-700'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50/50 p-3">
        {r.id === 'pct' && <>
          <Num value={v[0]} onChange={(x) => put(0, x)} label="%" w="w-16" /><span className={word}>{t('rf_pctOf')}</span>
          <Pick value={v[1]} onChange={(x) => put(1, x)} label={t('rf_pct')} options={N.costs.map(([n, l]) => [n.slice(5), l])} />
        </>}
        {r.id === 'per' && <>
          <span className={word}>{t('rf_oneForEvery')}</span><Num value={v[0]} onChange={(x) => put(0, x)} label={t('rf_per')} w="w-16" />
          <Pick value={v[1]} onChange={(x) => put(1, x)} label={t('rf_per')} options={[...N.people, ...N.inputs]} />
          <span className={word}>{t('rf_plus')}</span><Num value={v[2]} onChange={(x) => put(2, x)} label={t('rf_more')} w="w-14" />
          <span className="text-sm text-slate-500">{t('rf_moreHint')}</span>
        </>}
        {r.id === 'times' && <>
          <Num value={v[0]} onChange={(x) => put(0, x)} label={t('rf_times')} w="w-16" /><span className={word}>×</span>
          <Pick value={v[1]} onChange={(x) => put(1, x)} label={t('rf_times')} options={counts} />
        </>}
        {r.id === 'minus' && <>
          <Num value={v[0]} onChange={(x) => put(0, x)} label={t('rf_minus')} w="w-16" /><span className={word}>×</span>
          <Pick value={v[1]} onChange={(x) => put(1, x)} label={t('rf_minus')} options={counts} />
          <span className={word}>{t('rf_minusWord')}</span>
          <Pick value={v[2]} onChange={(x) => put(2, x)} label={t('rf_minusWord')} options={[['', '—'], ...N.inputs, ...N.people]} />
        </>}
        {r.id === 'if' && <>
          <span className={word}>{t('rf_ifWord')}</span>
          <Pick value={v[0]} onChange={(x) => put(0, x)} label={t('rf_if')} options={[...N.inputs, ...N.people, ...N.trip]} />
          <Select size="sm" value={v[1]} onChange={(e) => put(1, e.target.value)} className="w-auto" aria-label={t('rf_if')}>
            {OPS.map(([o, k]) => <option key={o} value={o}>{t(k)}</option>)}
          </Select>
          <Num value={v[2]} onChange={(x) => put(2, x)} label={t('rf_if')} w="w-16" />
          <span className={word}>{t('rf_use')}</span><Num value={v[3]} onChange={(x) => put(3, x)} label={t('rf_use')} />
          <span className={word}>{t('rf_otherwise')}</span><Num value={v[4]} onChange={(x) => put(4, x)} label={t('rf_otherwise')} />
        </>}
        {r.id === 'least' && <>
          <Num value={v[0]} onChange={(x) => put(0, x)} label={t('rf_least')} w="w-16" /><span className={word}>×</span>
          <Pick value={v[1]} onChange={(x) => put(1, x)} label={t('rf_least')} options={[...N.people, ...N.trip, ...N.inputs]} />
          <span className={word}>{t('rf_butAtLeast')}</span><Num value={v[2]} onChange={(x) => put(2, x)} label={t('rf_butAtLeast')} />
        </>}
      </div>
      <Button variant="tertiary" size="sm" onClick={() => setPicked(null)}><ChevronLeft size={16} />{t('rf_other')}</Button>
    </div>
  )
}

// --- blocks ----------------------------------------------------------------------------------------

const TOKEN = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|==|!=|>=|<=|[-+*/()<>,%])/g
const tokens = (f: string) => [...f.matchAll(TOKEN)].map((m) => m[1])
const SIGN: Record<string, string> = { '*': '×', '/': '÷', '-': '−', '+': '+', '(': '(', ')': ')', ',': ',', '==': '=', '>=': '≥', '<=': '≤' }

function Blocks({ value, onChange, doc }: { value: string; onChange: (v: string) => void; doc: QuoteDoc }) {
  const { t } = useI18n()
  const N = useNames(doc)
  const [n, setN] = useState('')
  const toks = tokens(value === '0' ? '' : value)
  const put = (list: string[]) => onChange(list.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')'))
  const add = (x: string) => {
    const last = toks.at(-1)
    // Two values side by side mean "times": days, 2 → days × 2.
    const needsSign = last && /^[\w.)]/.test(last) && last !== '(' && /^[\w.(]/.test(x) && !['if', 'else'].includes(last) && !['if', 'else'].includes(x)
    put([...toks, ...(needsSign ? ['*'] : []), x])
  }
  const chip = (x: string, i: number) => {
    const isName = /^[A-Za-z_]/.test(x) && !['if', 'else', 'ceil', 'floor', 'max', 'min', 'round', 'abs', 'and', 'or'].includes(x)
    const isNum = /^\d/.test(x)
    return (
      <span key={i} className={cn('group inline-flex h-8 items-center gap-1 rounded-full pl-3 pr-1 text-sm',
        isName ? 'bg-brand-100 font-medium text-brand-800' : isNum ? 'border border-slate-300 bg-white font-semibold tabular-nums' : 'bg-slate-100 font-semibold text-slate-700')}
        title={x}>
        {isName ? N.label(x) : isNum ? x : (SIGN[x] ?? t(`blk_${x}` as TKey))}
        <button type="button" onClick={() => put(toks.filter((_, j) => j !== i))} aria-label={`${t('delete')}: ${x}`}
          className="flex h-6 w-6 items-center justify-center rounded-full text-current opacity-50 hover:bg-white/70 hover:opacity-100"><X size={12} /></button>
      </span>
    )
  }
  const group = (title: string, items: Opt[]) => items.length > 0 && (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map(([v, l]) => (
          <button key={v} type="button" onClick={() => add(v)}
            className="inline-flex h-8 items-center rounded-full border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:border-brand-600 hover:bg-brand-50">{l}</button>
        ))}
      </div>
    </div>
  )
  return (
    <div className="space-y-3">
      <div className="flex min-h-12 flex-wrap items-center gap-1.5 rounded-xl border border-slate-300 bg-white p-2" aria-label={t('blk_formula')}>
        {toks.length ? toks.map(chip) : <span className="px-2 text-sm text-slate-500">{t('blk_empty')}</span>}
        {toks.length > 0 && <IconButton size="sm" label={t('blk_back')} className="ml-auto" onClick={() => put(toks.slice(0, -1))}><Delete size={16} /></IconButton>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {(['+', '-', '*', '/', '(', ')'] as const).map((s) => (
          <button key={s} type="button" onClick={() => put([...toks, s])} aria-label={t(`blk_${s === '*' ? 'times' : s === '/' ? 'divide' : s === '+' ? 'plus' : s === '-' ? 'minus' : s === '(' ? 'open' : 'close'}` as TKey)}
            className="flex h-10 w-10 items-center justify-center rounded border border-slate-300 bg-white text-lg font-semibold text-slate-700 hover:bg-slate-100">
            {s === '/' ? <Divide size={18} /> : SIGN[s]}
          </button>
        ))}
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (n) { add(n); setN('') } }}>
          <Input inputMode="decimal" value={n} onChange={(e) => setN(num(e.target.value))} placeholder="12" className="w-20 text-right" aria-label={t('blk_number')} />
          <Button type="submit" variant="secondary" disabled={!n}>{t('blk_addNumber')}</Button>
        </form>
      </div>
      <div className="space-y-3 rounded-xl bg-slate-50 p-3">
        {group(t('blk_people'), N.people)}
        {group(t('blk_trip'), N.trip)}
        {group(t('blk_costs'), N.costs)}
        {group(t('blk_inputs'), N.inputs)}
        {toks.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-slate-500">{t('blk_whole')}</div>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => onChange(`ceil(${value})`)}><ArrowUpToLine size={16} />{t('blk_ceil')}</Button>
              <Button variant="secondary" size="sm" onClick={() => onChange(`floor(${value})`)}><ArrowDownToLine size={16} />{t('blk_floor')}</Button>
              <Button variant="secondary" size="sm" onClick={() => onChange(`max(0, ${value})`)}><Shield size={16} />{t('blk_notBelowZero')}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// --- what it says, and what it comes to --------------------------------------------------------------

function useReadsAs(doc: QuoteDoc) {
  const { t } = useI18n()
  const N = useNames(doc)
  return (f: string): string => {
    const found = readyOf(f)
    if (found) {
      const v = found.v
      switch (found.r.id) {
        case 'pct': return t('rd_pct', { p: v[0], of: N.label(`cost_${v[1]}`) })
        case 'per': return Number(v[2]) ? t('rd_perMore', { n: v[0], who: N.label(v[1]), more: v[2] }) : t('rd_per', { n: v[0], who: N.label(v[1]) })
        case 'times': return Number(v[0]) === 1 ? N.label(v[1]) : `${v[0]} × ${N.label(v[1])}`
        case 'minus': return t('rd_minus', { k: v[0], what: N.label(v[1]), less: N.label(v[2]) })
        case 'if': return t('rd_if', { name: N.label(v[0]), op: t(OPS.find(([o]) => o === v[1])![1]), val: v[2], yes: v[3], no: v[4] })
        case 'least': return t('rd_least', { k: v[0], who: N.label(v[1]), min: v[2] })
      }
    }
    const word: Record<string, string> = { if: t('rd_ifWord'), else: t('rd_else'), ceil: t('rd_ceil'), floor: t('rd_floor'),
      max: t('rd_max'), min: t('rd_min'), round: t('rd_round'), abs: t('rd_abs'), and: t('rd_and'), or: t('rd_or') }
    return tokens(f).map((x) => word[x] ?? SIGN[x] ?? (/^[A-Za-z_]/.test(x) ? N.label(x) : x)).join(' ').replace(/\( /g, '(').replace(/ \)/g, ')')
  }
}

const fmt = (x: number) => (x + 0).toLocaleString('en-US', { maximumFractionDigits: 2 })

/** The formula box used everywhere: ready-made, blocks, or text. */
export function FormulaInput({ value, onChange, doc, sample, compact = false, placeholder }: {
  value: string; onChange: (v: string) => void; doc: QuoteDoc; sample: number; compact?: boolean; placeholder?: string
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const empty = !value || value === '0'
  const [mode, setMode] = useState<Mode>(() => (empty || readyOf(value) ? 'ready' : tokens(value).join('') === value.replace(/\s/g, '') ? 'blocks' : 'text'))
  const readsAs = useReadsAs(doc)
  const check = useDebounced({ doc, expr: value })
  const res = useQuery({
    queryKey: ['formulaCheck', ws.id, sample, JSON.stringify(check)], enabled: !empty && mode !== 'text',
    queryFn: () => api<FormulaCheck>(wsPath(ws.id, '/quotes/preview/formula'), { method: 'POST', body: { doc: check.doc, expression: check.expr, tourists: sample } }),
    placeholderData: (prev) => prev, retry: false,
  })
  if (compact) return <FormulaText compact value={value} onChange={onChange} doc={doc} sample={sample} placeholder={placeholder} />
  const r = res.data
  const values = r?.values ?? []
  const same = values.length > 0 && values.every((x) => x.value === values[0].value)
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3">
      <SegmentedControl size="sm" label={t('fb_how')} value={mode} onChange={setMode}
        options={[['ready', t('fb_ready')], ['blocks', t('fb_blocks')], ['text', t('fb_text')]]} />
      {mode === 'ready' && <ReadyMade value={value} onChange={onChange} doc={doc} />}
      {mode === 'blocks' && <Blocks value={value} onChange={onChange} doc={doc} />}
      {mode === 'text' && <FormulaText value={value} onChange={onChange} doc={doc} sample={sample} placeholder={placeholder} />}
      {mode !== 'text' && !empty && (
        <div className="space-y-1.5 border-t border-slate-200 pt-3 text-sm">
          <p><span className="text-slate-500">{t('fb_readsAs')}</span> <span className="font-medium text-slate-800">{readsAs(value)}</span></p>
          {r && (r.ok ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-emerald-700">
              <Check size={16} />
              {same ? t('fxSame', { v: fmt(values[0].value) })
                : values.map((x) => <span key={x.tourists} className="rounded bg-emerald-50 px-1.5 tabular-nums">{x.tourists}: <b>{fmt(x.value)}</b></span>)}
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-2 text-red-700"><AlertTriangle size={16} />{t(`fxErr_${r.error_code}` as TKey, r.error_params as Record<string, string | number>)}</p>
          ))}
          <p className="text-xs text-slate-500">{t('fb_asText')} <code className="font-mono">{value}</code></p>
        </div>
      )}
    </div>
  )
}
