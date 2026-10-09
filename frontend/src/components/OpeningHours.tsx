/**
 * A place's opening hours as the map gives them (kept when it was picked, or got with "Get from the map"):
 * the week, day by day; or a way to get them. Used in the supplier's form and in "what they do".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import type { OpeningHours as Hours } from './PlaceInput'

export function usePlaceHours(names: string[]) {
  const ws = useWorkspace()!
  const list = names.map((x) => x.trim()).filter(Boolean)
  return useQuery({
    queryKey: ['place-hours', ws.id, list.join('|')],
    queryFn: () => api<Record<string, Hours>>(wsPath(ws.id, '/places/hours'), { method: 'POST', body: { names: list } }),
    enabled: list.length > 0, staleTime: 5 * 60_000, meta: { silent: true },
  })
}

/** The week's hours; for a saved supplier, "Get from the map" when they're not known (or to refresh them). */
export function OpeningHoursBox({ names, vendorId, compact }: { names: string[]; vendorId?: string; compact?: boolean }) {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const q = usePlaceHours(names)
  const hours = names.map((n) => q.data?.[n.trim()]).find(Boolean)
  const get = useMutation({
    mutationFn: () => api<{ hours: Hours }>(wsPath(ws.id, `/vendors/${vendorId}/hours`), { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['place-hours', ws.id] }),
  })
  return (
    <div className={compact ? 'text-xs text-slate-600' : 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm'}>
      <p className="flex items-center gap-1.5 font-medium text-slate-700"><Clock size={compact ? 12 : 14} aria-hidden />{t('openingHours')}</p>
      {hours ? (
        hours.text.length ? (
          <ul className={compact ? 'mt-0.5 grid grid-cols-1 gap-x-3 sm:grid-cols-2' : 'mt-1 grid grid-cols-1 gap-x-4 text-slate-700 sm:grid-cols-2'}>
            {hours.text.map((x) => <li key={x}>{x}</li>)}
          </ul>
        ) : <p className="mt-0.5 text-slate-600">{hours.periods.map((p) => `${p.open}–${p.close}`).join(', ')}</p>
      ) : (
        <p className="mt-0.5 text-slate-500">{t('openingHoursNone')}</p>
      )}
      {vendorId && (
        <button type="button" onClick={() => get.mutate()} disabled={get.isPending}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline disabled:opacity-50">
          <RefreshCw size={12} aria-hidden className={get.isPending ? 'animate-spin' : ''} />{hours ? t('openingHoursRefresh') : t('openingHoursGet')}
        </button>
      )}
      {get.isError && <p className="mt-0.5 text-xs text-amber-700">{t('openingHoursNotFound')}</p>}
    </div>
  )
}
