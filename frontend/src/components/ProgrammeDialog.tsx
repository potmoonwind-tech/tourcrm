/**
 * "Download programme": the day-by-day programme for clients and partners, from what is on screen (saved or
 * not), in English, Georgian or Chinese, as PDF (the print page), Word or Excel. Distances, driving times and
 * places are in it; prices and team details are not.
 */
import { Copy, Download, Eye, FileSpreadsheet, FileText, Link2, MessageCircle, Printer } from 'lucide-react'
import { useState } from 'react'
import type { DayFields } from '../lib/api'
import { useServiceList, useVendors, wsPath } from '../lib/data'
import { stepUsual, suggest, withEnds } from './DayProgramme'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Dialog, toast } from './overlay'
import { Button, ErrorText, Input, SegmentedControl } from './ui'

type Lang = 'en' | 'ka' | 'zh'
type Format = 'pdf' | 'docx' | 'xlsx'
const PARTS = ['distance', 'hotels', 'meals', 'activities', 'schedule', 'notes', 'phones'] as const
export const PROGRAMME_KEY = 'programmePrint'

export interface ProgrammeRequest {
  title: string; start_date: string | null; days: DayFields[]; lang: Lang
  include: Record<(typeof PARTS)[number], boolean>; translate: boolean
  only_days: number[] | null      // the days to put in the file; null = all
  people?: number | null
  tour_id?: string | null
}

export function ProgrammeDialog({ title, startDate, days, people, tourId, onClose }: {
  title: string; startDate?: string | null; days: DayFields[]; onClose: () => void
  people?: number | null           // the group: each dish's plates (portions)
  tourId?: string                  // a tour's: its staff table, tour leaders and each day's guide and driver
}) {
  const ws = useWorkspace()!
  const { t, lang: appLang } = useI18n()
  const [lang, setLang] = useState<Lang>(appLang === 'ka' ? 'ka' : 'en')
  const [format, setFormat] = useState<Format>('pdf')
  const [include, setInclude] = useState<ProgrammeRequest['include']>({ distance: true, hotels: true, meals: true, activities: true, schedule: true, notes: true, phones: true })
  const [translate, setTranslate] = useState(true)
  // Which days go in the file (all at first); the others still count for the route and last night's hotel.
  const [skip, setSkip] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [shared, setShared] = useState('')      // the link anyone can open, once made
  // A day without its own programme gets the suggested one - what the day plan shows (times, sights,
  // meals, the hotel), so the file has the same programme and the drives between its destinations.
  const services = useServiceList()
  const factor = ws.drive_factor ?? 1.25
  const vendors = useVendors()
  const byId = new Map((vendors.data ?? []).map((v) => [v.id, v]))
  const shown = days.map((d, i) => {
    const items = d.schedule?.length ? d.schedule : suggest(d, i, i === days.length - 1, services.data ?? [], factor)
    // Every step with its end time (its own length, the activity's, or the usual one), like the day plan.
    return { ...d, schedule: withEnds(items, (x) => stepUsual(x, d, byId, services.data ?? [])) }
  })
  const body: ProgrammeRequest = {
    title, start_date: startDate ?? null, days: shown, lang, include, translate, people: people || null, tour_id: tourId ?? null,
    only_days: skip.size ? days.map((_, i) => i + 1).filter((n) => !skip.has(n)) : null,
  }

  const warn = (w: string | null) => {
    if (w?.includes('no_ai_key')) toast('programmeNoAiKey', 'error')
    else if (w?.includes('ai_failed')) toast('programmeAiFailed', 'error')
  }
  // A link anyone can open: the same programme (times, distances, a map for each place) on a phone or computer.
  const share = async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api${wsPath(ws.id, '/programme/share')}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(res.statusText || String(res.status))
      setShared(`${window.location.origin}/p/${((await res.json()) as { token: string }).token}`)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  // See the page the share link gives, before making it (a new tab; nothing is shared).
  const preview = () => {
    const key = Math.random().toString(36).slice(2)
    try { sessionStorage.setItem(`${PROGRAMME_KEY}:${key}`, JSON.stringify(body)) } catch { /* private mode */ }
    try { localStorage.setItem(`${PROGRAMME_KEY}:${key}`, JSON.stringify(body)) } catch { /* private mode */ }
    window.open(`/w/${ws.id}/preview/programme?k=${key}`, '_blank', 'noopener')
  }
  const download = async () => {
    setError(null)
    if (format === 'pdf') {
      // The print page builds it from the same request (kept for that tab only) and opens the print dialog.
      const key = Math.random().toString(36).slice(2)
      try { sessionStorage.setItem(`${PROGRAMME_KEY}:${key}`, JSON.stringify(body)) } catch { /* private mode */ }
      try { localStorage.setItem(`${PROGRAMME_KEY}:${key}`, JSON.stringify(body)) } catch { /* private mode */ }
      window.open(`/w/${ws.id}/print/programme?k=${key}`, '_blank', 'noopener')
      onClose()
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api${wsPath(ws.id, `/programme.${format}`)}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(res.statusText || String(res.status))
      warn(res.headers.get('X-Programme-Warnings'))
      const name = decodeURIComponent((res.headers.get('Content-Disposition') ?? '').split("''")[1] ?? `programme.${format}`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('programmeDownload')} onClose={onClose}
      footer={<div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        <Button variant="secondary" onClick={preview} disabled={!days.length || services.isLoading}><Eye size={16} />{t('preview')}</Button>
        <Button variant="secondary" onClick={share} disabled={busy || !days.length || services.isLoading}><Link2 size={16} />{t('shareLink')}</Button>
        <Button onClick={download} disabled={busy || !days.length || services.isLoading}>
          {format === 'pdf' ? <Printer size={16} /> : <Download size={16} />}{busy ? t('programmeMaking') : t('download')}
        </Button>
      </div>}>
      <div className="space-y-5">
        <p className="text-sm text-slate-600">{t('programmeHelp')}</p>
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">{t('language')}</p>
          <SegmentedControl label={t('language')} value={lang} onChange={setLang}
            options={[['en', 'English'], ['ka', 'ქართული'], ['zh', '中文']]} />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">{t('fileFormat')}</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('fileFormat')}>
            {([['pdf', 'PDF', <Printer size={18} key="p" />], ['docx', 'Word', <FileText size={18} key="w" />], ['xlsx', 'Excel', <FileSpreadsheet size={18} key="x" />]] as const).map(([id, label, icon]) => (
              <button key={id} type="button" role="radio" aria-checked={format === id} onClick={() => setFormat(id)}
                className={cn('flex h-16 flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium transition active:scale-[0.98]',
                  format === id ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}>
                {icon}{label}
              </button>
            ))}
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('programmeInclude')}</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {PARTS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={include[k]} onChange={(e) => setInclude({ ...include, [k]: e.target.checked })} />
                {t(`programmePart_${k}` as TKey)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('programmeDays')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {days.map((d, i) => {
              const n = i + 1
              const on = !skip.has(n)
              return (
                <button key={n} type="button" aria-pressed={on}
                  onClick={() => { const next = new Set(skip); if (on) next.add(n); else next.delete(n); if (next.size < days.length) setSkip(next) }}
                  className={cn('inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition active:scale-[0.97]',
                    on ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-400 line-through')}>
                  <b className="font-semibold">{n}</b>{d.city && <span className="max-w-28 truncate">{d.city}</span>}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-xs text-slate-500">{t('programmeDaysHelp')}</p>
        </fieldset>
        <label className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
          <span>{t('programmeTranslate')}<span className="block text-xs text-slate-500">{t('programmeTranslateHelp')}</span></span>
        </label>
        {shared && (
          <div ref={(el) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })} className="space-y-2 rounded-lg border border-brand-200 bg-brand-50/50 p-3">
            <p className="text-sm text-slate-700">{t('shareLinkHelp')}</p>
            <div className="flex gap-2">
              <Input readOnly value={shared} onFocus={(e) => e.target.select()} className="font-mono text-xs" aria-label={t('shareLink')} />
              <Button type="button" variant="secondary" onClick={() => void navigator.clipboard?.writeText(shared).then(() => toast('copied'))}><Copy size={15} />{t('copy')}</Button>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <a href={`https://wa.me/?text=${encodeURIComponent(`${title}: ${shared}`)}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white hover:bg-emerald-700"><MessageCircle size={15} />WhatsApp</a>
              <a href={shared} target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-2 py-2 font-medium text-brand-700 hover:underline">{t('phoneLinkPreview')}</a>
            </div>
          </div>
        )}
        <ErrorText error={error} />
      </div>
    </Dialog>
  )
}
