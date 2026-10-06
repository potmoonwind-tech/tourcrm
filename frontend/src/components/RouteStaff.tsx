/**
 * Who works which days of a route: a Georgian guide days 1–5, an Armenian guide days 6–7. Each one's
 * day price goes into calculations made from the route; departures get these people (new ones at
 * once, existing ones with "Give to departures"). A change on one departure stays on it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api, ROLE_VENDOR_TYPES, STAFF_ROLES, type Series, type StaffPlanItem, type StaffRole } from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { ask } from './overlay'
import { InfoTip, Tooltip } from './Tooltip'
import { VendorSelect } from './tour'
import { Button, Card, ErrorText, Input, Select } from './ui'

const GRID = 'sm:grid-cols-[9rem_7.5rem_8.5rem_1fr_10rem_2.5rem]'

/** A caption above the control on phones; on wider screens the column header says it (still read aloud). */
function Cap({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-slate-500 sm:sr-only">{text}</span>
      {children}
    </label>
  )
}

export function RouteStaff({ route, tourIds, canEdit }: { route: Series; tourIds: string[]; canEdit: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const vendors = useVendors()
  const [plan, setPlan] = useState<StaffPlanItem[]>(route.staff_plan ?? [])
  const n = route.days.length
  const days = Array.from({ length: n }, (_, i) => i + 1)
  const changed = JSON.stringify(plan) !== JSON.stringify(route.staff_plan ?? [])
  const save = useMutation({
    mutationFn: () => api<Series>(wsPath(ws.id, `/series/${route.id}`), {
      method: 'PUT',
      body: { code: route.code, name: route.name, color: route.color, notes: route.notes,
        days: route.days.map(({ day_number: _n, ...d }) => d), staff_plan: plan },
    }),
    onSuccess: (s) => { setPlan(s.staff_plan ?? []); qc.invalidateQueries({ queryKey: ['series', ws.id] }) },
  })
  const give = useMutation({
    mutationFn: () => api<{ code: string; added: string[]; busy: string[] }[]>(wsPath(ws.id, `/series/${route.id}/staff-plan/apply`), { method: 'POST', body: { tour_ids: tourIds } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tour'] }),
  })
  const set = (i: number, patch: Partial<StaffPlanItem>) => setPlan(plan.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  // A new person never changes the others: two people on the same days is normal (a second guide
  // in Armenia, a guide and a driver). It starts after the last one ends, or covers every day.
  const addPerson = () => {
    const prev = plan[plan.length - 1]
    const from = prev?.to_day && prev.to_day < n ? prev.to_day + 1 : 1
    setPlan([...plan, { role: prev?.role ?? 'guide', from_day: from, to_day: null, vendor_id: null, label: '' }])
  }

  return (
    <Card>
      <div className="flex items-start gap-2 border-b border-slate-100 px-5 py-3">
        <div className="flex-1">
          <h3 className="text-base font-semibold">{t('routeStaffTitle')}</h3>
          <p className="text-sm text-slate-600">{t('routeStaffHelp')}</p>
        </div>
        <InfoTip label={t('routeStaffTip')} />
      </div>
      {plan.length === 0 && <p className="px-5 py-3 text-sm text-slate-600">{t('routeStaffNone')}</p>}
      {plan.length > 0 && (
        <div className={cn(GRID, 'hidden px-5 pt-3 text-xs font-medium text-slate-500 sm:grid')} aria-hidden>
          <span>{t('routeStaffRole')}</span><span>{t('handOverFrom')}</span><span>{t('handOverTo')}</span>
          <span>{t('routeStaffPerson')}</span><span>{t('routeStaffLabel')}</span><span />
        </div>
      )}
      <ul className="divide-y divide-slate-100 sm:divide-y-0">
        {plan.map((x, i) => (
          <li key={i} className={cn(GRID, 'grid gap-2 px-5 py-3 text-sm sm:items-center sm:py-1.5')}>
            <Cap text={t('routeStaffRole')}>
              <Select value={x.role} disabled={!canEdit} onChange={(e) => set(i, { role: e.target.value as StaffRole, vendor_id: null })}>
                {STAFF_ROLES.map((r) => <option key={r} value={r}>{t(`staffRole_${r}`)}</option>)}
              </Select>
            </Cap>
            <Cap text={t('handOverFrom')}>
              <Select value={x.from_day} disabled={!canEdit} onChange={(e) => { const v = Number(e.target.value); set(i, { from_day: v, to_day: x.to_day && x.to_day < v ? v : x.to_day }) }}>
                {days.map((d) => <option key={d} value={d}>{t('day')} {d}</option>)}
              </Select>
            </Cap>
            <Cap text={t('handOverTo')}>
              <Select value={x.to_day ?? ''} disabled={!canEdit} onChange={(e) => set(i, { to_day: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('untilEnd')}</option>
                {days.filter((d) => d >= x.from_day).map((d) => <option key={d} value={d}>{t('day')} {d}</option>)}
              </Select>
            </Cap>
            <Cap text={t('routeStaffPerson')}>
              <VendorSelect vendors={vendors.data ?? []} types={ROLE_VENDOR_TYPES[x.role]} value={x.vendor_id} disabled={!canEdit}
                onChange={(v) => set(i, { vendor_id: v })} />
            </Cap>
            <Cap text={t('routeStaffLabel')}>
              <Input value={x.label} disabled={!canEdit} maxLength={100} placeholder={t('routeStaffLabelPh')} onChange={(e) => set(i, { label: e.target.value })} />
            </Cap>
            {canEdit && (
              <Tooltip label={t('routeStaffRemove')}>
                <button type="button" aria-label={t('routeStaffRemove')} onClick={() => setPlan(plan.filter((_, j) => j !== i))}
                  className="flex h-10 w-10 items-center justify-center justify-self-end rounded-md text-slate-500 hover:bg-red-50 hover:text-red-700"><Trash2 size={18} aria-hidden /></button>
              </Tooltip>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
          <Button type="button" size="sm" variant="secondary" disabled={n === 0} onClick={addPerson}>
            <Plus size={14} />{t('routeStaffAdd')}
          </Button>
          <div className="flex-1" />
          {!changed && plan.some((x) => x.vendor_id) && tourIds.length > 0 && (
            <Button type="button" size="sm" variant="secondary" disabled={give.isPending}
              onClick={() => void ask({ title: t('routeStaffGiveTitle', { n: tourIds.length }), message: t('routeStaffGiveMsg') }).then((ok) => ok && give.mutate())}>
              {t('routeStaffGive', { n: tourIds.length })}
            </Button>
          )}
          <Button type="button" size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>{t('save')}</Button>
        </div>
      )}
      {give.data && <p className="mx-5 mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {t('routeStaffGiven', { n: give.data.filter((r) => r.added.length).length, total: give.data.length })}</p>}
      {give.data && give.data.some((r) => r.busy.length) && (
        <div className="mx-5 mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p className="font-medium">{t('routeStaffBusy', { n: give.data.filter((r) => r.busy.length).length })}</p>
          <ul className="mt-1 max-h-40 list-inside list-disc overflow-y-auto">
            {give.data.filter((r) => r.busy.length).map((r) => <li key={r.code}><b>{r.code}</b>: {r.busy.join('; ')}</li>)}
          </ul>
          <p className="mt-1">{t('routeStaffBusyHint')}</p>
        </div>
      )}
      <div className="px-5 pb-3"><ErrorText error={save.error || give.error} /></div>
    </Card>
  )
}
