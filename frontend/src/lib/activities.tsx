/**
 * What kind of activity place a supplier is (museum, cable car, winery...): the ready list, each with its icon
 * and colour, plus the agency's own words (any category typed once is offered for every place after).
 * The icon is used wherever the place shows: the catalogue, "what they do" and the day's timeline.
 */
import { CableCar, Castle, ChefHat, Church, Landmark, MapPin, Mountain, Music, Sailboat, Tag, Trees, Wine } from 'lucide-react'
import type { ComponentType } from 'react'
import type { Vendor } from './api'
import type { TKey } from './i18n'

type Icon = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>
export interface ActivityCat { key: string; icon: Icon; tone: string }

export const ACTIVITY_CATS: ActivityCat[] = [
  { key: 'museum', icon: Landmark, tone: 'bg-blue-100 text-blue-800' },
  { key: 'church', icon: Church, tone: 'bg-violet-100 text-violet-800' },
  { key: 'fortress', icon: Castle, tone: 'bg-stone-200 text-stone-800' },
  { key: 'cable_car', icon: CableCar, tone: 'bg-sky-100 text-sky-800' },
  { key: 'winery', icon: Wine, tone: 'bg-rose-100 text-rose-800' },
  { key: 'nature', icon: Trees, tone: 'bg-green-100 text-green-800' },
  { key: 'cave', icon: Mountain, tone: 'bg-amber-100 text-amber-900' },
  { key: 'workshop', icon: ChefHat, tone: 'bg-orange-100 text-orange-800' },
  { key: 'show', icon: Music, tone: 'bg-pink-100 text-pink-800' },
  { key: 'boat', icon: Sailboat, tone: 'bg-cyan-100 text-cyan-800' },
  { key: 'other', icon: MapPin, tone: 'bg-slate-100 text-slate-700' },
]
const OWN: ActivityCat = { key: '', icon: Tag, tone: 'bg-teal-100 text-teal-800' }

/** A place's category: a ready one, the agency's own word, or none. */
export function catOf(category?: string | null): ActivityCat | null {
  if (!category) return null
  return ACTIVITY_CATS.find((c) => c.key === category) ?? { ...OWN, key: category }
}

/** The name to show: the ready ones translated, the agency's own as written. */
export const catLabel = (t: (k: TKey) => string, category: string) =>
  ACTIVITY_CATS.some((c) => c.key === category) ? t(`actCat_${category}` as TKey) : category

/** The agency's own words, from the places that use them. */
export const ownCats = (vendors: Vendor[]) =>
  [...new Set(vendors.map((v) => v.category ?? '').filter((c) => c && !ACTIVITY_CATS.some((x) => x.key === c)))].sort()
