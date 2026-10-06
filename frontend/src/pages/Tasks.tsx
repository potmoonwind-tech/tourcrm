/**
 * Tasks: what each person has to do — book suppliers, chase confirmations, confirm again after a
 * change, cancel, pay suppliers, plus tasks people write. Grouped by when they're due. Booking and
 * payment tasks are done by doing the thing (the booking moves on, the payment is recorded).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BedDouble, Bus, CheckCircle2, Circle, CreditCard, ListTodo, MapPin, Plus, Settings2, Ticket, Trash2, User, Utensils } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Dialog, Label, TONE, type Tone } from '../components/overlay'
import { EmptyState } from '../components/tour'
import { Button, Card, ErrorText, Field, Input, Select, Spinner } from '../components/ui'
import { api, type TaskItem, type TaskKind, type TaskType, type TaskTypeColor, type TourSummary, type WorkKind, can } from '../lib/api'
import { useMembers, wsPath } from '../lib/data'
import { addDays, fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useMe, useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { PageHeader } from './Dashboard'

const KIND_TONE: Record<TaskKind, Tone> = {
  book: 'grey', chase: 'blue', reconfirm: 'orange', cancel: 'red', problem: 'red', pay: 'purple', own: 'light',
}
const WORK_ICON: Record<WorkKind, ReactNode> = {
  hotel: <BedDouble size={15} />, meal: <Utensils size={15} />, transport: <Bus size={15} />,
  guide: <User size={15} />, activity: <Ticket size={15} />, other: <MapPin size={15} />,
}

export function useTasks(who: string) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['tasks', ws.id, who], queryFn: () => api<TaskItem[]>(wsPath(ws.id, `/tasks?who=${encodeURIComponent(who)}`)) })
}

/** "Overdue", "Today", "This week", "Later", "No date". */
function bucket(due: string | null) {
  const now = today()
  if (!due) return 'none'
  if (due < now) return 'late'
  if (due === now) return 'today'
  if (due <= addDays(now, 7)) return 'week'
  return 'later'
}
const BUCKETS = ['late', 'today', 'week', 'later', 'none'] as const

export function TasksPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const manager = can(ws, 'operations', 'finance')   // sees and gives everyone's tasks
  const [who, setWho] = useState('me')
  const tasks = useTasks(who)
  const members = useMembers()
  const [adding, setAdding] = useState(false)
  const [editTypes, setEditTypes] = useState(false)
  const [type, setType] = useState('')          // '' = every type
  const types = ws.task_types ?? []
  const all = tasks.data ?? []
  // One chip per type that has tasks now, with its count; your own types come after the built-in ones.
  const counts = new Map<string, number>()
  for (const x of all) counts.set(typeKey(x, types), (counts.get(typeKey(x, types)) ?? 0) + 1)
  const chips: [string, string][] = [
    ...KINDS.filter((k) => counts.has(k)).map((k): [string, string] => [k, t(`taskKind_${k}` as TKey)]),
    ...types.filter((y) => counts.has(`t:${y.id}`)).map((y): [string, string] => [`t:${y.id}`, y.name]),
    ...(counts.has('own') ? [['own', t('taskKindOther')] as [string, string]] : []),
  ]
  const rows = type && counts.has(type) ? all.filter((x) => typeKey(x, types) === type) : all
  return (
    <>
      <PageHeader title={t('tasks')} subtitle={t('tasksHelp')}
        action={<Button onClick={() => setAdding(true)}><Plus size={16} />{t('newTask')}</Button>} />
      <div className="space-y-4 p-4 md:p-8">
        <div className="flex flex-wrap items-center gap-2">
          {[['me', t('tasksMine')], ...(manager ? [['all', t('tasksEveryone')], ['nobody', t('tasksNobody')]] : [])].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setWho(k)}
              className={cn('rounded-full border px-3 py-1 text-sm font-medium', who === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
              {label}
            </button>
          ))}
          {manager && (
            <Select value={members.data?.some((m) => m.user_id === who) ? who : ''} onChange={(e) => e.target.value && setWho(e.target.value)} className="h-8 w-48 text-sm">
              <option value="">{t('tasksOfPerson')}</option>
              {members.data?.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
            </Select>
          )}
        </div>
        {(chips.length > 1 || manager) && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label={t('taskType')}>
            {chips.length > 1 && [['', t('allTypes'), all.length] as const, ...chips.map(([k, label]) => [k, label, counts.get(k) ?? 0] as const)].map(([k, label, n]) => (
              <button key={k} type="button" onClick={() => setType(k)} aria-pressed={type === k || (!k && !counts.has(type))}
                className={cn('rounded-lg px-2.5 py-1 text-xs font-medium', (type === k || (!k && !counts.has(type))) ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
                {label} <span className="tabular-nums opacity-70">{n}</span>
              </button>
            ))}
            {manager && (
              <button type="button" onClick={() => setEditTypes(true)} className="ml-1 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                <Settings2 size={13} />{t('taskTypes')}
              </button>
            )}
          </div>
        )}
        {tasks.isLoading ? <div className="flex justify-center py-10"><Spinner /></div>
          : rows.length === 0 ? <EmptyState title={t('noTasks')} hint={t('noTasksHint')} /> : (
            BUCKETS.map((bk) => {
              const list = rows.filter((x) => bucket(x.due_date) === bk)
              if (!list.length) return null
              return (
                <section key={bk}>
                  <h2 className={cn('mb-2 text-sm font-semibold', bk === 'late' ? 'text-red-700' : 'text-slate-600')}>{t(`due_${bk}` as TKey)} · {list.length}</h2>
                  <Card className="divide-y divide-slate-100">
                    {list.map((x) => <TaskRow key={x.key} x={x} showWho={who !== 'me'} />)}
                  </Card>
                </section>
              )
            })
          )}
      </div>
      {adding && <NewTaskDialog onClose={() => setAdding(false)} />}
      {editTypes && <TaskTypesDialog onClose={() => setEditTypes(false)} />}
    </>
  )
}

export function TaskRow({ x, showWho, compact }: { x: TaskItem; showWho?: boolean; compact?: boolean }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const tick = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tasks/${x.task_id}`), { method: 'PATCH', body: { done: !x.done } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', ws.id] }),
  })
  const late = x.due_date && x.due_date < today()
  const ownType = (ws.task_types ?? []).find((y) => y.id === x.type_id)
  const title = x.kind === 'own' ? x.title
    : x.kind === 'pay' ? t('task_pay', { name: x.title, amount: money(x.amount ?? 0, x.currency ?? undefined) })
      : t(`task_${x.kind}` as TKey, { name: x.title })
  return (
    <div className={cn('flex items-center gap-3', compact ? 'px-4 py-2.5' : 'px-4 py-3')}>
      {x.kind === 'own' ? (
        <button type="button" onClick={() => tick.mutate()} disabled={tick.isPending} aria-label={x.done ? t('markNotDone') : t('markDone')}
          className={cn('shrink-0', x.done ? 'text-emerald-600' : 'text-slate-300 hover:text-emerald-600')}>
          {x.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
        </button>
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500">
          {x.kind === 'pay' ? <CreditCard size={14} /> : x.vendor_kind ? WORK_ICON[x.vendor_kind] : <ListTodo size={14} />}
        </span>
      )}
      <Link to={x.link ? `/w/${ws.id}/${x.link}` : '#'} className={cn('min-w-0 flex-1', x.link && 'hover:underline', x.done && 'text-slate-400 line-through')}>
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-slate-500">
          {x.tour_code && <span className="font-mono">{x.tour_code}</span>}
          {x.count ? <span> · {t('nDepartures', { n: x.count })}</span> : null}
          {x.tour_start && <span> · {fmt(x.tour_start, lang)}</span>}
          {showWho && <span> · {x.assignee_name ?? t('nobodyYet')}</span>}
          {x.note && <span> · {x.note}</span>}
        </span>
      </Link>
      {!compact && x.kind !== 'own' && <Label tone={KIND_TONE[x.kind]} wide={false}>{t(`taskKind_${x.kind}` as TKey)}</Label>}
      {x.kind === 'own' && ownType && <Label tone={ownType.color} wide={false}>{ownType.name}</Label>}
      {x.due_date && <span className={cn('shrink-0 text-xs tabular-nums', late ? 'font-semibold text-red-600' : 'text-slate-500')}>{fmt(x.due_date, lang)}</span>}
      {!compact && !x.done && <AssignPick x={x} />}
    </div>
  )
}

/** Who does this one task. Managers give it to anyone; others can take a task nobody has.
 *  Booking and paying the same supplier are separate tasks, so they can go to different people. */
function AssignPick({ x }: { x: TaskItem }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const manager = can(ws, 'operations', 'finance')   // sees and gives everyone's tasks
  const members = useMembers()
  const assign = useMutation({
    mutationFn: (assignee_id: string | null) => api(wsPath(ws.id, '/tasks/assign'), { method: 'PUT', body: { key: x.key, assignee_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', ws.id] }),
  })
  if (!manager) {
    return x.assignee_id ? null : (
      <Button size="sm" variant="secondary" disabled={assign.isPending || !me} onClick={() => assign.mutate(me!.user.id)}>{t('takeIt')}</Button>
    )
  }
  return (
    <Select aria-label={t('assignTo')} title={t('assignTo')} value={x.assignee_id ?? ''} disabled={assign.isPending}
      onChange={(e) => assign.mutate(e.target.value || null)}
      className={cn('h-8 w-36 shrink-0 text-xs', !x.assignee_id && 'border-amber-300 bg-amber-50 text-amber-900')}>
      <option value="">{t('nobodyYet')}</option>
      {members.data?.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
    </Select>
  )
}

export function NewTaskDialog({ onClose, tourId }: { onClose: () => void; tourId?: string }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const members = useMembers()
  const tours = useQuery({ queryKey: ['tours', ws.id, 'forTasks'], enabled: !tourId,
    queryFn: () => api<TourSummary[]>(wsPath(ws.id, `/tours?date_from=${today()}`)) })
  const [f, setF] = useState({ title: '', note: '', assignee_id: me?.user.id ?? '', due_date: '', tour_id: tourId ?? '', type_id: '' })
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, '/tasks'), { method: 'POST', body: {
      ...f, assignee_id: f.assignee_id || null, due_date: f.due_date || null, tour_id: f.tour_id || null, type_id: f.type_id || null } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks', ws.id] }); onClose() },
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <Dialog title={t('newTask')} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }} className="space-y-4">
        <Field label={t('whatToDo')}><Input required autoFocus value={f.title} onChange={set('title')} placeholder={t('taskPh')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('whoDoesIt')}>
            <Select value={f.assignee_id} onChange={set('assignee_id')}>
              <option value="">{t('nobodyYet')}</option>
              {members.data?.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
            </Select>
          </Field>
          <Field label={t('dueDate')}><Input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        </div>
        <TypePick value={f.type_id} onChange={(type_id) => setF({ ...f, type_id })} />
        {!tourId && (
          <Field label={t('tour')}>
            <Select value={f.tour_id} onChange={set('tour_id')}>
              <option value="">—</option>
              {tours.data?.map((x) => <option key={x.id} value={x.id}>{x.code}{x.client_name ? ` · ${x.client_name}` : ''}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('notes')}><Input value={f.note} onChange={set('note')} /></Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={save.isPending}>{t('create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}


const KINDS: TaskKind[] = ['book', 'chase', 'reconfirm', 'cancel', 'problem', 'pay']
const COLORS: TaskTypeColor[] = ['blue', 'green', 'orange', 'red', 'purple', 'dark', 'grey']

/** The filter a task falls under: its built-in kind, or "t:<id>" for an own task with a type, or "own". */
function typeKey(x: TaskItem, types: TaskType[]) {
  if (x.kind !== 'own') return x.kind
  return x.type_id && types.some((y) => y.id === x.type_id) ? `t:${x.type_id}` : 'own'
}

const newTypeId = () => Math.random().toString(36).slice(2, 10)

function useSaveTypes() {
  const ws = useWorkspace()!
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (list: TaskType[]) => api<TaskType[]>(wsPath(ws.id, '/tasks/types'), { method: 'PUT', body: list }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })
}

/** Type of an own task; managers can add a new type without leaving the dialog. */
function TypePick({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const types = ws.task_types ?? []
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const saveTypes = useSaveTypes()
  const canAdd = can(ws, 'operations', 'finance')
  if (!types.length && !canAdd) return null
  const add = () => {
    const clean = name.trim()
    if (!clean) return
    const found = types.find((y) => y.name.toLowerCase() === clean.toLowerCase())
    if (found) { onChange(found.id); setAdding(false); return }
    const y: TaskType = { id: newTypeId(), name: clean, color: COLORS[types.length % COLORS.length] }
    saveTypes.mutate([...types, y], { onSuccess: () => { onChange(y.id); setAdding(false); setName('') } })
  }
  return (
    <Field label={t('taskType')}>
      {adding ? (
        <div className="flex gap-2">
          <Input autoFocus value={name} maxLength={40} placeholder={t('taskTypePh')} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } if (e.key === 'Escape') { e.stopPropagation(); setAdding(false) } }} />
          <Button type="button" variant="secondary" disabled={!name.trim() || saveTypes.isPending} onClick={add}>{t('add')}</Button>
        </div>
      ) : (
        <Select value={value} onChange={(e) => (e.target.value === '__new__' ? setAdding(true) : onChange(e.target.value))}>
          <option value="">—</option>
          {types.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          {canAdd && <option value="__new__">{t('newTaskTypeOption')}</option>}
        </Select>
      )}
      <ErrorText error={saveTypes.error} />
    </Field>
  )
}

/** The agency's own task types: rename, recolour, remove (their tasks stay, without a type). */
function TaskTypesDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [list, setList] = useState<TaskType[]>(ws.task_types ?? [])
  const saveTypes = useSaveTypes()
  const set = (i: number, patch: Partial<TaskType>) => setList(list.map((y, j) => (j === i ? { ...y, ...patch } : y)))
  return (
    <Dialog title={t('taskTypes')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e: FormEvent) => {
        e.preventDefault()
        saveTypes.mutate(list.filter((y) => y.name.trim()).map((y) => ({ ...y, name: y.name.trim() })), { onSuccess: onClose })
      }}>
        <p className="text-sm text-slate-600">{t('taskTypesHelp')}</p>
        {list.map((y, i) => (
          <div key={y.id} className="flex items-center gap-2">
            <Input value={y.name} maxLength={40} onChange={(e) => set(i, { name: e.target.value })} aria-label={t('name')} />
            <div className="flex shrink-0 gap-1">
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={c} aria-pressed={y.color === c} onClick={() => set(i, { color: c })}
                  className={cn('h-5 w-5 rounded-full', TONE[c].split(' ')[0], y.color === c && 'ring-2 ring-slate-900 ring-offset-1')} />
              ))}
            </div>
            <button type="button" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label={t('delete')} title={t('delete')}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 size={15} /></button>
          </div>
        ))}
        <button type="button" onClick={() => setList([...list, { id: newTypeId(), name: '', color: COLORS[list.length % COLORS.length] }])}
          className="flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"><Plus size={15} />{t('addTaskType')}</button>
        <ErrorText error={saveTypes.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={saveTypes.isPending}>{t('save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
