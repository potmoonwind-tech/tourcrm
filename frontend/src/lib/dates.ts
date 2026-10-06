// Tour dates are calendar days ("2026-09-06"), not instants: never let a
// timezone shift them. All math happens on UTC midnights.
const DAY = 86_400_000

export const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (s: string, n: number) => iso(parse(s) + n * DAY)
export const diffDays = (a: string, b: string) => Math.round((parse(b) - parse(a)) / DAY)

export function today() {
  const d = new Date()
  return iso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
}

// Georgian names built in: many browsers ship without Georgian locale data and
// silently fall back to English.
const KA_MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი']
const KA_MONTHS_SHORT = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ']
const KA_DAYS = ['კვირა', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი']
const KA_DAYS_SHORT = ['კვ', 'ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ']

function fmtKa(d: Date, opts: Intl.DateTimeFormatOptions) {
  const parts: string[] = []
  const wd = d.getUTCDay()
  if (opts.weekday === 'long') parts.push(KA_DAYS[wd] + (opts.day ? ',' : ''))
  else if (opts.weekday === 'short') parts.push(KA_DAYS_SHORT[wd])
  else if (opts.weekday === 'narrow') parts.push(KA_DAYS[wd][0])
  if (opts.day) parts.push(String(d.getUTCDate()))
  if (opts.month === 'long') parts.push(KA_MONTHS[d.getUTCMonth()])
  else if (opts.month) parts.push(KA_MONTHS_SHORT[d.getUTCMonth()])
  if (opts.year) parts.push(String(d.getUTCFullYear()))
  return parts.join(' ')
}

export function fmt(s: string, lang: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  const d = new Date(parse(s))
  if (lang === 'ka') return fmtKa(d, opts)
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts })
}

export const fmtLong = (s: string, lang: string) =>
  fmt(s, lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

export const weekday = (s: string, lang: string) => fmt(s, lang, { weekday: 'short' })

export const monthName = (s: string, lang: string) => fmt(s, lang, { month: 'long', year: 'numeric' })

export type Phase = 'upcoming' | 'running' | 'finished'
export function phase(start: string, end: string, on = today()): Phase {
  if (on < start) return 'upcoming'
  if (on > end) return 'finished'
  return 'running'
}
