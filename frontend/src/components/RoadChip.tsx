import { Car, ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'

/** 250 → "4 h 10" (minutes, rounded to 5). */
const hours = (min: number) => {
  const m = Math.round(min / 5) * 5
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`
}
/** The road between two towns, as a small chip between their names: "🚗 3 h 40 · 219 km ›" (a long day in amber). */
export function RoadChip({ km, minutes }: { km?: number | null; minutes?: number }) {
  const long = (minutes ?? 0) > 9 * 60
  return (
    <span className={cn('flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-normal tabular-nums',
      long ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')}>
      <Car size={12} aria-hidden />
      {!!minutes && <span className={long ? 'font-semibold' : ''}>{hours(minutes)}</span>}
      {!!minutes && !!km && <span aria-hidden>·</span>}
      {!!km && <span>{km} km</span>}
      <ChevronRight size={12} aria-hidden className="opacity-60" />
    </span>
  )
}
