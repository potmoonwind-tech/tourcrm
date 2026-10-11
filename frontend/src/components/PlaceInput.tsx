/**
 * A place name box that suggests real places from the map while you type ("Anan" → Ananuri Castle,
 * Dusheti, Georgia), only in the agency's countries. Picking one also pins the name to that exact
 * spot, so km and driving times use it. Anything typed by hand still works as before.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Landmark, MapPin } from 'lucide-react'
import { Fragment, useId, useState, type InputHTMLAttributes } from 'react'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useDebounced } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { useMapConfig } from '../lib/maps'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'

/** Opening hours as the map gives them: per weekday (0 = Sunday) from-to, and the map's own text. */
export interface OpeningHours { periods: { day: number; open: string; close: string }[]; text: string[] }

export interface PlaceSuggestion {
  name: string; detail: string; kind: string
  lat: number | null; lon: number | null   // null from Google until the place is picked (then looked up)
  place_id?: string | null   // Google's id: kept with the pin, so the spot can be looked up again later
  street?: string   // "Rustaveli Ave 12" when the map has it
  city?: string     // the town it is in
  own?: boolean     // one of the agency's own places (a catalogue sight), not from the map
  at?: string       // an activity of one of them: the place it happens at ("KTW")
  hours?: OpeningHours | null   // when it's open, as the map says (looked up when picked)
  service_id?: string   // the catalogue service it is (priced and booked when picked into a day)
}

/** A supplier's address from a picked place: street (with the place's name when there is no house
 * number, so two places on one avenue stay apart) and town. */
export const addressOf = (p: PlaceSuggestion) => {
  const street = p.street ? (/\d/.test(p.street) ? p.street : `${p.name}, ${p.street}`) : p.name
  return [street, p.city && p.city !== p.name ? p.city : ''].filter(Boolean).join(', ').slice(0, 300)
}

/** Fix a name (an address) to the picked spot for this agency: drives to it use exactly that place. */
export const pinPlace = (workspaceId: string, name: string, p: PlaceSuggestion) =>
  api(wsPath(workspaceId, '/places/pin'), {
    method: 'POST', body: { name: name.slice(0, 100), lat: p.lat, lon: p.lon, place_id: p.place_id ?? null, label: [p.name, p.detail].filter(Boolean).join(', '), hours: p.hours ?? null },
  })

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (v: string) => void
  /** After a suggestion is picked (the value is already set). */
  onPicked?: (p: PlaceSuggestion) => void
  /** The agency's own places, offered first ("Your places") as soon as something is typed. */
  own?: PlaceSuggestion[]
}

export function PlaceInput({ value, onChange, onPicked, own, className, onKeyDown, onBlur, onFocus, ...rest }: Props) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const q = useDebounced(value.trim(), 350)
  const maps = useMapConfig()
  // Google prices typing + the pick as one session: the same token until a place is picked.
  const [session, setSession] = useState(() => crypto.randomUUID())
  const found = useQuery({
    queryKey: ['places', ws.id, q.toLowerCase()],
    queryFn: () => api<PlaceSuggestion[]>(wsPath(ws.id, `/places?q=${encodeURIComponent(q)}&session=${session}`)),
    enabled: open && q.length >= 2,
    staleTime: 10 * 60_000,
    meta: { silent: true },
  })
  const pin = useMutation({
    mutationFn: (p: PlaceSuggestion) => api(wsPath(ws.id, '/places/pin'), {
      method: 'POST', body: { name: p.name, lat: p.lat, lon: p.lon, place_id: p.place_id ?? null, label: [p.name, p.detail].filter(Boolean).join(', '), hours: p.hours ?? null },
    }),
    meta: { silent: true },
  })
  // Only what matches the text now (not a stale answer for an earlier text).
  const typed = value.trim().toLowerCase()
  const mine = open && typed ? (own ?? []).filter((p) => p.name.toLowerCase().includes(typed) && p.name.toLowerCase() !== typed).slice(0, 5) : []
  const fromMap = open && q.length >= 2 && q === value.trim()
    ? (found.data ?? []).filter((p) => (p.name.toLowerCase() !== typed || p.detail) && !mine.some((m) => m.name.toLowerCase() === p.name.toLowerCase()))
    : []
  const items = [...mine, ...fromMap]
  // The place last picked here: renaming it ("Jvari Monastery" → "Джвари") keeps its spot on the map,
  // its hours and the roads to it - the agency's own name is pinned to the same place.
  const [last, setLast] = useState<{ name: string; p: PlaceSuggestion } | null>(null)
  const keepSpot = () => {
    const was = last
    const now = value.trim()
    if (!was || !now || now === was.name || was.p.lat == null) return
    pin.mutate({ ...was.p, name: now })
    setLast({ name: now, p: was.p })
  }
  const mapName = last && last.p.name !== value.trim() ? last.p.name : ''
  const choose = async (picked: PlaceSuggestion) => {
    onChange(picked.name)
    setOpen(false)
    let p = picked
    if (!p.own && p.place_id && p.lat == null) {
      // A Google suggestion: where it is, its street and town, now that it's picked.
      try {
        const d = await api<{ lat: number; lon: number; street: string; city: string; hours?: OpeningHours | null }>(
          wsPath(ws.id, `/places/details?id=${encodeURIComponent(p.place_id)}&session=${session}`))
        // The town as the list showed it ("…, Batumi, Georgia"): Google's address parts are
        // sometimes in the local script or spelling ("ბათუმი", "T'bilisi").
        const shown = p.detail.split(', ')
        const town = shown.length >= 2 ? shown[shown.length - 2] : ''
        p = { ...p, lat: d.lat, lon: d.lon, street: d.street || p.street, city: town || d.city || p.city, hours: d.hours ?? null }
      } catch { /* typed name still works */ }
      setSession(crypto.randomUUID())
    }
    if (!p.own && p.lat != null) pin.mutate(p)
    if (!p.own && p.lat != null) setLast({ name: p.name, p })
    setActive(-1)
    onPicked?.(p)
  }
  return (
    <span className={cn('relative', className?.includes('w-full') ? 'block w-full' : 'inline-block')}>
      <input {...rest} value={value} role="combobox" aria-autocomplete="list" aria-expanded={items.length > 0}
        aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1) }}
        onFocus={(e) => { setOpen(true); onFocus?.(e) }}
        // A rename counts right after picking (still in the box); once it's left, typing starts afresh -
        // a different town typed later never takes the old one's spot.
        onBlur={(e) => { setOpen(false); keepSpot(); setLast(null); onBlur?.(e) }}
        title={mapName ? t('placeOnMap', { name: mapName }) : rest.title}
        onKeyDown={(e) => {
          if (items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length))
            return
          }
          if (items.length && e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); return }
          if (e.key === 'Escape' && items.length) { e.stopPropagation(); setOpen(false); return }
          onKeyDown?.(e)
        }}
        className={className} />
      {items.length > 0 && (
        <ul id={listId} role="listbox" aria-label={t('placeSuggestions')}
          className="absolute left-0 top-full z-40 mt-1 max-h-72 w-80 max-w-[90vw] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {items.map((p, i) => (<Fragment key={`${p.name}|${p.detail}|${i}`}>
            {i === 0 && mine.length > 0 && <li role="presentation" className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase text-slate-500">{t('placeYours')}</li>}
            {i === mine.length && mine.length > 0 && <li role="presentation" className="border-t border-slate-100 px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase text-slate-500">{t('placeFromMap')}</li>}
            <li id={`${listId}-${i}`} role="option" aria-selected={i === active}
              // mousedown: before the input's blur closes the list
              onMouseDown={(e) => { e.preventDefault(); choose(p) }}
              className={cn('flex cursor-pointer items-start gap-2 px-3 py-2', i === active ? 'bg-brand-50' : 'hover:bg-slate-50')}>
              {p.own ? <Landmark size={15} aria-hidden className="mt-0.5 shrink-0 text-violet-600" /> : <MapPin size={15} aria-hidden className="mt-0.5 shrink-0 text-slate-500" />}
              <span className="min-w-0">
                <span className="block font-medium text-slate-800">{p.name}</span>
                <span className="block text-xs text-slate-600">{[p.kind && p.kind !== 'yes' ? p.kind : '', p.detail].filter(Boolean).join(' · ')}</span>
              </span>
            </li>
          </Fragment>))}
          <li role="presentation" className="px-3 pb-1 pt-1.5 text-xs text-slate-500">{maps.data?.maps === 'google' ? t('placeSuggestionsFootGoogle') : t('placeSuggestionsFoot')}</li>
        </ul>
      )}
    </span>
  )
}
