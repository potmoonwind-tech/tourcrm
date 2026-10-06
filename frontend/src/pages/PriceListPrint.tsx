import { useQuery } from '@tanstack/react-query'
import { useI18n } from '../lib/i18n'
import { Printer } from 'lucide-react'
import { useEffect } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, FullPageSpinner } from '../components/ui'
import { api, type PriceListData, can } from '../lib/api'
import { wsPath } from '../lib/data'
import { useMe } from '../lib/session'

/** The partner price list on one page, in the chosen language; Print → Save as PDF. */
export function PriceListPrintPage() {
  const { t } = useI18n()
  const { workspaceId, quoteId } = useParams()
  const [params] = useSearchParams()
  const lang = params.get('lang') ?? 'en'
  const { data: me } = useMe()
  const ws = me?.workspaces.find((w) => w.id === workspaceId)
  const allowed = can(ws, 'operations', 'sales', 'finance')
  const pl = useQuery({
    queryKey: ['priceList', workspaceId, quoteId, lang], enabled: allowed,
    queryFn: () => api<PriceListData>(wsPath(workspaceId!, `/quotes/${quoteId}/price-list?lang=${lang}`)),
  })
  useEffect(() => { if (pl.data) document.title = `${pl.data.title} · ${ws?.name ?? ''}` }, [pl.data, ws])
  if (!allowed) return <Navigate to="/" replace />
  if (!pl.data) return <FullPageSpinner />
  const d = pl.data
  const L = d.labels
  const n = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const cell = (x: string | number | null) => (typeof x === 'number' ? n(x) : x ?? '—')

  return (
    <div lang={d.lang} className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end px-4 print:hidden">
        <Button onClick={() => window.print()}><Printer size={16} />{t('printPdf')}</Button>
      </div>
      <article className="mx-auto max-w-[210mm] bg-white p-12 text-[13px] leading-relaxed text-slate-800 shadow print:max-w-none print:p-0 print:shadow-none">
        <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">{ws!.name}</p>
        <h1 className="mt-1 text-2xl font-bold">{d.title}</h1>
        <p className="mt-1 text-slate-500">
          {(d.valid_from || d.valid_to) && `${L.valid}: ${d.valid_from ?? ''} – ${d.valid_to ?? ''} · `}
          {L.currency.replace('{currency}', d.currency)}
        </p>

        {d.hotels.length > 0 && (
          <table className="mt-6 w-full">
            <thead><tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-1.5 font-semibold">{L.col_city}</th><th className="py-1.5 font-semibold">{L.col_hotel}</th>
            </tr></thead>
            <tbody>{d.hotels.map((h, i) => (
              <tr key={i} className="border-b border-slate-100"><td className="py-1.5 pr-4">{h.city}</td><td className="py-1.5">{h.hotel}</td></tr>
            ))}</tbody>
          </table>
        )}

        <dl className="mt-6 space-y-2">
          {(['meals', 'included', 'not_included'] as const).filter((k) => d.texts[k]).map((k) => (
            <div key={k} className="grid grid-cols-[10rem_1fr] gap-4">
              <dt className="font-semibold text-slate-500">{L[k]}</dt><dd className="whitespace-pre-line">{d.texts[k]}</dd>
            </div>
          ))}
        </dl>

        {(d.sections ?? []).map((sec, si) => (
          <section key={si} className="mt-8 break-inside-avoid">
            {sec.title && <h2 className="mb-2 text-base font-bold">{sec.title}</h2>}
            <table className="w-full">
              <thead>
                <tr className="bg-slate-900 text-left text-xs uppercase tracking-wide text-white">
                  {sec.columns.map((c, i) => (
                    <th key={i} className={`px-3 py-2 font-semibold ${i > 0 && i < sec.columns.length - 1 ? 'text-right' : ''}`}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sec.rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-slate-100 even:bg-slate-50">
                    {r.map((x, i) => (
                      <td key={i} className={`px-3 py-1.5 ${i > 0 && i < r.length - 1 ? 'text-right tabular-nums' : ''} ${i === 1 ? 'font-semibold' : ''}`}>{cell(x)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {(d.extras?.length ?? 0) > 0 && (
          <section className="mt-6">
            <h2 className="mb-1 font-semibold text-slate-500">{L.extras}</h2>
            <ul className="space-y-0.5">
              {d.extras!.map((x) => (
                <li key={x.name} className="flex justify-between border-b border-slate-100 py-1">
                  <span>{x.name}</span><span className="tabular-nums">{x.from === x.to ? n(x.from) : `${n(x.from)}–${n(x.to)}`} {d.currency}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {d.texts.notes && <p className="mt-6 whitespace-pre-line text-slate-600">{d.texts.notes}</p>}
      </article>
    </div>
  )
}
