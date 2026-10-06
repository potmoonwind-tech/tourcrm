/**
 * Email a supplier about a booking, from your own mailbox: a template (booking request, change,
 * cancellation, restaurant, payment) in the supplier's language, filled in from the tour; you check
 * and change the text, then send. The booking becomes "requested", and the email is logged on it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { Dialog } from './overlay'
import { Button, ErrorText, Field, Input, Select, Spinner } from './ui'

export const MAIL_KINDS = ['booking_request', 'booking_change', 'booking_cancel', 'restaurant', 'payment'] as const
export const MAIL_LANGS = ['en', 'ka', 'ru'] as const
interface Draft { kind: string; language: string; to: string; subject: string; body: string; has_account: boolean }
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
      body: { to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, tour_id: tourId, booking_id: bookingId, kind, mark_requested: markRequested },
    }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['mail-log', ws.id, tourId] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bookings', ws.id, tourId] }); qc.invalidateQueries({ queryKey: ['tasks', ws.id] }); onClose() },
  })
  const noAccount = draft.data && !draft.data.has_account
  return (
    <Dialog wide title={t('emailTo', { name: supplier })} onClose={onClose}
      footer={!noAccount && (
        <>
          <label className="mr-auto flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="size-4" checked={markRequested} onChange={(e) => setMarkRequested(e.target.checked)} />{t('emailMarkRequested')}
          </label>
          <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button disabled={send.isPending || !f.to.trim() || !f.subject.trim() || !f.body.trim()} onClick={() => send.mutate()}>
            <Send size={15} aria-hidden />{send.isPending ? t('emailSending') : t('emailSend')}
          </Button>
        </>
      )}>
      {draft.isPending && <div className="flex justify-center py-8"><Spinner /></div>}
      {noAccount && (
        <div className="space-y-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="flex items-center gap-2 font-medium"><Mail size={16} aria-hidden />{t('emailNoAccount')}</p>
          <p>{t('emailNoAccountHelp')}</p>
          <Link to={`/w/${ws.id}/settings/email`} className="inline-block font-medium text-brand-700 underline" onClick={onClose}>{t('emailConnectNow')}</Link>
        </div>
      )}
      {draft.data && !noAccount && (
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
