/**
 * Photos of a place: a hotel, restaurant or sight of the catalogue (vendorId), or a town or sight known only by
 * its name (place). The agency's own (uploaded) or free ones from Wikimedia Commons, with their author and
 * licence. The first is the main one - the one the tour presentation shows.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Search, Star, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Button, ErrorText, Input } from './ui'

export interface PhotoRow { id: string; vendor_id: string | null; place: string; source: 'upload' | 'wikimedia'; url: string; thumb: string; credit: string; link: string; auto: boolean; position: number }
interface Found { url: string; thumb: string; credit: string; link: string; title: string }

export function PlacePhotos({ vendorId, place, name, onChanged, compact }: {
  vendorId?: string | null; place?: string; name: string
  onChanged?: () => void      // after any change (the presentation's list refreshes)
  compact?: boolean
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const params = vendorId ? `vendor_id=${vendorId}` : `place=${encodeURIComponent(place ?? '')}`
  const key = ['photos', ws.id, vendorId ?? `place:${place}`]
  const list = useQuery({ queryKey: key, queryFn: () => api<PhotoRow[]>(wsPath(ws.id, `/photos?${params}`)) })
  const done = () => { qc.invalidateQueries({ queryKey: key }); onChanged?.() }
  const file = useRef<HTMLInputElement>(null)
  const [searching, setSearching] = useState(false)
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const body = new FormData()
      body.append('file', f)
      if (vendorId) body.append('vendor_id', vendorId)
      else body.append('place', place ?? '')
      const res = await fetch(`/api${wsPath(ws.id, '/photos')}`, { method: 'POST', credentials: 'include', body })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : res.statusText)
      return data as PhotoRow
    },
    onSuccess: done,
  })
  const pick = useMutation({
    mutationFn: (f: Found) => api(wsPath(ws.id, '/photos/wikimedia'), { method: 'POST', body: { vendor_id: vendorId ?? null, place: vendorId ? null : place, url: f.url, thumb: f.thumb, credit: f.credit, link: f.link } }),
    onSuccess: () => { setSearching(false); done() },
  })
  const main = useMutation({ mutationFn: (id: string) => api(wsPath(ws.id, `/photos/${id}/main`), { method: 'POST' }), onSuccess: done })
  const remove = useMutation({ mutationFn: (id: string) => api(wsPath(ws.id, `/photos/${id}`), { method: 'DELETE' }), onSuccess: done })
  const rows = list.data ?? []
  return (
    <div className="space-y-2">
      <div className={cn('grid gap-2', compact ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-3')}>
        {rows.map((p, i) => (
          <figure key={p.id} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            <img src={p.thumb} alt={name} loading="lazy" className="aspect-[4/3] w-full object-cover" />
            {i === 0 && <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-1.5 text-[10px] font-semibold text-slate-800">{t('photoMain')}</span>}
            <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {i > 0 && (
                <button type="button" onClick={() => main.mutate(p.id)} aria-label={t('photoMakeMain')} title={t('photoMakeMain')}
                  className="rounded-full bg-white/90 p-1 text-slate-700 hover:bg-white"><Star size={13} /></button>
              )}
              <button type="button" onClick={() => remove.mutate(p.id)} aria-label={t('delete')} title={t('delete')}
                className="rounded-full bg-white/90 p-1 text-red-600 hover:bg-white"><Trash2 size={13} /></button>
            </span>
            {p.credit && (
              <figcaption className="truncate px-1.5 py-0.5 text-[10px] text-slate-500" title={p.credit}>
                {p.link ? <a href={p.link} target="_blank" rel="noreferrer" className="hover:underline">{p.credit}</a> : p.credit}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      {list.isSuccess && !rows.length && <p className="text-xs text-slate-500">{t('photoNone')}</p>}
      <div className="flex flex-wrap gap-2">
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = '' }} />
        <Button size="sm" variant="secondary" disabled={upload.isPending} onClick={() => file.current?.click()}><ImagePlus size={14} />{t('photoUpload')}</Button>
        <Button size="sm" variant="secondary" onClick={() => setSearching(!searching)}><Search size={14} />{t('photoWiki')}</Button>
      </div>
      <ErrorText error={upload.error ?? pick.error ?? main.error ?? remove.error} />
      {searching && <WikiSearch initial={name} onPick={(f) => pick.mutate(f)} onClose={() => setSearching(false)} busy={pick.isPending} />}
    </div>
  )
}

/** Free photos from Wikimedia Commons for some words; a click takes one (with its author and licence). */
function WikiSearch({ initial, onPick, onClose, busy }: { initial: string; onPick: (f: Found) => void; onClose: () => void; busy: boolean }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [q, setQ] = useState(initial)
  const [asked, setAsked] = useState(initial)
  const found = useQuery({
    queryKey: ['wiki-photos', asked], enabled: asked.trim().length >= 2, staleTime: 10 * 60_000,
    queryFn: () => api<Found[]>(wsPath(ws.id, `/photos/search?q=${encodeURIComponent(asked.trim())}`)),
  })
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setAsked(q) }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('photoWiki')} className="h-8 flex-1" />
        <Button size="sm" type="submit">{t('photoFind')}</Button>
        <button type="button" onClick={onClose} aria-label={t('close')} className="rounded-md p-1 text-slate-500 hover:bg-white"><X size={16} /></button>
      </form>
      {found.isFetching && <p className="text-xs text-slate-500">{t('photoSearching')}</p>}
      {found.isSuccess && !found.data.length && <p className="text-xs text-slate-500">{t('photoNothing')}</p>}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {(found.data ?? []).map((f) => (
          <button key={f.url} type="button" disabled={busy} onClick={() => onPick(f)} title={f.credit}
            className="overflow-hidden rounded-md border border-slate-200 bg-white text-left hover:ring-2 hover:ring-brand-400 disabled:opacity-60">
            <img src={f.thumb} alt={f.title} loading="lazy" className="aspect-[4/3] w-full object-cover" />
            <span className="block truncate px-1 py-0.5 text-[10px] text-slate-500">{f.credit || f.title}</span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">{t('photoWikiNote')}</p>
    </div>
  )
}
