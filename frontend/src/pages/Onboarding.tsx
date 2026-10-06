import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Card, ErrorText, Field, Input, Select } from '../components/ui'
import { api, type InvitePublic, type Workspace } from '../lib/api'
import { useI18n, type Lang } from '../lib/i18n'
import { useMe, useRefreshMe } from '../lib/session'
import { AuthLayout } from './Auth'

export const CURRENCIES = ['USD', 'EUR', 'GEL', 'GBP', 'CNY', 'TRY', 'AMD', 'AZN', 'RUB', 'ILS', 'AED', 'KZT']

/** A good first guess for a new agency's currency, from the computer's time zone. */
export function guessCurrency(): string {
  let tz = ''
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { /* old browser */ }
  const byZone: Record<string, string> = {
    'Asia/Tbilisi': 'GEL', 'Europe/Istanbul': 'TRY', 'Asia/Yerevan': 'AMD', 'Asia/Baku': 'AZN', 'Europe/Moscow': 'RUB',
    'Asia/Jerusalem': 'ILS', 'Asia/Tel_Aviv': 'ILS', 'Asia/Dubai': 'AED', 'Asia/Almaty': 'KZT', 'Asia/Astana': 'KZT',
    'Europe/London': 'GBP', 'Asia/Shanghai': 'CNY', 'Asia/Hong_Kong': 'CNY',
  }
  return byZone[tz] ?? (tz.startsWith('Europe/') ? 'EUR' : 'USD')
}

export function WorkspaceForm({ onDone }: { onDone: (ws: Workspace) => void }) {
  const { t, lang } = useI18n()
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState(guessCurrency)
  const [language, setLanguage] = useState<Lang>(lang)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      onDone(await api<Workspace>('/workspaces', { method: 'POST', body: { name, base_currency: currency, language } }))
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label={t('agencyName')}>
        <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('agencyCurrency')} hint={t('agencyCurrencyHelp')}>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label={t('language')}>
          <Select value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
            <option value="ka">ქართული</option>
            <option value="en">English</option>
          </Select>
        </Field>
      </div>
      <ErrorText error={error} />
      <Button type="submit" className="w-full" disabled={busy}>{t('createWorkspace')}</Button>
    </form>
  )
}

export function NewWorkspacePage() {
  const { t } = useI18n()
  const { data: me } = useMe()
  const refresh = useRefreshMe()
  const navigate = useNavigate()
  const hasAny = !!me?.workspaces.length
  return (
    <AuthLayout>
      <h2 className="text-2xl font-bold">{hasAny ? t('newWorkspace') : t('welcomeTitle')}</h2>
      {!hasAny && <p className="mt-2 text-sm text-slate-600">{t('welcomeTextShort')}</p>}
      <div className="mt-6">
        <WorkspaceForm onDone={async (ws) => { await refresh(); navigate(`/w/${ws.id}`) }} />
      </div>
      {hasAny && (
        <Link to="/" className="mt-4 block text-center text-sm text-slate-500 hover:text-slate-700">{t('cancel')}</Link>
      )}
    </AuthLayout>
  )
}

export function InvitePage({ token }: { token: string }) {
  const { t } = useI18n()
  const { data: me } = useMe()
  const refresh = useRefreshMe()
  const navigate = useNavigate()
  const { data: invite } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InvitePublic>(`/invites/${token}`).catch(() => null),
  })
  const [error, setError] = useState<unknown>(null)

  const accept = async () => {
    try {
      const ws = await api<Workspace>(`/invites/${token}/accept`, { method: 'POST' })
      await refresh()
      navigate(`/w/${ws.id}`)
    } catch (e) { setError(e) }
  }

  const next = encodeURIComponent(`/invite/${token}`)
  let body
  if (invite === undefined) body = null
  else if (invite === null) body = <p className="text-slate-600">{t('inviteNotFound')}</p>
  else if (invite.status === 'expired') body = <p className="text-slate-600">{t('inviteExpired')}</p>
  else if (invite.status === 'accepted') body = <p className="text-slate-600">{t('inviteUsed')}</p>
  else {
    const wrongUser = me && me.user.email !== invite.email
    body = (
      <>
        <p className="text-sm text-slate-500">{t('invitedTo')}</p>
        <h2 className="mt-1 text-2xl font-bold">{invite.workspace_name}</h2>
        <p className="mt-1 text-sm text-slate-600">{t('asRole')} <b>{t(`role_${invite.role}`)}</b></p>
        <div className="mt-6 space-y-3">
          {me && !wrongUser && <Button className="w-full" onClick={accept}>{t('acceptInvite')}</Button>}
          {(!me || wrongUser) && (
            <>
              <p className="text-sm text-slate-600">{t('inviteFor')} <b>{invite.email}</b>. {t('loginToAccept')}</p>
              <Link to={`/signup?next=${next}`} state={{ email: invite.email }}><Button type="submit" className="w-full">{t('signup')}</Button></Link>
              <Link to={`/login?next=${next}`} state={{ email: invite.email }}><Button type="submit" variant="secondary" className="w-full">{t('login')}</Button></Link>
            </>
          )}
          <ErrorText error={error} />
        </div>
      </>
    )
  }
  return <AuthLayout><Card className="p-6">{body}</Card></AuthLayout>
}
