/**
 * Picking several rows at once (tours, routes) to act on them together - for now, delete. A checkbox per
 * row and one in the header; while something is picked, a bar says how many, with the action and "Clear".
 * Deleting always asks first (ask), then goes one by one and says what couldn't be deleted.
 */
import { Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { ask, toast } from './overlay'
import { Button } from './ui'

export function useSelection(ids: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Only what is still on screen counts (a filter or search may have hidden some).
  const on = new Set([...picked].filter((x) => ids.includes(x)))
  return {
    picked: on,
    has: (id: string) => on.has(id),
    toggle: (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n }),
    all: on.size > 0 && on.size === ids.length,
    some: on.size > 0 && on.size < ids.length,
    toggleAll: () => setPicked(on.size === ids.length ? new Set() : new Set(ids)),
    clear: () => setPicked(new Set()),
  }
}

/** Delete each url in turn; true when all went. */
export async function deleteAll(urls: string[]): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0
  for (const u of urls) {
    try { await api(u, { method: 'DELETE' }); ok++ } catch { failed++ }
  }
  return { ok, failed }
}

export function BulkBar({ count, onClear, onDelete, title, message }: {
  count: number; onClear: () => void
  onDelete: () => Promise<{ ok: number; failed: number }>
  title: string; message: string      // the question before deleting, and what it means
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  if (!count) return null
  const run = async () => {
    if (!(await ask({ title, message, confirmLabel: t('delete'), danger: true }))) return
    setBusy(true)
    const r = await onDelete()
    setBusy(false)
    onClear()
    toast(r.failed ? 'bulkSomeFailed' : 'bulkDeleted', r.failed ? 'error' : 'ok')
  }
  return (
    <div className="animate-reveal flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2" role="region" aria-label={t('bulkPicked', { n: count })}>
      <span className="text-sm font-medium text-brand-900">{t('bulkPicked', { n: count })}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onClear}><X size={16} aria-hidden />{t('bulkClear')}</Button>
      <Button type="button" size="sm" variant="danger" className="ml-auto" disabled={busy} onClick={() => void run()}>
        <Trash2 size={16} aria-hidden />{t('bulkDelete', { n: count })}
      </Button>
    </div>
  )
}

/** The row's (or header's) checkbox: big enough to hit, and it never opens the row. */
export function PickBox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  return (
    <input type="checkbox" checked={checked} aria-label={label} onChange={onChange} onClick={(e) => e.stopPropagation()}
      ref={(el) => { if (el) el.indeterminate = !!indeterminate }}
      className="h-4 w-4 cursor-pointer rounded accent-brand-600" />
  )
}
