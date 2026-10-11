/**
 * Sections and their views (monday's board views): one menu entry per section, and
 * the section's pages as tabs under the page title. See DESIGN.md "Navigation".
 */
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { atLeast, type Role, can, type Job } from '../lib/api'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'

export type Section = 'tours' | 'catalog' | 'finance' | 'settings'

interface View { path: string; tab?: string; label: TKey; min?: Role; jobs?: Job[] }

export const SECTIONS: Record<Section, View[]> = {
  tours: [
    { path: 'tours', label: 'viewList' },
    { path: 'timeline', label: 'timeline' },
    { path: 'day', label: 'dayView' },
    { path: 'rooms', label: 'roomsByNight', min: 'staff' },
  ],
  catalog: [
    { path: 'routes', label: 'routes' },
    { path: 'vendors', label: 'vendors' },
    { path: 'prices', label: 'priceCatalog', jobs: ['operations', 'finance', 'sales'] },
  ],
  finance: [
    { path: 'finance', tab: 'profit', label: 'profit', jobs: ['finance'] },
    { path: 'finance', tab: 'invoices', label: 'invoices', jobs: ['finance', 'sales'] },
    { path: 'finance', tab: 'debts', label: 'debts', jobs: ['finance'] },
    { path: 'payments', label: 'vendorPayments', jobs: ['finance'] },
  ],
  settings: [
    { path: 'settings/general', label: 'general' },
    { path: 'settings/email', label: 'emailSettings', min: 'staff' },
    { path: 'settings/places', label: 'placeNames', min: 'staff' },
    { path: 'settings/team', label: 'team', min: 'staff' },
    { path: 'settings/import', label: 'import', min: 'staff' },
  ],
}

/** Which section a workspace path belongs to ("tours/abc" → tours), for the menu's active item. */
export function sectionOf(rest: string): Section | null {
  const first = rest.split('/')[0]
  for (const [s, views] of Object.entries(SECTIONS) as [Section, View[]][]) {
    if (views.some((v) => v.path.split('/')[0] === first)) return s
  }
  return null
}

/** The section's views as tabs, shown under the page title. */
export function SectionNav({ section }: { section: Section }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const rest = pathname.replace(`/w/${ws.id}/`, '')
  const views = SECTIONS[section].filter((v) => (!v.min || atLeast(ws.role, v.min)) && (!v.jobs || can(ws, ...v.jobs)))
  if (views.length < 2) return null
  const active = (v: View) => (rest === v.path || rest.startsWith(`${v.path}/`)) && (!v.tab || (params.get('tab') ?? 'profit') === v.tab)
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={t(`section_${section}` as TKey)}>
      {views.map((v) => (
        <Link key={v.path + (v.tab ?? '')} to={`/w/${ws.id}/${v.path}${v.tab ? `?tab=${v.tab}` : ''}`}
          className={cn('shrink-0 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm',
            active(v) ? 'border-brand-600 font-medium text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-800')}>
          {t(v.label)}
        </Link>
      ))}
    </nav>
  )
}
