import { Plus, Ticket, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DayExtra, ServiceBrief } from '../lib/api'
import { useServiceList } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'

/** Units whose quantity the system can work out by itself (group size, rooms, 1 per day/group). */
const AUTO_UNITS = new Set(['person', 'room_night', 'group', 'vehicle_day', 'day', 'km', 'litre'])   // km/litre: from the day's km

/**
 * The extra services of one day: chips with a quantity box, plus a picker over the
 * price catalog grouped by vendor. Quantity left empty = counted from the unit.
 */
export function DayServices({ value, onChange, disabled, compact, onAddNew }: {
  value: DayExtra[]; onChange: (v: DayExtra[]) => void; disabled?: boolean; compact?: boolean
  onAddNew?: () => void
}) {
  const { t } = useI18n()
  const services = useServiceList()
  const byId = new Map((services.data ?? []).map((s) => [s.id, s]))
  const [adding, setAdding] = useState(false)

  const groups = new Map<string, ServiceBrief[]>()
  for (const s of services.data ?? []) groups.set(s.vendor.name, [...(groups.get(s.vendor.name) ?? []), s])

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', compact ? 'min-w-56' : '')}>
      {value.map((x, i) => {
        const s = byId.get(x.service_id)
        return (
          <span key={x.id ?? i} title={s ? `${s.vendor.name} · ${t(`unit_${s.unit}`)}` : undefined}
            className={cn('inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs',
              s ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-red-200 bg-red-50 text-red-700')}>
            <Ticket size={12} className="shrink-0" />
            <span className="max-w-40 truncate">{s ? s.name : t('serviceRemoved')}</span>
            {s && !compact && <span className="text-sky-600/70">· {s.vendor.name}</span>}
            {s && (
              <Qty value={x.quantity} auto={AUTO_UNITS.has(s.unit)} unit={t(`unit_${s.unit}`)} disabled={disabled}
                onChange={(q) => onChange(value.map((y, j) => (j === i ? { ...y, quantity: q } : y)))} />
            )}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('delete')}
                className="rounded-full p-0.5 text-sky-700/60 hover:bg-white hover:text-red-600"><X size={12} /></button>
            )}
          </span>
        )
      })}
      {!disabled && (adding ? (
        <select autoFocus className="h-7 max-w-64 rounded-md border border-slate-300 bg-white px-1 text-xs" value=""
          onBlur={() => setAdding(false)}
          onChange={(e) => {
            if (e.target.value === '__new__') onAddNew?.()
            else if (e.target.value) onChange([...value, { service_id: e.target.value, quantity: null, notes: '' }])
            setAdding(false)
          }}>
          <option value="">{t('pickService')}</option>
          {[...groups].map(([vendor, list]) => (
            <optgroup key={vendor} label={vendor}>
              {list.map((s) => <option key={s.id} value={s.id}>{s.name} ({t(`unit_${s.unit}`)})</option>)}
            </optgroup>
          ))}
          {onAddNew && <option value="__new__">{t('addNewOption')}</option>}
        </select>
      ) : (
        <button type="button" onClick={() => (services.data?.length ? setAdding(true) : onAddNew?.())} disabled={!services.data?.length && !onAddNew}
          title={services.data?.length ? undefined : t('noServicesYet')}
          className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:text-slate-400">
          <Plus size={12} />{t('service')}
        </button>
      ))}
    </div>
  )
}

/** Quantity box inside a chip: empty means "auto". Commits on blur. */
function Qty({ value, auto, unit, disabled, onChange }: {
  value: DayExtra['quantity']; auto: boolean; unit: string; disabled?: boolean; onChange: (q: string | null) => void
}) {
  const { t } = useI18n()
  const shown = value === null || value === undefined ? '' : String(Number(value))
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  return (
    <input type="number" min="0" step="any" disabled={disabled} value={text} placeholder={auto ? t('autoQty') : '1?'}
      title={auto ? t('autoQtyHelp', { unit }) : t('setQtyHelp', { unit })} aria-label={t('quantity')}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== shown) onChange(text && Number(text) > 0 ? text : null) }}
      className={cn('h-5 w-12 rounded border bg-white px-1 text-right text-xs tabular-nums',
        !auto && !text ? 'border-amber-400' : 'border-sky-200')} />
  )
}
