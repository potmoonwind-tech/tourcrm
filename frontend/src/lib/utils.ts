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
/** "19", "~20", or "19 + 1" with free tour leaders on top. */
export const paxText = (t: { pax: number; pax_estimated?: boolean; leaders?: number | null }) =>
  (t.pax ? `${t.pax_estimated ? '~' : ''}${t.pax}${t.leaders ? ` + ${t.leaders}` : ''}` : '?')

export const countWord = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** An id for a new slot on a day (a service, a programme step) before it's saved: the server keeps it. */
export const slotId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)

// Georgian and Russian letters in Latin (Georgia's national romanisation), as in backend geo.town_key.
const LATIN: Record<string, string> = {
  ა: 'a', ბ: 'b', გ: 'g', დ: 'd', ე: 'e', ვ: 'v', ზ: 'z', თ: 't', ი: 'i', კ: 'k', ლ: 'l', მ: 'm', ნ: 'n', ო: 'o', პ: 'p', ჟ: 'zh',
  რ: 'r', ს: 's', ტ: 't', უ: 'u', ფ: 'p', ქ: 'k', ღ: 'gh', ყ: 'q', შ: 'sh', ჩ: 'ch', ც: 'ts', ძ: 'dz', წ: 'ts', ჭ: 'ch', ხ: 'kh',
  ჯ: 'j', ჰ: 'h', а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}
/** One spelling for a town in any alphabet: "Tbilisi" = "თბილისი" = "Тбилиси"; "Qazbegi" = "Kazbegi". */
// Georgian gives foreign names an ending "-ი" and drops the "Y" (ერევანი = Yerevan): neither counts.
export const townKey = (name: string) => {
  const s = [...(name.split(',')[0] ?? '').trim().toLowerCase()].map((c) => LATIN[c] ?? c).join('')
    .replace(/[^a-z0-9]/g, '').replace(/q/g, 'k').replace(/^y(?=[aeiou])/, '')
  return s.length > 3 && s.endsWith('i') ? s.slice(0, -1) : s
}
