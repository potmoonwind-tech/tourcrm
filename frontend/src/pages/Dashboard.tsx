import type { ReactNode } from 'react'
import { SectionNav, type Section } from '../components/SectionNav'
import { cn } from '../lib/utils'

export function PageHeader({ title, subtitle, action, section }: {
  title: ReactNode; subtitle?: ReactNode; action?: ReactNode; section?: Section
}) {
  return (
    <header className={cn('border-b border-slate-200 px-4 md:px-8', section ? 'pt-5 md:pt-7' : 'py-5 md:py-7')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold leading-8 text-slate-800">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
        </div>
        {action}
      </div>
      {section && <div className="mt-3"><SectionNav section={section} /></div>}
    </header>
  )
}
