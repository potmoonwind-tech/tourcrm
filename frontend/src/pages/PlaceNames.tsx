/**
 * Settings → Place names: every town, stop and visit the agency's tours and routes use, in one list. Mixed
 * spellings ("Tbilisi", "თბილისი") are made one by renaming - everywhere at once - or by taking the map's name
 * (in the agency's place language). Each name also has the name clients see in programme files (English,
 * Georgian, Chinese): filled by the AI's translations when a file is made, and editable here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Search, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { ask, toast } from '../components/overlay'
import { Card, Input } from '../components/ui'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { PageHeader } from './Dashboard'

interface NameRow { name: string; uses: number; on_map: boolean; client: Record<'en' | 'ka' | 'zh', string> }
const LANGS = [['en', 'EN'], ['ka', 'KA'], ['zh', '中文']] as const

export function PlaceNamesPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const names = useQuery({ queryKey: ['place-names', ws.id], queryFn: () => api<NameRow[]>(wsPath(ws.id, '/place-names')) })
  const shown = (names.data ?? []).filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <>
      <PageHeader section="settings" title={t('settings')} subtitle={ws.name} />
      <div className="max-w-5xl space-y-4 p-4 md:p-8">
        <div>
          <h2 className="text-base font-semibold text-slate-800">{t('placeNames')}</h2>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-600">{t('placeNamesHelp')}</p>
        </div>
        <div className="relative max-w-sm">
          <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-9 pl-8" aria-label={t('search')} />
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
              {shown.map((r) => <Row key={r.name} row={r} all={names.data ?? []} />)}
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
    mutationFn: (to: string) => api<{ changed: number }>(wsPath(ws.id, '/place-names/rename'), { method: 'POST', body: { old: row.name, new: to } }),
    onSuccess: (r) => { toast(t('placeRenamed', { n: r.changed })); setMapName(null); void refresh() },
  })
  const fromMap = useMutation({
    mutationFn: () => api<{ name: string }>(wsPath(ws.id, '/place-names/map-name'), { method: 'POST', body: { name: row.name } }),
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
    const joins = all.some((x) => x.name === next)
    const ok = await ask({ title: t('placeRenameTitle'), message: t(joins ? 'placeRenameJoin' : 'placeRenameMsg', { old: row.name, new: next, n: row.uses }), confirmLabel: t('placeRenameGo') })
    if (ok) rename.mutate(next)
    else setName(row.name)
  }
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <MapPin size={14} aria-label={row.on_map ? t('placeOnMapPinned') : undefined}
            className={cn('shrink-0', row.on_map ? 'text-brand-600' : 'text-slate-300')} />
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('placeNameCol')}
            onBlur={() => void confirmRename(name)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1.5 font-medium hover:border-slate-300 focus:bg-white" />
          <button type="button" onClick={() => fromMap.mutate()} disabled={fromMap.isPending} title={t('placeMapName')} aria-label={t('placeMapName')}
            className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-700 disabled:opacity-50"><Sparkles size={14} /></button>
        </div>
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
