import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask, Dialog, toast } from '../components/overlay'
import { AlertTriangle, ArrowRightLeft, BedDouble, Copy, Download, MessageCircle, Plus, Smartphone, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ImportDialog } from '../components/ImportDialog'
import { EmptyState, Phone, VendorSelect } from '../components/tour'
import { awayDuring, awayText } from '../components/GuideInfo'
import { TeamChanges } from '../components/TeamChanges'
import { HandOver } from '../components/HandOver'
import { Tooltip } from '../components/Tooltip'
import { QuickVendorDialog } from '../components/QuickAdd'
import { Button, Card, ErrorText, Input, Select } from '../components/ui'
import {
  api, ROLE_VENDOR_TYPES, ROOM_TYPES, STAFF_ROLES,
  type Participant, type RoomingSummary, type StaffAssignment, type StaffRole, type Tour,
} from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { addDays, diffDays } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'

/** Refresh everything that depends on the participant list. */
function useTourRefresh(tourId: string) {
  const ws = useWorkspace()!
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['participants', ws.id, tourId] })
    qc.invalidateQueries({ queryKey: ['rooming', ws.id, tourId] })
    qc.invalidateQueries({ queryKey: ['tour', ws.id, tourId] })
    qc.invalidateQueries({ queryKey: ['tours', ws.id] })
  }
}

// --- participants ----------------------------------------------------------------

export function ParticipantsTab({ tour }: { tour: Tour }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const base = wsPath(ws.id, `/tours/${tour.id}`)
  const refresh = useTourRefresh(tour.id)
  const [importing, setImporting] = useState(false)
  const people = useQuery({ queryKey: ['participants', ws.id, tour.id], queryFn: () => api<Participant[]>(`${base}/participants`) })
  const rooming = useQuery({ queryKey: ['rooming', ws.id, tour.id], queryFn: () => api<RoomingSummary>(`${base}/rooming`) })

  const patchTour = useMutation({
    mutationFn: (body: Partial<Tour>) => api(base, { method: 'PATCH', body }),
    onSuccess: refresh,
  })
  const clear = useMutation({ mutationFn: () => api(`${base}/participants`, { method: 'DELETE' }), onSuccess: refresh })
  const list = people.data ?? []
  const r = rooming.data
  // Passports should outlive the trip by ~6 months.
  const passportLimit = addDays(tour.end_date, 183)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setImporting(true)}><Upload size={16} />{t('importList')}</Button>
        {list.length > 0 && (
          <>
            <a href={`/api${base}/rooming-list.xlsx`} download
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              <Download size={16} />{t('downloadRooming')}
            </a>
            <div className="flex-1" />
            <Button variant="ghost" className="text-red-600" onClick={() => void ask({ title: t('confirmClear'), danger: true }).then((ok) => ok && clear.mutate())}>
              <Trash2 size={16} />{t('clearList')}
            </Button>
          </>
        )}
      </div>

      {r && list.length > 0 && (
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
          <span className="flex items-center gap-2">
            <BedDouble size={16} className="text-slate-400" />{t('roomsNeeded')}: <b>{r.text || '—'}</b>
            {r.text && r.text !== tour.rooms && (
              <Button size="sm" variant="secondary" onClick={() => patchTour.mutate({ rooms: r.text })}>{t('useAsRooms')}</Button>
            )}
          </span>
          {list.length !== tour.pax && (
            <span className="flex items-center gap-2 text-amber-700">
              <AlertTriangle size={16} />{t('paxMismatch', { pax: tour.pax, n: list.length })}
              <Button size="sm" variant="secondary" onClick={() => patchTour.mutate({ pax: list.length })}>{t('setPax', { n: list.length })}</Button>
            </span>
          )}
          {r.unassigned > 0 && <span className="text-slate-500">{r.unassigned} {t('withoutRoom')}</span>}
          {r.passport_warnings > 0 && (
            <span className="flex items-center gap-1 text-red-600"><AlertTriangle size={16} />{r.passport_warnings} {t('passportWarn')}</span>
          )}
        </Card>
      )}

      {people.isSuccess && list.length === 0 ? (
        <EmptyState title={t('noParticipants')} hint={t('noParticipantsHint')} action={<AddParticipant tourId={tour.id} />} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2">#</th>
                  <th className="px-2 py-2">{t('fullName')}</th>
                  <th className="w-20 px-2 py-2">{t('gender')}</th>
                  <th className="w-36 px-2 py-2">{t('birthDate')}</th>
                  <th className="w-32 px-2 py-2">{t('nationality')}</th>
                  <th className="w-36 px-2 py-2">{t('passport')}</th>
                  <th className="w-36 px-2 py-2">{t('passportExpiry')}</th>
                  <th className="w-24 px-2 py-2">{t('roomType')}</th>
                  <th className="w-24 px-2 py-2" title={t('roomGroupHint')}>{t('roomGroup')}</th>
                  <th className="px-2 py-2">{t('notes')}</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((p, i) => <ParticipantRow key={p.id} n={i + 1} p={p} base={base} passportLimit={passportLimit} onChange={refresh} />)}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-100 p-3"><AddParticipant tourId={tour.id} /></div>
        </Card>
      )}
      {importing && <ImportDialog entity="participants" tourId={tour.id} onClose={() => setImporting(false)} onDone={refresh} />}
    </div>
  )
}

function AddParticipant({ tourId }: { tourId: string }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const refresh = useTourRefresh(tourId)
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${tourId}/participants`), { method: 'POST', body: { full_name: name.trim() } }),
    onSuccess: () => { setName(''); refresh() },
  })
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) add.mutate() }} className="flex max-w-md gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fullName')} />
      <Button type="submit" disabled={add.isPending || !name.trim()}><Plus size={16} />{t('add')}</Button>
    </form>
  )
}

const cell = 'h-9 border-transparent bg-transparent shadow-none hover:border-slate-300 focus:bg-white'

function ParticipantRow({ n, p, base, passportLimit, onChange }: {
  n: number; p: Participant; base: string; passportLimit: string; onChange: () => void
}) {
  const { t } = useI18n()
  // Opened from search ("?p=<id>"): bring this tourist into view and mark the row for a moment.
  const [params] = useSearchParams()
  const found = params.get('p') === p.id
  const row = useRef<HTMLTableRowElement>(null)
  const [flash, setFlash] = useState(found)
  useEffect(() => {
    if (!found) return
    // Twice: the alerts and details above may still be loading and push the list down.
    const go = () => row.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const ids = [setTimeout(go, 150), setTimeout(go, 900), setTimeout(() => setFlash(false), 3000)]
    return () => ids.forEach(clearTimeout)
  }, [found])
  const textKeys = ['full_name', 'nationality', 'passport_number', 'room_group', 'notes'] as const
  const pick = () => Object.fromEntries(textKeys.map((k) => [k, p[k]])) as Record<(typeof textKeys)[number], string>
  const [text, setText] = useState(pick)
  useEffect(() => setText(pick()), [p]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: (body: Record<string, string | null>) => api<Participant>(`${base}/participants/${p.id}`, { method: 'PATCH', body }),
    onSuccess: onChange,
  })
  const del = useMutation({ mutationFn: () => api(`${base}/participants/${p.id}`, { method: 'DELETE' }), onSuccess: onChange })
  const blur = (k: (typeof textKeys)[number]) => () => {
    if (text[k] !== p[k] && (k !== 'full_name' || text[k].trim())) save.mutate({ [k]: text[k] })
  }
  const txt = (k: (typeof textKeys)[number], extra = '') => (
    <Input className={cn(cell, extra)} value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} onBlur={blur(k)} />
  )
  const expiring = !!p.passport_expiry && p.passport_expiry < passportLimit

  return (
    <tr ref={row} className={cn('transition-colors duration-700', save.isPending && 'opacity-60', save.isError && 'bg-red-50', flash && 'bg-amber-100')}>
      <td className="px-3 text-slate-400">{n}</td>
      <td className="px-1 py-1">{txt('full_name', 'font-medium')}</td>
      <td className="px-1 py-1">
        <Select className={cell} value={p.gender} onChange={(e) => save.mutate({ gender: e.target.value })}>
          <option value="">—</option><option value="M">{t('genderM')}</option><option value="F">{t('genderF')}</option>
        </Select>
      </td>
      <td className="px-1 py-1">
        <Input type="date" className={cell} value={p.birth_date ?? ''} onChange={(e) => save.mutate({ birth_date: e.target.value || null })} />
      </td>
      <td className="px-1 py-1">{txt('nationality')}</td>
      <td className="px-1 py-1">{txt('passport_number', 'font-mono')}</td>
      <td className="px-1 py-1">
        <Input type="date" className={cn(cell, expiring && 'text-red-600')} value={p.passport_expiry ?? ''}
          onChange={(e) => save.mutate({ passport_expiry: e.target.value || null })} />
      </td>
      <td className="px-1 py-1">
        <Select className={cell} value={p.room_type} onChange={(e) => save.mutate({ room_type: e.target.value })}>
          <option value="">—</option>{ROOM_TYPES.map((r) => <option key={r}>{r}</option>)}
        </Select>
      </td>
      <td className="px-1 py-1">{txt('room_group')}</td>
      <td className="px-1 py-1">{txt('notes')}</td>
      <td className="px-1">
        <button type="button" aria-label={t('delete')} title={t('delete')} onClick={() => void ask({ title: t('confirmDeleteParticipant'), danger: true }).then((ok) => ok && del.mutate())}
          className="rounded p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
      </td>
    </tr>
  )
}

// --- staff -------------------------------------------------------------------------

export function StaffTab({ tour }: { tour: Tour }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const vendors = useVendors()
  const refresh = useTourRefresh(tour.id)
  const base = wsPath(ws.id, `/tours/${tour.id}/staff`)
  const n = diffDays(tour.start_date, tour.end_date) + 1
  const dayOptions = Array.from({ length: n }, (_, i) => i + 1)
  const links = useFieldLinks(tour.id)
  const languagesOf = (id: string) => vendors.data?.find((v) => v.id === id)?.languages?.join(', ')
  const byIdV = new Map((vendors.data ?? []).map((v) => [v.id, v]))
  const companyOf = (id: string) => { const c = byIdV.get(id)?.company_id; return c ? byIdV.get(c)?.name : undefined }
  // Drivers of the bus companies already on this tour come first when choosing a driver.
  const tourCompanies = new Set(tour.staff.filter((s) => s.role === 'transport').map((s) => s.vendor.id))
  const ordered = [...(vendors.data ?? [])].sort((a, b) =>
    Number(!(a.company_id && tourCompanies.has(a.company_id))) - Number(!(b.company_id && tourCompanies.has(b.company_id))))
  const [linkFor, setLinkFor] = useState<StaffAssignment | null>(null)
  const [handFor, setHandFor] = useState<StaffAssignment | null>(null)

  const [form, setForm] = useState<{ role: StaffRole; vendor_id: string | null; start_day: number; end_day: number | null }>(
    { role: 'guide', vendor_id: null, start_day: 1, end_day: null })
  // The dates the new person would work: who is away then is marked in the list and warned about.
  const from = addDays(tour.start_date, form.start_day - 1)
  const to = form.end_day ? addDays(tour.start_date, form.end_day - 1) : tour.end_date
  const picked = vendors.data?.find((v) => v.id === form.vendor_id)
  const pickedAway = picked && awayDuring(picked, from, to)
  const add = useMutation({
    mutationFn: () => api(base, { method: 'POST', body: form }),
    onSuccess: () => { setForm({ ...form, vendor_id: null }); refresh() },
  })
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<StaffAssignment> }) => api(`${base}/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }), onSuccess: refresh })
  const [quickAdd, setQuickAdd] = useState(false)

  const dateOf = (d: number) => addDays(tour.start_date, d - 1).slice(5).split('-').reverse().join('.')
  const dayLabel = (d: number) => `${t('day')} ${d} · ${dateOf(d)}`

  return (
    <div className="space-y-4">
      <Card>
        {tour.staff.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">{t('noStaff')}</p>}
        <ul className="divide-y divide-slate-100">
          {tour.staff.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="w-32 shrink-0 rounded-md bg-slate-100 px-2 py-1 text-center text-xs font-semibold text-slate-700">{t(`staffRole_${a.role}`)}</span>
              <span className="min-w-40 flex-1">
                <b>{a.vendor.name}</b> <Phone phone={a.vendor.phone} />
                {companyOf(a.vendor.id) && <span className="block text-xs text-slate-600">{t('worksForShort', { company: companyOf(a.vendor.id)! })}</span>}
                {languagesOf(a.vendor.id) && <span className="block text-xs text-slate-500">{languagesOf(a.vendor.id)}</span>}
              </span>
              <Select className="h-8 w-40" value={a.start_day}
                onChange={(e) => update.mutate({ id: a.id, body: { start_day: Number(e.target.value) } })}>
                {dayOptions.map((d) => <option key={d} value={d} disabled={a.end_day !== null && d > a.end_day}>{dayLabel(d)}</option>)}
              </Select>
              <span className="text-slate-400">→</span>
              <Select className="h-8 w-40" value={a.end_day ?? ''}
                onChange={(e) => update.mutate({ id: a.id, body: { end_day: e.target.value ? Number(e.target.value) : null } })}>
                <option value="">{t('untilEnd')}</option>
                {dayOptions.map((d) => <option key={d} value={d} disabled={d < a.start_day}>{dayLabel(d)}</option>)}
              </Select>
              {['guide', 'driver', 'tour_leader', 'assistant'].includes(a.role) && (
                <Button size="sm" variant="secondary" onClick={() => setLinkFor(a)} title={t('phoneLinkHelp')}
                  className={cn(links.data?.some((x) => x.staff_id === a.id) && 'border-emerald-300 text-emerald-800')}>
                  <Smartphone size={14} />{t('phoneLink')}
                </Button>
              )}
              <Tooltip label={t('handOverTip')}><Button size="sm" variant="secondary" onClick={() => setHandFor(a)}><ArrowRightLeft size={14} aria-hidden />{t('handOverButton')}</Button></Tooltip>
              <button type="button" aria-label={t('delete')} title={t('delete')} onClick={() => void ask({ title: t('confirmRemoveStaff'), danger: true }).then((ok) => ok && remove.mutate(a.id))}
                className="rounded p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
        <ErrorText error={update.error || remove.error} />
        {handFor && <HandOver tour={tour} staff={handFor} onClose={() => setHandFor(null)} onDone={refresh} />}
        {linkFor && <PhoneLinkDialog tourId={tour.id} staff={linkFor} live={links.data?.find((x) => x.staff_id === linkFor.id)} onClose={() => setLinkFor(null)} />}
      </Card>
      <TeamChanges tourId={tour.id} code={tour.code} />

      {quickAdd && <QuickVendorDialog type={ROLE_VENDOR_TYPES[form.role][0]} onCreated={(v) => setForm({ ...form, vendor_id: v.id })} onClose={() => setQuickAdd(false)} />}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('addStaff')}</h3>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (form.vendor_id) add.mutate() }}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[10rem_1fr_10rem_10rem_auto]">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as StaffRole, vendor_id: null })}>
            {STAFF_ROLES.map((r) => <option key={r} value={r}>{t(`staffRole_${r}`)}</option>)}
          </Select>
          <VendorSelect vendors={ordered} types={ROLE_VENDOR_TYPES[form.role]} value={form.vendor_id}
            note={(v) => [v.company_id && byIdV.get(v.company_id) ? ` · ${byIdV.get(v.company_id)!.name}` : '',
              v.languages?.length ? ` · ${v.languages.join(', ')}` : '', awayDuring(v, from, to) ? ` — ${t('notAvailableShort')}` : ''].join('')}
            onChange={(v) => setForm({ ...form, vendor_id: v })} onAddNew={() => setQuickAdd(true)} />
          <Select value={form.start_day} onChange={(e) => setForm({ ...form, start_day: Number(e.target.value) })}>
            {dayOptions.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
          </Select>
          <Select value={form.end_day ?? ''} onChange={(e) => setForm({ ...form, end_day: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t('untilEnd')}</option>
            {dayOptions.filter((d) => d >= form.start_day).map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
          </Select>
          <Button type="submit" disabled={!form.vendor_id || add.isPending}><Plus size={16} />{t('add')}</Button>
        </form>
        {pickedAway && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{t('pickedAway', { name: picked!.name, when: awayText(pickedAway, lang) })}</p>
        )}
        <div className="mt-2"><ErrorText error={add.error} /></div>
      </Card>
    </div>
  )
}


interface FieldLink { id: string; staff_id: string; created_at: string; expires_on: string; last_seen_at: string | null; token: string | null }

function useFieldLinks(tourId: string) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['fieldLinks', ws.id, tourId], queryFn: () => api<FieldLink[]>(wsPath(ws.id, `/tours/${tourId}/field-links`)) })
}

/** Make (or replace) the private phone link for one guide/driver, and send it. The link is shown
 *  only right after it's made — only its fingerprint is stored — so "New link" is always there. */
function PhoneLinkDialog({ tourId, staff, live, onClose }: { tourId: string; staff: StaffAssignment; live?: FieldLink; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['fieldLinks', ws.id, tourId] })
  const make = useMutation({
    mutationFn: () => api<FieldLink>(wsPath(ws.id, `/tours/${tourId}/staff/${staff.id}/field-link`), { method: 'POST' }),
    onSuccess: done, meta: { silent: true },
  })
  const off = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/tours/${tourId}/field-links/${live!.id}`), { method: 'DELETE' }),
    onSuccess: () => { done(); onClose() },
  })
  const url = make.data?.token ? `${window.location.origin}/f/${make.data.token}` : ''
  const message = t('phoneLinkMessage', { name: staff.vendor.name, url })
  const digits = staff.vendor.phone.replace(/[^\d]/g, '')
  const when = (s: string) => new Date(s).toLocaleString(lang === 'ka' ? 'ka-GE' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <Dialog title={`${t('phoneLink')} · ${staff.vendor.name}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">{t('phoneLinkExplain')}</p>
        {url ? (
          <>
            <div className="flex gap-2">
              <Input readOnly value={url} onFocus={(e) => e.target.select()} className="font-mono text-xs" aria-label={t('phoneLink')} />
              <Button type="button" variant="secondary" onClick={() => void navigator.clipboard?.writeText(url).then(() => toast('copied'))}><Copy size={15} />{t('copy')}</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={`https://wa.me/${digits}?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white hover:bg-emerald-700"><MessageCircle size={15} />WhatsApp</a>
              {digits && <a href={`sms:${digits}?body=${encodeURIComponent(message)}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50">SMS</a>}
              <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-2 py-2 font-medium text-brand-700 hover:underline">{t('phoneLinkPreview')}</a>
            </div>
            <p className="text-xs text-slate-500">{t('phoneLinkOnce', { date: make.data!.expires_on })}</p>
          </>
        ) : live ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
            {t('phoneLinkLive', { date: when(live.created_at) })}{' '}
            {live.last_seen_at ? t('phoneLinkSeen', { date: when(live.last_seen_at) }) : t('phoneLinkNotOpened')}
          </p>
        ) : null}
        <ErrorText error={make.error || off.error} />
        <div className="flex flex-wrap justify-end gap-2">
          {live && !url && <Button type="button" variant="ghost" className="text-red-600" disabled={off.isPending} onClick={() => off.mutate()}>{t('phoneLinkOff')}</Button>}
          {!url && <Button type="button" disabled={make.isPending} onClick={() => make.mutate()}>{live ? t('phoneLinkNew') : t('phoneLinkMake')}</Button>}
          {url && <Button type="button" variant="secondary" onClick={onClose}>{t('done')}</Button>}
        </div>
      </div>
    </Dialog>
  )
}
