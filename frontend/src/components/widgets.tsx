/**
 * Home widgets: every card a person can put on their Home, and the default set per role.
 * A widget renders its own card (or nothing when it has nothing to say, e.g. "Get started"
 * once done). Money widgets are manager+ — the same rule as the rest of the app.
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, atLeast, type ClientDebt, type DayViewRow, type Incident, type ProfitReport, type QuoteSummary, type Role, type SeriesColor, type TourSummary, type VendorRef, can, type Job } from '../lib/api'
import { wsPath } from '../lib/data'
import { addDays, diffDays, fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money, moneyList, paxText } from '../lib/utils'
import { useSchedule } from '../pages/Payments'
import { ToClose } from '../pages/TourClose'
import { NeedsAttention } from './Alerts'
import { TaskRow, useTasks } from '../pages/Tasks'
import { RatesNeeded } from './money'
import { GetStarted } from './GetStarted'
import { CodeChip, COLOR } from './tour'
import { Card } from './ui'

export type WidgetSize = 'half' | 'full'
export interface WidgetPick { id: string; size: WidgetSize }
type Group = 'operations' | 'money' | 'setup'

interface WidgetDef { id: string; group: Group; min: Role; jobs?: Job[]; size: WidgetSize; render: () => ReactNode }

export const WIDGETS: WidgetDef[] = [
  { id: 'get_started', group: 'setup', min: 'staff', size: 'full', render: () => <GetStarted /> },
  { id: 'my_tasks', group: 'operations', min: 'staff', size: 'half', render: () => <MyTasksWidget /> },
  { id: 'stats', group: 'operations', min: 'staff', size: 'full', render: () => <StatsWidget /> },
  { id: 'attention', group: 'operations', min: 'staff', size: 'half', render: () => <NeedsAttention /> },
  { id: 'today', group: 'operations', min: 'staff', size: 'half', render: () => <TodayWidget /> },
  { id: 'soon', group: 'operations', min: 'staff', size: 'half', render: () => <SoonWidget /> },
  { id: 'staff_week', group: 'operations', min: 'staff', size: 'full', render: () => <StaffWeekWidget /> },
  { id: 'incidents', group: 'operations', min: 'staff', size: 'half', render: () => <IncidentsWidget /> },
  { id: 'to_close', group: 'operations', min: 'staff', jobs: ['finance', 'operations'], size: 'half', render: () => <ToClose /> },
  { id: 'payments_due', group: 'money', min: 'staff', jobs: ['finance'], size: 'full', render: () => <PaymentsDueWidget /> },
  { id: 'client_debts', group: 'money', min: 'staff', jobs: ['finance'], size: 'half', render: () => <ClientDebtsWidget /> },
  { id: 'profit', group: 'money', min: 'staff', jobs: ['finance'], size: 'half', render: () => <ProfitWidget /> },
  { id: 'cash', group: 'money', min: 'staff', jobs: ['finance'], size: 'full', render: () => <CashWidget /> },
  { id: 'bill_issues', group: 'money', min: 'staff', jobs: ['finance'], size: 'half', render: () => <BillIssuesWidget /> },
  { id: 'quotes', group: 'money', min: 'staff', jobs: ['operations', 'sales'], size: 'half', render: () => <QuotesWidget /> },
]
export const GROUPS: Group[] = ['operations', 'money', 'setup']
export const widgetById = new Map(WIDGETS.map((w) => [w.id, w]))
type Who = { role: Role; jobs?: Job[] }
const fits = (w: WidgetDef, who: Who) => atLeast(who.role, w.min) && (!w.jobs || can(who, ...w.jobs))
export const allowedFor = (who: Who) => WIDGETS.filter((w) => fits(w, who))

const pick = (ids: string[], who: Who): WidgetPick[] =>
  [...new Set(ids)].map((id) => widgetById.get(id)!).filter((w) => fits(w, who)).map((w) => ({ id: w.id, size: w.size }))

// What each job looks at first thing in the morning.
const JOB_HOME: Record<Job, string[]> = {
  operations: ['stats', 'attention', 'today', 'soon', 'staff_week', 'incidents', 'to_close'],
  finance: ['payments_due', 'client_debts', 'cash', 'bill_issues', 'profit', 'to_close'],
  sales: ['quotes', 'soon', 'stats'],
}

/** What Home shows before someone customizes it: by what they do all day. */
export function defaultLayout(who: Who): WidgetPick[] {
  if (atLeast(who.role, 'admin')) return pick(['get_started', 'stats', 'my_tasks', 'attention', 'today', 'profit', 'client_debts', 'cash', 'soon', 'to_close'], who)
  const jobs = atLeast(who.role, 'staff') ? who.jobs ?? [] : []
  if (!jobs.length) return pick(['get_started', 'my_tasks', 'stats', 'attention', 'today', 'soon', 'staff_week', 'incidents'], who)
  return pick(['get_started', 'my_tasks', ...(['operations', 'finance', 'sales'] as Job[]).filter((j) => jobs.includes(j)).flatMap((j) => JOB_HOME[j])], who)
}

/** The card frame every new widget uses: a title row that links to the full page. */
function WidgetCard({ title, to, extra, children }: { title: string; to?: string; extra?: ReactNode; children: ReactNode }) {
  const head = (
    <>
      <h2 className="font-semibold">{title}</h2>
      <span className="flex items-center gap-3 text-sm">{extra}{to && <ArrowRight size={16} className="text-slate-400" />}</span>
    </>
  )
  return (
    <Card className="min-w-0">
      {to
        ? <Link to={to} className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 hover:bg-slate-50">{head}</Link>
        : <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">{head}</div>}
      {children}
    </Card>
  )
}
const Empty = ({ children }: { children: ReactNode }) => <p className="px-5 py-6 text-sm text-slate-500">{children}</p>

// --- operations ---------------------------------------------------------------------------------

function useToday() {
  const ws = useWorkspace()!
  const now = today()
  // light: without each group's hour-by-hour programme (Home only needs where they are)
  return useQuery({ queryKey: ['day-light', ws.id, now], queryFn: () => api<DayViewRow[]>(wsPath(ws.id, `/day/${now}?light=1`)) })
}
function useSoon() {
  const ws = useWorkspace()!
  const now = today()
  const q = useQuery({
    queryKey: ['tours', ws.id, 'soon', now],
    queryFn: () => api<TourSummary[]>(wsPath(ws.id, `/tours?date_from=${addDays(now, 1)}&date_to=${addDays(now, 14)}`)),
  })
  return { ...q, starting: (q.data ?? []).filter((r) => r.start_date > now && r.status !== 'cancelled') }
}

function StatsWidget() {
  const { t } = useI18n()
  const rows = useToday().data ?? []
  const { starting } = useSoon()
  const stats: [string, number][] = [
    [t('groupsToday'), rows.length], [t('touristsTotal'), rows.reduce((s, r) => s + r.tour.pax, 0)], [t('startingSoon'), starting.length],
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {stats.map(([label, value]) => (
        <Card key={label} className="px-5 py-4">
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
        </Card>
      ))}
    </div>
  )
}

function TodayWidget() {
  const { t } = useI18n()
  const q = useToday()
  const rows = q.data ?? []
  return (
    <WidgetCard title={t('groupsToday')} to="day">
      {q.isSuccess && rows.length === 0 && <Empty>{t('noGroupsDay')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {rows.map(({ tour, day }) => (
          <li key={tour.id}>
            <Link to={`tours/${tour.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
              <CodeChip code={tour.code} color={tour.color} />
              <span className="min-w-0 flex-1 truncate"><b>{day.city || '—'}</b>{day.hotel && <span className="text-slate-500"> · {day.hotel.name}</span>}</span>
              <span className="text-xs text-slate-400">{t('day')} {day.day_number}/{diffDays(tour.start_date, tour.end_date) + 1}</span>
              <span className="w-10 text-right font-semibold tabular-nums">{paxText(tour)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

function SoonWidget() {
  const { t, lang } = useI18n()
  const q = useSoon()
  return (
    <WidgetCard title={t('startingSoon')} to="timeline">
      {q.isSuccess && q.starting.length === 0 && <Empty>{t('nothingSoon')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {q.starting.map((tour) => (
          <li key={tour.id}>
            <Link to={`tours/${tour.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
              <CodeChip code={tour.code} color={tour.color} />
              <span className="min-w-0 flex-1 truncate">{tour.client_name}</span>
              {tour.status === 'inquiry' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{t('status_inquiry')}</span>}
              <span className="whitespace-nowrap text-slate-500">{fmt(tour.start_date, lang)}</span>
              <span className="w-10 text-right font-semibold tabular-nums">{paxText(tour)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

interface StaffWeek { vendor: VendorRef; role: string; busy: number; days: { date: string; tour_id: string | null; tour_code: string | null; tour_color: SeriesColor | null; also: string[] }[] }

function StaffWeekWidget() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const q = useQuery({ queryKey: ['staffWeek', ws.id], queryFn: () => api<StaffWeek[]>(wsPath(ws.id, '/dashboard/staff-week')) })
  const days = q.data?.[0]?.days.map((d) => d.date) ?? Array.from({ length: 7 }, (_, i) => addDays(today(), i))
  return (
    <WidgetCard title={t('w_staff_week')}>
      {q.isSuccess && q.data.length === 0 ? <Empty>{t('staffWeekEmpty')}</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium" />
                {days.map((d) => <th key={d} className="px-1 py-2 text-center font-medium">{fmt(d, lang, { weekday: 'short', day: 'numeric' })}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data?.map((r) => (
                <tr key={r.vendor.id}>
                  <td className="px-5 py-2">
                    <span className="block font-medium">{r.vendor.name}</span>
                    <span className="text-xs text-slate-500">{t(`staffRole_${r.role}` as TKey)} · {t('daysBusy', { n: r.busy })}</span>
                  </td>
                  {r.days.map((d) => (
                    <td key={d.date} className="px-1 py-2 text-center">
                      {d.tour_id
                        ? <Link to={`tours/${d.tour_id}?tab=staff`} title={d.also.length ? t('staffClash', { tours: [d.tour_code, ...d.also].join(', ') }) : undefined}
                            className={cn('inline-block rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold',
                              d.also.length ? 'bg-red-600 text-white' : COLOR[d.tour_color ?? 'slate'].soft)}>
                            {d.tour_code}{d.also.length > 0 && ` +${d.also.length}`}
                          </Link>
                        : <span className="text-xs text-emerald-600">{t('staffFree')}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetCard>
  )
}

function IncidentsWidget() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const q = useQuery({ queryKey: ['incidents', ws.id, 'open'], queryFn: () => api<Incident[]>(wsPath(ws.id, '/incidents?status=open')) })
  return (
    <WidgetCard title={t('w_incidents')} to="incidents" extra={q.data?.length ? <span className="font-semibold text-amber-700">{q.data.length}</span> : undefined}>
      {q.isSuccess && q.data.length === 0 && <Empty>{t('noOpenIncidents')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {q.data?.slice(0, 6).map((x) => (
          <li key={x.id}>
            <Link to={`tours/${x.tour_id}?tab=incidents`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
              <span className="font-mono text-xs font-semibold text-slate-500">{x.tour_code}</span>
              <span className="min-w-0 flex-1 truncate">{x.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

function MyTasksWidget() {
  const { t } = useI18n()
  const q = useTasks('me')
  const rows = (q.data ?? []).filter((x) => !x.done)
  const late = rows.filter((x) => x.due_date && x.due_date < today()).length
  return (
    <WidgetCard title={t('myTasks')} to="tasks" extra={rows.length > 0 && (
      <span className={cn('font-semibold', late ? 'text-red-600' : 'text-slate-600')}>{late ? t('nLate', { n: late }) : rows.length}</span>
    )}>
      {q.isSuccess && rows.length === 0 && <Empty>{t('noTasks')}</Empty>}
      <div className="divide-y divide-slate-100">{rows.slice(0, 6).map((x) => <TaskRow key={x.key} x={x} compact />)}</div>
    </WidgetCard>
  )
}

// --- money --------------------------------------------------------------------------------------

function PaymentsDueWidget() {
  const { t, lang } = useI18n()
  const sched = useSchedule('status=open')
  const now = today()
  // Overdue and the next 7 days: what the accountant should look at this morning.
  const items = (sched.data?.items ?? []).filter((p) => p.due_date && p.due_date <= addDays(now, 7)).slice(0, 8)
  return (
    <WidgetCard title={t('paymentsDue')} to="payments" extra={sched.data && Object.keys(sched.data.overdue).length > 0 && (
      <span className="font-semibold text-red-600">{t('filter_overdue')}: {moneyList(sched.data.overdue)}</span>
    )}>
      {sched.isSuccess && items.length === 0 && <Empty>{t('nothingDue')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {items.map((p) => (
          <li key={p.tour_id + p.vendor.id + p.currency}>
            <Link to={`tours/${p.tour_id}?tab=costs`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
              <span className={cn('w-16 shrink-0', p.status === 'overdue' ? 'font-semibold text-red-600' : 'text-slate-500')}>{p.due_date ? fmt(p.due_date, lang) : '—'}</span>
              <CodeChip code={p.tour_code} color={p.tour_color} />
              <span className="min-w-0 flex-1 truncate">{p.vendor.name}</span>
              <span className="whitespace-nowrap font-semibold tabular-nums">{money(p.balance, p.currency)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

function ClientDebtsWidget() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const q = useQuery({ queryKey: ['debts', ws.id], queryFn: () => api<ClientDebt[]>(wsPath(ws.id, '/debts')) })
  const rows = (q.data ?? []).filter((d) => Object.keys(d.open).length > 0).slice(0, 6)
  return (
    <WidgetCard title={t('w_client_debts')} to="finance?tab=debts">
      {q.isSuccess && rows.length === 0 && <Empty>{t('noClientDebts')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {rows.map((d) => {
          const late = Object.keys(d.overdue).length > 0
          return (
            <li key={d.client.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{d.client.name}</span>
              {late && <span className="whitespace-nowrap text-xs font-semibold text-red-600">{t('filter_overdue')}: {moneyList(d.overdue)}</span>}
              <span className="whitespace-nowrap font-semibold tabular-nums">{moneyList(d.open)}</span>
            </li>
          )
        })}
      </ul>
    </WidgetCard>
  )
}

function ProfitWidget() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const now = today()
  const thisMonth = now.slice(0, 7)
  const lastStart = addDays(`${thisMonth}-01`, -1).slice(0, 7) + '-01'
  const endOfMonth = addDays(addDays(`${thisMonth}-01`, 32).slice(0, 7) + '-01', -1)
  const q = useQuery({
    queryKey: ['profit', ws.id, 'widget', thisMonth],
    queryFn: () => api<ProfitReport>(wsPath(ws.id, `/reports/profit?group=month&date_from=${lastStart}&date_to=${endOfMonth}`)),
  })
  const row = (m: string) => q.data?.rows.find((r) => r.key === m)
  const cur = q.data?.base_currency
  const months: [string, string][] = [[lastStart.slice(0, 7), t('lastMonth')], [thisMonth, t('thisMonth')]]
  const missing = [...new Set(months.flatMap(([m]) => row(m)?.missing_currencies ?? []))]
  return (
    <WidgetCard title={t('w_profit')} to="finance">
      <div className="grid grid-cols-2 divide-x divide-slate-100">
        {months.map(([m, label]) => {
          const r = row(m)
          return (
            <div key={m} className="px-5 py-4">
              <p className="text-xs text-slate-500">{label} · {fmt(`${m}-01`, lang, { month: 'long' })}</p>
              <p className={cn('mt-1 text-2xl font-bold tabular-nums', r && !r.missing_rates && r.profit < 0 && 'text-red-600')}>{r && !r.missing_rates ? money(r.profit, cur) : '—'}</p>
              <p className="text-xs text-slate-500">
                {r ? `${t('revenue')} ${money(r.revenue)} · ${r.margin === null ? '—' : `${r.margin}%`} · ${r.tours} ${t('tours').toLowerCase()}` : t('noToursThatMonth')}
              </p>
            </div>
          )
        })}
      </div>
      {missing.length > 0 && <div className="px-5 pb-4"><RatesNeeded currencies={missing} compact /></div>}
    </WidgetCard>
  )
}

interface CashForecast { base_currency: string; weeks: { label: string; money_in: number; money_out: number }[]; total_in: number; total_out: number; missing_rates: string[] }

function CashWidget() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const q = useQuery({ queryKey: ['cash', ws.id], queryFn: () => api<CashForecast>(wsPath(ws.id, '/dashboard/cash')) })
  const d = q.data
  const top = Math.max(1, ...(d?.weeks ?? []).flatMap((w) => [w.money_in, w.money_out]))
  const net = d ? d.total_in - d.total_out : 0
  return (
    <WidgetCard title={t('w_cash')} extra={d && (
      <span className={cn('font-semibold tabular-nums', net < 0 ? 'text-red-600' : 'text-emerald-700')}>{t('net')}: {money(net, d.base_currency)}</span>
    )}>
      {d && (
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap gap-4 text-xs text-slate-600">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />{t('moneyIn')}: <b className="tabular-nums">{money(d.total_in, d.base_currency)}</b></span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-rose-400" />{t('moneyOut')}: <b className="tabular-nums">{money(d.total_out, d.base_currency)}</b></span>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {d.weeks.map((w) => (
              <div key={w.label} className="min-w-0">
                <div className="flex h-28 items-end justify-center gap-1 rounded-lg bg-slate-50 px-1 pt-2">
                  <div className="w-1/3 rounded-t bg-emerald-500" style={{ height: `${(w.money_in / top) * 100}%` }} title={`${t('moneyIn')}: ${money(w.money_in, d.base_currency)}`} />
                  <div className="w-1/3 rounded-t bg-rose-400" style={{ height: `${(w.money_out / top) * 100}%` }} title={`${t('moneyOut')}: ${money(w.money_out, d.base_currency)}`} />
                </div>
                <p className={cn('mt-1 truncate text-center text-xs', w.label === 'overdue' ? 'font-semibold text-red-600' : 'text-slate-500')}>{t(`cash_${w.label}` as TKey)}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">{t('cashHelp')}</p>
          {d.missing_rates.length > 0 && <RatesNeeded currencies={d.missing_rates} compact />}
        </div>
      )}
    </WidgetCard>
  )
}

function BillIssuesWidget() {
  const { t } = useI18n()
  const sched = useSchedule('status=bills')
  const items = sched.data?.items ?? []
  return (
    <WidgetCard title={t('w_bill_issues')} to="payments" extra={items.length > 0 && <span className="font-semibold text-amber-700">{items.length}</span>}>
      {sched.isSuccess && items.length === 0 && <Empty>{t('noBillIssues')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {items.slice(0, 6).map((p) => (
          <li key={p.tour_id + p.vendor.id + p.currency}>
            <Link to={`tours/${p.tour_id}?tab=costs`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
              <CodeChip code={p.tour_code} color={p.tour_color} />
              <span className="min-w-0 flex-1 truncate">{p.vendor.name}</span>
              <span className={cn('whitespace-nowrap text-xs font-semibold', p.bill_state === 'disputed' ? 'text-red-600' : 'text-amber-700')}>
                {p.bill_state === 'disputed' ? t('billDisputed') : `${p.bill_difference > 0 ? '+' : ''}${money(p.bill_difference, p.currency)}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}

function QuotesWidget() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const q = useQuery({ queryKey: ['quotes', ws.id], queryFn: () => api<QuoteSummary[]>(wsPath(ws.id, '/quotes')) })
  const waiting = (q.data ?? []).filter((x) => x.status === 'sent').slice(0, 6)
  return (
    <WidgetCard title={t('w_quotes')} to="calculations">
      {q.isSuccess && waiting.length === 0 && <Empty>{t('noQuotesWaiting')}</Empty>}
      <ul className="divide-y divide-slate-100">
        {waiting.map((x) => (
          <li key={x.id}>
            <Link to={`calculations/${x.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50">
              <span className="min-w-0 flex-1 truncate"><b className="font-medium">{x.name}</b>{x.client_name && <span className="text-slate-500"> · {x.client_name}</span>}</span>
              <span className="whitespace-nowrap text-xs text-slate-500">{t('sentOn', { date: fmt(x.updated_at.slice(0, 10), lang) })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}
