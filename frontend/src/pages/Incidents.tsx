import { useQuery } from '@tanstack/react-query'
import { AlertOctagon, Plus } from 'lucide-react'
import { useState } from 'react'
import { IncidentModal, IncidentStatusPill } from '../components/IncidentModal'
import { CodeChip, EmptyState } from '../components/tour'
import { Button, Card } from '../components/ui'
import { api, type Incident, type IncidentStatus, type Tour, can } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { PageHeader } from './Dashboard'

export function useIncidents(params: string) {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['incidents', ws.id, params],
    queryFn: () => api<Incident[]>(wsPath(ws.id, `/incidents?${params}`)),
    placeholderData: (prev) => prev,
  })
}

function IncidentList({ rows, showTour, onOpen }: { rows: Incident[]; showTour?: boolean; onOpen: (i: Incident) => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const seesMoney = can(ws, 'operations', 'finance')
  return (
    <Card>
      <ul className="divide-y divide-slate-100">
        {rows.map((i) => (
          <li key={i.id}>
            <button type="button" onClick={() => onOpen(i)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50">
              <IncidentStatusPill status={i.status} />
              {showTour && <CodeChip code={i.tour_code} color="slate" />}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{i.title}</span>
                <span className="block text-xs text-slate-500">
                  {i.date ? `${t('day')} ${i.day} · ${fmt(i.date, lang)}` : t('wholeTour')} · {t(`incidentKind_${i.kind}` as TKey)}
                  {' · '}{t(`carried_${i.carried_by}` as TKey)}{i.vendor && ` (${i.vendor.name})`}
                </span>
              </span>
              {seesMoney && i.total_base !== null && i.total_base > 0 && (
                <span className="tabular-nums text-sm font-semibold">{money(i.total_base, ws.base_currency)}</span>
              )}
              {i.status === 'open' && seesMoney && !i.can_decide && <span className="text-xs text-amber-700">{t('needsAdminShort')}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** A tour's incidents, with "Report incident". */
export function IncidentsTab({ tour }: { tour: Tour }) {
  const { t } = useI18n()
  const list = useIncidents(`tour_id=${tour.id}`)
  const [open, setOpen] = useState<Incident | 'new' | null>(null)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen('new')}><Plus size={16} />{t('reportIncident')}</Button>
        <p className="text-xs text-slate-500 lg:max-w-lg">{t('incidentsHelp')}</p>
      </div>
      {list.data && list.data.length === 0 && <EmptyState title={t('noIncidents')} />}
      {list.data && list.data.length > 0 && <IncidentList rows={list.data} onOpen={setOpen} />}
      {open && <IncidentModal tourId={tour.id} incident={open === 'new' ? undefined : open} onClose={() => setOpen(null)} onChanged={() => list.refetch()} />}
    </div>
  )
}

const FILTERS: (IncidentStatus | 'all')[] = ['open', 'approved', 'settled', 'rejected', 'all']

/** Every incident across tours: what is waiting for a decision first. */
export function IncidentsPage() {
  const { t } = useI18n()
  const [filter, setFilter] = useState<IncidentStatus | 'all'>('open')
  const list = useIncidents(filter === 'all' ? '' : `status=${filter}`)
  const [open, setOpen] = useState<Incident | null>(null)
  return (
    <>
      <PageHeader title={t('incidents')} subtitle={t('incidentsPageHelp')} />
      <div className="space-y-4 p-4 md:p-8">
        <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
          {FILTERS.map((f) => (
            <button type="button" key={f} onClick={() => setFilter(f)}
              className={cn('shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 font-medium', filter === f ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
              {f === 'all' ? t('all') : t(`incident_${f}` as TKey)}
            </button>
          ))}
        </div>
        {list.data && list.data.length === 0 && <EmptyState title={filter === 'open' ? t('noOpenIncidents') : t('noIncidents')} hint={t('reportFromTour')} />}
        {list.data && list.data.length > 0 && <IncidentList rows={list.data} showTour onOpen={setOpen} />}
      </div>
      {open && <IncidentModal tourId={open.tour_id} incident={open} onClose={() => setOpen(null)} onChanged={() => list.refetch()} />}
    </>
  )
}

export const IncidentIcon = AlertOctagon
