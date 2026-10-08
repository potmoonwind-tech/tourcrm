/**
 * "Get started" on Home: the few things a new agency sets up, in the order that makes
 * the rest work (suppliers → their prices → a route → clients → a tour → the team).
 * Each step is ticked from real data; the card hides once everything is done, or
 * when someone closes it (remembered per workspace in this browser).
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, FileSpreadsheet, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, atLeast, type Role, can, type Job } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Card } from './ui'

interface SetupProgress { vendors: number; priced_services: number; routes: number; clients: number; tours: number; members: number }

export function useSetup() {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['setup', ws.id], queryFn: () => api<SetupProgress>(wsPath(ws.id, '/setup')) })
}

const hiddenKey = (wsId: string) => `getStartedHidden:${wsId}`
const readHidden = (wsId: string) => { try { return localStorage.getItem(hiddenKey(wsId)) === '1' } catch { return false } }

type T = ReturnType<typeof useI18n>['t']
function setupSteps(s: SetupProgress, ws: { role: Role; jobs?: Job[] }, t: T) {
  return [
    { done: s.vendors > 0, title: t('gs_vendors'), hint: t('gs_vendorsHint'), to: 'vendors', show: true },
    { done: s.priced_services > 0, title: t('gs_prices'), hint: t('gs_pricesHint'), to: 'prices', show: can(ws, 'operations') },
    { done: s.routes > 0, title: t('gs_route'), hint: t('gs_routeHint'), to: 'routes', show: true },
    { done: s.clients > 0, title: t('gs_clients'), hint: t('gs_clientsHint'), to: 'clients', show: true },
    { done: s.tours > 0, title: t('gs_tour'), hint: t('gs_tourHint'), to: 'tours', show: true },
    { done: s.members > 1, title: t('gs_team'), hint: t('gs_teamHint'), to: 'settings/team', show: atLeast(ws.role, 'admin') },
  ].filter((x) => x.show)
}

/**
 * On a setup page whose step is done: "✓ Suppliers added · Next: Build a route →", so nobody has
 * to go back to Home to find out what comes next. Hidden once setup is complete.
 */
export function SetupNudge({ step }: { step: 'vendors' | 'prices' | 'routes' | 'clients' | 'tours' }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const q = useSetup()
  if (!q.data) return null
  const steps = setupSteps(q.data, ws, t)
  const here = steps.find((x) => x.to === step)
  const next = steps.find((x) => !x.done)
  if (!here?.done || !next) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm">
      <span className="flex items-center gap-1.5 font-medium text-emerald-800"><Check size={16} />{t('nudgeDone', { step: here.title })}</span>
      <Link to={`../${next.to}`} relative="path" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
        {t('nudgeNext', { step: next.title })}<ArrowRight size={14} />
      </Link>
    </div>
  )
}

export function GetStarted() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [hidden, setHidden] = useState(() => readHidden(ws.id))
  const q = useSetup()
  if (hidden || !q.data) return null
  const steps = setupSteps(q.data, ws, t)
  const done = steps.filter((x) => x.done).length
  if (done === steps.length) return null
  const next = steps.findIndex((x) => !x.done)
  const hide = () => { try { localStorage.setItem(hiddenKey(ws.id), '1') } catch { /* private mode */ } setHidden(true) }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="font-semibold">{t('gs_title')}</h2>
          <p className="mt-0.5 text-sm text-slate-500">{t('gs_subtitle', { done, total: steps.length })}</p>
          <div className="mt-2 h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
        </div>
        <button type="button" onClick={hide} title={t('gs_hide')} aria-label={t('gs_hide')}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X size={16} /></button>
      </div>
      <ol className="divide-y divide-slate-100">
        {steps.map((x, i) => (
          <li key={x.to}>
            <Link to={x.to} className={cn('flex items-center gap-3 px-5 py-3 hover:bg-slate-50', i === next && 'bg-brand-50/60')}>
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                x.done ? 'bg-emerald-500 text-white' : i === next ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>
                {x.done ? <Check size={14} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block font-medium', x.done && 'text-slate-400 line-through')}>{x.title}</span>
                {!x.done && <span className="block text-xs text-slate-500">{x.hint}</span>}
              </span>
              {i === next && <span className="hidden text-sm font-medium text-brand-700 sm:inline">{t('gs_start')}</span>}
              <ArrowRight size={16} className="shrink-0 text-slate-400" />
            </Link>
          </li>
        ))}
      </ol>
      <Link to="settings/import" className="flex items-center gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3 text-sm text-slate-600 hover:text-brand-700">
        <FileSpreadsheet size={16} />{t('gs_import')}
      </Link>
    </Card>
  )
}
