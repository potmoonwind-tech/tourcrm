import { useQuery } from '@tanstack/react-query'
import { SetupNudge } from '../components/GetStarted'
import { Drawer } from '../components/overlay'
import { AlertTriangle, Search } from 'lucide-react'
import { useState } from 'react'
import { ServicesEditor } from '../components/ServicesEditor'
import { EmptyState } from '../components/tour'
import { ButtonLink, Input, Select } from '../components/ui'
import { api, VENDOR_TYPES, type CatalogRow, type ServiceRate, type VendorType } from '../lib/api'
import { useVendors, wsPath } from '../lib/data'
import { fmt, today } from '../lib/dates'
import { useDebounced } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { PageHeader } from './Dashboard'

/** Every service the agency buys, with the price that applies on a chosen date and group size. */
export function PriceCatalogPage() {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const vendors = useVendors(true)
  const [on, setOn] = useState(today())
  const [pax, setPax] = useState('')
  const [type, setType] = useState<VendorType | ''>('')
  const [q, setQ] = useState('')
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const search = useDebounced(q, 250)
  const params = new URLSearchParams({ on })
  if (pax) params.set('pax', pax)
  if (type) params.set('type', type)
  if (search.trim()) params.set('q', search.trim())
  if (missing) params.set('missing', 'true')
  const rows = useQuery({
    queryKey: ['catalog', ws.id, params.toString()],
    queryFn: () => api<CatalogRow[]>(wsPath(ws.id, `/catalog?${params}`)),
    placeholderData: (prev) => prev,
  })
  const vendor = vendors.data?.find((v) => v.id === editing)

  // Which price row applied, in words: "High season · 1 Jun – 30 Sep · 20+ pax".
  const why = (r: ServiceRate | undefined) => {
    if (!r) return ''
    const parts = []
    if (r.valid_from || r.valid_to) parts.push(`${r.valid_from ? fmt(r.valid_from, lang) : '…'} – ${r.valid_to ? fmt(r.valid_to, lang) : '…'}`)
    if (r.min_pax || r.max_pax) parts.push(r.max_pax ? `${r.min_pax ?? 1}–${r.max_pax} ${t('pax')}` : `${r.min_pax}+ ${t('pax')}`)
    return [r.notes, ...parts].filter(Boolean).join(' · ') || t('allYear')
  }

  return (
    <>
      <PageHeader section="catalog" title={t('catalog')} subtitle={t('priceCatalogHelp')} />
      <div className="space-y-4 p-4 md:p-8">
        <SetupNudge step="prices" />
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-600">{t('pricesOn')}</span>
            <Input type="date" value={on} onChange={(e) => setOn(e.target.value || today())} className="w-44" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-600">{t('groupSize')}</span>
            <Input type="number" min="1" value={pax} placeholder={t('anySize')} onChange={(e) => setPax(e.target.value)} className="w-28" />
          </label>
          <Select value={type} onChange={(e) => setType(e.target.value as VendorType | '')} className="w-44">
            <option value="">{t('all')}</option>
            {VENDOR_TYPES.map((v) => <option key={v} value={v}>{t(`vendorType_${v}`)}</option>)}
          </Select>
          <div className="relative min-w-48 flex-1">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="pl-9" />
          </div>
          <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} />{t('onlyMissing')}
          </label>
        </div>

        {rows.data && rows.data.length === 0 ? <EmptyState title={missing ? t('noMissingPrices') : t('noServices')}
          action={!missing && <ButtonLink to="../vendors" relative="path">{t('openVendors')}</ButtonLink>} /> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('vendor')}</th><th className="px-4 py-3">{t('service')}</th>
                  <th className="px-4 py-3">{t('unit')}</th><th className="px-4 py-3 text-right">{t('unitPrice')}</th>
                  <th className="px-4 py-3">{t('whichPrice')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.data?.map((r) => {
                  const applied = r.service.rates.find((x) => x.id === r.rate_id)
                  return (
                    <tr key={r.service.id} onClick={() => setEditing(r.vendor.id)} className="cursor-pointer hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{r.vendor.name}</span>
                        <span className="block text-xs text-slate-500">{t(`vendorType_${r.vendor.type}`)}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {r.service.name}
                        {r.service.rates.length > 1 && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{t('nPrices', { n: r.service.rates.length })}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{t(`unit_${r.service.unit}`)}</td>
                      <td className={cn('whitespace-nowrap px-4 py-2.5 text-right tabular-nums', r.price === null ? 'text-red-600' : 'font-semibold')}>
                        {r.price === null
                          ? <span className="inline-flex items-center gap-1"><AlertTriangle size={14} />{t('noPriceOnDate')}</span>
                          : `${money(r.price)} ${r.currency}`}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500">{why(applied)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {vendor && (
        <Drawer size="xl" title={vendor.name} onClose={() => setEditing(null)}>
          <ServicesEditor vendor={vendor} standalone />
        </Drawer>
      )}
    </>
  )
}
