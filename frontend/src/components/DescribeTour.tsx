/**
 * A new tour in a few words: "Chinese group of 20 + 1 leader, from 3 November, Tbilisi 2 nights, Kazbegi,
 * Kutaisi, Batumi 2". The assistant reads it into a draft - dates, people, client, towns and nights, a hotel
 * from the catalogue for each night - shown before anything is saved. "Create tour" makes it and opens it on the
 * whole-tour view, where what's left is listed (and "Fill the gaps" can place the rest).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BedDouble, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Tour } from '../lib/api'
import { wsPath } from '../lib/data'
import { addDays, dayDate } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useDateStyle, useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { blankDay } from './ItineraryBuilder'
import { roomsText, suggestRooms } from './RoomsPicker'
import { Button, ErrorText, Input } from './ui'

interface Draft {
  start_date: string | null; days: { city: string; hotel_id: string | null; hotel: string }[]
  pax: number | null; leaders: number | null; client_id: string | null; client_name: string; notes: string
}

export function DescribeTour({ onForm }: { onForm: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const style = useDateStyle()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [d, setD] = useState<Draft | null>(null)
  const read = useMutation({
    mutationFn: () => api<Draft>(wsPath(ws.id, '/tours/draft'), { method: 'POST', body: { text } }),
    onSuccess: (r) => setD(r),
  })
  const create = useMutation({
    mutationFn: async () => {
      const draft = d!
      let clientId = draft.client_id
      if (!clientId && draft.client_name.trim()) {
        clientId = (await api<{ id: string }>(wsPath(ws.id, '/clients'), { method: 'POST', body: { name: draft.client_name.trim() } })).id
      }
      const pax = draft.pax ?? 0
      const tour = await api<Tour>(wsPath(ws.id, '/tours'), {
        method: 'POST',
        body: { start_date: draft.start_date, end_date: addDays(draft.start_date!, draft.days.length - 1), client_id: clientId,
          pax, leaders: draft.leaders ?? 0, rooms: roomsText(suggestRooms(pax)), status: 'confirmed', notes: draft.notes || undefined },
      })
      // The towns and the hotels go into its days.
      await api(wsPath(ws.id, `/tours/${tour.id}/itinerary`), {
        method: 'PUT', body: { days: draft.days.map((x) => ({ ...blankDay(x.city), hotel_id: x.hotel_id })) },
      })
      return tour
    },
    onSuccess: (tour) => {
      try { localStorage.setItem('itineraryView', 'check') } catch { /* private window */ }   // opens on the whole tour
      void qc.invalidateQueries({ queryKey: ['tours', ws.id] })
      navigate(`/w/${ws.id}/tours/${tour.id}`)
    },
  })

  if (!d) {
    return (
      <div className="space-y-3">
        <div>
          <p className="flex items-center gap-1.5 font-medium text-slate-900"><Sparkles size={16} className="text-brand-600" aria-hidden />{t('describeTitle')}</p>
          <p className="mt-0.5 text-sm text-slate-600">{t('describeHelp')}</p>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus maxLength={4000}
          placeholder={t('describeExample')} aria-label={t('describeTitle')}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim().length > 2) read.mutate() }}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        <ErrorText error={read.error} />
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={onForm} className="text-sm text-slate-500 hover:text-brand-700 hover:underline">{t('describeUseForm')}</button>
          <Button type="button" disabled={text.trim().length < 3 || read.isPending} onClick={() => read.mutate()}>
            {read.isPending ? t('describeReading') : t('describeMake')}
          </Button>
        </div>
      </div>
    )
  }

  // The draft: what was understood, the days with their hotels; a few fields to correct before creating.
  const set = (p: Partial<Draft>) => setD({ ...d, ...p })
  const missingHotels = d.days.slice(0, -1).filter((x) => !x.hotel_id).length
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t('draftHelp')}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-xs text-slate-500">{t('draftStart')}
          <Input type="date" value={d.start_date ?? ''} onChange={(e) => set({ start_date: e.target.value || null })}
            className={cn('mt-0.5 h-9', !d.start_date && 'border-amber-400')} />
        </label>
        <label className="text-xs text-slate-500">{t('draftPax')}
          <Input type="number" min={0} value={d.pax ?? ''} onChange={(e) => set({ pax: e.target.value === '' ? null : Number(e.target.value) })} className="mt-0.5 h-9" />
        </label>
        <label className="text-xs text-slate-500">{t('draftLeaders')}
          <Input type="number" min={0} value={d.leaders ?? ''} onChange={(e) => set({ leaders: e.target.value === '' ? null : Number(e.target.value) })} className="mt-0.5 h-9" />
        </label>
        <label className="text-xs text-slate-500">{t('client')}
          <Input value={d.client_name} onChange={(e) => set({ client_name: e.target.value, client_id: null })} className="mt-0.5 h-9" />
          <span className="mt-0.5 block text-[11px]">{d.client_id ? <span className="text-emerald-700">{t('draftClientKnown')}</span> : d.client_name ? <span className="text-slate-500">{t('draftClientNew')}</span> : null}</span>
        </label>
      </div>
      {d.days.length === 0 ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle size={14} aria-hidden />{t('draftNoTowns')}</p>
      ) : (
        <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {d.days.map((x, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-1.5">
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-700 px-1 text-[11px] font-bold text-white">{i + 1}</span>
              <span className="w-28 shrink-0 text-xs tabular-nums text-slate-500">{d.start_date ? dayDate(addDays(d.start_date, i), lang, style) : ''}</span>
              <span className="w-28 shrink-0 truncate font-medium text-slate-900">{x.city}</span>
              <span className="flex min-w-0 items-center gap-1 text-xs">
                {i === d.days.length - 1 ? <span className="text-slate-400">{t('departureDay')}</span>
                  : x.hotel_id ? <><BedDouble size={13} className="shrink-0 text-slate-400" aria-hidden /><span className="truncate text-slate-700">{x.hotel}</span></>
                  : <span className="text-amber-700">{t('draftNoHotel')}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {missingHotels > 0 && <p className="text-xs text-slate-500">{t('draftLater')}</p>}
      <ErrorText error={create.error} />
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setD(null)} className="text-sm text-slate-500 hover:text-brand-700 hover:underline">{t('draftChangeText')}</button>
        <Button type="button" disabled={!d.start_date || d.days.length === 0 || create.isPending} onClick={() => create.mutate()}>{t('draftCreate')}</Button>
      </div>
    </div>
  )
}
