import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask } from '../components/overlay'
import { PaymentTermsEditor } from '../components/PaymentTermsEditor'
import { ScaleEditor } from '../components/ScaleEditor'
import { NbgButton } from '../components/money'
import { Copy, Check, KeyRound, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, ErrorText, Field, Input, RoleBadge, Select } from '../components/ui'
import { api, atLeast, ROLES, WORK_KINDS, type ExchangeRate, type Invite, type Member, type Role, type Workspace, can, JOBS, type Job } from '../lib/api'
import { useI18n, type Lang, type TKey } from '../lib/i18n'
import { useMe, useRefreshMe, useWorkspace } from '../lib/session'
import { fmt as fmtDate } from '../lib/dates'
import { PageHeader } from './Dashboard'
import { useMembers, wsPath } from '../lib/data'
import { CURRENCIES } from './Onboarding'
import { cn } from '../lib/utils'
import { AppearanceCard } from '../components/ThemePicker'

export function TeamPage() {
  const ws = useWorkspace()!
  const { data: me } = useMe()
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const refreshMe = useRefreshMe()
  const navigate = useNavigate()
  const isAdmin = atLeast(ws.role, 'admin')
  const isOwner = ws.role === 'owner'
  const base = `/workspaces/${ws.id}`

  const members = useQuery({ queryKey: ['members', ws.id], queryFn: () => api<Member[]>(`${base}/members`) })
  const invites = useQuery({
    queryKey: ['invites', ws.id], queryFn: () => api<Invite[]>(`${base}/invites`), enabled: isAdmin,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['members', ws.id] })
    qc.invalidateQueries({ queryKey: ['invites', ws.id] })
  }

  const changeRole = useMutation({
    mutationFn: ({ id, role, jobs }: { id: string; role?: Role; jobs?: Job[] }) =>
      api(`${base}/members/${id}`, { method: 'PATCH', body: { role, jobs } }),
    onSuccess: () => { invalidate(); refreshMe() },
  })
  const removeMember = useMutation({
    mutationFn: (m: Member) => api(`${base}/members/${m.id}`, { method: 'DELETE' }),
    onSuccess: (_, m) => {
      if (m.user_id === me?.user.id) { refreshMe(); navigate('/') } else invalidate()
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api(`${base}/invites/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  // Which roles the current user may hand out: only owners create owners.
  const assignable = ROLES.filter((r) => r !== 'owner' || isOwner)
  const fmt = (d: string) => fmtDate(d.slice(0, 10), lang, { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <>
      <PageHeader section="settings" title={t('settings')} subtitle={ws.name} />
      <div className="max-w-4xl space-y-6 p-4 md:p-8">
        {isAdmin && <InviteForm workspaceId={ws.id} roles={assignable} onDone={invalidate} />}

        {isAdmin && !!invites.data?.length && (
          <Card>
            <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-500">{t('pendingInvites')}</h2>
            <ul className="divide-y divide-slate-100">
              {invites.data.map((inv) => (
                <li key={inv.id} className="flex items-center gap-4 px-5 py-3 text-sm">
                  <span className="flex-1 truncate font-medium">{inv.email}</span>
                  <RoleBadge role={inv.role} />
                  <span className="hidden text-slate-500 sm:inline">{t('expires')} {fmt(inv.expires_at)}</span>
                  <CopyButton text={inv.link} />
                  <Button size="sm" variant="ghost" onClick={() => void ask({ title: t('confirmRevoke', { email: inv.email }), danger: true }).then((ok) => ok && revoke.mutate(inv.id))}>{t('revoke')}</Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-500">
            {t('members')} · {members.data?.length ?? ''}
          </h2>
          <ErrorText error={changeRole.error || removeMember.error} />
          <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <tbody className="divide-y divide-slate-100">
              {members.data?.map((m) => {
                const self = m.user_id === me?.user.id
                // Mirrors the API's rules so the UI never offers a forbidden action.
                const canEdit = isAdmin && !self && (m.role !== 'owner' || isOwner)
                const soleOwner = m.role === 'owner' && members.data!.filter((x) => x.role === 'owner').length === 1
                const canLeave = self && !soleOwner
                return (
                  <tr key={m.id}>
                    <td className="px-5 py-3">
                      <p className="font-medium">{m.full_name || m.email}{self && <span className="text-slate-400"> ({t('you')})</span>}</p>
                      <p className="text-slate-500">{m.email}</p>
                    </td>
                    <td className="px-5 py-3">
                      {canEdit ? (
                        <Select className="h-8 w-40" value={m.role}
                          onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Role })}>
                          {assignable.map((r) => <option key={r} value={r}>{t(`role_${r}`)}</option>)}
                        </Select>
                      ) : <RoleBadge role={m.role} />}
                    </td>
                    <td className="px-5 py-3">
                      <JobPicker member={m} canEdit={isAdmin && (m.role !== 'owner' || isOwner)}
                        onChange={(jobs) => changeRole.mutate({ id: m.id, jobs })} />
                    </td>
                    <td className="hidden px-5 py-3 text-slate-500 md:table-cell">{t('joined')} {fmt(m.created_at)}</td>
                    <td className="px-5 py-3 text-right">
                      {(canEdit || canLeave) && (
                        <Button size="sm" variant="ghost"
                          onClick={() => void ask({ title: self ? t('confirmLeave') : t('confirmRemove'), danger: true }).then((ok) => ok && removeMember.mutate(m))}>
                          {self ? t('leave') : <Trash2 size={16} />}
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-500">{t('jobsTitle')}</h2>
          <dl className="mb-5 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            {JOBS.map((j) => (
              <div key={j} className="contents">
                <dt className="font-medium text-slate-800">{t(`job_${j}` as TKey)}</dt>
                <dd className="text-slate-600">{t(`jobDesc_${j}` as TKey)}</dd>
              </div>
            ))}
          </dl>
          <h2 className="mb-3 text-sm font-semibold text-slate-500">{t('role')}</h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr]">
            {ROLES.map((r) => (
              <div key={r} className="contents">
                <dt><RoleBadge role={r} /></dt>
                <dd className="text-slate-600">{t(`roleDesc_${r}`)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  )
}

function InviteForm({ workspaceId, roles, onDone }: { workspaceId: string; roles: Role[]; onDone: () => void }) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [jobs, setJobs] = useState<Job[]>(['operations'])
  const [created, setCreated] = useState<Invite | null>(null)
  const withJobs = role === 'staff' || role === 'manager'
  const create = useMutation({
    mutationFn: () => api<Invite>(`/workspaces/${workspaceId}/invites`, { method: 'POST', body: { email, role, ...(withJobs ? { jobs } : {}) } }),
    onSuccess: (inv) => { setCreated(inv); setEmail(''); onDone() },
  })
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate() }
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{t('inviteMember')}</h2>
      <p className="mt-1 text-sm text-slate-500">{t('inviteHelp')}</p>
      <form onSubmit={onSubmit} className="mt-4 flex flex-wrap gap-3">
        <Input type="email" required placeholder={t('email')} value={email}
          onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" />
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-44">
          {roles.map((r) => <option key={r} value={r}>{t(`role_${r}`)}</option>)}
        </Select>
        <Button type="submit" disabled={create.isPending}>{t('invite')}</Button>
        {withJobs && (
          <fieldset className="flex w-full flex-wrap items-center gap-2">
            <legend className="mb-1 w-full text-sm text-slate-600">{t('inviteJobs')}</legend>
            {JOBS.map((j) => (
              <JobChip key={j} job={j} on={jobs.includes(j)} onToggle={() => setJobs(jobs.includes(j) ? jobs.filter((x) => x !== j) : [...jobs, j])} />
            ))}
          </fieldset>
        )}
      </form>
      <div className="mt-3"><ErrorText error={create.error} /></div>
      {created && (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-brand-50 px-3 py-2 text-sm">
          <code className="flex-1 truncate text-brand-700">{created.link}</code>
          <CopyButton text={created.link} />
        </div>
      )}
    </Card>
  )
}

/** What a member does here. Owners and admins do everything; guides only their phone page. */
function JobPicker({ member, canEdit, onChange }: { member: Member; canEdit: boolean; onChange: (jobs: Job[]) => void }) {
  const { t } = useI18n()
  if (member.role === 'owner' || member.role === 'admin') return <span className="text-sm text-slate-600">{t('jobsAll')}</span>
  if (member.role === 'guide') return <span className="text-sm text-slate-500">—</span>
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('jobsOf', { name: member.full_name || member.email })}>
      {JOBS.map((j) => {
        const on = member.jobs.includes(j)
        return canEdit
          ? <JobChip key={j} job={j} on={on} onToggle={() => onChange(on ? member.jobs.filter((x) => x !== j) : [...member.jobs, j])} />
          : on ? <span key={j} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800">{t(`job_${j}` as TKey)}</span> : null
      })}
      {!member.jobs.length && !canEdit && <span className="text-sm text-slate-500">{t('jobsNone')}</span>}
    </div>
  )
}

function JobChip({ job, on, onToggle }: { job: Job; on: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <button type="button" aria-pressed={on} onClick={onToggle}
      className={cn('inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium',
        on ? 'border-brand-500 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400')}>
      {on && <Check size={13} aria-hidden />}{t(`job_${job}` as TKey)}
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n()
  const [done, setDone] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <Button size="sm" variant="secondary" type="button" onClick={copy}>
      {done ? <Check size={14} /> : <Copy size={14} />}{done ? t('copied') : t('copyLink')}
    </Button>
  )
}

export function GeneralSettingsPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const refreshMe = useRefreshMe()
  const navigate = useNavigate()
  const isAdmin = atLeast(ws.role, 'admin')
  const [form, setForm] = useState({ name: ws.name, base_currency: ws.base_currency, language: ws.language, phone: ws.phone ?? '' })
  const [limit, setLimit] = useState(ws.incident_approval_limit != null ? String(ws.incident_approval_limit) : '')
  const [scale, setScale] = useState(ws.cancellation_scale ?? [])
  const [tolerance, setTolerance] = useState(String(ws.bill_tolerance_pct ?? 1))
  const [fuel, setFuel] = useState(String(ws.fuel_l_per_100km ?? 30))
  const [countries, setCountries] = useState((ws.countries ?? []).map((c) => c.toUpperCase()).join(', '))
  const [placeLang, setPlaceLang] = useState(ws.place_lang ?? '')
  const [factorPct, setFactorPct] = useState(String(Math.round((ws.drive_factor ?? 1.25) * 100)))
  const [vat, setVat] = useState(ws.vat_rate != null ? String(ws.vat_rate) : '')
  const [plateShare, setPlateShare] = useState(String(ws.plate_share ?? 1))
  const [terms, setTerms] = useState(ws.payment_terms ?? { deposit_percent: 0, deposit_days: 7, balance_days_before: 14 })
  const [confirmName, setConfirmName] = useState('')

  const save = useMutation({
    mutationFn: () => api<Workspace>(`/workspaces/${ws.id}`, {
      method: 'PATCH', body: { ...form, incident_approval_limit: limit === '' ? null : limit, cancellation_scale: scale, payment_terms: terms, bill_tolerance_pct: tolerance || '0', fuel_l_per_100km: fuel || '30',
        countries: countries.split(/[\s,;]+/).filter(Boolean), place_lang: placeLang, drive_factor: ((Number(factorPct) || 125) / 100).toFixed(2),
        vat_rate: vat.trim() === '' ? null : vat, plate_share: Number(plateShare) || 1 },
    }),
    onSuccess: () => refreshMe(),
  })
  const del = useMutation({
    mutationFn: () => api(`/workspaces/${ws.id}`, { method: 'DELETE' }),
    onSuccess: async () => { await refreshMe(); navigate('/') },
  })

  return (
    <>
      <PageHeader section="settings" title={t('settings')} subtitle={ws.name} />
      <div className="max-w-4xl space-y-6 p-4 md:p-8">
        <AppearanceCard />
        <Card className="p-5">
          <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="space-y-4">
            <fieldset disabled={!isAdmin} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
                <Field label={t('agencyName')}>
                  <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label={t('officePhone')} hint={t('officePhoneHelp')}>
                  <Input type="tel" maxLength={50} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('baseCurrency')}>
                  <Select value={form.base_currency} onChange={(e) => setForm({ ...form, base_currency: e.target.value })}>
                    {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </Select>
                </Field>
                <Field label={t('language')}>
                  <Select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as Lang })}>
                    <option value="ka">ქართული</option>
                    <option value="en">English</option>
                  </Select>
                </Field>
              </div>
              <Field label={t('incidentLimit', { cur: ws.base_currency })} hint={t('incidentLimitHelp')}>
                <Input type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={t('noLimit')} className="w-48" />
              </Field>
              <Field label={t('billTolerance')} hint={t('billToleranceHelp')}>
                <Input type="number" min="0" max="50" step="0.1" value={tolerance} onChange={(e) => setTolerance(e.target.value)} className="w-28" />
              </Field>
              <Field label={t('vatRateLabel')} hint={t('vatRateHelp')}>
                <div className="flex items-center gap-2">
                  <Input type="number" min="0" max="50" step="0.01" value={vat} onChange={(e) => setVat(e.target.value)} placeholder={t('vatOff')} className="w-28" />
                  <span className="text-sm text-slate-600">%</span>
                </div>
              </Field>
              <Field label={t('plateShareLabel')} hint={t('plateShareHelp')}>
                <Select value={plateShare} onChange={(e) => setPlateShare(e.target.value)} className="w-56">
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n === 1 ? t('plateOwn') : t('platePer', { n })}</option>)}
                </Select>
              </Field>
              <Field label={t('fuelUse')} hint={t('fuelUseHelp')}>
                <Input type="number" min="1" max="200" step="0.1" value={fuel} onChange={(e) => setFuel(e.target.value)} className="w-28" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('countriesLabel')} hint={t('countriesHelp')}>
                  <Input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="GE, AM, AZ" maxLength={80} />
                </Field>
                <Field label={t('placeLangLabel')} hint={t('placeLangHelp')}>
                  <Select value={placeLang} onChange={(e) => setPlaceLang(e.target.value)}>
                    <option value="">{t('placeLangSame')}</option>
                    <option value="en">English</option>
                    <option value="ka">ქართული</option>
                    <option value="ru">Русский</option>
                    <option value="hy">Հայերեն</option>
                  </Select>
                </Field>
                <Field label={t('driveFactorLabel')} hint={t('driveFactorHelp')}>
                  <div className="flex items-center gap-2">
                    <Input type="number" min="100" max="300" step="5" value={factorPct} onChange={(e) => setFactorPct(e.target.value)} className="w-28" />
                    <span className="text-sm text-slate-600">%</span>
                  </div>
                </Field>
              </div>
              <Field label={t('clientPaymentTerms')} hint={t('paymentTermsHelp')}>
                <PaymentTermsEditor value={terms} disabled={!isAdmin} onChange={setTerms} />
              </Field>
              <Field label={t('cancellationScale')} hint={t('cancellationScaleHelp')}>
                <ScaleEditor of="price" value={scale} disabled={!isAdmin} onChange={setScale} />
              </Field>
            </fieldset>
            <ErrorText error={save.error} />
            {isAdmin && (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={save.isPending}>{t('save')}</Button>
                {save.isSuccess && <span className="text-sm text-emerald-600">{t('saved')}</span>}
              </div>
            )}
          </form>
        </Card>

        {isAdmin && <WhoDoesWhatCard />}
        {isAdmin && <AiKeyCard />}
        {can(ws, 'operations', 'finance') && <ExchangeRatesCard />}

        {ws.role === 'owner' && (
          <Card className="border-red-200 p-5">
            <h2 className="font-semibold text-red-700">{t('dangerZone')}</h2>
            <p className="mt-1 text-sm text-slate-600">{t('deleteWorkspaceText')}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Input placeholder={t('typeToConfirm')} value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)} className="min-w-56 flex-1" />
              <Button variant="danger" disabled={confirmName !== ws.name || del.isPending} onClick={() => del.mutate()}>
                {t('deleteWorkspace')}
              </Button>
            </div>
            <div className="mt-3"><ErrorText error={del.error} /></div>
          </Card>
        )}
      </div>
    </>
  )
}

/** Rates to the workspace base currency, used to total multi-currency costs. */
/** Who does what: bookings of each kind and supplier payments go to these people as tasks. */
function WhoDoesWhatCard() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const refreshMe = useRefreshMe()
  const members = useMembers()
  const [owners, setOwners] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(ws.task_owners ?? {}).filter(([, v]) => v).map(([k, v]) => [k, v as string])))
  const save = useMutation({
    mutationFn: () => api<Workspace>(`/workspaces/${ws.id}`, { method: 'PATCH', body: {
      task_owners: Object.fromEntries([...WORK_KINDS, 'payments'].map((k) => [k, owners[k] || null])) } }),
    onSuccess: () => refreshMe(),
  })
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{t('whoDoesWhat')}</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">{t('whoDoesWhatHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {[...WORK_KINDS, 'payments' as const].map((k) => (
          <Field key={k} label={t(`work_${k}`)}>
            <Select value={owners[k] ?? ''} onChange={(e) => setOwners({ ...owners, [k]: e.target.value })}>
              <option value="">{t('nobodyYet')}</option>
              {members.data?.filter((m) => k !== 'payments' || m.jobs.includes('finance'))
                .map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
            </Select>
          </Field>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>{t('save')}</Button>
        <ErrorText error={save.error} />
      </div>
    </Card>
  )
}

function ExchangeRatesCard() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const url = `/workspaces/${ws.id}/exchange-rates`
  const rates = useQuery({ queryKey: ['exchangeRates', ws.id], queryFn: () => api<ExchangeRate[]>(url) })
  const [rows, setRows] = useState<{ currency: string; rate: string }[] | null>(null)
  useEffect(() => {
    if (rates.data) setRows(rates.data.map((r) => ({ currency: r.currency, rate: String(r.rate) })))
  }, [rates.data])
  const save = useMutation({
    mutationFn: () => api<ExchangeRate[]>(url, { method: 'PUT', body: rows }),
    onSuccess: (d) => { qc.setQueryData(['exchangeRates', ws.id], d); qc.invalidateQueries() },   // totals everywhere change
  })
  if (!rows) return null
  const used = new Set([ws.base_currency, ...rows.map((r) => r.currency)])
  const next = CURRENCIES.find((c) => !used.has(c))
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{t('exchangeRates')}</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">{t('exchangeHelp', { base: ws.base_currency })}</p>
      {rows.length === 0 && <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{t('noRatesHint', { base: ws.base_currency })}</p>}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-8 text-sm text-slate-500">1</span>
            <Select value={r.currency} onChange={(e) => setRow(i, { currency: e.target.value })} className="w-28">
              {CURRENCIES.filter((c) => c === r.currency || !used.has(c)).map((c) => <option key={c}>{c}</option>)}
            </Select>
            <span className="text-slate-400">=</span>
            <Input type="number" step="0.000001" min="0" value={r.rate} onChange={(e) => setRow(i, { rate: e.target.value })} className="w-36 text-right" />
            <span className="w-12 text-sm font-medium">{ws.base_currency}</span>
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t('delete')} title={t('delete')}
              className="rounded-md p-2 text-slate-300 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {next && <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { currency: next, rate: '' }])}><Plus size={14} />{t('addCurrency')}</Button>}
        <NbgButton currencies={rows.map((r) => r.currency)}
          onRates={(r) => setRows(rows.map((x) => (x.currency in r ? { ...x, rate: String(r[x.currency]) } : x)))} />
        <div className="flex-1" />
        {save.isSuccess && <span className="text-sm text-emerald-600">{t('saved')}</span>}
        <Button size="sm" variant="secondary" disabled={save.isPending || rows.some((r) => !(Number(r.rate) > 0))} onClick={() => save.mutate()}>{t('saveRates')}</Button>
      </div>
      <div className="mt-2"><ErrorText error={save.error} /></div>
    </Card>
  )
}

/** The agency's own Anthropic API key for the AI assistant. It is checked with Anthropic before
 *  saving, stored encrypted, and never shown again — only its last 4 characters. */
function AiKeyCard() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const refreshMe = useRefreshMe()
  const [key, setKey] = useState('')
  const [wsid, setWsid] = useState(ws.ai_workspace_id ?? '')
  const base = wsPath(ws.id, '/ai')
  const status = useQuery({ queryKey: ['aiStatus', ws.id], queryFn: () => api<{ available: boolean; own_key: boolean; spent_usd: number; limit_usd: number }>(`${base}/status`) })
  const done = () => { setKey(''); refreshMe(); qc.invalidateQueries({ queryKey: ['aiStatus', ws.id] }) }
  const save = useMutation({ mutationFn: () => api(`${base}/key`, { method: 'PUT', body: { key: key.trim(), workspace_id: wsid.trim() } }), onSuccess: done })
  const test = useMutation({ mutationFn: () => api(`${base}/key/test`, { method: 'POST' }), meta: { silent: true } })
  const remove = useMutation({ mutationFn: () => api(`${base}/key`, { method: 'DELETE' }), onSuccess: done })
  const hint = ws.ai_key_hint
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Sparkles size={18} className="text-violet-600" />{t('aiKeyTitle')}</h2>
      <p className="mt-1 text-sm text-slate-500">{t('aiKeyHelp')}</p>
      {hint ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <KeyRound size={15} />{t('aiKeySaved', { hint })}{ws.ai_workspace_id && ` · ${ws.ai_workspace_id}`}
          </span>
          <Button variant="secondary" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>{t('aiKeyTest')}</Button>
          {test.isSuccess && <span className="text-sm text-emerald-700">{t('aiKeyWorks')}</span>}
          <Button variant="ghost" size="sm" className="text-red-600" disabled={remove.isPending}
            onClick={() => void ask({ title: t('aiKeyRemove'), message: t('aiKeyRemoveMsg'), danger: true }).then((ok) => ok && remove.mutate())}>
            <Trash2 size={14} />{t('aiKeyRemove')}
          </Button>
        </div>
      ) : null}
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (key.trim()) save.mutate() }}>
        <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={hint ? t('aiKeyReplacePh') : 'sk-ant-…'} className="min-w-64 flex-1 font-mono text-sm" aria-label={t('aiKeyTitle')} />
        <Input value={wsid} onChange={(e) => setWsid(e.target.value)} placeholder={t('aiWorkspacePh')} spellCheck={false}
          className="w-56 font-mono text-sm" aria-label={t('aiWorkspace')} title={t('aiWorkspaceHelp')} />
        <Button type="submit" disabled={!key.trim() || save.isPending}>{save.isPending ? t('aiKeyChecking') : hint ? t('aiKeyReplace') : t('save')}</Button>
      </form>
      <p className="mt-1.5 text-xs text-slate-500">{t('aiWorkspaceHelp')}</p>
      <ErrorText error={save.error || test.error || remove.error} />
      <p className="mt-3 text-xs text-slate-500">
        {t('aiKeyWhere')}{' '}
        {status.data && t('aiAllowance', { spent: status.data.spent_usd.toFixed(2), limit: status.data.limit_usd.toFixed(0) })}
      </p>
    </Card>
  )
}
