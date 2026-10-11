/**
 * A place's names where you work with it: the map's own name (✨ - in the agency's place-name language, one
 * tap to use it) and the names clients see in programme files (EN · KA · 中文; empty = translated
 * automatically). Used in the supplier's form; the Catalog's "Place names" tab has them for everything.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { toast } from './overlay'
import { Input } from './ui'

export interface NameInfo { map: string; client: Record<'en' | 'ka' | 'zh', string> }
const LANGS = [['en', 'EN'], ['ka', 'KA'], ['zh', '中文']] as const

/** The map's name and the names for clients of one name (only fetched when `enabled`). */
export function useNameInfo(name: string, enabled = true) {
  const ws = useWorkspace()!
  const n = name.trim()
  return useQuery({
    queryKey: ['name-info', ws.id, n],
    queryFn: () => api<NameInfo>(wsPath(ws.id, `/place-names/info?name=${encodeURIComponent(n)}`)),
    enabled: enabled && !!n, staleTime: 60_000, meta: { silent: true },
  })
}

/** "✨ The map's name": asks the map, then offers its name ("Use this name"). */
export function MapNameButton({ name, city, onUse }: { name: string; city?: string; onUse: (name: string) => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [found, setFound] = useState<string | null>(null)
  const ask = useMutation({
    mutationFn: () => api<{ name: string }>(wsPath(ws.id, '/place-names/map-name'), { method: 'POST', body: { name, city: city ?? '' } }),
    onSuccess: (r) => setFound(r.name),
    onError: () => toast('placeMapNameNone', 'error'),
  })
  if (!name.trim()) return null
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {found && found !== name.trim() ? <>
        <span className="text-slate-600">{t('placeOnMap', { name: found })}</span>
        <button type="button" onClick={() => { onUse(found); setFound(null) }} className="font-medium text-brand-700 hover:underline">{t('placeUseMapName')}</button>
        <button type="button" onClick={() => setFound(null)} className="text-slate-400 hover:text-slate-600">{t('cancel')}</button>
      </> : (
        <button type="button" onClick={() => ask.mutate()} disabled={ask.isPending}
          className="inline-flex items-center gap-1 text-slate-500 hover:text-brand-700 disabled:opacity-50">
          <Sparkles size={12} aria-hidden />{found ? t('placeSameAsMap') : t('placeMapName')}
        </button>
      )}
    </span>
  )
}

/** The names clients see for this place (programme files), saved as each box is left. */
export function ClientNamesBox({ name }: { name: string }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const info = useNameInfo(name)
  const save = useMutation({
    mutationFn: (p: { lang: string; text: string }) => api(wsPath(ws.id, '/place-names/client-name'), { method: 'PUT', body: { name: name.trim(), ...p } }),
    onSuccess: () => { toast('saved'); void qc.invalidateQueries({ queryKey: ['name-info', ws.id] }); void qc.invalidateQueries({ queryKey: ['place-names', ws.id] }) },
    meta: { silent: true },
  })
  if (!name.trim() || !info.data) return null
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-slate-700">{t('placeNamesForClients')}</p>
      <div className="grid grid-cols-3 gap-2">
        {LANGS.map(([l, label]) => (
          <label key={`${l}|${info.data!.client[l]}`} className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="w-8 shrink-0">{label}</span>
            <Input defaultValue={info.data!.client[l]} placeholder={t('placeClientAuto')} aria-label={`${t('placeNamesForClients')} · ${label}`}
              onBlur={(e) => { if (e.target.value.trim() !== info.data!.client[l]) save.mutate({ lang: l, text: e.target.value }) }}
              className="h-8 min-w-0 flex-1 text-xs" />
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">{t('placeNamesForClientsHelp')}</p>
    </div>
  )
}
