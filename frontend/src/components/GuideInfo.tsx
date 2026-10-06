/**
 * Guide / driver details on their supplier record: the languages they work in, and the dates
 * they can't work (vacation, another job). Assigning them on those dates raises a tour alert.
 */
import { CalendarX, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { Away, Vendor } from '../lib/api'
import { fmt, today } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { Input } from './ui'

const COMMON = ['English', 'Russian', 'German', 'French', 'Spanish', 'Italian', 'Hebrew', 'Chinese', 'Polish', 'Georgian']

export function GuideInfo({ languages, away, disabled, onChange }: {
  languages: string[]; away: Away[]; disabled?: boolean
  onChange: (patch: { languages?: string[]; unavailable?: Away[] }) => void
}) {
  const { t } = useI18n()
  const [typed, setTyped] = useState('')
  const addLang = (x: string) => {
    const clean = x.trim()
    if (clean && !languages.some((l) => l.toLowerCase() === clean.toLowerCase())) onChange({ languages: [...languages, clean] })
    setTyped('')
  }
  const setAway = (i: number, patch: Partial<Away>) => onChange({ unavailable: away.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  const past = (a: Away) => !!a.end && a.end < today()
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">{t('languages')}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {languages.map((l) => (
            <span key={l} className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-sm ring-1 ring-slate-200">
              {l}
              {!disabled && <button type="button" aria-label={`${t('delete')} ${l}`} onClick={() => onChange({ languages: languages.filter((x) => x !== l) })}
                className="text-slate-400 hover:text-red-600"><X size={13} /></button>}
            </span>
          ))}
          {!disabled && (
            <Input value={typed} list="guide-langs" placeholder={t('addLanguagePh')} maxLength={30} className="h-8 w-40 text-sm"
              onChange={(e) => setTyped(e.target.value)} onBlur={() => typed && addLang(typed)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLang(typed) } }} />
          )}
          <datalist id="guide-langs">{COMMON.filter((c) => !languages.includes(c)).map((c) => <option key={c} value={c} />)}</datalist>
        </div>
      </div>
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700"><CalendarX size={15} />{t('notAvailable')}</p>
        {away.length === 0 && <p className="text-xs text-slate-500">{t('notAvailableNone')}</p>}
        <ul className="space-y-1.5">
          {away.map((a, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Input type="date" required value={a.start} disabled={disabled} onChange={(e) => setAway(i, { start: e.target.value })} className="h-8 w-36 text-sm" aria-label={t('from')} />
              <span className="text-slate-400">→</span>
              <Input type="date" required value={a.end} min={a.start} disabled={disabled} onChange={(e) => setAway(i, { end: e.target.value })} className="h-8 w-36 text-sm" aria-label={t('to')} />
              <Input value={a.note} disabled={disabled} maxLength={200} placeholder={t('notAvailablePh')} onChange={(e) => setAway(i, { note: e.target.value })}
                className="h-8 min-w-32 flex-1 text-sm" aria-label={t('notes')} />
              {past(a) && <span className="text-xs text-slate-400">{t('pastPeriod')}</span>}
              {!disabled && <button type="button" aria-label={t('delete')} onClick={() => onChange({ unavailable: away.filter((_, j) => j !== i) })}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 size={14} /></button>}
            </li>
          ))}
        </ul>
        {!disabled && (
          <button type="button" onClick={() => onChange({ unavailable: [...away, { start: today(), end: today(), note: '' }] })}
            className="mt-2 flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"><Plus size={14} />{t('addNotAvailable')}</button>
        )}
      </div>
    </div>
  )
}

/** The away period that overlaps [from, to], if any (ISO dates). */
export function awayDuring(v: Vendor, from: string, to: string): Away | undefined {
  return (v.unavailable ?? []).find((a) => a.start <= to && from <= a.end)
}

export function awayText(a: Away, lang: 'en' | 'ka') {
  return `${fmt(a.start, lang)} – ${fmt(a.end, lang)}${a.note ? ` (${a.note})` : ''}`
}
