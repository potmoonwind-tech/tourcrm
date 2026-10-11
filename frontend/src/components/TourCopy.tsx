/**
 * A tour copied as a draft (new dates, same plan, nothing booked), and the tour's change history where a
 * change made by mistake - a hotel removed, a lunch changed - can be taken back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, can, type Tour } from '../lib/api'
import { useClients, wsPath } from '../lib/data'
import { addDays, fmt } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { Drawer } from './overlay'
import { Button, ErrorText, Field, Input, Select } from './ui'

/** "Duplicate": the new dates and group; the copy opens as a draft. */
export function DuplicateTour({ tour, onClose }: { tour: Tour; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const clients = useClients()
  const length = tour.days.length
  // A week later: the next departure of the same programme, the usual reason to copy.
  const [start, setStart] = useState(addDays(tour.start_date, 7))
  const [code, setCode] = useState('')
  const [client, setClient] = useState(tour.client_id ?? '')
  const [pax, setPax] = useState(String(tour.pax || ''))
  const [leaders, setLeaders] = useState(String(tour.leaders ?? 0))
  const [staff, setStaff] = useState(false)
  const [people, setPeople] = useState(false)
  const copy = useMutation({
    mutationFn: () => api<Tour>(wsPath(ws.id, `/tours/${tour.id}/duplicate`), {
      method: 'POST',
      body: { start_date: start, code: code.trim() || null, client_id: client || null, keep_client: false,
        pax: Number(pax) || 0, leaders: Number(leaders) || 0, staff, people },
    }),
    onSuccess: (t2) => {
      qc.invalidateQueries({ queryKey: ['tours', ws.id] })
      onClose()
      navigate(`/w/${ws.id}/tours/${t2.id}`)
    },
  })
  return (
    <Drawer title={t('dupTitle', { code: tour.code })} subtitle={t('dupSubtitle')} onClose={onClose} size="md"
      footer={<>
        <Button type="submit" form="dup-tour" disabled={copy.isPending || !start}>{t('dupCreate')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        <ErrorText error={copy.error} />
      </>}>
      <form id="dup-tour" onSubmit={(e: FormEvent) => { e.preventDefault(); copy.mutate() }} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('startDate')} hint={start ? t('dupEnds', { date: fmt(addDays(start, length - 1), lang), n: length }) : undefined}>
            <Input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label={t('tourCode')} hint={t('dupCodeHint')}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('dupCodeAuto')} className="font-mono uppercase" />
          </Field>
        </div>
        <Field label={t('client')}>
          <Select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">{t('noClientYet')}</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field label={t('paxGuests')}><Input type="number" min={0} value={pax} onChange={(e) => setPax(e.target.value)} className="w-28" /></Field>
          <Field label={t('tourLeaders')}><Input type="number" min={0} max={20} value={leaders} onChange={(e) => setLeaders(e.target.value)} className="w-28" /></Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-slate-800">{t('dupAlso')}</legend>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={staff} onChange={(e) => setStaff(e.target.checked)} />
            {t('dupStaff', { n: tour.staff.length })}
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={people} onChange={(e) => setPeople(e.target.checked)} />
            {t('dupPeople', { n: tour.participant_count ?? 0 })}
          </label>
        </fieldset>
        {/* What comes along and what doesn't, so nothing is a surprise. */}
        <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          <p><span className="font-medium text-slate-800">{t('dupCopied')}</span> {t('dupCopiedList')}{can(ws, 'operations', 'finance', 'sales') ? `, ${t('pricePerPerson').toLowerCase()}` : ''}.</p>
          <p className="mt-1"><span className="font-medium text-slate-800">{t('dupNotCopied')}</span> {t('dupNotCopiedList')}</p>
          <p className="mt-1 text-slate-500">{t('dupDraftNote')}</p>
        </div>
      </form>
    </Drawer>
  )
}

interface ChangeRow { id: string; day: number | null; kind: string; text: string; at: string; by: string; can_undo: boolean }

/** Every change to the tour's days, newest first; "Return" puts that part of the day back as it was. */
export function TourHistory({ tour, onClose, onChanged }: { tour: Tour; onClose: () => void; onChanged: (t: Tour) => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const key = ['tour-changes', ws.id, tour.id]
  const log = useQuery({ queryKey: key, queryFn: () => api<{ changes: ChangeRow[] }>(wsPath(ws.id, `/tours/${tour.id}/changes`)) })
  const back = useMutation({
    mutationFn: (id: string) => api<Tour>(wsPath(ws.id, `/tours/${tour.id}/changes/${id}/undo`), { method: 'POST' }),
    onSuccess: (t2) => {
      onChanged(t2)
      qc.invalidateQueries({ queryKey: key })
      for (const k of ['bookings', 'alerts', 'meals']) qc.invalidateQueries({ queryKey: [k, ws.id] })
    },
  })
  const when = (s: string) => {
    const d = new Date(s)
    return `${fmt(s.slice(0, 10), lang)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const rows = log.data?.changes ?? []
  return (
    <Drawer title={t('historyTitle')} subtitle={tour.code} onClose={onClose} size="md">
      <ErrorText error={back.error} />
      {log.isSuccess && rows.length === 0 && <p className="py-6 text-center text-sm text-slate-500">{t('historyEmpty')}</p>}
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-slate-800">{r.text}</span>
              <span className="block text-xs text-slate-500">{when(r.at)}{r.by && ` · ${r.by}`}</span>
            </span>
            {r.can_undo && (
              <Button size="sm" variant="secondary" disabled={back.isPending} onClick={() => back.mutate(r.id)} title={t('historyReturnHelp')}>
                <RotateCcw size={14} />{t('historyReturn')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Drawer>
  )
}
