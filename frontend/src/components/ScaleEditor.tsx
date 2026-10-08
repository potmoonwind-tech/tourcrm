import { Plus, Trash2 } from 'lucide-react'
import type { ScaleRow } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { Input } from './ui'

/**
 * "Cancelled within N days → X%" rows (a client cancellation scale or a vendor's
 * release terms). Read top to bottom like a contract; the narrowest row that
 * applies wins, and earlier than every row is free.
 */
export function ScaleEditor({ value, onChange, disabled, of }: {
  value: ScaleRow[]; onChange: (v: ScaleRow[]) => void; disabled?: boolean
  of: 'price' | 'booked'   // what the percent is taken of, for the sentence
}) {
  const { t } = useI18n()
  const rows = [...value].sort((a, b) => b.within_days - a.within_days)
  const set = (i: number, patch: Partial<ScaleRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const dupes = new Set(rows.map((r) => r.within_days).filter((d, i, all) => all.indexOf(d) !== i))
  return (
    <div className="space-y-1.5">
      {rows.length === 0 && <p className="text-xs text-slate-500">{of === 'price' ? t('scaleEmptyClient') : t('scaleEmptyVendor')}</p>}
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">{t('scaleWithin')}</span>
          <Input type="number" min={0} max={730} value={r.within_days} disabled={disabled}
            onChange={(e) => set(i, { within_days: Number(e.target.value) })}
            className={`h-8 w-20 px-2 text-right ${dupes.has(r.within_days) ? 'border-red-400' : ''}`} aria-label={t('scaleDays')} />
          <span className="text-slate-500">{t('scaleDaysOf', { what: of === 'price' ? t('scaleArrival') : t('scaleFirstService') })}</span>
          <Input type="number" min={0} max={100} step="0.01" value={r.percent} disabled={disabled}
            onChange={(e) => set(i, { percent: Number(e.target.value) })} className="h-8 w-20 px-2 text-right" aria-label="%" />
          <span className="text-slate-500">% {of === 'price' ? t('scaleOfPrice') : t('scaleOfBooked')}</span>
          {!disabled && (
            <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={t('delete')}
              className="rounded-md p-1 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
          )}
        </div>
      ))}
      {!disabled && (
        <button type="button" onClick={() => onChange([...rows, { within_days: rows.length ? Math.max(0, rows.at(-1)!.within_days - 7) : 30, percent: 0 }])}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <Plus size={13} />{t('scaleAddRow')}
        </button>
      )}
    </div>
  )
}
