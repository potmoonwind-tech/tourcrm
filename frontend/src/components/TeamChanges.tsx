/**
 * What changed on a tour, and whether its guides and drivers have seen it. Changes are recorded by
 * the server (app/changes.py); a person "sees" them by tapping Got it on their phone page. Until a
 * message service is set up, the office sends the changes on WhatsApp in one tap.
 */
import { useQuery } from '@tanstack/react-query'
import { Check, MessageCircle } from 'lucide-react'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { Label } from './overlay'
import { Card } from './ui'

interface Change { id: string; day: number | null; kind: string; text: string; at: string }
interface Seen { staff_id: string; person: string; role: string; phone: string; has_link: boolean; acked_at: string | null; unseen: number; unseen_texts: string[] }

export function useTourChanges(tourId: string) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['changes', ws.id, tourId], queryFn: () => api<{ changes: Change[]; team: Seen[] }>(wsPath(ws.id, `/tours/${tourId}/changes`)) })
}

export function TeamChanges({ tourId, code }: { tourId: string; code: string }) {
  const { t, lang } = useI18n()
  const q = useTourChanges(tourId)
  if (!q.data || (!q.data.changes.length && !q.data.team.length)) return null
  const { changes, team } = q.data
  const when = (s: string) => new Date(s).toLocaleString(lang === 'ka' ? 'ka-GE' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  // The message: the changes on this person's days that they haven't acknowledged.
  const message = (s: Seen) => {
    const mine = s.unseen_texts.map((x) => `• ${x}`)
    return `${code} — ${t('changesMsgIntro')}\n${mine.join('\n')}\n${t('changesMsgOutro')}`
  }
  return (
    <Card>
      <div className="border-b border-slate-100 px-5 py-3">
        <h3 className="text-sm font-semibold">{t('changesTitle')}</h3>
        <p className="text-xs text-slate-500">{t('changesHelp')}</p>
      </div>
      {team.length > 0 && (
        <ul className="divide-y divide-slate-100 border-b border-slate-100">
          {team.map((s) => (
            <li key={s.staff_id} className="flex flex-wrap items-center gap-3 px-5 py-2 text-sm">
              <span className="min-w-40 flex-1"><b>{s.person}</b> <span className="text-xs text-slate-500">{t(`staffRole_${s.role}` as TKey)}</span></span>
              {!s.has_link ? <span className="text-xs text-slate-400">{t('changesNoLink')}</span>
                : s.unseen ? <Label tone="orange" wide={false}>{t('changesUnseen', { n: s.unseen })}</Label>
                  : <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check size={13} />{s.acked_at ? t('changesSeenAt', { at: when(s.acked_at) }) : t('changesNothingNew')}</span>}
              {s.unseen > 0 && s.phone && (
                <a href={`https://wa.me/${s.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(message(s))}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">
                  <MessageCircle size={13} />WhatsApp
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {changes.length === 0 ? <p className="px-5 py-3 text-sm text-slate-500">{t('changesNone')}</p> : (
        <ul className="max-h-64 divide-y divide-slate-50 overflow-y-auto">
          {changes.slice(0, 50).map((c) => (
            <li key={c.id} className="flex gap-3 px-5 py-1.5 text-sm">
              <span className="w-32 shrink-0 text-xs tabular-nums text-slate-400">{when(c.at)}</span>
              <span className="min-w-0 flex-1">{c.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
