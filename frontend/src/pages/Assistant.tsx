/**
 * The setup assistant: drop in price lists, contracts or a tour description; the assistant
 * proposes suppliers, prices, routes, tours and participants; nothing is saved until you tick
 * what's right and press Save. Server: app/routers/assistant.py, app/ai/.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, FileSpreadsheet, FileText, Image as ImageIcon, Loader2, MessageSquarePlus, Paperclip, Send, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { ask, Label } from '../components/overlay'
import { EmptyState } from '../components/tour'
import { Link } from 'react-router-dom'
import { Button, ButtonLink, Card, ErrorText, Spinner } from '../components/ui'
import { api, ApiError, atLeast } from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { PageHeader } from './Dashboard'

type Kind = 'vendor' | 'prices' | 'client' | 'route' | 'route_change' | 'calculation' | 'tour' | 'participants'
interface Proposal {
  id: string; kind: Kind; label: string; status: 'proposed' | 'applied' | 'failed'
  result_id: string | null; error: string; data: Record<string, unknown>
}
interface ChatLine { role: 'user' | 'assistant' | 'step' | 'notice'; text: string; files?: string[]; ok?: number; failed?: number }
interface AiSession { id: string; title: string; status: 'idle' | 'running' | 'error'; error: string; chat: ChatLine[]; plan: Proposal[]; files: { name: string; kind: string }[] }
interface Brief { id: string; title: string; status: string; proposed: number; applied: number; updated_at: string }
interface AiStatus { available: boolean; spent_usd: number; limit_usd: number }

const KINDS: Kind[] = ['vendor', 'prices', 'client', 'route', 'route_change', 'calculation', 'tour', 'participants']
const ACCEPT = '.xlsx,.xlsm,.csv,.tsv,.docx,.txt,.pdf,image/jpeg,image/png,image/webp'

export function AssistantPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const base = wsPath(ws.id, '/ai')
  const status = useQuery({ queryKey: ['aiStatus', ws.id], queryFn: () => api<AiStatus>(`${base}/status`) })
  const list = useQuery({ queryKey: ['aiSessions', ws.id], queryFn: () => api<Brief[]>(`${base}/sessions`) })
  const [openId, setOpenId] = useState<string | null>(null)
  const current = openId ?? list.data?.[0]?.id ?? null
  const create = useMutation({
    mutationFn: () => api<AiSession>(`${base}/sessions`, { method: 'POST' }),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: ['aiSessions', ws.id] }); setOpenId(s.id) },
    meta: { silent: true },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setOpenId(null); qc.invalidateQueries({ queryKey: ['aiSessions', ws.id] }) },
  })

  if (status.data && !status.data.available) {
    return (
      <>
        <PageHeader title={t('assistant')} subtitle={t('assistantHelp')} />
        <div className="p-4 md:p-8"><EmptyState title={t('assistantOff')} hint={t('assistantOffHint')}
          action={atLeast(ws.role, 'admin') && <ButtonLink to={`/w/${ws.id}/settings/general`}>{t('aiKeyAdd')}</ButtonLink>} /></div>
      </>
    )
  }
  const spent = status.data ? `${t('aiAllowance', { spent: status.data.spent_usd.toFixed(2), limit: status.data.limit_usd.toFixed(0) })}` : ''
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2"><Sparkles size={22} className="text-violet-600" />{t('assistant')}</span>}
        subtitle={t('assistantHelp')}
        action={<div className="flex items-center gap-3">
          {spent && <span className="hidden text-xs text-slate-500 sm:inline">{spent}</span>}
          <Button variant="secondary" disabled={create.isPending} onClick={() => create.mutate()}><MessageSquarePlus size={16} />{t('newConversation')}</Button>
        </div>} />
      <div className="p-4 md:p-6">
        {(list.data?.length ?? 0) > 1 && (
          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
            {list.data!.map((b) => (
              <button key={b.id} type="button" onClick={() => setOpenId(b.id)}
                className={cn('flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm', b.id === current ? 'border-violet-400 bg-violet-50 text-violet-900' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
                <span className="max-w-[14rem] truncate">{b.title || t('newConversation')}</span>
                {b.proposed > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs text-amber-800">{b.proposed}</span>}
              </button>
            ))}
          </div>
        )}
        {list.isLoading ? <div className="flex justify-center py-10"><Spinner /></div>
          : current ? <Conversation key={current} id={current} onDelete={() => void ask({ title: t('deleteConversation'), message: t('deleteConversationMsg'), danger: true }).then((ok) => ok && remove.mutate(current))} />
            : <Welcome busy={create.isPending} onStart={() => create.mutate()} />}
      </div>
    </>
  )
}

function Welcome({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  const { t } = useI18n()
  return (
    <Card className="mx-auto max-w-2xl p-8 text-center">
      <Sparkles size={32} className="mx-auto text-violet-600" />
      <h2 className="mt-3 text-lg font-semibold">{t('assistantWelcome')}</h2>
      <ul className="mx-auto mt-4 max-w-md space-y-2 text-left text-sm text-slate-600">
        <li className="flex gap-2"><FileSpreadsheet size={16} className="mt-0.5 shrink-0 text-emerald-600" />{t('assistantIdea1')}</li>
        <li className="flex gap-2"><FileText size={16} className="mt-0.5 shrink-0 text-red-500" />{t('assistantIdea2')}</li>
        <li className="flex gap-2"><MessageSquarePlus size={16} className="mt-0.5 shrink-0 text-sky-600" />{t('assistantIdea3')}</li>
      </ul>
      <p className="mx-auto mt-4 max-w-md text-xs text-slate-500">{t('assistantSafe')}</p>
      <Button className="mt-5" disabled={busy} onClick={onStart}>{t('startConversation')}</Button>
    </Card>
  )
}

function Conversation({ id, onDelete }: { id: string; onDelete: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const url = wsPath(ws.id, `/ai/sessions/${id}`)
  const key = ['aiSession', ws.id, id]
  const s = useQuery({
    queryKey: key, queryFn: () => api<AiSession>(url),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
    refetchIntervalInBackground: true,    // people switch to Excel while it works
  })
  const running = s.data?.status === 'running'
  // When the assistant finishes, the list (proposal counts) and the allowance change.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: ['aiSessions', ws.id] })
      qc.invalidateQueries({ queryKey: ['aiStatus', ws.id] })
    }
    wasRunning.current = running
  }, [running, qc, ws.id])

  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [drag, setDrag] = useState(false)
  const send = useMutation({
    mutationFn: async () => {
      const body = new FormData()
      body.append('text', text)
      files.forEach((f) => body.append('files', f))
      const res = await fetch(`/api${url}/messages`, { method: 'POST', credentials: 'include', body })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : res.statusText)
      return data as AiSession
    },
    onSuccess: (d) => { qc.setQueryData(key, d); setText(''); setFiles([]) },
    meta: { silent: true },
  })
  const chatEnd = useRef<HTMLDivElement>(null)
  const lines = s.data?.chat.length ?? 0
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'end' }) }, [lines])

  if (!s.data) return <div className="flex justify-center py-10"><Spinner /></div>
  const v = s.data
  const addFiles = (list: FileList | null) => list && setFiles((f) => [...f, ...Array.from(list)].slice(0, 10))
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }
  const submit = (e?: FormEvent) => { e?.preventDefault(); if ((text.trim() || files.length) && !running) send.mutate() }
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,32rem)]">
      <div className="min-w-0" onDragOver={(e: DragEvent) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <Card className={cn('flex min-h-[28rem] flex-col xl:h-[calc(100vh-13rem)]', drag && 'ring-2 ring-violet-400')}>
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{v.title || t('newConversation')}</span>
          {v.files.length > 0 && <span className="text-xs text-slate-500">{t('nFiles', { n: v.files.length })}</span>}
          <button type="button" onClick={onDelete} disabled={running} title={t('deleteConversation')} aria-label={t('deleteConversation')}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 size={15} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {v.chat.length === 0 && <p className="py-8 text-center text-sm text-slate-500">{t('assistantFirstHint')}</p>}
          {v.chat.map((c, i) => <Line key={i} c={c} />)}
          {running && (
            <p className="flex items-center gap-2 text-sm text-violet-700"><Loader2 size={15} className="animate-spin" />{t('assistantWorking')}</p>
          )}
          {v.status === 'error' && <p className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"><AlertTriangle size={15} />{v.error}</p>}
          <div ref={chatEnd} />
        </div>
        <form onSubmit={submit} className="border-t border-slate-100 p-3">
          {files.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs">
                  <FileIcon name={f.name} />{f.name}
                  <button type="button" aria-label={t('delete')} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <label className="cursor-pointer rounded-lg p-2 text-slate-500 hover:bg-slate-100" title={t('attachFiles')}>
              <Paperclip size={18} />
              <input type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            </label>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(6, Math.max(1, text.split('\n').length))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
              placeholder={t('assistantPh')} maxLength={20000}
              className="min-h-10 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none" />
            <Button type="submit" disabled={running || send.isPending || (!text.trim() && !files.length)} aria-label={t('send')}><Send size={16} /></Button>
          </div>
          <ErrorText error={send.error} />
          <p className="mt-1.5 text-[11px] text-slate-400">{t('assistantFilesHint')}</p>
        </form>
      </Card>
      </div>
      <PlanPanel s={v} url={url} onSaved={(d) => qc.setQueryData(key, d)} />
    </div>
  )
}

function FileIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  if (/\.(xlsx|xlsm|csv|tsv)$/.test(n)) return <FileSpreadsheet size={13} className="text-emerald-600" />
  if (n.endsWith('.pdf')) return <FileText size={13} className="text-red-500" />
  if (/\.(docx|txt|md)$/.test(n)) return <FileText size={13} className="text-blue-600" />
  return <ImageIcon size={13} className="text-sky-600" />
}

function Line({ c }: { c: ChatLine }) {
  const { t } = useI18n()
  if (c.role === 'step') return <p className="pl-1 text-xs text-slate-400">· {c.text}</p>
  if (c.role === 'notice') {
    const msg = c.text === 'applied' ? t('aiSaved', { ok: c.ok ?? 0, failed: c.failed ?? 0 })
      : c.text === 'limit' ? t('aiLimitReached') : t('aiRefused')
    return <p className={cn('rounded-lg px-3 py-2 text-sm', c.text === 'applied' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}>{msg}</p>
  }
  const mine = c.role === 'user'
  return (
    <div className={cn('flex', mine && 'justify-end')}>
      <div className={cn('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm', mine ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-800')}>
        {c.files && c.files.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {c.files.map((f) => <span key={f} className={cn('rounded-md px-1.5 py-0.5 text-xs', mine ? 'bg-violet-500' : 'bg-white')}>{f}</span>)}
          </div>
        )}
        {c.text && <p className="whitespace-pre-wrap">{c.text}</p>}
      </div>
    </div>
  )
}

// --- the plan: what to save ------------------------------------------------------------------------

function PlanPanel({ s, url, onSaved }: { s: AiSession; url: string; onSaved: (d: AiSession) => void }) {
  const { t } = useI18n()
  const open = s.plan.filter((p) => p.status !== 'applied')
  const [off, setOff] = useState<Set<string>>(new Set())          // unticked by the person
  const picked = open.filter((p) => !off.has(p.id)).map((p) => p.id)
  const save = useMutation({
    mutationFn: () => api<AiSession>(`${url}/apply`, { method: 'POST', body: { ids: picked } }),
    onSuccess: onSaved,
  })
  const groups = useMemo(() => KINDS.map((k) => [k, s.plan.filter((p) => p.kind === k)] as const).filter(([, l]) => l.length), [s.plan])
  const vendors = useVendors()
  // "p3" or an id → a readable name for the details.
  const nameOf = (r?: string | null) => !r ? '' : s.plan.find((p) => p.id === r)?.label.split(' · ')[0]
    ?? vendors.data?.find((v) => v.id === r)?.name ?? r
  const toggle = (id: string) => setOff((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <Card className="flex min-h-[20rem] flex-col xl:h-[calc(100vh-13rem)]">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold">{t('aiPlan')}</h3>
        <p className="text-xs text-slate-500">{t('aiPlanHelp')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {s.plan.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t('aiPlanEmpty')}</p> : groups.map(([kind, list]) => (
          <section key={kind}>
            <h4 className="sticky top-0 z-10 bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t(`aiKind_${kind}` as TKey)} · {list.length}
            </h4>
            <ul className="divide-y divide-slate-100">
              {list.map((p) => <PlanItem key={p.id} p={p} nameOf={nameOf} checked={!off.has(p.id)} onToggle={() => toggle(p.id)} />)}
            </ul>
          </section>
        ))}
      </div>
      {open.length > 0 && (
        <div className="space-y-2 border-t border-slate-100 p-3">
          <ErrorText error={save.error} />
          <div className="flex items-center gap-2">
            <button type="button" className="text-xs text-slate-500 hover:text-slate-800"
              onClick={() => setOff(picked.length ? new Set(open.map((p) => p.id)) : new Set())}>
              {picked.length ? t('untickAll') : t('tickAll')}
            </button>
            <div className="flex-1" />
            <Button disabled={!picked.length || save.isPending || s.status === 'running'} onClick={() => save.mutate()}>
              <Check size={16} />{t('aiSaveSelected', { n: picked.length })}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function PlanItem({ p, checked, onToggle, nameOf }: { p: Proposal; checked: boolean; onToggle: () => void; nameOf: (r?: string | null) => string }) {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const [open, setOpen] = useState(false)
  const done = p.status === 'applied'
  return (
    <li className="px-4 py-2.5 text-sm">
      <div className="flex items-start gap-2.5">
        {done ? <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />
          : <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 shrink-0" aria-label={p.label} />}
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <span className={cn('block', done && 'text-slate-500')}>{p.label}</span>
          {p.status === 'failed' && <span className="block text-xs text-red-700">{p.error}</span>}
        </button>
        <span className="shrink-0 text-[11px] text-slate-400">{p.id}</span>
        {done && p.kind === 'calculation' && p.result_id
          ? <Link to={`/w/${ws.id}/calculations/${p.result_id}`} className="shrink-0 text-xs font-medium text-brand-700 hover:underline">{t('aiOpen')}</Link>
          : done ? <Label tone="green" wide={false}>{t('aiSavedOne')}</Label> : null}
        <ChevronDown size={15} onClick={() => setOpen(!open)} className={cn('mt-0.5 shrink-0 cursor-pointer text-slate-400 transition-transform', open && 'rotate-180')} />
      </div>
      {open && <div className="ml-6 mt-2 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-700"><Details p={p} nameOf={nameOf} /></div>}
    </li>
  )
}

/** The proposal in plain words, so it can be checked before saving. */
function Details({ p, nameOf }: { p: Proposal; nameOf: (r?: string | null) => string }) {
  const { t } = useI18n()
  const d = p.data as Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any
  const row = (k: string, v: unknown) => v !== undefined && v !== null && v !== '' &&
    <div key={k} className="flex gap-2"><span className="w-28 shrink-0 text-slate-500">{k}</span><span className="min-w-0 break-words">{Array.isArray(v) ? v.join(', ') : String(v)}</span></div>
  if (p.kind === 'prices') {
    return (
      <ul className="space-y-1">
        {(d.services as any[]).map((sv, i) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
          <li key={i}>
            <b>{sv.name}</b>{sv.code ? ` (${sv.code})` : ''} · {t(`unit_${sv.unit}` as TKey)}
            {(sv.rates as any[]).map((r, j) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
              <div key={j} className="ml-3 text-slate-600">
                {r.price} {r.currency}
                {(r.valid_from || r.valid_to) && ` · ${r.valid_from ?? '…'} – ${r.valid_to ?? '…'}`}
                {(r.min_pax || r.max_pax) && ` · ${r.min_pax ?? 1}–${r.max_pax ?? '∞'} pax`}
              </div>
            ))}
            {sv.dishes?.length > 0 && <div className="ml-3 text-slate-500">{sv.dishes.map((x: any) => x.name ?? x).join(', ')}</div>}
          </li>
        ))}
      </ul>
    )
  }
  if (p.kind === 'route_change') {
    // Changes to a route that exists: each day and what changes on it, as the assistant read it.
    const what = (c: any) => [   // eslint-disable-line @typescript-eslint/no-explicit-any
      c.city != null && `${t('city')}: ${c.city}`, c.stops && `${t('aiStops')}: ${c.stops.join(', ')}`,
      c.hotel != null && `${t('hotel')}: ${c.hotel ? d.names?.[c.hotel] ?? nameOf(c.hotel) ?? c.hotel : '—'}`,
      c.lunch != null && `${t('lunch')}: ${c.lunch ? d.names?.[c.lunch] ?? nameOf(c.lunch) ?? c.lunch : '—'}`,
      c.dinner != null && `${t('dinner')}: ${c.dinner ? d.names?.[c.dinner] ?? nameOf(c.dinner) ?? c.dinner : '—'}`,
      c.lunch_mode && `${t('lunch')}: ${c.lunch_mode}`, c.dinner_mode && `${t('dinner')}: ${c.dinner_mode}`,
      c.add_extras?.length > 0 && `+ ${c.add_extras.map((x: any) => x.service).join(', ')}`,   // eslint-disable-line @typescript-eslint/no-explicit-any
      c.remove_extras?.length > 0 && `− ${c.remove_extras.join(', ')}`,
      c.notes != null && `${t('notes')}: ${c.notes}`, c.km != null && `${c.km} km`,
    ].filter(Boolean).join(' · ')
    return (
      <div className="space-y-1">
        {[row(t('name'), d.name), row(t('notes'), d.notes)]}
        <ul className="space-y-0.5">
          {(d.changes as any[]).map((c, i) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
            <li key={i}><b>{c.op === 'insert_after' ? t('aiNewDayAfter', { n: c.day }) : c.op === 'remove' ? t('aiRemoveDay', { n: c.day }) : `${t('day')} ${c.day}`}</b> {what(c)}</li>
          ))}
        </ul>
      </div>
    )
  }
  if (p.kind === 'route' || (p.kind === 'tour' && d.days)) {
    return (
      <div className="space-y-1">
        {p.kind === 'tour' && [row(t('startDate'), d.start_date), row(t('pax'), d.pax), row(t('rooms'), d.rooms), row(t('client'), nameOf(d.client))]}
        <ol className="space-y-0.5">
          {(d.days as any[]).map((day, i) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
            <li key={i}><b>{t('day')} {i + 1}</b> {day.city} {[day.hotel && `${t('hotel')}: ${nameOf(day.hotel)}`, day.lunch && `${t('lunch')}: ${nameOf(day.lunch)}`, day.dinner && `${t('dinner')}: ${nameOf(day.dinner)}`].filter(Boolean).join(' · ')}
              {day.extras?.length > 0 && <span className="text-slate-500"> · {day.extras.map((x: any) => x.service).join(', ')}</span>}</li>
          ))}
        </ol>
      </div>
    )
  }
  if (p.kind === 'calculation') {
    return (
      <div className="space-y-1">
        {[row(t('route'), nameOf(d.route)), row(t('aiCalcSizes'), `${d.pax_min ?? 10}–${d.pax_max ?? 25}${d.leaders ? ` + ${d.leaders}` : ''}`),
          row(t('aiCalcPricesOn'), d.prices_on), row(t('aiCalcValidTo'), d.valid_to), row(t('client'), nameOf(d.client)), row(t('notes'), d.notes)]}
        {d.lines?.length > 0 && (
          <ul className="pt-1">
            {(d.lines as any[]).map((x, i) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
              <li key={i}>{x.name} · {x.price != null ? `${x.price} ${x.currency}` : <span className="text-amber-700">{t('aiCalcToFill')}</span>}
                {x.per === 'group' ? ` · ${t('aiCalcPerGroup')}` : ''}</li>
            ))}
          </ul>
        )}
        <p className="pt-1 text-slate-500">{t('aiCalcHow')}</p>
      </div>
    )
  }
  if (p.kind === 'participants') {
    return <ol className="list-inside list-decimal">{(d.people as any[]).map((x, i) => <li key={i}>{x.full_name}{x.room_type ? ` · ${x.room_type}` : ''}</li>)}</ol>   // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  if (p.kind === 'tour') {
    return <div className="space-y-0.5">{[row(t('route'), nameOf(d.route)), row(t('startDate'), d.start_date), row(t('endDate'), d.end_date),
      row(t('pax'), d.pax), row(t('rooms'), d.rooms), row(t('client'), nameOf(d.client)), row(t('notes'), d.notes)]}</div>
  }
  return <div className="space-y-0.5">{Object.entries(d).map(([k, v]) => row(k, v))}</div>
}
