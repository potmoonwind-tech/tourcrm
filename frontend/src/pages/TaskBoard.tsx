/**
 * Tasks as a board: by stage (to do → in progress → waiting → done) or by person (who does what).
 * Moving a card does the work it stands for - a booking moved to "waiting" is asked of the supplier, to
 * "done" is confirmed - and dropping it on a person passes it to them. Every move can be undone.
 * A card opens the task's panel: where it stands, pass it on with a note, and its history.
 */
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CornerDownRight, GripVertical } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Drawer, Menu, toast } from '../components/overlay'
import { Button, ErrorText, Field, SegmentedControl, Select, Spinner, Textarea } from '../components/ui'
import { api, type TaskItem, type TaskStage } from '../lib/api'
import { useMembers, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'

export const STAGES: TaskStage[] = ['todo', 'doing', 'waiting', 'done']

/** What the task says, in the app's words ("Book Hotel Ushba", "Pay Guide 300 GEL"). */
export function taskTitle(x: TaskItem, t: (k: TKey, v?: Record<string, string | number>) => string) {
  if (x.kind === 'own') return x.title
  if (x.kind === 'pay') return t('task_pay', { name: x.title, amount: money(x.amount ?? 0, x.currency ?? undefined) })
  return t(`task_${x.kind}` as TKey, { name: x.title })
}

const initials = (name?: string | null) => (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'

/** Move and pass, with the list updated at once and "Undo" in the notice. */
export function useTaskActions(queryKey: unknown[]) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const patchList = (key: string, patch: Partial<TaskItem>) =>
    qc.setQueryData<TaskItem[]>(queryKey, (list) => list?.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tasks', ws.id] })
    qc.invalidateQueries({ queryKey: ['bookings', ws.id] })
    qc.invalidateQueries({ queryKey: ['taskHistory', ws.id] })
  }
  const move = useMutation({
    mutationFn: ({ x, stage }: { x: TaskItem; stage: TaskStage; undo?: boolean }) =>
      api(wsPath(ws.id, '/tasks/move'), { method: 'POST', body: { key: x.key, stage } }),
    onMutate: ({ x, stage }) => patchList(x.key, { stage }),
    onError: () => toast('taskMoveFailed', 'error'),
    onSuccess: (_r, { x, stage, undo }) => {
      if (!undo) toast('taskMovedToast', 'ok', { label: t('undo'), onClick: () => move.mutate({ x: { ...x, stage }, stage: x.stage, undo: true }) })
    },
    onSettled: refresh,
  })
  const pass = useMutation({
    mutationFn: ({ x, to, note }: { x: TaskItem; to: string; note?: string; undo?: boolean }) =>
      api(wsPath(ws.id, '/tasks/pass'), { method: 'POST', body: { key: x.key, assignee_id: to, note: note ?? '' } }),
    onMutate: ({ x, to }) => patchList(x.key, { assignee_id: to }),
    onError: () => toast('taskPassFailed', 'error'),
    onSuccess: (_r, { x, to, undo }) => {
      if (!undo && x.assignee_id) toast('taskPassedToast', 'ok', { label: t('undo'), onClick: () => pass.mutate({ x: { ...x, assignee_id: to }, to: x.assignee_id!, undo: true }) })
      else if (!undo) toast('taskPassedToast')
    },
    onSettled: refresh,
  })
  return { move, pass }
}

export function TaskBoard({ tasks, by, queryKey, onOpen }: {
  tasks: TaskItem[]; by: 'stage' | 'person'; queryKey: unknown[]; onOpen: (x: TaskItem) => void
}) {
  const { t } = useI18n()
  const members = useMembers()
  const { move, pass } = useTaskActions(queryKey)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }), useSensor(KeyboardSensor))
  const columns: { id: string; title: string; list: TaskItem[]; hint?: string }[] = by === 'stage'
    ? STAGES.map((s) => ({ id: s, title: t(`stage_${s}` as TKey), list: tasks.filter((x) => x.stage === s), hint: s === 'done' ? t('stageDoneHint') : undefined }))
    : [{ id: '', title: t('nobodyYet'), list: tasks.filter((x) => !x.assignee_id) },
       ...(members.data ?? []).map((m) => ({ id: m.user_id, title: m.full_name || m.email, list: tasks.filter((x) => x.assignee_id === m.user_id) }))]
  // The dragged card floats above the columns (they scroll, so the card itself would be cut off).
  const [dragged, setDragged] = useState<TaskItem | null>(null)
  const onDragEnd = (e: DragEndEvent) => {
    setDragged(null)
    const x = tasks.find((y) => y.key === e.active.id)
    const to = e.over?.id as string | undefined
    if (!x || to === undefined) return
    if (by === 'stage') {
      if (to === x.stage) return
      if (to === 'done' && x.kind === 'pay') { toast('payDoneHint', 'error'); return }
      move.mutate({ x, stage: to as TaskStage })
    } else if (to && to !== x.assignee_id) {
      pass.mutate({ x, to })
    }
  }
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragCancel={() => setDragged(null)}
      onDragStart={(e) => setDragged(tasks.find((y) => y.key === e.active.id) ?? null)}>
      <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
        {columns.map((col) => (
          <Column key={col.id || 'nobody'} id={col.id} title={col.title} count={col.list.length} hint={col.hint}>
            {col.list.map((x) => <TaskCard key={x.key} x={x} showWho={by === 'stage'} onOpen={() => onOpen(x)}
              onMove={(stage) => (stage === 'done' && x.kind === 'pay' ? toast('payDoneHint', 'error') : move.mutate({ x, stage }))} />)}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {dragged && (
          <div className="w-68 rotate-2 rounded-lg border border-brand-300 bg-white p-2.5 text-sm font-medium text-slate-800 shadow-xl">
            {taskTitle(dragged, t)}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function Column({ id, title, count, hint, children }: { id: string; title: string; count: number; hint?: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <section ref={setNodeRef} aria-label={title}
      className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-slate-100/70 p-2 transition-colors', isOver && 'bg-brand-50 ring-2 ring-brand-300')}>
      <h3 className="flex items-center gap-2 px-1.5 pb-2 pt-1 text-sm font-semibold text-slate-700">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="rounded-full bg-white px-2 text-xs font-medium tabular-nums text-slate-500">{count}</span>
      </h3>
      {/* Each column scrolls on its own, so a long "to do" doesn't push the board off the screen. */}
      <div className="stagger flex max-h-[calc(100vh-15rem)] min-h-24 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-0.5">
        {children}
        {hint && !count && <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500">{hint}</p>}
      </div>
    </section>
  )
}

function TaskCard({ x, showWho, onOpen, onMove }: { x: TaskItem; showWho: boolean; onOpen: () => void; onMove: (s: TaskStage) => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: x.key })
  const late = x.due_date && x.due_date < today() && x.stage !== 'done'
  const title = taskTitle(x, t)
  return (
    <article ref={setNodeRef}
      className={cn('group rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition-shadow hover:shadow-md',
        isDragging && 'border-dashed opacity-40')}>
      <div className="flex items-start gap-1.5">
        <button type="button" {...listeners} {...attributes} aria-label={t('dragTask', { name: title })} title={t('dragTaskTip')}
          className="-ml-1 mt-0.5 flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-slate-400 hover:bg-slate-100 active:cursor-grabbing">
          <GripVertical size={14} aria-hidden />
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className={cn('block text-sm font-medium leading-snug text-slate-800', x.stage === 'done' && 'text-slate-400 line-through')}>{title}</span>
        </button>
        <Menu kind="icon" label={`${t('moreActions')}: ${title}`} items={[
          { label: t('openTask'), onClick: onOpen },
          ...STAGES.filter((s) => s !== x.stage).map((s) => ({ label: `${t('moveTo')}: ${t(`stage_${s}` as TKey)}`, icon: <ArrowRight size={16} />, onClick: () => onMove(s) })),
        ]} />
      </div>
      {x.passed_note && (
        <p className="mt-1.5 flex gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
          <CornerDownRight size={13} className="mt-px shrink-0" aria-hidden />
          <span className="min-w-0"><b className="font-semibold">{x.passed_by}:</b> {x.passed_note}</span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
        {x.tour_code && <Link to={`/w/${ws.id}/tours/${x.tour_id}`} className="font-mono hover:text-slate-800 hover:underline">{x.tour_code}</Link>}
        {x.due_date && <span className={cn('tabular-nums', late && 'font-semibold text-red-600')}>{fmt(x.due_date, lang)}</span>}
        <span className="flex-1" />
        {showWho && (
          <span title={x.assignee_name ?? t('nobodyYet')}
            className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold',
              x.assignee_id ? 'bg-brand-100 text-brand-800' : 'border border-dashed border-slate-300 text-slate-400')}>
            {x.assignee_id ? initials(x.assignee_name) : '?'}
          </span>
        )}
      </div>
    </article>
  )
}

interface TaskEventOut { kind: 'created' | 'passed' | 'moved' | 'done' | 'reopened'; by: string | null; to: string | null; stage: TaskStage | null; note: string; at: string }

/** One task: where it stands, pass it on with a note, and what happened to it so far. */
export function TaskPanel({ x, queryKey, onClose }: { x: TaskItem; queryKey: unknown[]; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const members = useMembers()
  const { move, pass } = useTaskActions(queryKey)
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [stage, setStage] = useState<TaskStage>(x.stage)
  const history = useQuery({
    queryKey: ['taskHistory', ws.id, x.key],
    queryFn: () => api<TaskEventOut[]>(wsPath(ws.id, `/tasks/history?key=${encodeURIComponent(x.key)}`)),
  })
  const title = taskTitle(x, t)
  const when = (s: string) => { const d = new Date(s); return `${fmt(s.slice(0, 10), lang)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const line = (e: TaskEventOut) => t(`hist_${e.kind}` as TKey, { by: e.by ?? '—', to: e.to ?? '—', stage: e.stage ? t(`stage_${e.stage}` as TKey) : '' })
  return (
    <Drawer title={title} subtitle={[x.tour_code, x.due_date && fmt(x.due_date, lang), x.assignee_name ?? t('nobodyYet')].filter(Boolean).join(' · ')}
      onClose={onClose} size="md" footer={<div className="flex w-full justify-between">
        {x.link ? <Link to={`/w/${ws.id}/${x.link}`} className="inline-flex h-10 items-center text-sm font-medium text-brand-700 hover:underline">{t('openWhereItIs')}</Link> : <span />}
        <Button onClick={onClose}>{t('done')}</Button>
      </div>}>
      <div className="space-y-6">
        {x.passed_note && (
          <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <CornerDownRight size={16} className="mt-0.5 shrink-0" aria-hidden /><span><b>{x.passed_by}:</b> {x.passed_note}</span>
          </p>
        )}
        {x.note && <p className="whitespace-pre-line text-sm text-slate-700">{x.note}</p>}

        <Field label={t('taskStage')}>
          <SegmentedControl label={t('taskStage')} value={stage} onChange={(s) => {
            if (s === 'done' && x.kind === 'pay') { toast('payDoneHint', 'error'); return }
            setStage(s); move.mutate({ x: { ...x, stage }, stage: s })
          }} options={STAGES.map((s) => [s, t(`stage_${s}` as TKey)])} />
        </Field>

        <form className="space-y-3 rounded-xl border border-slate-200 p-4" onSubmit={(e) => {
          e.preventDefault()
          if (!to) return
          pass.mutate({ x, to, note }, { onSuccess: onClose })
        }}>
          <h3 className="text-sm font-semibold text-slate-800">{t('passTo')}</h3>
          <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('passTo')} required>
            <option value="">{t('pickPerson')}</option>
            {members.data?.filter((m) => m.user_id !== x.assignee_id).map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
          </Select>
          <Textarea rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder={t('passNotePh')} aria-label={t('passNote')} />
          <ErrorText error={pass.error} />
          <div className="flex justify-end"><Button type="submit" variant="secondary" disabled={!to || pass.isPending}>{t('passBtn')}</Button></div>
        </form>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-800">{t('taskHistory')}</h3>
          {history.isLoading ? <Spinner /> : !history.data?.length ? <p className="text-sm text-slate-500">{t('taskHistoryEmpty')}</p> : (
            <ol className="space-y-3 border-l-2 border-slate-200 pl-4">
              {history.data.map((e, i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-500 ring-2 ring-white" aria-hidden />
                  <p className="text-slate-800">{line(e)}</p>
                  {e.note && <p className="mt-0.5 rounded bg-slate-50 px-2 py-1 text-slate-600">“{e.note}”</p>}
                  <p className="text-xs text-slate-400">{when(e.at)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Drawer>
  )
}
