/**
 * A quiet map of a trip or of one day: numbered pins on a light grey base map, and the real road
 * between them in the brand colour. Places come from the itinerary (route/tour days) or from a day
 * programme; where they are and the roads' shapes come from the server (app/geo.py path_map).
 */
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { loadGoogleMaps, useMapConfig, type GoogleMaps } from '../lib/maps'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Drawer } from './overlay'
import { Spinner } from './ui'

/** One place on the map. `night`: where a day ends (a big pin with the day number); `stop`: a place on
 * the way (a small pin); `step`: a day programme's step (numbered in order); `start`: where the day starts. */
export interface MapStop { place: string; label: string; kind: 'night' | 'stop' | 'step' | 'start'; day?: number }
interface MapPoint { name: string; lat: number | null; lon: number | null; where: string; missing: 'not_found' | 'far' | 'pending' | null }
interface MapData { points: MapPoint[]; roads: { from: number; to: number; polyline: string | null }[] }

const BRAND = '#0073ea'
// OpenStreetMap's own tiles, made grey and quiet in CSS (.tm-tiles) so the route stands out. Fine for
// an office tool's light use; before launch, switch to a tile provider with an account (their policy).
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

/** Google's encoded polyline (precision 5) → [lat, lon] points. */
function decode(s: string): [number, number][] {
  const out: [number, number][] = []
  let i = 0, lat = 0, lon = 0
  while (i < s.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b: number
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
      const d = result & 1 ? ~(result >> 1) : result >> 1
      if (which === 0) lat += d
      else lon += d
    }
    out.push([lat / 1e5, lon / 1e5])
  }
  return out
}

const pinHtml = (s: MapStop, n: number, active: boolean) => {
  if (s.kind === 'stop') return `<span class="tm-pin tm-pin-stop${active ? '' : ' tm-dim'}"></span>`
  if (s.kind === 'start') return `<span class="tm-pin tm-pin-start${active ? '' : ' tm-dim'}"></span>`
  return `<span class="tm-pin tm-pin-num${active ? '' : ' tm-dim'}">${n}</span>`
}

export function TripMap({ stops, title, subtitle, onClose }: { stops: MapStop[]; title: string; subtitle?: string; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const places = stops.map((s) => s.place.trim())
  const data = useQuery({
    queryKey: ['map', ws.id, places.map((p) => p.toLowerCase())],
    queryFn: () => api<MapData>(wsPath(ws.id, '/map'), { method: 'POST', body: { places } }),
    staleTime: Infinity,
    meta: { silent: true },
  })
  const days = useMemo(() => [...new Set(stops.map((s) => s.day).filter((d): d is number => d != null))], [stops])
  const [day, setDay] = useState<number | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const config = useMapConfig()
  const isGoogle = config.data?.maps === 'google'
  const gmap = useGoogleTrip(el, isGoogle ? config.data!.maps_key : null, data.data, stops, day)

  // The map itself, once (OpenStreetMap; Google's is drawn by useGoogleTrip).
  useEffect(() => {
    if (!el.current || !config.data || isGoogle) return
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: true })
    L.control.zoom({ position: 'bottomright' }).addTo(m)
    m.attributionControl.setPrefix(false)
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, className: 'tm-tiles' }).addTo(m)
    m.setView([41.9, 44.6], 7)
    map.current = m
    layer.current = L.layerGroup().addTo(m)
    return () => { m.remove(); map.current = null }
  }, [config.data, isGoogle])

  // Pins and roads; the chosen day stands out, the rest fades.
  useEffect(() => {
    const m = map.current, g = layer.current, d = data.data
    if (!m || !g || !d) return
    g.clearLayers()
    const on = (i: number) => day === null || stops[i]?.day === day
    for (const r of d.roads) {
      const a = d.points[r.from], b = d.points[r.to]
      const line = r.polyline ? decode(r.polyline) : [[a.lat!, a.lon!], [b.lat!, b.lon!]] as [number, number][]
      const active = on(r.to)
      L.polyline(line, { color: active ? BRAND : '#94a3b8', weight: active ? 4 : 3, opacity: active ? 0.9 : 0.5,
        dashArray: r.polyline ? undefined : '6 6', lineCap: 'round' }).addTo(g)
    }
    let n = 0
    const shown: L.LatLngExpression[] = []
    d.points.forEach((p, i) => {
      const s = stops[i]
      if (!s || s.kind === 'night' || s.kind === 'step') n++
      if (p.lat == null || p.lon == null || !s) return
      const num = s.kind === 'night' ? (s.day ?? n) : n
      const active = on(i)
      const size = s.kind === 'stop' || s.kind === 'start' ? 14 : 26
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', html: pinHtml(s, num, active), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        zIndexOffset: active ? 1000 : 0, keyboard: true, title: s.label,
      }).bindTooltip(`<b>${s.label}</b>${p.where && p.where.toLowerCase() !== s.label.toLowerCase() ? `<br><span>${p.where.split(',').slice(0, 3).join(',')}</span>` : ''}`,
        { direction: 'top', offset: [0, -size / 2], className: 'tm-tip' }).addTo(g)
      if (active) shown.push([p.lat, p.lon])
    })
    if (shown.length) m.fitBounds(L.latLngBounds(shown), { padding: [48, 48], maxZoom: 14 })
  }, [data.data, day, stops])

  const missing = (data.data?.points ?? []).map((p, i) => ({ p, s: stops[i] })).filter(({ p }) => p.missing)
  // On top of the whole page: opened from inside a drawer, it must not be trapped in it.
  return createPortal(
    <Drawer size="full" title={title} subtitle={subtitle} onClose={onClose}>
      <div className="flex h-[calc(100vh-9rem)] min-h-[420px] flex-col gap-3 lg:flex-row">
        {days.length > 1 && (
          <nav aria-label={t('mapDays')} className="flex shrink-0 gap-1.5 overflow-x-auto lg:w-56 lg:flex-col lg:overflow-y-auto">
            <DayButton active={day === null} onClick={() => setDay(null)}>{t('mapWholeTrip')}</DayButton>
            {days.map((d) => {
              const night = stops.find((s) => s.day === d && s.kind === 'night')
              const via = stops.filter((s) => s.day === d && s.kind === 'stop').length
              return (
                <DayButton key={d} active={day === d} onClick={() => setDay(d)}>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{d}</span>
                  <span className="min-w-0 truncate">{night?.label ?? '—'}</span>
                  {via > 0 && <span className="text-xs text-slate-500">+{via}</span>}
                </DayButton>
              )
            })}
          </nav>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200">
          <div ref={el} className="h-full w-full" role="region" aria-label={t('mapRegion')} />
          {(data.isPending || config.isPending || gmap === 'loading') && (
            <div className="absolute inset-0 z-[500] flex items-center justify-center gap-2 bg-white/60 text-sm text-slate-700" role="status">
              <Spinner />{t('mapLoading')}
            </div>
          )}
          {(data.isError || gmap === 'error') && <p className="absolute inset-x-0 top-0 z-[500] bg-white/90 px-3 py-2 text-sm text-red-700" role="alert">{t('mapUnavailable')}</p>}
        </div>
      </div>
      {missing.length > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
          <span><b>{t('mapMissing')}</b> {[...new Set(missing.map(({ s, p }) => s?.label ?? p.name))].join(', ')}</span>
        </p>
      )}
    </Drawer>,
    document.body,
  )
}

// --- Google Maps -----------------------------------------------------------------------------------

/** Grey and quiet, like the OpenStreetMap version: the route stands out. */
const QUIET = [
  { elementType: 'geometry', stylers: [{ saturation: -100 }, { lightness: 8 }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
]

/** Draws the same pins and roads on a Google map. 'loading' / 'error' / 'ready'. */
function useGoogleTrip(el: React.RefObject<HTMLDivElement | null>, key: string | null, d: MapData | undefined, stops: MapStop[], day: number | null) {
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const gm = useRef<GoogleMaps>(null)
  const map = useRef<GoogleMaps>(null)
  const drawn = useRef<GoogleMaps[]>([])

  useEffect(() => {
    if (!key || !el.current) return
    let gone = false
    setState('loading')
    loadGoogleMaps(key).then((maps) => {
      if (gone || !el.current) return
      gm.current = maps
      map.current = new maps.Map(el.current, { center: { lat: 41.9, lng: 44.6 }, zoom: 7, styles: QUIET, disableDefaultUI: true,
        zoomControl: true, clickableIcons: false, gestureHandling: 'greedy' })
      setState('ready')
    }).catch(() => !gone && setState('error'))
    return () => { gone = true }
  }, [key, el])

  useEffect(() => {
    const maps = gm.current, m = map.current
    if (state !== 'ready' || !maps || !m || !d) return
    drawn.current.forEach((x) => x.setMap(null))
    drawn.current = []
    const on = (i: number) => day === null || stops[i]?.day === day
    for (const r of d.roads) {
      const a = d.points[r.from], b = d.points[r.to]
      const path = (r.polyline ? decode(r.polyline) : [[a.lat!, a.lon!], [b.lat!, b.lon!]] as [number, number][]).map(([lat, lng]) => ({ lat, lng }))
      const active = on(r.to)
      const color = active ? BRAND : '#94a3b8'
      drawn.current.push(new maps.Polyline({ map: m, path, strokeColor: color, strokeOpacity: r.polyline ? (active ? 0.9 : 0.5) : 0,
        strokeWeight: active ? 4 : 3, icons: r.polyline ? [] : [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: color, scale: 3 }, offset: '0', repeat: '12px' }] }))
    }
    // HTML pins (the same look as the OpenStreetMap version), placed by an overlay.
    class Pin extends maps.OverlayView {
      div: HTMLDivElement
      at: GoogleMaps
      z: number
      constructor(at: GoogleMaps, html: string, title: string, z: number) {
        super()
        this.at = at
        this.z = z
        this.div = document.createElement('div')
        this.div.style.position = 'absolute'
        this.div.style.transform = 'translate(-50%, -50%)'
        this.div.title = title
        this.div.innerHTML = html
      }
      onAdd() { this.div.style.zIndex = String(this.z); this.getPanes().overlayMouseTarget.appendChild(this.div) }
      draw() { const p = this.getProjection().fromLatLngToDivPixel(this.at); if (p) { this.div.style.left = `${p.x}px`; this.div.style.top = `${p.y}px` } }
      onRemove() { this.div.remove() }
    }
    let n = 0
    const bounds = new maps.LatLngBounds()
    let any = false
    d.points.forEach((p, i) => {
      const s = stops[i]
      if (!s || s.kind === 'night' || s.kind === 'step') n++
      if (p.lat == null || p.lon == null || !s) return
      const num = s.kind === 'night' ? (s.day ?? n) : n
      const active = on(i)
      const where = p.where && p.where.toLowerCase() !== s.label.toLowerCase() ? `\n${p.where.split(',').slice(0, 3).join(',')}` : ''
      const pin = new Pin(new maps.LatLng(p.lat, p.lon), pinHtml(s, num, active), s.label + where, active ? 1000 : 1)
      pin.setMap(m)
      drawn.current.push(pin)
      if (active) { bounds.extend({ lat: p.lat, lng: p.lon }); any = true }
    })
    if (any) {
      m.fitBounds(bounds, 48)
      maps.event.addListenerOnce(m, 'idle', () => { if (m.getZoom() > 14) m.setZoom(14) })
    }
  }, [state, d, day, stops])

  return key ? state : 'idle'
}

function DayButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex min-h-10 shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm',
        active ? 'border-brand-500 bg-brand-50 font-medium text-brand-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')}>
      {children}
    </button>
  )
}
