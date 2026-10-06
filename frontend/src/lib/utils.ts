import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/** "1,234.50 GEL". Same format in every language, so amounts line up in tables. */
export const money = (n: number, currency?: string) =>
  // + 0 turns -0 (e.g. a "half day off" line set to zero) into 0, so it never prints "-0.00".
  `${(Math.round(n * 100) / 100 + 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`

/** "1,200.00 GEL · 300.00 USD" */
export const moneyList = (byCurrency: Record<string, number>) =>
  Object.entries(byCurrency).filter(([, v]) => v).map(([c, v]) => money(v, c)).join(' · ') || '—'

/** "1 day" / "3 days" (Georgian uses one form; the keys hold it). */
/** "20", "~20" when it's a guess, "?" when not known yet. */
export const paxText = (t: { pax: number; pax_estimated?: boolean }) => (t.pax ? `${t.pax_estimated ? '~' : ''}${t.pax}` : '?')

export const countWord = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** An id for a new slot on a day (a service, a programme step) before it's saved: the server keeps it. */
export const slotId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)
