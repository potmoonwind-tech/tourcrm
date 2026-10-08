import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask, askText } from '../components/overlay'
import { CheckCircle2, Circle, Lock, LockOpen, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, ErrorText, Input } from '../components/ui'
import { api, atLeast, type CloseCheck, type Tour, type TourPhase, can } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'

const STEPS: TourPhase[] = ['inquiry', 'confirmed', 'operating', 'settling', 'closed']

/** One line from first request to closed tour: where this tour is now. */
export function LifecycleBar({ tour }: { tour: Tour }) {
  const { t } = useI18n()
  const cancelled = tour.status === 'cancelled'
  // A cancelled tour still settles (penalties paid) and closes.
  const current = tour.phase === 'cancelled' ? 'settling' : tour.phase
  const at = STEPS.indexOf(current)
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs font-semibold">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-1">
          <span className={cn('rounded-full px-2.5 py-1',
            i < at ? 'bg-brand-100 text-brand-800' : i === at ? (cancelled ? 'bg-red-600 text-white' : 'bg-brand-600 text-white') : 'bg-slate-100 text-slate-400')}>
            {i === at && cancelled && s !== 'closed' ? t('life_cancelled') : t(`life_${s}` as TKey)}
          </span>
          {i < STEPS.length - 1 && <span className="text-slate-300">›</span>}
        </li>
      ))}
    </ol>
  )
}

export const closeKey = (ws: string, tourId: string) => ['closeCheck', ws, tourId]

/** The close checklist, closing, and the closed banner with reopen. */
export function ClosePanel({ tour, onTab }: { tour: Tour; onTab: (tab: string) => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const show = tour.phase === 'settling' || tour.phase === 'cancelled' || tour.phase === 'closed'
  const check = useQuery({
    queryKey: closeKey(ws.id, tour.id), enabled: show,
    queryFn: () => api<CloseCheck>(wsPath(ws.id, `/tours/${tour.id}/close-check`)),
  })
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)      // a short bar until opened: the tour's work stays in view
  const done = () => { for (const k of ['tour', 'tours', 'closeCheck', 'toClose']) qc.invalidateQueries({ queryKey: [k, ws.id] }) }
  const close = useMutation({
    mutationFn: (force: boolean) => api<CloseCheck>(wsPath(ws.id, `/tours/${tour.id}/close`), { method: 'POST', body: { note, force } }),
    onSuccess: () => { setNote(''); done() },
  })
  const reopen = useMutation({
    mutationFn: (why: string) => api<CloseCheck>(wsPath(ws.id, `/tours/${tour.id}/reopen`), { method: 'POST', body: { note: why } }),
    onSuccess: done,
  })
  const c = check.data
  if (!show || !c) return null
  const cur = ws.base_currency

  if (c.phase === 'closed') {
    const profit = (c.final_revenue ?? 0) - (c.final_cost ?? 0)
    return (
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 border-slate-300 bg-slate-50 px-5 py-4">
        <Lock size={18} className="text-slate-500" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('tourClosed', { date: c.closed_at ? fmt(c.closed_at.slice(0, 10), lang) : '', who: c.closed_by ?? '—' })}</p>
          <p className="text-sm text-slate-600">{t('tourClosedHelp')}{c.close_note && ` · “${c.close_note}”`}</p>
        </div>
        <span className="text-sm">{t('revenue')} <b className="tabular-nums">{money(c.final_revenue ?? 0, cur)}</b></span>
        <span className="text-sm">{t('costs')} <b className="tabular-nums">{money(c.final_cost ?? 0, cur)}</b></span>
        <span className="text-sm">{t('profit')} <b className={cn('tabular-nums', profit < 0 ? 'text-red-600' : 'text-emerald-700')}>{money(profit, cur)}</b></span>
        {atLeast(ws.role, 'admin') && (
          <Button size="sm" variant="secondary" disabled={reopen.isPending}
            onClick={() => void askText({ title: t('reopenWhy'), confirmLabel: t('reopen') }).then((why) => why && reopen.mutate(why))}>
            <LockOpen size={14} />{t('reopen')}
          </Button>
        )}
        <div className="w-full"><ErrorText error={reopen.error} /></div>
      </Card>
    )
  }

  if (!can(ws, 'finance', 'operations')) return null
  const blocking = c.items.filter((i) => i.blocking)
  const done_n = blocking.filter((i) => i.ok).length
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
        <h3 className="font-semibold">{t('closeTour')}</h3>
        <span className="text-sm text-slate-500">{t('closeProgress', { done: done_n, total: blocking.length })}</span>
        <div className="flex-1" />
        <span className="text-sm">{t('profit')} <b className="tabular-nums">{money(c.profit, cur)}</b></span>
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('hideChecklist') : t('showChecklist')}</Button>
      </div>
      {open && <>
      <ul className="grid gap-x-6 gap-y-1.5 px-5 py-3 text-sm sm:grid-cols-2">
        {c.items.map((i) => (
          <li key={i.key} className="flex items-start gap-2">
            {i.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
              : i.blocking ? <XCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
                : <Circle size={16} className="mt-0.5 shrink-0 text-amber-500" />}
            <span className={cn(i.ok && 'text-slate-500')}>
              {t(`check_${i.key}` as TKey)}
              {!i.ok && i.count > 0 && <span className="text-slate-500"> · {t('checkCount', { n: i.count })}</span>}
              {!i.ok && i.detail && <span className="text-slate-500"> · {i.detail}</span>}
              {!i.ok && i.link && <button type="button" className="ml-2 text-brand-600 hover:underline" onClick={() => onTab(i.link)}>{t('fixIt')}</button>}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={c.ready ? t('closeNotePh') : t('forceNotePh')}
          maxLength={500} className="h-9 min-w-48 flex-1" />
        {c.ready ? (
          <Button disabled={close.isPending} onClick={() => void ask({ title: t('confirmClose') }).then((ok) => ok && close.mutate(false))}><Lock size={15} />{t('closeTour')}</Button>
        ) : c.can_force && blocking.find((i) => i.key === 'ended')?.ok ? (
          <Button variant="secondary" disabled={close.isPending || !note.trim()} title={t('forceHelp')}
            onClick={() => void ask({ title: t('confirmForceClose'), danger: true }).then((ok) => ok && close.mutate(true))}><Lock size={15} />{t('closeAnyway')}</Button>
        ) : <span className="text-sm text-slate-500">{t('notReadyToClose')}</span>}
      </div>
      <div className="px-5 pb-3"><ErrorText error={close.error} /></div>
      </>}
    </Card>
  )
}

/** Dashboard: ended tours still waiting to be closed, and what blocks each. */
export function ToClose() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const list = useQuery({
    queryKey: ['toClose', ws.id], enabled: can(ws, 'finance', 'operations'),
    queryFn: () => api<{ id: string; code: string; color: string; end_date: string; status: string; open_items: string[] }[]>(wsPath(ws.id, '/tours-to-close')),
  })
  if (!list.data?.length) return null
  return (
    <Card className="min-w-0">
      <h2 className="border-b border-slate-100 px-5 py-3 font-semibold">{t('waitingToClose')} · {list.data.length}</h2>
      <ul className="divide-y divide-slate-100">
        {list.data.map((x) => (
          <li key={x.id}>
            <Link to={`/w/${ws.id}/tours/${x.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm hover:bg-slate-50">
              <span className="font-mono font-semibold">{x.code}</span>
              <span className="text-slate-500">{fmt(x.end_date, lang)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                {x.open_items.length ? x.open_items.map((k) => t(`check_${k}` as TKey)).join(' · ') : t('readyToClose')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
