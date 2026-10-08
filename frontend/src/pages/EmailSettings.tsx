/**
 * Settings → Email: your own mailbox (to send from the CRM) and the agency's email templates.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, Mail, RotateCcw } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { MAIL_LANGS, TEMPLATE_KINDS } from '../components/EmailDialog'
import { ask } from '../components/overlay'
import { Button, Card, ErrorText, Field, Input, Select } from '../components/ui'
import { api, can } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { PageHeader } from './Dashboard'

interface Account { connected: boolean; provider: string; email: string; from_name: string; smtp_host: string; smtp_port: number; signature: string; last_ok_at: string | null }
interface Template { kind: string; language: string; subject: string; body: string; custom: boolean }

const PLACEHOLDERS = ['supplier', 'contact', 'group', 'tour_code', 'pax', 'dates', 'check_in', 'check_out', 'nights', 'rooms', 'what', 'reference', 'notes', 'client', 'my_name', 'agency', 'signature']
// A series email's own: the route, how many groups, and each departure's block.
const SERIES_PLACEHOLDERS = ['supplier', 'series', 'count', 'departures', 'dates', 'notes', 'my_name', 'agency', 'signature']

export function EmailSettingsPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  return (
    <>
      <PageHeader section="settings" title={t('settings')} subtitle={ws.name} />
      <div className="max-w-4xl space-y-6 p-4 md:p-8">
        <MailboxCard />
        <TemplatesCard canEdit={can(ws, 'operations', 'finance')} />
      </div>
    </>
  )
}

function MailboxCard() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const key = ['mail-account', ws.id]
  const acc = useQuery({ queryKey: key, queryFn: () => api<Account>(wsPath(ws.id, '/mail/account')) })
  const [f, setF] = useState({ provider: 'gmail', email: '', from_name: '', password: '', smtp_host: '', smtp_port: '587', signature: '' })
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const a = acc.data
    if (a?.connected) setF((cur) => ({ ...cur, provider: a.provider, email: a.email, from_name: a.from_name, smtp_host: a.smtp_host, smtp_port: String(a.smtp_port), signature: a.signature }))
  }, [acc.data])
  const save = useMutation({
    mutationFn: () => api<Account>(wsPath(ws.id, '/mail/account'), {
      method: 'PUT',
      body: { provider: f.provider, email: f.email, from_name: f.from_name, signature: f.signature, password: f.password || null,
        ...(f.provider === 'other' ? { smtp_host: f.smtp_host, smtp_port: Number(f.smtp_port) || 587 } : {}) },
    }),
    onSuccess: (a) => { qc.setQueryData(key, a); setF((cur) => ({ ...cur, password: '' })); setEditing(false) },
  })
  const remove = useMutation({
    mutationFn: () => api(wsPath(ws.id, '/mail/account'), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })
  const a = acc.data
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const open = editing || (a && !a.connected)
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Mail size={18} aria-hidden />{t('mailboxTitle')}</h2>
      <p className="mt-1 text-sm text-slate-600">{t('mailboxHelp')}</p>
      {a?.connected && !editing && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm">
          <CheckCircle2 size={18} aria-hidden className="text-emerald-700" />
          <span className="min-w-48 flex-1">
            <b>{a.from_name ? `${a.from_name} <${a.email}>` : a.email}</b>
            {a.last_ok_at && <span className="block text-xs text-slate-600">{t('mailboxChecked', { date: fmt(a.last_ok_at.slice(0, 10), lang) })}</span>}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t('edit')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void ask({ title: t('mailboxDisconnect'), danger: true }).then((ok) => ok && remove.mutate())}>{t('mailboxDisconnectShort')}</Button>
        </div>
      )}
      {open && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }} className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <Field label={t('mailboxProvider')}>
              <Select value={f.provider} onChange={set('provider')}>
                <option value="gmail">Gmail / Google Workspace</option>
                <option value="outlook">Outlook / Hotmail</option>
                <option value="other">{t('mailboxOther')}</option>
              </Select>
            </Field>
            <Field label={t('email')}><Input type="email" required value={f.email} onChange={set('email')} placeholder="you@gmail.com" /></Field>
          </div>
          {f.provider === 'other' && (
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <Field label={t('mailboxServer')}><Input required value={f.smtp_host} onChange={set('smtp_host')} placeholder="mail.yourdomain.ge" /></Field>
              <Field label={t('mailboxPort')}>
                <Select value={f.smtp_port} onChange={set('smtp_port')}><option value="587">587</option><option value="465">465</option></Select>
              </Field>
            </div>
          )}
          <Field label={t('mailboxPassword')} hint={a?.connected ? t('mailboxPasswordKeep') : undefined}>
            <Input type="password" autoComplete="new-password" required={!a?.connected} value={f.password} onChange={set('password')} placeholder="xxxx xxxx xxxx xxxx" />
          </Field>
          <AppPasswordHelp provider={f.provider} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('mailboxFromName')} hint={t('mailboxFromNameHint')}><Input value={f.from_name} maxLength={120} onChange={set('from_name')} placeholder={`${ws.name}`} /></Field>
          </div>
          <Field label={t('mailboxSignature')}>
            <textarea value={f.signature} onChange={set('signature')} rows={4} maxLength={2000}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </Field>
          <ErrorText error={save.error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>{save.isPending ? t('mailboxChecking') : a?.connected ? t('save') : t('mailboxConnect')}</Button>
            {a?.connected && <Button variant="secondary" onClick={() => setEditing(false)}>{t('cancel')}</Button>}
          </div>
        </form>
      )}
    </Card>
  )
}

/** Where to get an app password, step by step. */
function AppPasswordHelp({ provider }: { provider: string }) {
  const { t } = useI18n()
  if (provider === 'other') return <p className="text-sm text-slate-600">{t('appPwOther')}</p>
  const gmail = provider === 'gmail'
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
      <p className="font-medium">{t('appPwTitle')}</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
        <li>{t(gmail ? 'appPwGmail1' : 'appPwOutlook1')}</li>
        <li>{t(gmail ? 'appPwGmail2' : 'appPwOutlook2')}</li>
        <li>{t('appPwPaste')}</li>
      </ol>
      <a href={gmail ? 'https://myaccount.google.com/apppasswords' : 'https://account.microsoft.com/security'} target="_blank" rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
        {t(gmail ? 'appPwOpenGoogle' : 'appPwOpenMicrosoft')}<ExternalLink size={13} aria-hidden />
      </a>
    </div>
  )
}

function TemplatesCard({ canEdit }: { canEdit: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const key = ['mail-templates', ws.id]
  const list = useQuery({ queryKey: key, queryFn: () => api<Template[]>(wsPath(ws.id, '/mail/templates')) })
  const [kind, setKind] = useState<string>('booking_request')
  const [language, setLanguage] = useState<string>(ws.language === 'ka' ? 'ka' : 'en')
  const cur = list.data?.find((x) => x.kind === kind && x.language === language)
  const [f, setF] = useState({ subject: '', body: '' })
  useEffect(() => { if (cur) setF({ subject: cur.subject, body: cur.body }) }, [cur?.subject, cur?.body, kind, language]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/mail/templates/${kind}/${language}`), { method: 'PUT', body: f }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })
  const reset = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/mail/templates/${kind}/${language}`), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })
  const dirty = cur && (f.subject !== cur.subject || f.body !== cur.body)
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{t('templatesTitle')}</h2>
      <p className="mt-1 text-sm text-slate-600">{t('templatesHelp')}</p>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label={t('emailTemplate')}>
        {TEMPLATE_KINDS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={cn('rounded-full border px-3 py-1.5 text-sm', kind === k ? 'border-brand-500 bg-brand-50 font-medium text-brand-900' : 'border-slate-200 text-slate-700 hover:border-slate-300')}>
            {t(`mailKind_${k}` as TKey)}
            {list.data?.some((x) => x.kind === k && x.custom) && <span className="ml-1 text-xs text-brand-700">•</span>}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-1" role="group" aria-label={t('emailLanguage')}>
        {MAIL_LANGS.map((l) => (
          <button key={l} type="button" aria-pressed={language === l} onClick={() => setLanguage(l)}
            className={cn('rounded-md px-2.5 py-1 text-sm', language === l ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100')}>
            {t(`mailLang_${l}` as TKey)}
          </button>
        ))}
      </div>
      {cur && (
        <fieldset disabled={!canEdit} className="mt-4 space-y-3">
          <Field label={t('emailSubject')}><Input value={f.subject} maxLength={300} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label={t('emailBody')}>
            <textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={12}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </Field>
          <p className="text-xs text-slate-600">{t('templatesPlaceholders')} {(kind === 'series_request' ? SERIES_PLACEHOLDERS : PLACEHOLDERS).map((p) => <code key={p} className="mr-1 rounded bg-slate-100 px-1">{`{${p}}`}</code>)}</p>
          <ErrorText error={save.error || reset.error} />
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{t('save')}</Button>
              {cur.custom && (
                <Button variant="ghost" onClick={() => void ask({ title: t('templatesResetAsk') }).then((ok) => ok && reset.mutate())}>
                  <RotateCcw size={15} aria-hidden />{t('templatesReset')}
                </Button>
              )}
              <span className="text-xs text-slate-500">{cur.custom ? t('templatesCustom') : t('templatesBuiltIn')}</span>
            </div>
          )}
        </fieldset>
      )}
    </Card>
  )
}
