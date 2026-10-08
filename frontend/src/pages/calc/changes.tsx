import { ArrowRight, Minus, Plus } from 'lucide-react'
import type { Change } from '../../lib/api'
import { useClients, useSeries, useVendors } from '../../lib/data'
import { useI18n, type TKey } from '../../lib/i18n'
import { cn } from '../../lib/utils'

/** Settings fields share labels with the settings form; fall back to the raw key. */
const FIELD_KEY = (f: string) => `f_${f}` as TKey

/** One change as a readable row: "Bus · price  550 → 600". */
export function ChangeRow({ c }: { c: Change }) {
  const { t } = useI18n()
  const series = useSeries()
  const clients = useClients()
  const vendors = useVendors()
  const label = (s: string) => t(FIELD_KEY(s)) || s
  // Ids are meaningless to people: show the route / client name instead.
  const value = (v: string | null) => {
    if (v === null) return '—'
    if (v === 'yes' || v === 'no') return t(v)
    if (c.field === 'series_id') return series.data?.find((s) => s.id === v)?.code ?? v
    if (c.field === 'client_id') return clients.data?.find((x) => x.id === v)?.name ?? v
    if (c.field === 'vendor_id') return vendors.data?.find((x) => x.id === v)?.name ?? '…'
    return v
  }
  let what: string
  if (c.area === 'settings') what = label(c.key)
  else if (c.area === 'texts') what = t('textsChanged', { lang: c.key })
  else if (c.area === 'fx') what = `1 → ${c.key}`
  else what = c.field ? `${c.label} · ${label(c.field)}` : c.label

  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm">
      {c.action === 'added' && <Plus size={16} className="self-center text-emerald-600" />}
      {c.action === 'removed' && <Minus size={16} className="self-center text-red-600" />}
      <span className={cn(c.action === 'removed' && 'text-slate-400 line-through')}>{what}</span>
      {c.action !== 'changed' && <span className="text-xs text-slate-400">{t(c.action)}</span>}
      {c.action === 'changed' && (c.before !== null || c.after !== null) && (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <span className="rounded-md bg-red-50 px-1.5 text-red-700 line-through decoration-red-300">{value(c.before)}</span>
          <ArrowRight size={12} className="text-slate-400" />
          <span className="rounded-md bg-emerald-50 px-1.5 text-emerald-800">{value(c.after)}</span>
        </span>
      )}
      {c.action !== 'changed' && c.after && <span className="font-mono text-xs text-emerald-800">{value(c.after)}</span>}
      {c.action === 'removed' && c.before && <span className="font-mono text-xs text-slate-400">{value(c.before)}</span>}
    </li>
  )
}

export function ChangeList({ changes, empty }: { changes: Change[]; empty?: string }) {
  const { t } = useI18n()
  if (!changes.length) return <p className="text-sm text-slate-400">{empty ?? t('noChanges')}</p>
  return <ul className="divide-y divide-slate-200">{changes.map((c, i) => <ChangeRow key={i} c={c} />)}</ul>
}

/** Version notes are stored as codes ("restore:3") so they read in every language. */
export function noteText(note: string, first: boolean, t: (k: TKey, v?: Record<string, string | number>) => string): string {
  const [kind, ...rest] = note.split(':')
  const arg = rest.join(':')
  switch (kind) {
    case 'preset': return t('note_preset')
    case 'copy': return t('note_copy', { name: arg })
    case 'scenario': return first ? t('note_scenario_created', { name: arg }) : t('note_scenario', { name: arg })
    case 'restore': return t('note_restore', { n: arg })
    case 'tour': return t('note_tour', { code: arg })
    case 'route': return t('note_route', { code: arg })
    default: return note
  }
}
