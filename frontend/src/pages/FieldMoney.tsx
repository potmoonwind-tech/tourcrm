/**
 * The guide's money on the phone page: cash the office gave, what was spent (with a receipt
 * photo), extra pay for extra work. The office approves each item; nothing here changes money by
 * itself. Photos are shrunk on the phone before sending (smaller upload, no location data).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiError } from '../lib/api'
import { fmt, today } from '../lib/dates'
import { useI18n, type TKey } from '../lib/i18n'
import { cn, money } from '../lib/utils'
import { STATUS_TONE, type FieldEntry } from '../components/GuideReports'
import { TONE } from '../components/overlay'

interface CashLine { currency: string; given: string; spent: string; waiting: string; in_hand: string; extra_pay: string }
interface FieldMoney {
  can_report: boolean; currency: string; advances: { paid_on: string; amount: string; currency: string }[]
  entries: FieldEntry[]; cash: CashLine[]
}
const CATEGORIES = ['meal', 'ticket', 'transport', 'visa', 'other'] as const

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : res.statusText)
  return data as T
}

/** A phone photo shrunk to at most 1600 px as JPEG (drops EXIF, incl. location). */
async function shrink(file: File): Promise<Blob> {
  const img = await createImageBitmap(file).catch(() => null)
  if (!img) return file
  const k = Math.min(1, 1600 / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * k)
  canvas.height = Math.round(img.height * k)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise((ok) => canvas.toBlob((b) => ok(b ?? file), 'image/jpeg', 0.82))
}

export function MoneyTab({ token, days }: { token: string; days: { number: number; date: string }[] }) {
  const { t, lang } = useI18n()
  const qc = useQueryClient()
  const key = ['fieldMoney', token]
  const m = useQuery({ queryKey: key, queryFn: () => call<FieldMoney>(`/api/field/${token}/money`) })
  const [form, setForm] = useState<'expense' | 'extra' | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => call<FieldMoney>(`/api/field/${token}/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: (d) => qc.setQueryData(key, d),
  })
  if (!m.data) return <p className="p-6 text-center text-slate-500">…</p>
  const v = m.data
  return (
    <main className="space-y-3 p-3">
      {v.cash.map((c) => (
        <section key={c.currency} className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-500">{t('fieldInHand')}</span>
            <span className={cn('text-2xl font-bold tabular-nums', Number(c.in_hand) < 0 ? 'text-red-600' : 'text-slate-900')}>{money(Number(c.in_hand), c.currency)}</span>
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-slate-50 py-2"><dt className="text-slate-500">{t('fieldGiven')}</dt><dd className="font-semibold tabular-nums">{money(Number(c.given))}</dd></div>
            <div className="rounded-lg bg-slate-50 py-2"><dt className="text-slate-500">{t('fieldSpent')}</dt><dd className="font-semibold tabular-nums">{money(Number(c.spent))}</dd></div>
            <div className="rounded-lg bg-slate-50 py-2"><dt className="text-slate-500">{t('fieldWaiting')}</dt><dd className="font-semibold tabular-nums">{money(Number(c.waiting))}</dd></div>
          </dl>
          {Number(c.extra_pay) > 0 && <p className="mt-2 text-sm text-emerald-700">{t('fieldExtraOwed', { amount: money(Number(c.extra_pay), c.currency) })}</p>}
        </section>
      ))}
      {v.cash.length === 0 && <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500">{t('fieldNoMoneyYet')}</p>}

      {v.can_report && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setForm('expense')} className="flex items-center justify-center gap-2 rounded-xl bg-brand-600 py-3.5 font-semibold text-white active:bg-brand-700">
            <Camera size={18} />{t('fieldIPaid')}
          </button>
          <button type="button" onClick={() => setForm('extra')} className="flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white py-3.5 font-semibold text-slate-700 active:bg-slate-100">
            <Plus size={18} />{t('extraPay')}
          </button>
        </div>
      )}

      {v.entries.length > 0 && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {v.entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-3">
              {e.has_receipt
                ? <a href={`/api/field/${token}/expenses/${e.id}/receipt`} target="_blank" rel="noopener noreferrer" className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200">
                    <img src={`/api/field/${token}/expenses/${e.id}/receipt`} alt={t('receipt')} className="h-full w-full object-cover" loading="lazy" /></a>
                : <span className="h-12 w-12 shrink-0 rounded-lg bg-slate-50" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{e.kind === 'extra' ? `${t('extraPay')}: ` : ''}{e.description}</span>
                <span className="block text-xs text-slate-500">
                  {e.day ? `${t('day')} ${e.day} · ` : ''}{fmt(e.created_at.slice(0, 10), lang)}
                  {e.office_note && <span className="text-slate-700"> · “{e.office_note}”</span>}
                </span>
              </span>
              <span className="text-right">
                <span className="block font-semibold tabular-nums">{money(Number(e.amount), e.currency)}</span>
                <span className={cn('inline-block rounded px-1.5 py-0.5 text-[11px] font-medium', TONE[STATUS_TONE[e.status]])}>{t(`fieldStatus_${e.status}` as TKey)}</span>
              </span>
              {e.status === 'pending' && (
                <button type="button" aria-label={t('delete')} disabled={remove.isPending}
                  onClick={() => window.confirm(t('fieldDeleteAsk')) && remove.mutate(e.id)} className="rounded p-2 text-slate-400 active:bg-slate-100"><Trash2 size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      )}

      {v.advances.length > 0 && (
        <p className="px-1 text-xs text-slate-500">
          {t('fieldAdvances')}: {v.advances.map((a) => `${fmt(a.paid_on, lang)} ${money(Number(a.amount), a.currency)}`).join(' · ')}
        </p>
      )}

      {form && <ReportSheet token={token} kind={form} currency={v.currency} days={days} onClose={() => setForm(null)}
        onSaved={(d) => { qc.setQueryData(key, d); setForm(null) }} />}
    </main>
  )
}

function ReportSheet({ token, kind, currency, days, onClose, onSaved }: {
  token: string; kind: 'expense' | 'extra'; currency: string; days: { number: number; date: string }[]
  onClose: () => void; onSaved: (d: FieldMoney) => void
}) {
  const { t, lang } = useI18n()
  const todayNo = days.find((d) => d.date === today())?.number
  const [f, setF] = useState({ description: '', amount: '', currency, category: 'meal', day: todayNo ? String(todayNo) : '' })
  const [photo, setPhoto] = useState<File | null>(null)
  const preview = photo ? URL.createObjectURL(photo) : null
  const save = useMutation({
    mutationFn: async () => {
      const body = new FormData()
      body.append('kind', kind)
      Object.entries(f).forEach(([k, val]) => val && body.append(k, val))
      if (photo) body.append('photo', await shrink(photo), 'receipt.jpg')
      return call<FieldMoney>(`/api/field/${token}/expenses`, { method: 'POST', body })
    },
    onSuccess: onSaved,
  })
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-900/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}
        className="max-h-[92vh] w-full space-y-3 overflow-y-auto rounded-t-2xl bg-white p-4 pb-6">
        <div className="flex items-center">
          <h2 className="flex-1 text-lg font-semibold">{kind === 'expense' ? t('fieldIPaid') : t('extraPay')}</h2>
          <button type="button" onClick={onClose} aria-label={t('close')} className="rounded-lg p-2 text-slate-500"><X size={20} /></button>
        </div>
        {kind === 'extra' && <p className="text-sm text-slate-500">{t('extraPayHelp')}</p>}
        <input required autoFocus maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
          placeholder={kind === 'expense' ? t('fieldWhatPh') : t('fieldExtraPh')} className="h-12 w-full rounded-xl border border-slate-300 px-3 text-base" />
        <div className="flex gap-2">
          <input required type="number" inputMode="decimal" min="0.01" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })}
            placeholder={t('amount')} className="h-12 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-base tabular-nums" />
          <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} className="h-12 rounded-xl border border-slate-300 px-2 text-base">
            {[...new Set([currency, 'GEL', 'USD', 'EUR'])].map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        {kind === 'expense' && (
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button key={c} type="button" onClick={() => setF({ ...f, category: c })}
                className={cn('rounded-full px-3 py-1.5 text-sm font-medium', f.category === c ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600')}>
                {t(`cat_${c}` as TKey)}
              </button>
            ))}
          </div>
        )}
        <select value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} className="h-12 w-full rounded-xl border border-slate-300 px-3 text-base">
          <option value="">{t('fieldWhichDay')}</option>
          {days.map((d) => <option key={d.number} value={d.number}>{t('day')} {d.number} · {fmt(d.date, lang)}</option>)}
        </select>
        {kind === 'expense' && (
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-slate-300 p-3 text-sm text-slate-600">
            {preview ? <img src={preview} alt="" className="h-16 w-16 rounded-lg object-cover" /> : <Camera size={24} className="text-slate-400" />}
            <span className="flex-1">{photo ? t('fieldPhotoChange') : t('fieldPhotoAdd')}</span>
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
        <button disabled={save.isPending} className="h-12 w-full rounded-xl bg-brand-600 text-base font-semibold text-white disabled:opacity-60">
          {save.isPending ? '…' : t('fieldSend')}
        </button>
      </form>
    </div>
  )
}
