/**
 * What still has no price: hotel nights without a room price, and lines in the price at 0 with no
 * formula and no price by group size. They are there on purpose - empty, to fill when the data
 * comes - and the screen says so, so nobody takes an unfinished price for a real one.
 */
import type { QuoteDoc, QuoteItem } from '../../lib/api'

export const lineMissing = (it: QuoteItem) =>
  it.included && !it.optional && !Number(it.unit_price) && !it.price_formula && !it.tiers.some((x) => Number(x.unit_price))

export function missingPrices(doc: QuoteDoc) {
  const nights = doc.nights.map((n, i) => ({ n, i })).filter(({ n }) => n.price_dbl === null || n.price_dbl === '')
  const items = doc.items.map((it, i) => ({ it, i })).filter(({ it }) => lineMissing(it))
  return { nights, items, count: nights.length + items.length }
}
