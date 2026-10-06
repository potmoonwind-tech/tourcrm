/**
 * Which map the app draws: Google Maps when the server has Google keys (GET /api/config), else
 * OpenStreetMap. Google's script is loaded once, only when a map is opened.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export interface MapConfig { maps: 'google' | 'osm'; maps_key: string }

export function useMapConfig() {
  return useQuery({ queryKey: ['mapConfig'], queryFn: () => api<MapConfig>('/config'), staleTime: Infinity, meta: { silent: true } })
}

// Google's own script defines window.google; we only use a few of its classes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GoogleMaps = any
declare global { interface Window { google?: GoogleMaps; __tourcrmMapsReady?: () => void } }

let loading: Promise<GoogleMaps> | null = null

export function loadGoogleMaps(key: string): Promise<GoogleMaps> {
  if (window.google?.maps) return Promise.resolve(window.google.maps)
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    window.__tourcrmMapsReady = () => resolve(window.google!.maps)
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__tourcrmMapsReady`
    s.async = true
    s.onerror = () => { loading = null; reject(new Error('Google Maps could not load')) }
    document.head.appendChild(s)
  })
  return loading
}
