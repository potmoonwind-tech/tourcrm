import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Button, FullPageSpinner } from '../components/ui'
import { useI18n } from '../lib/i18n'
import { ProgrammeDoc, type Programme } from './ProgrammePrint'

/** A programme shared by link (/p/<token>): anyone with it can read it, on a phone or a computer, and save it as PDF. */
export function ProgrammeSharedPage() {
  const { token } = useParams()
  const { t } = useI18n()
  const p = useQuery({
    queryKey: ['sharedProgramme', token], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/shared/programme/${encodeURIComponent(token ?? '')}`)
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as Programme
    },
  })
  useEffect(() => { if (p.data) document.title = `${p.data.title} · ${p.data.agency}` }, [p.data])
  if (p.isLoading) return <FullPageSpinner />
  if (!p.data) {
    return (
      <div className="mx-auto max-w-md p-6 pt-20 text-center">
        <p className="text-lg font-semibold text-slate-800">{t('shareLinkDead')}</p>
      </div>
    )
  }
  return <ProgrammeDoc d={p.data} toolbar={<Button variant="secondary" onClick={() => window.print()}><Printer size={16} />{t('printPdf')}</Button>} />
}
