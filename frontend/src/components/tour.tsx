import type { ReactNode } from 'react'
import type { SeriesColor, TourPhase, TourStatus, Vendor, VendorType } from '../lib/api'
import { phase, type Phase } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Dialog, Label, type Tone } from './overlay'
import { Select } from './ui'

// Static class lists so Tailwind keeps them in the build.
export const COLOR: Record<SeriesColor, { bar: string; soft: string; dot: string }> = {
  indigo: { bar: 'bg-indigo-500', soft: 'bg-indigo-100 text-indigo-800', dot: 'bg-indigo-500' },
  emerald: { bar: 'bg-emerald-500', soft: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
  amber: { bar: 'bg-amber-500', soft: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  rose: { bar: 'bg-rose-500', soft: 'bg-rose-100 text-rose-800', dot: 'bg-rose-500' },
  sky: { bar: 'bg-sky-500', soft: 'bg-sky-100 text-sky-800', dot: 'bg-sky-500' },
  violet: { bar: 'bg-violet-500', soft: 'bg-violet-100 text-violet-800', dot: 'bg-violet-500' },
  teal: { bar: 'bg-teal-500', soft: 'bg-teal-100 text-teal-800', dot: 'bg-teal-500' },
  orange: { bar: 'bg-orange-500', soft: 'bg-orange-100 text-orange-800', dot: 'bg-orange-500' },
  lime: { bar: 'bg-lime-500', soft: 'bg-lime-100 text-lime-800', dot: 'bg-lime-500' },
  slate: { bar: 'bg-slate-500', soft: 'bg-slate-200 text-slate-700', dot: 'bg-slate-500' },
}

export function CodeChip({ code, color, className }: { code: string; color: SeriesColor; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-bold', COLOR[color].soft, className)}>
      {code}
    </span>
  )
}

const STATUS_TONE: Record<TourStatus, Tone> = { confirmed: 'green', inquiry: 'orange', cancelled: 'grey' }
const PHASE_STYLE: Record<Phase, string> = {
  upcoming: 'bg-sky-100 text-sky-800',
  running: 'bg-brand-600 text-white',
  finished: 'bg-slate-100 text-slate-500',
}

/** Monday-style full-width status cell. */
export function StatusPill({ status, className }: { status: TourStatus; className?: string }) {
  const { t } = useI18n()
  return (
    <Label tone={STATUS_TONE[status]} className={className}>{t(`status_${status}`)}</Label>
  )
}

const LIFE_TONE: Record<TourPhase, Tone> = {
  inquiry: 'light', confirmed: 'blue', operating: 'purple', settling: 'orange', closed: 'green', cancelled: 'grey',
}

/** Where a tour is in its life (same words as the lifecycle bar on the tour page). */
export function PhaseLabel({ phase }: { phase: TourPhase }) {
  const { t } = useI18n()
  return <Label tone={LIFE_TONE[phase]}>{t(`life_${phase}`)}</Label>
}

export function PhasePill({ start, end }: { start: string; end: string }) {
  const { t } = useI18n()
  const p = phase(start, end)
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', PHASE_STYLE[p])}>{t(`phase_${p}`)}</span>
}

/** A centered dialog (see overlay.tsx): for decisions and short tasks. Records open in a Drawer. */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <Dialog {...props} />
}

/** Vendor dropdown limited to one or more types; keeps showing a selected vendor even if it no longer matches. */
export function VendorSelect({ vendors, types, value, onChange, className, disabled, onAddNew, note, cities }: {
  vendors: Vendor[]; types: VendorType[]; value: string | null; onChange: (id: string | null) => void
  className?: string; disabled?: boolean
  onAddNew?: () => void   // shows "+ Add new…" (a quick-create dialog)
  note?: (v: Vendor) => string   // extra text after the name (languages, "not available")
  cities?: string[]       // the day's places: their suppliers are listed first
}) {
  const { t } = useI18n()
  const options = vendors.filter((v) => types.includes(v.type) || v.id === value)
  // Grouped by city — the day's own cities first, then the rest A–Z, suppliers without a city last.
  const key = (c: string) => c.trim().toLowerCase()
  const first = [...new Set((cities ?? []).map(key).filter(Boolean))]
  const groups = new Map<string, Vendor[]>()
  for (const v of [...options].sort((a, b) => a.name.localeCompare(b.name))) {
    const k = key(v.city ?? '')
    groups.set(k, [...(groups.get(k) ?? []), v])
  }
  const order = [...groups.keys()].sort((a, b) => {
    const ra = first.indexOf(a), rb = first.indexOf(b)
    if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
    if (!a || !b) return a ? -1 : 1
    return a.localeCompare(b)
  })
  const grouped = order.length > 1 || (order.length === 1 && order[0] !== '')
  const label = (k: string) => (k ? groups.get(k)![0].city.trim() : t('noCity')) + (first.includes(k) ? ` · ${t('thisDay')}` : '')
  const row = (v: Vendor) => <option key={v.id} value={v.id}>{v.name}{!grouped && v.city ? ` · ${v.city}` : ''}{note?.(v) ?? ''}</option>
  return (
    <Select className={className} disabled={disabled} value={value ?? ''}
      onChange={(e) => (e.target.value === '__new__' ? onAddNew?.() : onChange(e.target.value || null))}>
      <option value="">—</option>
      {grouped ? order.map((k) => <optgroup key={k || '-'} label={label(k)}>{groups.get(k)!.map(row)}</optgroup>) : options.map(row)}
      {onAddNew && <option value="__new__">{t('addNewOption')}</option>}
    </Select>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="font-semibold text-slate-700">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Phone({ phone }: { phone: string }) {
  if (!phone) return null
  return <a href={`tel:${phone.replace(/\s/g, '')}`} className="whitespace-nowrap text-brand-600 hover:underline">{phone}</a>
}
