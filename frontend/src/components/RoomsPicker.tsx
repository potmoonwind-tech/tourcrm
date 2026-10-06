import { Check, Minus, Plus, Wand2 } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { IconButton } from './ui'

/**
 * The group's rooms as numbers per type — kept as the text the server reads ("10 DBL + 2 SGL"), so older
 * tours with typed rooms still work. Shows whether the beds fit the people, and fills itself from the group
 * size in one click (20 people → 10 double).
 */
const TYPES = ['DBL', 'TWN', 'SGL', 'TRP'] as const
type RoomType = (typeof TYPES)[number] | 'QUAD'
const BEDS: Record<RoomType, number> = { DBL: 2, TWN: 2, SGL: 1, TRP: 3, QUAD: 4 }
// The same words the server understands (finance._ROOM_WORDS).
const WORDS: [string, RoomType][] = [
  ['sngl', 'SGL'], ['sgl', 'SGL'], ['single', 'SGL'], ['ერთადგ', 'SGL'], ['одномест', 'SGL'],
  ['dbl', 'DBL'], ['double', 'DBL'], ['ორადგ', 'DBL'], ['двухмест', 'DBL'], ['дабл', 'DBL'],
  ['twn', 'TWN'], ['twin', 'TWN'], ['твин', 'TWN'],
  ['trp', 'TRP'], ['tpl', 'TRP'], ['triple', 'TRP'], ['სამადგ', 'TRP'], ['трехмест', 'TRP'], ['трёхмест', 'TRP'],
  ['quad', 'QUAD'], ['ოთხადგ', 'QUAD'],
]

export type RoomCounts = Partial<Record<RoomType, number>>

export function parseRooms(text: string): RoomCounts {
  const out: RoomCounts = {}
  for (const m of text.matchAll(/(\d+)\s*-?\s*([\p{L}]+)/gu)) {
    const w = m[2].toLowerCase()
    const kind = WORDS.find(([p]) => w.startsWith(p))?.[1]
    if (kind) out[kind] = (out[kind] ?? 0) + Number(m[1])
  }
  return out
}

export const roomsText = (c: RoomCounts) =>
  ([...TYPES, 'QUAD'] as RoomType[]).filter((k) => (c[k] ?? 0) > 0).map((k) => `${c[k]} ${k}`).join(' + ')

export const bedsOf = (c: RoomCounts) => (Object.entries(c) as [RoomType, number][]).reduce((s, [k, n]) => s + BEDS[k] * n, 0)

/** The usual split for a group: doubles, and a single for the odd one out. */
export const suggestRooms = (pax: number): RoomCounts => (pax > 0 ? { DBL: Math.floor(pax / 2), ...(pax % 2 ? { SGL: 1 } : {}) } : {})

export function RoomsPicker({ value, onChange, pax, disabled, id }: {
  value: string; onChange: (text: string) => void; pax?: number; disabled?: boolean; id?: string
}) {
  const { t } = useI18n()
  const counts = parseRooms(value)
  const readable = roomsText(counts)
  // Typed earlier in words the system can't read ("rooms TBD"): kept, shown, replaced once numbers are set.
  const unread = value.trim() && !readable ? value.trim() : ''
  const beds = bedsOf(counts)
  const set = (k: RoomType, n: number) => onChange(roomsText({ ...counts, [k]: Math.max(0, Math.min(200, n)) }))
  return (
    <div className="@container space-y-2" id={id}>
      <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
        {TYPES.map((k) => {
          const n = counts[k] ?? 0
          const name = t(`roomType_${k}`)
          return (
            <div key={k} className={cn('rounded-lg border px-2 py-1.5', n ? 'border-brand-200 bg-brand-50/40' : 'border-slate-200')}>
              <span className="block text-xs font-medium text-slate-600">{name}</span>
              <span className="mt-0.5 flex items-center gap-0.5" role="group" aria-label={name}>
                <IconButton size="sm" label={`${t('fewer')} · ${name}`} disabled={disabled || n <= 0} onClick={() => set(k, n - 1)}><Minus size={14} /></IconButton>
                <input type="number" inputMode="numeric" min={0} max={200} value={n || ''} placeholder="0" disabled={disabled}
                  aria-label={name} onChange={(e) => set(k, Number(e.target.value) || 0)}
                  className="h-8 w-12 shrink-0 rounded-md border border-slate-300 bg-white text-center text-sm font-semibold tabular-nums focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                <IconButton size="sm" label={`${t('more')} · ${name}`} disabled={disabled} onClick={() => set(k, n + 1)}><Plus size={14} /></IconButton>
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
        {beds > 0 && (pax ?? 0) > 0 && (
          beds === pax
            ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={14} aria-hidden />{t('roomsFit', { beds, pax: pax! })}</span>
            : <span className="text-amber-800">{t(beds < pax! ? 'roomsTooFew' : 'roomsTooMany', { beds, pax: pax! })}</span>
        )}
        {beds > 0 && !pax && <span className="text-slate-500">{t('roomsBeds', { beds })}</span>}
        {unread && <span className="text-amber-800">{t('roomsUnread', { text: unread })}</span>}
        {!disabled && (pax ?? 0) > 0 && beds !== pax && (
          <button type="button" onClick={() => onChange(roomsText(suggestRooms(pax!)))}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-medium text-brand-700 hover:bg-brand-50">
            <Wand2 size={13} aria-hidden />{t('roomsSuggest', { rooms: roomsText(suggestRooms(pax!)) })}
          </button>
        )}
      </div>
    </div>
  )
}
