/**
 * Email a supplier about a booking, from your own mailbox: a template (booking request, change,
 * cancellation, restaurant, payment) in the supplier's language, filled in from the tour; you check
 * and change the text, then send. The booking becomes "requested", and the email is logged on it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Mail, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { Dialog, toast } from './overlay'
import { Button, ErrorText, Field, Input, Select, Spinner } from './ui'

export const MAIL_KINDS = ['booking_request', 'booking_change', 'booking_cancel', 'restaurant', 'payment'] as const
/** Every template (Settings → Email): the tour's, and the one for a whole series. */
export const TEMPLATE_KINDS = [...MAIL_KINDS, 'series_request', 'rooming'] as const

/** "Subject\n\nBody" on the clipboard: to paste into your own email, WhatsApp or the hotel's form. */
export const copyEmail = (subject: string, body: string) =>
  void navigator.clipboard?.writeText(`${subject}\n\n${body}`).then(() => toast('copied'))
export const MAIL_LANGS = ['en', 'ka', 'ru'] as const
interface Draft { kind: string; language: string; to: string; subject: string; body: string; has_account: boolean; can_attach_rooming?: boolean }
export interface MailLogRow { id: string; tour_id: string | null; vendor_id: string | null; kind: string; sender: string; to: string; subject: string; body: string; error: string; sent_at: string }

/** The tour's sent emails (shared by every booking card of the tour). */
export function useMailLog(tourId: string) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['mail-log', ws.id, tourId], queryFn: () => api<MailLogRow[]>(wsPath(ws.id, `/mail/log?tour_id=${tourId}`)) })
}

export function EmailDialog({ tourId, bookingId, supplier, startKind, onClose }: {
  tourId: string; bookingId: string; supplier: string; startKind?: string; onClose: () => void
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const [kind, setKind] = useState<string | undefined>(startKind)
  const [language, setLanguage] = useState<string>(ws.language === 'ka' ? 'ka' : 'en')
  const [f, setF] = useState({ to: '', cc: '', subject: '', body: '' })
  const [markRequested, setMarkRequested] = useState(true)
  const [rooming, setRooming] = useState(true)   // a hotel: the rooming list goes along unless unticked
  const draft = useQuery({
    queryKey: ['mail-draft', ws.id, bookingId, kind ?? '', language],
    queryFn: () => api<Draft>(wsPath(ws.id, `/tours/${tourId}/bookings/${bookingId}/email-draft`), { method: 'POST', body: { kind, language } }),
    staleTime: 0,
    meta: { silent: true },
  })
  // A new template or language replaces the text (the address stays if you typed one).
  useEffect(() => {
    const d = draft.data
    if (!d) return
    if (!kind) setKind(d.kind)
    setF((cur) => ({ to: cur.to || d.to, cc: cur.cc, subject: d.subject, body: d.body }))
  }, [draft.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
  const send = useMutation({
    mutationFn: () => api<MailLogRow>(wsPath(ws.id, '/mail/send'), {
      method: 'POST',
      body: { to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, tour_id: tourId, booking_id: bookingId, kind, mark_requested: markRequested,
        attach_rooming: !!draft.data?.can_attach_rooming && rooming },
    }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['mail-log', ws.id, tourId] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bookings', ws.id, tourId] }); qc.invalidateQueries({ queryKey: ['tasks', ws.id] }); onClose() },
  })
  const noAccount = draft.data && !draft.data.has_account
  return (
    <Dialog wide title={t('emailTo', { name: supplier })} onClose={onClose}
      footer={draft.data && (noAccount ? (
        <>
          <Button variant="secondary" onClick={onClose}>{t('close')}</Button>
          <Button onClick={() => copyEmail(f.subject, f.body)}><Copy size={15} aria-hidden />{t('emailCopy')}</Button>
        </>
      ) : (
        <>
          <span className="mr-auto flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="size-4" checked={markRequested} onChange={(e) => setMarkRequested(e.target.checked)} />{t('emailMarkRequested')}
            </label>
            {draft.data?.can_attach_rooming && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="size-4" checked={rooming} onChange={(e) => setRooming(e.target.checked)} />{t('emailAttachRooming')}
              </label>
            )}
          </span>
          <Button variant="secondary" onClick={() => copyEmail(f.subject, f.body)}><Copy size={15} aria-hidden />{t('emailCopy')}</Button>
          <Button disabled={send.isPending || !f.to.trim() || !f.subject.trim() || !f.body.trim()} onClick={() => send.mutate()}>
            <Send size={15} aria-hidden />{send.isPending ? t('emailSending') : t('emailSend')}
          </Button>
        </>
      ))}>
      {draft.isPending && <div className="flex justify-center py-8"><Spinner /></div>}
      {noAccount && <NoMailbox onClose={onClose} />}
      {draft.data && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('emailTemplate')}>
              <Select value={kind ?? draft.data.kind} onChange={(e) => setKind(e.target.value)}>
                {MAIL_KINDS.map((k) => <option key={k} value={k}>{t(`mailKind_${k}` as TKey)}</option>)}
              </Select>
            </Field>
            <Field label={t('emailLanguage')}>
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {MAIL_LANGS.map((l) => <option key={l} value={l}>{t(`mailLang_${l}` as TKey)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={t('emailToLabel')} hint={!draft.data.to ? t('emailNoAddress') : undefined}>
            <Input type="text" inputMode="email" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="reservations@hotel.ge" />
          </Field>
          <Field label={t('emailCc')}><Input type="text" inputMode="email" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></Field>
          <Field label={t('emailSubject')}><Input value={f.subject} maxLength={300} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label={t('emailBody')}>
            <textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={14}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </Field>
          <ErrorText error={send.error} />
          <PastEmails tourId={tourId} lang={lang} />
        </div>
      )}
      <ErrorText error={draft.error} />
    </Dialog>
  )
}

function PastEmails({ tourId, lang }: { tourId: string; lang: string }) {
  const { t } = useI18n()
  const log = useMailLog(tourId)
  if (!log.data?.length) return null
  return (
    <details className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-slate-700">{t('emailSentOnTour', { n: log.data.length })}</summary>
      <ul className="mt-2 space-y-1">
        {log.data.slice(0, 10).map((m) => (
          <li key={m.id} className={m.error ? 'text-red-700' : 'text-slate-600'}>
            {fmt(m.sent_at.slice(0, 10), lang)} {m.sent_at.slice(11, 16)} · {m.to} · {m.subject}{m.error && ` — ${m.error}`}
          </li>
        ))}
      </ul>
    </details>
  )
}


/** Not connected: the text can still be copied and sent from your own email or WhatsApp. */
function NoMailbox({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  return (
    <div className="mb-3 space-y-1 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <p className="flex items-center gap-2 font-medium"><Mail size={16} aria-hidden />{t('emailNoAccount')}</p>
      <p>{t('emailNoAccountCopy')}</p>
      <Link to={`/w/${ws.id}/settings/email`} className="inline-block font-medium text-brand-700 underline" onClick={onClose}>{t('emailConnectNow')}</Link>
    </div>
  )
}

interface SeriesDraft {
  language: string; to: string; subject: string; body: string; has_account: boolean
  tours: { tour_id: string; booking_id: string; code: string; start_date: string; status: string; included: boolean }[]
}

/** One booking request to a supplier for a route's departures: tick which groups, check the text,
 * send it once (each departure's booking becomes "requested") or copy it. */
export function SeriesEmailDialog({ seriesId, vendorId, supplier, seriesCode, onClose }: {
  seriesId: string; vendorId: string; supplier: string; seriesCode: string; onClose: () => void
}) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const [language, setLanguage] = useState<string>(ws.language === 'ka' ? 'ka' : 'en')
  const [picked, setPicked] = useState<string[] | null>(null)      // null: every upcoming departure
  const [f, setF] = useState({ to: '', cc: '', subject: '', body: '' })
  const [markRequested, setMarkRequested] = useState(true)
  const draft = useQuery({
    queryKey: ['series-mail-draft', ws.id, seriesId, vendorId, language, picked?.join(',') ?? '*'],
    queryFn: () => api<SeriesDraft>(wsPath(ws.id, `/series/${seriesId}/bookings/${vendorId}/email-draft`), {
      method: 'POST', body: { language, tour_ids: picked },
    }),
    placeholderData: (x) => x, staleTime: 0, meta: { silent: true },
  })
  useEffect(() => {
    const d = draft.data
    if (d) setF((cur) => ({ to: cur.to || d.to, cc: cur.cc, subject: d.subject, body: d.body }))
  }, [draft.data])
  const tours = draft.data?.tours ?? []
  const chosen = tours.filter((x) => (picked ? picked.includes(x.tour_id) : true))
  const toggle = (id: string) => {
    const now = picked ?? tours.map((x) => x.tour_id)
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id]
    if (next.length) setPicked(next)
  }
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
  const send = useMutation({
    mutationFn: () => api<MailLogRow>(wsPath(ws.id, '/mail/send'), {
      method: 'POST',
      body: { to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, kind: 'series_request',
        booking_ids: chosen.map((x) => x.booking_id), mark_requested: markRequested },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['seriesBookings', ws.id, seriesId] }); qc.invalidateQueries({ queryKey: ['tasks', ws.id] }); onClose() },
  })
  const noAccount = draft.data && !draft.data.has_account
  return (
    <Dialog wide title={t('seriesEmailTitle', { name: supplier, code: seriesCode })} onClose={onClose}
      footer={draft.data && (
        <>
          {!noAccount && (
            <label className="mr-auto flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="size-4" checked={markRequested} onChange={(e) => setMarkRequested(e.target.checked)} />{t('emailMarkRequested')}
            </label>
          )}
          <Button variant="secondary" onClick={() => copyEmail(f.subject, f.body)}><Copy size={15} aria-hidden />{t('emailCopy')}</Button>
          {!noAccount && (
            <Button disabled={send.isPending || !f.to.trim() || !f.subject.trim() || !f.body.trim() || !chosen.length} onClick={() => send.mutate()}>
              <Send size={15} aria-hidden />{send.isPending ? t('emailSending') : t('emailSend')}
            </Button>
          )}
        </>
      )}>
      {draft.isPending && <div className="flex justify-center py-8"><Spinner /></div>}
      {noAccount && <NoMailbox onClose={onClose} />}
      {draft.data && (
        <div className="space-y-3">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('seriesEmailDepartures', { n: chosen.length, total: tours.length })}</legend>
            <div className="flex flex-wrap gap-1.5">
              {tours.map((x) => {
                const on = picked ? picked.includes(x.tour_id) : true
                return (
                  <button key={x.tour_id} type="button" aria-pressed={on} onClick={() => toggle(x.tour_id)}
                    className={on ? 'rounded-full border border-brand-300 bg-brand-50 px-3 py-1 text-xs text-brand-800' : 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-400 line-through'}>
                    <b className="font-mono font-semibold">{x.code}</b> · {fmt(x.start_date, lang)}
                  </button>
                )
              })}
            </div>
          </fieldset>
          <Field label={t('emailLanguage')}>
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {MAIL_LANGS.map((l) => <option key={l} value={l}>{t(`mailLang_${l}` as TKey)}</option>)}
            </Select>
          </Field>
          <Field label={t('emailToLabel')} hint={!draft.data.to ? t('emailNoAddress') : undefined}>
            <Input type="text" inputMode="email" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="reservations@hotel.ge" />
          </Field>
          <Field label={t('emailCc')}><Input type="text" inputMode="email" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></Field>
          <Field label={t('emailSubject')}><Input value={f.subject} maxLength={300} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label={t('emailBody')}>
            <textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={16}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </Field>
          <ErrorText error={send.error} />
        </div>
      )}
      <ErrorText error={draft.error} />
    </Dialog>
  )
}


interface RoomingDraft { booking_id: string; vendor_id: string; name: string; to: string; check_in: string; check_out: string; subject: string; body: string }
type Letter = RoomingDraft & { on: boolean }

/** The rooming list to the tour's hotels: every hotel of this tour ticked, each its own letter (its dates and
 * rooms); copy one, or send to the ticked ones with the Excel list attached. */
export function RoomingEmailDialog({ tourId, onClose }: { tourId: string; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [language, setLanguage] = useState<string>(ws.language === 'ka' ? 'ka' : 'en')
  const [letters, setLetters] = useState<Letter[]>([])
  const [active, setActive] = useState(0)
  const drafts = useQuery({
    queryKey: ['rooming-drafts', ws.id, tourId, language],
    queryFn: () => api<RoomingDraft[]>(wsPath(ws.id, `/tours/${tourId}/rooming-drafts`), { method: 'POST', body: { language } }),
    staleTime: 0, meta: { silent: true },
  })
  useEffect(() => {
    if (!drafts.data) return
    setLetters((cur) => drafts.data.map((d) => {
      const was = cur.find((x) => x.booking_id === d.booking_id)
      return { ...d, to: was?.to || d.to, on: was ? was.on : true }
    }))
  }, [drafts.data])
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
  const ready = letters.filter((l) => l.on && split(l.to).length)
  const send = useMutation({
    mutationFn: async () => {
      for (const l of ready) {
        await api(wsPath(ws.id, '/mail/send'), {
          method: 'POST',
          body: { to: split(l.to), subject: l.subject, body: l.body, tour_id: tourId, booking_id: l.booking_id, kind: 'rooming',
            mark_requested: false, attach_rooming: true },
        })
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['mail-log', ws.id, tourId] }),
    onSuccess: () => { toast('roomingSent'); onClose() },
  })
  const cur = letters[active]
  const set = (p: Partial<Letter>) => setLetters(letters.map((l, i) => (i === active ? { ...l, ...p } : l)))
  return (
    <Dialog wide title={t('roomingSend')} onClose={onClose}
      footer={letters.length > 0 && (
        <>
          <Button variant="secondary" onClick={() => cur && copyEmail(cur.subject, cur.body)}><Copy size={15} aria-hidden />{t('emailCopy')}</Button>
          <Button disabled={send.isPending || !ready.length} onClick={() => send.mutate()} title={!ready.length ? t('roomingNoAddress') : undefined}>
            <Send size={15} aria-hidden />{send.isPending ? t('emailSending') : t('roomingSendTo', { n: ready.length })}
          </Button>
        </>
      )}>
      {drafts.isPending && <div className="flex justify-center py-8"><Spinner /></div>}
      {drafts.data && !letters.length && <p className="text-sm text-slate-600">{t('roomingNoHotels')}</p>}
      {letters.length > 0 && (
        <div className="space-y-3">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('roomingHotels')}</legend>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {letters.map((l, i) => (
                <li key={l.booking_id} className={i === active ? 'flex items-center gap-3 bg-brand-50/60 px-3 py-2' : 'flex items-center gap-3 px-3 py-2'}>
                  <input type="checkbox" className="size-4" checked={l.on} aria-label={l.name}
                    onChange={(e) => setLetters(letters.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                  <button type="button" onClick={() => setActive(i)} className="min-w-0 flex-1 text-left text-sm">
                    <b className="font-medium text-slate-900">{l.name}</b>
                    <span className="ml-2 text-slate-500">{l.check_in} – {l.check_out}</span>
                    {!l.to && <span className="ml-2 text-xs text-amber-700">{t('roomingNoEmail')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
          <Field label={t('emailLanguage')}>
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {MAIL_LANGS.map((l) => <option key={l} value={l}>{t(`mailLang_${l}` as TKey)}</option>)}
            </Select>
          </Field>
          {cur && (
            <div className="space-y-3 rounded-lg border border-slate-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('roomingLetterFor', { name: cur.name })}</p>
              <Field label={t('emailToLabel')}><Input type="text" inputMode="email" value={cur.to} onChange={(e) => set({ to: e.target.value })} placeholder="reservations@hotel.ge" /></Field>
              <Field label={t('emailSubject')}><Input value={cur.subject} maxLength={300} onChange={(e) => set({ subject: e.target.value })} /></Field>
              <Field label={t('emailBody')}>
                <textarea value={cur.body} onChange={(e) => set({ body: e.target.value })} rows={14}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              </Field>
            </div>
          )}
          <ErrorText error={send.error} />
        </div>
      )}
      <ErrorText error={drafts.error} />
    </Dialog>
  )
}
