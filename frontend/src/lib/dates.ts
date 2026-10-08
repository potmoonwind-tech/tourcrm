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


/** 45 → "45 min", 90 → "1 h 30 min", 120 → "2 h" (in the app's words). */
export function lengthLabel(min: number, t: (k: 'durMin' | 'durH' | 'durHM', v?: Record<string, number>) => string): string {
  const h = Math.floor(min / 60), m = min % 60
  return h === 0 ? t('durMin', { n: m }) : m === 0 ? t('durH', { h }) : t('durHM', { h, m })
}


/** The day (ISO) a traveller has a birthday during the tour, else null (29 Feb: the 28th in other years). */
export function birthdayOn(birth: string | null | undefined, start: string, end: string): string | null {
  if (!birth) return null
  const [, m, dd] = birth.split('-')
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
    let d = `${y}-${m}-${dd}`
    if (m === '02' && dd === '29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) d = `${y}-02-28`
    if (d >= start && d <= end) return d
  }
  return null
}
