import { freeAt } from './BuildTab'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, X } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { toast } from '../../components/overlay'
import { Button, IconButton, Input } from '../../components/ui'
import { api, can, type FormulaCheck, type QuoteDoc, type SavedFormula } from '../../lib/api'
import { wsPath } from '../../lib/data'
import { useDebounced } from '../../lib/hooks'
import { useI18n, type TKey } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn } from '../../lib/utils'

const FUNCTIONS = ['ceil', 'floor', 'min', 'max', 'round', 'abs'] as const
const EXAMPLES: [string, TKey][] = [
  ['days * 2', 'fx_ex_meals'],
  ['days * 2 - armenia_meals', 'fx_ex_meals_ge'],
  ['ceil(persons / 7)', 'fx_ex_cars'],
  ['(km_route + km_reserve) / 100 * 40', 'fx_ex_fuel'],
  ['558 if armenia_meals > 0 else 0', 'fx_ex_choice'],
  ['max(days - 1, 0)', 'fx_ex_nights'],
  ['cost_total * 0.03', 'fx_ex_insurance'],
  ['cost_flight * 0.05', 'fx_ex_fee'],
]

type Suggestion = { name: string; detail: string; fn: boolean }

/**
 * A quantity formula with help: suggestions while typing, the value for small,
 * sample and large groups, plain-language errors with a one-click fix, and examples.
 */
export function FormulaText({ value, onChange, doc, sample, compact = false, placeholder }: {
  value: string; onChange: (v: string) => void; doc: QuoteDoc; sample: number; compact?: boolean; placeholder?: string
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const ref = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState<'names' | 'examples' | 'library' | null>(null)
  const qc = useQueryClient()
  const style = useQuery({ queryKey: ['calcStyle', ws.id], queryFn: () => api<{ formulas?: SavedFormula[] }>(wsPath(ws.id, '/calc-style')) })
  const library = style.data?.formulas ?? []
  const [saveName, setSaveName] = useState('')
  const putLibrary = useMutation({
    mutationFn: (list: SavedFormula[]) => api<{ formulas?: SavedFormula[] }>(wsPath(ws.id, '/calc-style/formulas'), { method: 'PUT', body: list }),
    onSuccess: (st) => { qc.setQueryData(['calcStyle', ws.id], (old: object | undefined) => ({ ...(old ?? {}), ...st })); setSaveName('') },
    meta: { silent: true },
  })
  const canSave = can(ws, 'operations') || can(ws, 'sales')
  const expr = value || placeholder || ''
  const check = useDebounced({ doc, expr })
  const res = useQuery({
    queryKey: ['formulaCheck', ws.id, sample, JSON.stringify(check)],
    queryFn: () => api<FormulaCheck>(wsPath(ws.id, '/quotes/preview/formula'), {
      method: 'POST', body: { doc: check.doc, expression: check.expr, tourists: sample },
    }),
    placeholderData: (prev) => prev, retry: false,
  })
  const r = res.data

  // The identifier being typed right before the caret.
  const token = /[A-Za-z_][A-Za-z0-9_]*$/.exec(value.slice(0, caret))?.[0] ?? ''
  const all: Suggestion[] = [
    ...(r?.names ?? []).map((n) => ({ name: n.name, detail: `${n.note || ''} = ${fmtNum(n.value)}`, fn: false })),
    ...FUNCTIONS.map((f) => ({ name: f, detail: t(`fn_${f}` as TKey), fn: true })),
  ]
  const suggestions = token
    ? [...all.filter((s) => s.name.startsWith(token)), ...all.filter((s) => !s.name.startsWith(token) && s.name.includes(token))]
        .filter((s) => s.name !== token).slice(0, 7)
    : []
  const showList = focused && suggestions.length > 0

  const insert = (text: string, replaceToken = true) => {
    const start = replaceToken ? caret - token.length : caret
    const next = value.slice(0, start) + text + value.slice(caret)
    onChange(next)
    const pos = start + text.length
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); setCaret(pos) })
  }
  const pick = (s: Suggestion) => insert(s.fn ? `${s.name}(` : s.name)
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showList) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length) }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[Math.min(active, suggestions.length - 1)]) }
    else if (e.key === 'Escape') setFocused(false)
  }
  const fixName = (from: string, to: string) => onChange(value.replace(new RegExp(`\\b${from}\\b`), to))
  const values = r?.values ?? []
  const same = values.length > 0 && values.every((v) => v.value === values[0].value)
  const leaders = freeAt(doc, sample) ? `+${freeAt(doc, sample)}` : ''

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input ref={ref} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off"
          className={cn('font-mono', compact && 'h-9 text-xs', r && !r.ok && value && 'border-red-300 focus:border-red-400')}
          onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActive(0) }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKey} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} />
        {showList && (
          <ul role="listbox" className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
            {suggestions.map((s, i) => (
              <li key={s.name} role="option" aria-selected={i === active}>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(s) }}
                  className={cn('flex w-full items-baseline gap-3 px-3 py-1.5 text-left', i === active ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                  <span className="font-mono font-semibold">{s.name}{s.fn && '()'}</span>
                  <span className="truncate text-xs text-slate-500">{s.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Result or what to fix */}
      {r && (r.ok ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-emerald-700">
          <Check size={16} />
          {same ? t('fxSame', { v: fmtNum(values[0].value) })
            : values.map((v) => <span key={v.tourists} className="rounded bg-emerald-50 px-1.5 tabular-nums">{v.tourists}{leaders}: <b>{fmtNum(v.value)}</b></span>)}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-700">
          <AlertTriangle size={16} />
          <span>{t(`fxErr_${r.error_code}` as TKey, r.error_params as Record<string, string | number>)}</span>
          {r.error_params.suggestion && (
            <>
              <span>{t('fxDidYouMean', { s: String(r.error_params.suggestion) })}</span>
              <button type="button" onClick={() => fixName(String(r.error_params.name), String(r.error_params.suggestion))}
                className="rounded-md border border-red-200 bg-white px-2 py-0.5 text-xs font-semibold hover:bg-red-50">
                {t('fxUse', { s: String(r.error_params.suggestion) })}
              </button>
            </>
          )}
        </div>
      ))}

      {!compact && (
        <div className="flex flex-wrap gap-4 text-sm">
          {(['names', 'examples', 'library'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k} className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-800">
              <ChevronDown size={16} className={cn('transition-transform', open === k && 'rotate-180')} />
              {k === 'names' ? t('fxNames') : k === 'examples' ? t('fxExamples') : `${t('fxLibrary')}${library.length ? ` · ${library.length}` : ''}`}
            </button>
          ))}
        </div>
      )}
      {!compact && open === 'names' && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3">
          <div className="flex flex-wrap gap-1.5">
            {(r?.names ?? []).map((n) => (
              <button key={n.name} type="button" onClick={() => insert(n.name, false)} title={n.note}
                className={cn('rounded-full border px-2.5 py-1 text-xs', n.builtin ? 'border-slate-200 bg-white' : 'border-brand-200 bg-brand-50 text-brand-800')}>
                <span className="font-mono font-semibold">{n.name}</span> = {fmtNum(n.value)}{n.note && <span className="text-slate-500"> · {n.note}</span>}
              </button>
            ))}
          </div>
          <p className="text-xs font-medium text-slate-500">{t('fxFunctions')}</p>
          <div className="flex flex-wrap gap-1.5">
            {FUNCTIONS.map((f) => (
              <button key={f} type="button" onClick={() => insert(`${f}(`, false)} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs">
                <span className="font-mono font-semibold">{f}()</span> <span className="text-slate-500">{t(`fn_${f}` as TKey)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!compact && open === 'library' && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
          {library.length === 0 && <p className="text-slate-500">{t('fxLibraryEmpty')}</p>}
          <ul className="divide-y divide-slate-200">
            {library.map((f, i) => (
              <li key={`${f.name}${i}`} className="flex flex-wrap items-center gap-3 py-1.5">
                <span className="font-medium">{f.name}</span>
                <code className="font-mono text-xs text-slate-600">{f.formula}</code>
                <span className="min-w-0 flex-1 truncate text-slate-500">{f.note}</span>
                <Button variant="tertiary" size="sm" onClick={() => onChange(f.formula)}>{t('fxInsert')}</Button>
                {canSave && <IconButton size="sm" tone="danger" label={`${t('delete')}: ${f.name}`}
                  onClick={() => { putLibrary.mutate(library.filter((_, j) => j !== i)); toast('fxRemovedFromLibrary') }}><X size={16} /></IconButton>}
              </li>
            ))}
          </ul>
          {canSave && value && r?.ok && !library.some((f) => f.formula === value) && (
            <form className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2"
              onSubmit={(e) => { e.preventDefault(); if (saveName.trim()) { putLibrary.mutate([...library, { name: saveName.trim(), formula: value, note: '' }]); toast('fxSavedToLibrary') } }}>
              <span className="text-slate-600">{t('fxSaveThis')}</span>
              <code className="font-mono text-xs">{value}</code>
              <Input size="sm" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={t('fxSaveNamePh')} className="w-52" aria-label={t('name')} />
              <Button type="submit" variant="secondary" size="sm" disabled={!saveName.trim() || putLibrary.isPending}>{t('save')}</Button>
            </form>
          )}
        </div>
      )}
      {!compact && open === 'examples' && (
        <ul className="divide-y divide-slate-200 rounded-lg bg-slate-50 text-sm">
          {EXAMPLES.map(([ex, label]) => (
            <li key={ex} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <code className="font-mono text-xs">{ex}</code>
              <span className="flex-1 text-slate-500">{t(label)}</span>
              <button type="button" onClick={() => onChange(ex)} className="text-xs font-semibold text-brand-600 hover:underline">{t('fxInsert')}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const fmtNum = (x: number) => (x + 0).toLocaleString('en-US', { maximumFractionDigits: 2 })
