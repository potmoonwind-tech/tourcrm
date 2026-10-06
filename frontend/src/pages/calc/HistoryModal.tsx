import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Drawer, ask } from '../../components/overlay'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button, ErrorText, Input } from '../../components/ui'
import { api, type QuoteOut, type QuoteVersion, type VersionDiff } from '../../lib/api'
import { wsPath } from '../../lib/data'
import { fmt } from '../../lib/dates'
import { useI18n } from '../../lib/i18n'
import { useWorkspace } from '../../lib/session'
import { cn, money } from '../../lib/utils'
import { ChangeList, noteText } from './changes'

/** Every saved version, what each one changed, its effect on prices, and restore. */
export function HistoryModal({ quoteId, dirty, onRestored, onClose }: {
  quoteId: string; dirty: boolean; onRestored: (q: QuoteOut) => void; onClose: () => void
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const base = wsPath(ws.id, `/quotes/${quoteId}`)
  const versions = useQuery({ queryKey: ['quoteVersions', ws.id, quoteId], queryFn: () => api<QuoteVersion[]>(`${base}/versions`) })
  const [picked, setPicked] = useState<number | null>(null)
  const n = picked ?? versions.data?.[0]?.number ?? null
  const diff = useQuery({
    queryKey: ['quoteVersion', ws.id, quoteId, n], enabled: n !== null,
    queryFn: () => api<VersionDiff>(`${base}/versions/${n}`),
  })
  const restore = useMutation({
    mutationFn: (num: number) => api<QuoteOut>(`${base}/versions/${num}/restore`, { method: 'POST' }),
    onSuccess: (q) => { onRestored(q); onClose() },
  })
  const first = versions.data?.at(-1)?.number
  const latest = versions.data?.[0]?.number
  // Local date via the app's own formatter (Georgian month names), plus the time.
  const when = (s: string) => {
    const d = new Date(s)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `${fmt(day, lang)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const moved = (diff.data?.impact ?? []).filter((x) => x.before !== x.after)

  return (
    <Drawer size="xl" title={t('history')} onClose={onClose}>
      <div className="grid gap-4 md:grid-cols-[15rem_1fr]">
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
          {versions.data?.map((v) => (
            <li key={v.number}>
              <button type="button" onClick={() => setPicked(v.number)}
                className={cn('w-full rounded-lg px-3 py-2 text-left text-sm', v.number === n ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-slate-50')}>
                <span className="flex items-baseline justify-between gap-2">
                  <b>{t('versionN', { n: v.number })}</b>
                  <span className="text-xs text-slate-400">{when(v.created_at)}</span>
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {v.created_by ?? '—'}{v.number !== first && ` · ${t('changesN', { n: v.changes })}`}
                </span>
                {v.note && <span className="mt-0.5 block truncate text-xs text-slate-600">{noteText(v.note, v.number === first, t)}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 space-y-4">
          {n !== null && <VersionName key={n} quoteId={quoteId} number={n} note={versions.data?.find((v) => v.number === n)?.note ?? ''} />}
          {diff.data && (
            <>
              <ChangeList changes={diff.data.changes} />
              {moved.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">{t('priceEffect')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {moved.map((x) => {
                      const d = (x.after ?? 0) - (x.before ?? 0)
                      return (
                        <span key={x.tourists} className="rounded-md bg-slate-50 px-2 py-1 text-xs tabular-nums">
                          {x.label}: {money(x.before ?? 0)} → <b>{money(x.after ?? 0)}</b>{' '}
                          <span className={d > 0 ? 'text-red-600' : 'text-emerald-700'}>{d > 0 ? '+' : ''}{money(d)}</span>
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}
              {n !== null && n !== latest && (
                <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
                  <Button variant="secondary" disabled={restore.isPending}
                    onClick={() => void ask({ title: t('confirmRestore', { n }) }).then((ok) => ok && restore.mutate(n))}>
                    <RotateCcw size={16} />{t('restoreVersion')}
                  </Button>
                  {dirty && <span className="text-sm text-amber-600">{t('unsaved')}</span>}
                </div>
              )}
              <ErrorText error={restore.error} />
            </>
          )}
        </div>
      </div>
    </Drawer>
  )
}

/** A name for a version ("Sent to the client"), so it is easy to find again. */
function VersionName({ quoteId, number, note }: { quoteId: string; number: number; note: string }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [text, setText] = useState(note)
  const name = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/quotes/${quoteId}/versions/${number}`), { method: 'PATCH', body: { note: text } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['quoteVersions', ws.id, quoteId] }),
  })
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); name.mutate() }}>
      <Input size="sm" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder={t('versionNamePh')}
        aria-label={t('versionName')} className="min-w-0 flex-1" />
      <Button type="submit" size="sm" variant="secondary" disabled={name.isPending || text === note}>{t('versionNameSave')}</Button>
      <ErrorText error={name.error} />
    </form>
  )
}
