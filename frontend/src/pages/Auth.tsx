import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, ErrorText, Field, Input, LangToggle, Select } from '../components/ui'
import { api, type Me } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { CURRENCIES, guessCurrency } from './Onboarding'

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-[44%] flex-col justify-between bg-gradient-to-br from-brand-700 via-brand-600 to-violet-500 p-12 text-white lg:flex">
        <div className="flex items-center gap-2 text-lg font-bold">
          <img src="/favicon.svg" className="h-8 w-8 rounded-lg ring-2 ring-white/30" alt="" />{t('appName')}
        </div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">{t('tagline')}</h1>
          <ul className="mt-8 space-y-3 text-brand-100">
            {(['pitch1', 'pitch2', 'pitch3', 'pitch4'] as const).map((k) => (
              <li key={k} className="flex items-center gap-3">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white" />{t(k)}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-brand-100">© {new Date().getFullYear()} {t('appName')}</p>
      </div>
      <div className="flex flex-1 flex-col p-6">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 font-bold lg:invisible"><img src="/favicon.svg" className="h-7 w-7 rounded-lg" alt="" />{t('appName')}</span>
          <span className="flex items-center gap-2">
            <Link to="/pricing" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">{t('pr_link')}</Link>
            <LangToggle />
          </span>
        </div>
        <p className="mt-4 text-center text-sm text-slate-600 lg:hidden">{t('tagline')} — {t('taglineMore')}</p>
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  )
}

function useAuthSubmit(path: string) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  // The invite page hands the invited email over in router state, not the URL,
  // so it never lands in browser history or server logs.
  const linkState = useLocation().state as { email?: string } | null
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (body: unknown) => {
    setBusy(true)
    setError(null)
    try {
      const me = await api<Me>(path, { method: 'POST', body })
      qc.setQueryData(['me'], me)
      // Only follow in-app paths, never an external URL smuggled into ?next=.
      const next = params.get('next')
      navigate(next?.startsWith('/') && !next.startsWith('//') ? next : '/')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return { submit, error, busy, params, linkState, prefillEmail: linkState?.email ?? '' }
}

export function LoginPage() {
  const { t } = useI18n()
  const { submit, error, busy, params, linkState, prefillEmail } = useAuthSubmit('/auth/login')
  const [email, setEmail] = useState(prefillEmail)
  const [password, setPassword] = useState('')
  const onSubmit = (e: FormEvent) => { e.preventDefault(); submit({ email, password }) }
  return (
    <AuthLayout>
      <h2 className="text-2xl font-bold">{t('login')}</h2>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <Field label={t('email')}>
          <Input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('password')}>
          <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>{t('login')}</Button>
      </form>
      <div className="mt-6 border-t border-slate-200 pt-5 text-center">
        <p className="text-sm text-slate-600">{t('noAccount')}</p>
        <Link to={`/signup?${params}`} state={linkState}
          className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-800 hover:bg-slate-100">
          {t('signupCta')}
        </Link>
      </div>
    </AuthLayout>
  )
}

export function SignupPage() {
  const { t, lang } = useI18n()
  const { submit, error, busy, params, linkState, prefillEmail } = useAuthSubmit('/auth/signup')
  // Someone arriving from an invite joins an existing agency instead of creating one.
  const fromInvite = params.get('next')?.startsWith('/invite/')
  const [form, setForm] = useState({ full_name: '', email: prefillEmail, password: '', workspace_name: '', base_currency: guessCurrency() })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit({ ...form, workspace_name: fromInvite ? null : form.workspace_name, language: lang })
  }
  return (
    <AuthLayout>
      <h2 className="text-2xl font-bold">{t('signup')}</h2>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <Field label={t('fullName')}>
          <Input required autoFocus autoComplete="name" value={form.full_name} onChange={set('full_name')} />
        </Field>
        <Field label={t('email')}>
          <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label={t('password')} hint={t('passwordHint')}>
          <Input type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        {!fromInvite && (
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label={t('agencyName')}>
              <Input required value={form.workspace_name} onChange={set('workspace_name')} />
            </Field>
            <Field label={t('agencyCurrency')}>
              <Select value={form.base_currency} onChange={set('base_currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
            </Field>
          </div>
        )}
        <ErrorText error={error} />
        {!fromInvite && <p className="text-xs text-slate-500">{t('agencyCurrencyHelp')}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{t('signup')}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        {t('haveAccount')} <Link className="font-semibold text-brand-600" to={`/login?${params}`} state={linkState}>{t('login')}</Link>
      </p>
    </AuthLayout>
  )
}
