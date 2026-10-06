import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SectionNav, type Section } from '../components/SectionNav'
import { cn } from '../lib/utils'

/**
 * A page's head: where you are (breadcrumbs on detail pages: "Tours / HM-0909"), the title with its actions on
 * one row, and the section's tabs right under it. Kept short so the work starts high on the page.
 */
export function PageHeader({ title, subtitle, action, section, crumbs }: {
  title: ReactNode; subtitle?: ReactNode; action?: ReactNode; section?: Section
  crumbs?: { label: string; to: string }[]
}) {
  return (
    <header className={cn('border-b border-slate-200 px-4 md:px-8', section ? 'pt-4 md:pt-5' : 'py-4 md:py-5')}>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
            {crumbs.map((c) => (
              <li key={c.to} className="flex items-center gap-1">
                <Link to={c.to} className="rounded hover:text-slate-800 hover:underline">{c.label}</Link>
                <ChevronRight size={14} aria-hidden className="text-slate-400" />
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-8 text-slate-800 md:text-2xl">{title}</h1>
          {subtitle && <div className="text-sm text-slate-500">{subtitle}</div>}
        </div>
        {action}
      </div>
      {section && <div className="mt-2"><SectionNav section={section} /></div>}
    </header>
  )
}
