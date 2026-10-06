// Turning a calculation line's rule into plain words, and the "how many times"
// choices into the quantity formula the engine reads (and back).
import type { ItemCalc, QuoteDoc, QuoteItem, QuoteTier } from '../../lib/api'
import type { TKey } from '../../lib/i18n'
import { money } from '../../lib/utils'

type T = (k: TKey, vars?: Record<string, string | number>) => string

export type QtyMode =
  | { kind: 'once' }
  | { kind: 'days' }
  | { kind: 'nights' }
  | { kind: 'number'; n: string }
  | { kind: 'variable'; name: string }
  | { kind: 'formula' }

/** Which simple choice a quantity formula corresponds to, if any. */
export function qtyMode(expr: string, variables: Record<string, string>): QtyMode {
  const e = expr.trim()
  if (e === '' || e === '1') return { kind: 'once' }
  if (e === 'days') return { kind: 'days' }
  if (e === 'nights') return { kind: 'nights' }
  if (/^\d+(\.\d+)?$/.test(e)) return { kind: 'number', n: e }
  if (e in variables) return { kind: 'variable', name: e }
  return { kind: 'formula' }
}

export function qtyExpr(mode: QtyMode, current: string): string {
  switch (mode.kind) {
    case 'once': return '1'
    case 'days': return 'days'
    case 'nights': return 'nights'
    case 'number': return mode.n || '1'
    case 'variable': return mode.name
    case 'formula': return current
  }
}

const num = (x: number | null | undefined) =>
  x === null || x === undefined ? '?' : (x + 0).toLocaleString('en-US', { maximumFractionDigits: 2 })

/** Same rule as the engine: first tier covering the group, else the largest. */
export function tierFor(item: QuoteItem, tourists: number): QuoteTier | undefined {
  const tiers = [...item.tiers].sort((a, b) => a.max_pax - b.max_pax)
  return tiers.find((x) => tourists <= x.max_pax) ?? tiers.at(-1)
}

/**
 * "550.00 GEL per day × 9 days", "12.20 USD per person × 22 everyone × 14 meals in Georgia"…
 * Uses the engine's numbers for the sample group, so the words always match the amount.
 */
export function sentence(item: QuoteItem, c: ItemCalc | undefined, doc: QuoteDoc, t: T, tourists: number): string {
  const price = money(c?.unit_price ?? Number(item.unit_price), item.currency)
  // A group-size row may replace the quantity (e.g. litres for a minibus vs a bus).
  const qtyFormula = tierFor(item, tourists)?.quantity || item.quantity
  const mode = qtyMode(qtyFormula, doc.variables)
  const q = c?.quantity
  const qty = {
    once: '',
    days: t('s_days', { n: num(q) }),
    nights: t('s_nights', { n: num(q) }),
    number: t('s_times', { n: num(q) }),
    variable: mode.kind === 'variable' ? `${num(q)} ${doc.variable_notes?.[mode.name] || mode.name}` : '',
    formula: `${num(q)} (${qtyFormula.replace(/\*/g, '×').replace(/\s+/g, ' ').trim()})`,
  }[mode.kind]
  const who = t(`who_${item.who}` as TKey)
  let base: string
  if (item.basis === 'per_person') {
    base = t('s_per_person', { price, n: num(c?.multiplier), who })
  } else if (item.basis === 'per_vehicle') {
    const extra = item.extra ? t('s_extra', { n: item.extra }) : ''
    base = t('s_per_vehicle', { price, n: num(c?.multiplier), cap: item.capacity ?? '?', who: who + extra })
  } else {
    base = qty ? price : t('s_once_group', { price })
  }
  return qty ? `${base} × ${qty}` : base
}

/** "up to 12: 350 GEL (17-seater minibus) · up to 25: 550 GEL (45-seater bus)" */
export function tierText(item: QuoteItem, t: T): string {
  return [...item.tiers].sort((a, b) => a.max_pax - b.max_pax).map((x) => {
    const parts = [x.unit_price !== null ? money(Number(x.unit_price), item.currency) : '', x.quantity ? `× ${x.quantity}` : '']
      .filter(Boolean).join(' ')
    return `${t('s_upto', { n: x.max_pax })}: ${parts}${x.label ? ` (${x.label})` : ''}`
  }).join(' · ')
}
