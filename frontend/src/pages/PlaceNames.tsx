/**
 * Catalog → Place names: every town, stop and visit the agency's tours and routes use, in one list. Mixed
 * spellings ("Tbilisi", "თბილისი") are made one by renaming - everywhere at once - or by taking the map's name
 * (in the agency's place language). Each name also has the name clients see in programme files (English,
 * Georgian, Chinese): filled by the AI's translations when a file is made, and editable here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BedDouble, Landmark, MapPin, Search, Sparkles, Utensils } from 'lucide-react'
import { useState } from 'react'
import { ask, toast } from '../components/overlay'
import { Card, Input } from '../components/ui'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { PageHeader } from './Dashboard'

interface NameRow {
  name: string; uses: number; on_map: boolean; client: Record<'en' | 'ka' | 'zh', string>
  kind: 'place' | 'hotel' | 'restaurant' | 'activity' | 'other'; vendor_id: string | null; city: string
}
type Filter = 'all' | 'place' | 'hotel' | 'restaurant' | 'activity'
const KIND_ICON = { place: MapPin, hotel: BedDouble, restaurant: Utensils, activity: Landmark, other: Landmark }
const LANGS = [['en', 'EN'], ['ka', 'KA'], ['zh', '中文']] as const

export function PlaceNamesPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Filter>('all')
  const names = useQuery({ queryKey: ['place-names', ws.id], queryFn: () => api<NameRow[]>(wsPath(ws.id, '/place-names')) })
  const shown = (names.data ?? []).filter((r) => (kind === 'all' || r.kind === kind || (kind === 'activity' && r.kind === 'other'))
    && (!q.trim() || `${r.name} ${r.city}`.toLowerCase().includes(q.trim().toLowerCase())))
  return (
    <>
      <PageHeader section="catalog" title={t('catalog')} subtitle={t('placeNamesSub')} />
      <div className="max-w-5xl space-y-4 p-4 md:p-8">
        <div>
          <h2 className="text-base font-semibold text-slate-800">{t('placeNames')}</h2>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-600">{t('placeNamesHelp')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-9 pl-8" aria-label={t('search')} />
          </div>
          {/* What kind: places (towns, stops, visits) or the catalogue's hotels, restaurants, sights. */}
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('placeKind')}>
            {(['all', 'place', 'hotel', 'restaurant', 'activity'] as Filter[]).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                className={cn('rounded-full px-3 py-1 text-xs font-medium', kind === k ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-200' : 'text-slate-600 hover:bg-slate-100')}>
                {t(`placeKind_${k}`)} <span className="tabular-nums text-slate-400">{(names.data ?? []).filter((r) => k === 'all' || r.kind === k || (k === 'activity' && r.kind === 'other')).length}</span>
              </button>
            ))}
          </div>
        </div>
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
              <tr>
                <th className="px-3 py-2">{t('placeNameCol')}</th>
                <th className="px-2 py-2 text-right">{t('placeUsesCol')}</th>
                {LANGS.map(([l, label]) => <th key={l} className="px-2 py-2">{t('placeForClients')} · {label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {names.isLoading && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">{t('loading')}</td></tr>}
              {!names.isLoading && shown.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">{t('placeNamesNone')}</td></tr>}
              {shown.map((r) => <Row key={`${r.vendor_id ?? 'p'}|${r.name}`} row={r} all={names.data ?? []} />)}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}

function Row({ row, all }: { row: NameRow; all: NameRow[] }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [name, setName] = useState(row.name)
  const [mapName, setMapName] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['place-names', ws.id] })
  const rename = useMutation({
    mutationFn: (to: string) => api<{ changed: number }>(wsPath(ws.id, '/place-names/rename'), { method: 'POST', body: { old: row.name, new: to, vendor_id: row.vendor_id } }),
    onSuccess: (r) => {
      toast(row.vendor_id ? t('placeRenamedSupplier') : t('placeRenamed', { n: r.changed }))
      setMapName(null); void refresh()
      if (row.vendor_id) void qc.invalidateQueries({ queryKey: ['vendors'] })
    },
  })
  const fromMap = useMutation({
    mutationFn: () => api<{ name: string }>(wsPath(ws.id, '/place-names/map-name'), { method: 'POST', body: { name: row.name, city: row.city } }),
    onSuccess: (r) => setMapName(r.name),
    onError: () => toast('placeMapNameNone', 'error'),
  })
  const client = useMutation({
    mutationFn: (p: { lang: string; text: string }) => api(wsPath(ws.id, '/place-names/client-name'), { method: 'PUT', body: { name: row.name, ...p } }),
    onSuccess: () => { toast('saved'); void refresh() },
    meta: { silent: true },
  })
  // Renaming changes every tour and route that uses the name: asked first (and said when it joins another).
  const confirmRename = async (to: string) => {
    const next = to.trim()
    if (!next || next === row.name) { setName(row.name); return }
    const joins = !row.vendor_id && all.some((x) => !x.vendor_id && x.name === next)
    const ok = await ask({ title: t('placeRenameTitle'), confirmLabel: t('placeRenameGo'),
      message: row.vendor_id ? t('placeRenameSupplier', { old: row.name, new: next })
        : t(joins ? 'placeRenameJoin' : 'placeRenameMsg', { old: row.name, new: next, n: row.uses }) })
    if (ok) rename.mutate(next)
    else setName(row.name)
  }
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          {(() => { const Icon = KIND_ICON[row.kind] ?? MapPin; return (
            <Icon size={14} aria-label={`${t(`placeKind_${row.kind === 'other' ? 'activity' : row.kind}`)}${row.on_map ? ` · ${t('placeOnMapPinned')}` : ''}`}
              className={cn('shrink-0', row.on_map ? 'text-brand-600' : 'text-slate-400')} />
          ) })()}
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('placeNameCol')}
            onBlur={() => void confirmRename(name)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1.5 font-medium hover:border-slate-300 focus:bg-white" />
          <button type="button" onClick={() => fromMap.mutate()} disabled={fromMap.isPending} title={t('placeMapName')} aria-label={t('placeMapName')}
            className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-700 disabled:opacity-50"><Sparkles size={14} /></button>
        </div>
        {row.city && row.kind !== 'place' && <p className="pl-6 text-[11px] text-slate-400">{row.city}</p>}
        {mapName && mapName !== row.name && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 pl-6 text-xs text-slate-600">
            {t('placeOnMap', { name: mapName })}
            <button type="button" onClick={() => void confirmRename(mapName)} className="font-medium text-brand-700 hover:underline">{t('placeUseMapName')}</button>
            <button type="button" onClick={() => setMapName(null)} className="text-slate-400 hover:text-slate-600">{t('cancel')}</button>
          </p>
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-slate-500"><span className="inline-block pt-1.5">{row.uses}</span></td>
      {LANGS.map(([l, label]) => (
        <td key={l} className="px-2 py-2">
          <Input defaultValue={row.client[l]} placeholder={t('placeClientAuto')} aria-label={`${row.name} · ${label}`}
            onBlur={(e) => { if (e.target.value.trim() !== row.client[l]) client.mutate({ lang: l, text: e.target.value }) }}
            className="h-8 w-full text-xs" />
        </td>
      ))}
    </tr>
  )
}
