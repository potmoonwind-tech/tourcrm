/**
 * Change the hotel on one tour (an overbooked series hotel, or the client asking): choose the
 * nights and the new hotel, see what it costs, decide who pays the difference, then send the
 * partner the ready message. Server: app/routers/hotel_change.py.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Mail, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Tour } from '../lib/api'
import { useClients, useVendors, wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn, money } from '../lib/utils'
import { Dialog, toast } from './overlay'
import { VendorSelect } from './tour'
import { Button, ErrorText, Field, Input } from './ui'

interface Result {
  nights: { day: number; date: string; old: number | null; new: number | null }[]
  currency: string; old_cost: number | null; new_cost: number | null; difference: number | null; per_person: number | null
  missing_prices: string[]; client_currency: string; client_amount: number; message: string
  incident_id: string | null; invoice_id: string | null; approval_needed: boolean; changes: string[]
}
type Who = 'agency' | 'client' | 'hotel'

export function ChangeHotel({ tour, hotelId, hotelName, onClose }: { tour: Tour; hotelId: string; hotelName: string; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const vendors = useVendors()
  const clients = useClients()
  const last = tour.days.length
  const nights = tour.days.filter((d) => d.hotel?.id === hotelId && d.day_number < last)
  const [picked, setPicked] = useState<number[]>(nights.map((d) => d.day_number))
  const [to, setTo] = useState<string | null>(null)
  const [reason, setReason] = useState<'overbooked' | 'client_request' | 'other'>('overbooked')
  const [who, setWho] = useState<Who>('agency')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const url = wsPath(ws.id, `/tours/${tour.id}/change-hotel`)
  const body = (preview: boolean) => ({
    from_hotel_id: hotelId, to_hotel_id: to, days: picked, reason, who_pays: who, note, preview,
    ...(who === 'client' && amount !== '' ? { client_amount: amount } : {}),
  })
  const preview = useMutation({ mutationFn: () => api<Result>(url, { method: 'POST', body: body(true) }), meta: { silent: true } })
  const confirm = useMutation({
    mutationFn: () => api<Result>(url, { method: 'POST', body: body(false) }),
    onSuccess: () => {
      for (const k of ['tour', 'bookings', 'costs', 'changes', 'alerts', 'incidents', 'invoices', 'tasks']) qc.invalidateQueries({ queryKey: [k] })
      qc.invalidateQueries({ queryKey: ['tours', ws.id] })
    },
  })
  // Preview again whenever the choice changes.
  useEffect(() => { if (to && picked.length) preview.mutate() }, [to, picked.join(','), who, amount, reason]) // eslint-disable-line react-hooks/exhaustive-deps
  const p = confirm.data ?? preview.data
  const client = clients.data?.find((c) => c.id === tour.client_id)
  const done = confirm.data

  return (
    <Dialog wide title={t('changeHotelTitle', { hotel: hotelName, code: tour.code })} onClose={onClose}>
      {done ? (
        <div className="space-y-4 text-sm">
          <p className="font-medium text-emerald-800">{t('changeHotelDone')}</p>
          <ul className="list-inside list-disc text-slate-600">{done.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          {done.approval_needed && <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">{t('changeHotelApproval')}</p>}
          <div>
            <p className="mb-1 font-medium">{t('changeHotelMessage')}</p>
            <p className="whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2">{done.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(done.message).then(() => toast('copied'))}><Copy size={14} />{t('copy')}</Button>
              {client?.phone && <a href={`https://wa.me/${client.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(done.message)}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white"><MessageCircle size={14} />WhatsApp</a>}
              {client?.email && <a href={`mailto:${client.email}?subject=${encodeURIComponent(`${tour.code}: ${t('changeHotelSubject')}`)}&body=${encodeURIComponent(done.message)}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700"><Mail size={14} />{t('email')}</a>}
            </div>
          </div>
          <p className="text-slate-600">{t('changeHotelNext')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            {done.invoice_id && <Link to={`/w/${ws.id}/finance?tab=invoices&open=${done.invoice_id}`} className="text-sm font-medium text-brand-700 hover:underline">{t('changeHotelInvoice')}</Link>}
            <Button onClick={onClose}>{t('done')}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('changeHotelNights')}</legend>
            <div className="flex flex-wrap gap-2">
              {nights.map((d) => (
                <label key={d.day_number} className={cn('flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3', picked.includes(d.day_number) ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:border-slate-500')}>
                  <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={picked.includes(d.day_number)}
                    onChange={() => setPicked(picked.includes(d.day_number) ? picked.filter((x) => x !== d.day_number) : [...picked, d.day_number].sort((a, b) => a - b))} />
                  {t('day')} {d.day_number} · {fmt(d.date, lang)}{d.city && ` · ${d.city}`}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label={t('changeHotelNew')}>
            <VendorSelect vendors={(vendors.data ?? []).filter((v) => v.id !== hotelId)} types={['hotel']} value={to} onChange={setTo}
              cities={[nights[0]?.city ?? '']} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('changeHotelWhy')}</legend>
              <div className="space-y-1.5">
                {(['overbooked', 'client_request', 'other'] as const).map((r) => (
                  <label key={r} className={cn('flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-3', reason === r ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:border-slate-500')}>
                    <input type="radio" name="why" className="h-4 w-4 accent-brand-600" checked={reason === r} onChange={() => setReason(r)} />{t(`chReason_${r}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700">{t('changeHotelWho')}</legend>
              <div className="space-y-1.5">
                {(['agency', 'client', 'hotel'] as const).map((w) => (
                  <label key={w} className={cn('flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2', who === w ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:border-slate-500')}>
                    <input type="radio" name="who-pays" className="mt-1 h-4 w-4 accent-brand-600" checked={who === w} onChange={() => setWho(w)} />
                    <span><span className="block font-medium text-slate-800">{t(`chWho_${w}`)}</span>
                      <span className="block text-xs text-slate-600">{t(`chWhoHelp_${w}`)}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          {p && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><p className="text-xs text-slate-500">{hotelName}</p><p className="font-semibold tabular-nums">{p.old_cost === null ? '—' : money(p.old_cost, p.currency)}</p></div>
                <div><p className="text-xs text-slate-500">{vendors.data?.find((v) => v.id === to)?.name}</p><p className="font-semibold tabular-nums">{p.new_cost === null ? '—' : money(p.new_cost, p.currency)}</p></div>
                <div><p className="text-xs text-slate-500">{t('changeHotelDiff')}</p>
                  {p.difference === null ? <p className="font-bold text-slate-400">—</p>
                    : <p className={cn('font-bold tabular-nums', p.difference > 0 ? 'text-red-600' : 'text-emerald-700')}>{p.difference > 0 ? '+' : ''}{money(p.difference, p.currency)}</p>}
                  {p.per_person !== null && <p className="text-xs text-slate-500">{p.per_person > 0 ? '+' : ''}{money(p.per_person, p.currency)} {t('perPersonShort')}</p>}
                </div>
              </div>
              {p.missing_prices.length > 0 && (
                <div className="mt-2 text-xs text-amber-800">
                  <p className="font-medium">{t('changeHotelNoPrice')}</p>
                  <ul className="list-inside list-disc">{p.missing_prices.map((m) => <li key={m}>{m}</li>)}</ul>
                </div>
              )}
              {who === 'client' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span>{t('changeHotelCharge')}</span>
                  <Input type="number" min={0} step="0.01" className="h-8 w-32 text-right" value={amount === '' ? String(p.client_amount) : amount} onChange={(e) => setAmount(e.target.value)} />
                  <span>{p.client_currency}</span>
                </div>
              )}
              <p className="mt-3 whitespace-pre-wrap text-xs text-slate-600"><b>{t('changeHotelMessage')}:</b> {p.message}</p>
            </div>
          )}
          <Field label={t('notes')}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
          <ErrorText error={preview.error || confirm.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
            <Button disabled={!to || !picked.length || confirm.isPending || !p} onClick={() => confirm.mutate()}>{t('changeHotelConfirm')}</Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
