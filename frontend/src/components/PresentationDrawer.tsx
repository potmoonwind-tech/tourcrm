/**
 * "Presentation" of a tour: links for the client (in their language, with or without the price) and the photos
 * each day will show - its town, sights and hotel, found on Wikimedia or the agency's own, changed right here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, ImageOff, Link2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, can, type Tour } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Drawer, toast } from './overlay'
import { PlacePhotos } from './Photos'
import { Button, ErrorText, Field, Select } from './ui'

interface Subject { kind: 'town' | 'sight' | 'hotel'; name: string; vendor_id: string | null; place: string; photo: { thumb: string; credit: string } | null }
interface Link { id: string; token: string; lang: string; price: boolean; created_at: string; views: number; last_seen_at: string | null }

const LANGS: [string, string][] = [['en', 'English'], ['ka', 'ქართული'], ['zh', '中文']]

export function PresentationDrawer({ tour, onClose }: { tour: Tour; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const seesPrice = can(ws, 'operations', 'finance', 'sales') && !!tour.price_pp
  const [plang, setPlang] = useState(lang === 'ka' ? 'ka' : 'en')
  const [price, setPrice] = useState(false)
  const [open, setOpen] = useState<string | null>(null)      // the subject whose photos are open
  const linksKey = ['presentation-links', ws.id, tour.id]
  const placesKey = ['presentation-places', ws.id, tour.id]
  const links = useQuery({ queryKey: linksKey, queryFn: () => api<Link[]>(wsPath(ws.id, `/tours/${tour.id}/presentation`)) })
  // Opening finds the missing towns' and sights' photos on Wikimedia (once per name), so it can take a moment.
  const places = useQuery({ queryKey: placesKey, queryFn: () => api<Subject[][]>(wsPath(ws.id, `/tours/${tour.id}/presentation/places`)) })
  const make = useMutation({
    mutationFn: () => api<Link>(wsPath(ws.id, `/tours/${tour.id}/presentation`), { method: 'POST', body: { lang: plang, price } }),
    onSuccess: (l) => { qc.invalidateQueries({ queryKey: linksKey }); copy(l.token); window.open(`/present/${l.token}`, '_blank') },
  })
  const drop = useMutation({
    mutationFn: (id: string) => api(wsPath(ws.id, `/programme/share/${id}`), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: linksKey }),
  })
  const url = (token: string) => `${window.location.origin}/present/${token}`
  const copy = (token: string) => { void navigator.clipboard?.writeText(url(token)).then(() => toast('presLinkCopied')) }
  const days = places.data ?? []
  const missing = days.flat().filter((s) => !s.photo).length
  return (
    <Drawer title={t('presTitle')} subtitle={tour.code} onClose={onClose} size="lg">
      <div className="space-y-6">
        <section className="space-y-3">
          <p className="text-sm text-slate-600">{t('presIntro')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('presLang')}>
              <Select value={plang} onChange={(e) => setPlang(e.target.value)} className="w-40">
                {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </Select>
            </Field>
            {seesPrice && (
              <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={price} onChange={(e) => setPrice(e.target.checked)} />
                {t('presWithPrice')}
              </label>
            )}
            <Button disabled={make.isPending} onClick={() => make.mutate()}><Link2 size={16} />{make.isPending ? t('presMaking') : t('presMake')}</Button>
          </div>
          <ErrorText error={make.error ?? drop.error} />
          {(links.data ?? []).length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {links.data!.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-slate-800">{LANGS.find(([v]) => v === l.lang)?.[1] ?? l.lang}</span>
                    {l.price && <span className="text-slate-500"> · {t('presPriceShown')}</span>}
                    <span className="block text-xs text-slate-500">{fmt(l.created_at.slice(0, 10), lang)} · {t('presViews', { n: l.views })}</span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => copy(l.token)}><Copy size={14} />{t('presCopy')}</Button>
                  <a href={`/present/${l.token}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-brand-700 hover:bg-brand-50"><ExternalLink size={14} />{t('presOpen')}</a>
                  <button type="button" onClick={() => drop.mutate(l.id)} aria-label={t('presRemove')} title={t('presRemove')}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"><Trash2 size={15} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* The photos each day will show: click one to change it (upload your own, or pick on Wikimedia). */}
        <section className="space-y-3 border-t border-slate-100 pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">{t('presPhotos')}</h3>
            {places.isSuccess && <span className={cn('text-xs', missing ? 'text-amber-700' : 'text-slate-500')}>{missing ? t('presMissing', { n: missing }) : t('presAllPhotos')}</span>}
          </div>
          {places.isLoading && <p className="text-sm text-slate-500">{t('presFinding')}</p>}
          <ErrorText error={places.error} />
          {days.map((day, i) => (
            <div key={i} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('day')} {i + 1}{day[0]?.kind === 'town' ? ` · ${day[0].name}` : ''}</p>
              <div className="flex flex-wrap gap-2">
                {day.map((s) => {
                  const id = `${i}:${s.vendor_id ?? s.place}`
                  return (
                    <button key={id} type="button" onClick={() => setOpen(open === id ? null : id)}
                      className={cn('flex w-36 flex-col overflow-hidden rounded-lg border text-left transition-shadow hover:shadow-md',
                        open === id ? 'border-brand-400 ring-2 ring-brand-100' : 'border-slate-200')}>
                      {s.photo
                        ? <img src={s.photo.thumb} alt={s.name} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                        : <span className="flex aspect-[4/3] w-full items-center justify-center bg-slate-100 text-slate-400"><ImageOff size={20} /></span>}
                      <span className="px-2 py-1">
                        <span className="block truncate text-xs font-medium text-slate-800">{s.name}</span>
                        <span className="block text-[10px] text-slate-500">{t(`presKind_${s.kind}` as TKey)}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {day.map((s) => `${i}:${s.vendor_id ?? s.place}` === open && (
                <div key={open} className="rounded-lg border border-slate-200 p-3">
                  <PlacePhotos vendorId={s.vendor_id} place={s.vendor_id ? undefined : s.name} name={s.name} compact
                    onChanged={() => qc.invalidateQueries({ queryKey: placesKey })} />
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </Drawer>
  )
}
