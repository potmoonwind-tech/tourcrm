import type { QuoteDoc } from '../../lib/api'

/**
 * Take one day out of the trip: its lines go, the days after it move up by one, and the trip loses the
 * night that day stood for - the night after it, or for the last day the night before (night k is the
 * night after day k, so a trip of D days has D − 1 nights). Lines for the whole trip stay.
 */
export function removeDay(d: QuoteDoc, day: number) {
  if (d.days <= 1 || day < 1 || day > d.days) return
  const night = day < d.days ? day - 1 : day - 2
  if (night >= 0 && night < d.nights.length) d.nights.splice(night, 1)
  d.items = d.items.filter((it) => it.day !== day)
  for (const it of d.items) if (it.day && it.day > day) it.day -= 1
  d.days -= 1
}
