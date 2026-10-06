/**
 * The public pricing page (/pricing): three plans in lari, monthly or yearly, what every plan has,
 * and the questions agencies ask before they start. Numbers live in lib/plans.ts.
 */
import { Check, Minus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { LangToggle } from '../components/ui'
import { useI18n, type TKey } from '../lib/i18n'
import { PLANS, TRIAL_DAYS, VAT_PERCENT, YEARLY_MONTHS, yearlyPerMonth, type Plan } from '../lib/plans'
import { useMe } from '../lib/session'
import { cn } from '../lib/utils'

const INCLUDED: TKey[] = ['pr_inc_tours', 'pr_inc_suppliers', 'pr_inc_calc', 'pr_inc_bookings', 'pr_inc_days', 'pr_inc_finance',
  'pr_inc_phone', 'pr_inc_email', 'pr_inc_langs', 'pr_inc_backups']
const FAQ: [TKey, TKey][] = [
  ['pr_q_trial', 'pr_a_trial'], ['pr_q_pay', 'pr_a_pay'], ['pr_q_move', 'pr_a_move'], ['pr_q_guides', 'pr_a_guides'],
  ['pr_q_users', 'pr_a_users'], ['pr_q_data', 'pr_a_data'], ['pr_q_cancel', 'pr_a_cancel'],
]

export function PricingPage() {
  const { t } = useI18n()
  const [yearly, setYearly] = useState(false)
  const loggedIn = !!useMe().data
  return (
    <div className="min-h-screen bg-white text-slate-800">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 font-bold"><img src="/favicon.svg" className="h-8 w-8 rounded-lg" alt="" />{t('appName')}</Link>
        <nav className="flex items-center gap-2" aria-label={t('appName')}>
          <LangToggle />
          {loggedIn ? (
            <Link to="/" className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">{t('pr_openApp')}</Link>
          ) : (
            <>
              <Link to="/login" className="hidden h-10 items-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex">{t('login')}</Link>
              <Link to="/signup" className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">{t('pr_tryFree')}</Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-4 pb-10 pt-8 text-center sm:px-6 sm:pt-14">
          <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-5xl">{t('pr_title')}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600">{t('pr_subtitle', { days: TRIAL_DAYS })}</p>
          <div className="mt-8 inline-flex rounded-full bg-slate-100 p-1" role="group" aria-label={t('pr_billing')}>
            {[false, true].map((y) => (
              <button key={String(y)} type="button" aria-pressed={yearly === y} onClick={() => setYearly(y)}
                className={cn('min-h-10 rounded-full px-5 text-sm font-medium', yearly === y ? 'bg-white text-slate-900 shadow' : 'text-slate-600 hover:text-slate-900')}>
                {y ? <>{t('pr_yearly')} <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">{t('pr_monthsFree', { n: 12 - YEARLY_MONTHS })}</span></> : t('pr_monthly')}
              </button>
            ))}
          </div>
        </section>

        <section aria-label={t('pr_plans')} className="mx-auto grid max-w-6xl gap-5 px-4 sm:px-6 lg:grid-cols-3">
          {PLANS.map((p) => <PlanCard key={p.id} plan={p} yearly={yearly} />)}
        </section>
        <p className="mx-auto mt-4 max-w-6xl px-4 text-center text-sm text-slate-600 sm:px-6">{t('pr_vat', { vat: VAT_PERCENT })}</p>

        <section className="mx-auto mt-16 max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-bold">{t('pr_allPlans')}</h2>
          <ul className="mx-auto mt-6 grid max-w-4xl gap-x-8 gap-y-3 sm:grid-cols-2">
            {INCLUDED.map((k) => (
              <li key={k} className="flex items-start gap-3 text-slate-700">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Check size={14} aria-hidden /></span>{t(k)}
              </li>
            ))}
          </ul>
        </section>

        <section className="mx-auto mt-16 max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-bold">{t('pr_faq')}</h2>
          <div className="mt-6 divide-y divide-slate-200 rounded-xl border border-slate-200">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group px-5 py-4">
                <summary className="cursor-pointer list-none font-medium text-slate-800 marker:hidden">
                  <span className="flex items-center justify-between gap-3">{t(q)}<span aria-hidden className="text-slate-400 transition-transform group-open:rotate-45">+</span></span>
                </summary>
                <p className="mt-2 text-slate-600">{t(a, { days: TRIAL_DAYS, vat: VAT_PERCENT })}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-auto my-16 max-w-4xl px-4 sm:px-6">
          <div className="rounded-2xl bg-gradient-to-br from-brand-700 via-brand-600 to-violet-500 px-6 py-10 text-center text-white sm:px-10">
            <h2 className="text-2xl font-bold sm:text-3xl">{t('pr_ctaTitle')}</h2>
            <p className="mx-auto mt-3 max-w-xl text-brand-100">{t('pr_ctaText', { days: TRIAL_DAYS })}</p>
            {!loggedIn && (
              <Link to="/signup" className="mt-6 inline-flex h-11 items-center rounded-lg bg-white px-6 font-medium text-brand-700 hover:bg-brand-50">{t('pr_tryFree')}</Link>
            )}
          </div>
        </section>
      </main>
      <footer className="border-t border-slate-200 py-6 text-center text-sm text-slate-500">© {new Date().getFullYear()} {t('appName')}</footer>
    </div>
  )
}

function PlanCard({ plan: p, yearly }: { plan: Plan; yearly: boolean }) {
  const { t } = useI18n()
  const price = yearly ? yearlyPerMonth(p) : p.monthly
  const rows: [boolean, string][] = [
    [true, p.extraUser ? t('pr_usersExtra', { n: p.users, extra: p.extraUser }) : t('pr_users', { n: p.users })],
    [true, t('pr_unlimited')],
    [true, t('pr_phoneFree')],
    [p.jobs, t('pr_jobs')],
    [true, t('pr_ai', { amount: p.aiAllowance })],
    [true, t(`pr_onboard_${p.onboarding}` as TKey)],
  ]
  return (
    <article className={cn('relative flex flex-col rounded-2xl border bg-white p-6 sm:p-7',
      p.popular ? 'border-brand-500 shadow-lg ring-1 ring-brand-500' : 'border-slate-200')}>
      {p.popular && <span className="absolute -top-3 left-6 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">{t('pr_popular')}</span>}
      <h3 className="text-lg font-semibold">{t(`pr_plan_${p.id}` as TKey)}</h3>
      <p className="mt-1 min-h-10 text-sm text-slate-600">{t(`pr_for_${p.id}` as TKey)}</p>
      <p className="mt-5 flex items-baseline gap-1">
        <span className="text-4xl font-bold tabular-nums">{price}</span><span className="text-2xl font-semibold">₾</span>
        <span className="ml-1 text-sm text-slate-600">{t('pr_perMonth')}</span>
      </p>
      <p className="mt-1 min-h-5 text-sm text-slate-600">{yearly ? t('pr_billedYearly', { total: p.monthly * YEARLY_MONTHS }) : ' '}</p>
      <Link to={`/signup?plan=${p.id}`}
        className={cn('mt-6 inline-flex h-11 items-center justify-center rounded-lg text-sm font-medium',
          p.popular ? 'bg-brand-600 text-white hover:bg-brand-700' : 'border border-slate-300 text-slate-800 hover:bg-slate-50')}>
        {t('pr_startTrial', { days: TRIAL_DAYS })}
      </Link>
      <ul className="mt-6 space-y-2.5 text-sm">
        {rows.map(([on, text]) => (
          <li key={text} className={cn('flex items-start gap-2.5', on ? 'text-slate-700' : 'text-slate-400')}>
            {on ? <Check size={16} aria-hidden className="mt-0.5 shrink-0 text-brand-600" /> : <Minus size={16} aria-hidden className="mt-0.5 shrink-0" />}
            <span>{on ? text : <><span className="sr-only">{t('pr_notIncluded')}: </span>{text}</>}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}
