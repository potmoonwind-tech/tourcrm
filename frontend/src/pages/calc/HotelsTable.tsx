/**
 * The calculation's nights as one table: where the group sleeps and what a room costs.
 * One row per night - drag it by its handle (or Space + arrow keys) to change the order; the hotel is
 * one field (from the catalogue, or a name typed in); where the driver and guide sleep is a short line
 * that opens the night's panel, which also has the season prices.
 */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { VendorSelect } from '../../components/tour'
import { Button, Card, IconButton, Input, Select } from '../../components/ui'
import type { QuoteDoc, QuoteNight, StaffStay, Vendor } from '../../lib/api'
import { useVendors } from '../../lib/data'
import { useI18n, type TKey } from '../../lib/i18n'
import { cn, money } from '../../lib/utils'
import { CURRENCIES } from '../Onboarding'
import { NightDrawer, peopleOf } from './BuildTab'
import { newId } from './ItemsTab'
import { useRemove, type EditFn } from './undo'

type Edit = EditFn<QuoteDoc>
type PriceKey = 'price_dbl' | 'price_sgl' | 'price_trp' | 'price_quad'
const STAFF_STAYS: StaffStay[] = ['none', 'same', 'own', 'allowance', 'free']

export function HotelsTable({ doc, edit }: { doc: QuoteDoc; edit: Edit }) {
  const { t } = useI18n()
  const vendors = useVendors()
  const hotels = (vendors.data ?? []).filter((v) => v.type === 'hotel')
  const remove = useRemove(edit)
  const [open, setOpen] = useState<number | null>(null)
  // Triple and quad rooms: a column each, there when a night has a price for it or when added.
  const [added, setAdded] = useState<{ trp?: boolean; quad?: boolean }>({})
  const hasTrp = doc.nights.some((n) => n.price_trp != null), hasQuad = doc.nights.some((n) => n.price_quad != null)
  const showTrp = hasTrp || !!added.trp, showQuad = hasQuad || !!added.quad
  // The engine gives a triple (quad) price only when every priced night has one: say which nights lack it.
  const lacking = (k: 'price_trp' | 'price_quad') =>
    doc.nights.map((n, i) => (n.price_dbl != null && n[k] == null ? i + 1 : 0)).filter(Boolean)
  const trpGaps = hasTrp ? lacking('price_trp') : [], quadGaps = hasQuad ? lacking('price_quad') : []
  const staff = peopleOf(doc).filter((p) => p.role === 'staff').reduce((s, p) => s + (p.count ?? 0), 0)
  const set = (i: number, patch: Partial<QuoteNight>) => edit((d) => { Object.assign(d.nights[i], patch) })
  const ids = doc.nights.map((n, i) => n.id || `night-${i}`)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const onDragEnd = (e: DragEndEvent) => {
    const from = ids.indexOf(String(e.active.id)), to = e.over ? ids.indexOf(String(e.over.id)) : -1
    if (from >= 0 && to >= 0 && from !== to) edit((d) => { d.nights = arrayMove(d.nights, from, to) }, true)
  }
  const addNight = () => edit((d) => {
    const last = d.nights.at(-1)
    d.nights.push({ id: newId(), city: last?.city ?? '', vendor_id: null, hotel_name: '', currency: last?.currency ?? d.currency, price_dbl: null, price_sgl: null, price_trp: null })
  }, true)

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
            <tr>
              <th className="w-8" /><th className="w-10 px-1 py-2">{t('night')}</th>
              <th className="w-36 px-1 py-2">{t('city')}</th><th className="px-1 py-2">{t('hotel')}</th>
              <th className="w-24 px-1 py-2 text-right">{t('roomDouble')}<span className="block font-normal text-slate-400">{t('pricePerRoom')}</span></th>
              <th className="w-24 px-1 py-2 text-right">{t('roomSingle')}</th>
              {showTrp && <RoomHead label={t('roomTriple')} onRemove={hasTrp ? undefined : () => setAdded({ ...added, trp: false })} />}
              {showQuad && <RoomHead label={t('roomQuad')} onRemove={hasQuad ? undefined : () => setAdded({ ...added, quad: false })} />}
              <th className="w-20 px-1 py-2">{t('currency')}</th>
              {staff > 0 && <th className="w-48 px-1 py-2">{t('staffStay')}</th>}
              <th className="w-20" />
            </tr>
          </thead>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <tbody className="divide-y divide-slate-200">
                {doc.nights.map((n, i) => (
                  <NightRow key={ids[i]} id={ids[i]} i={i} n={n} hotels={hotels} showTrp={showTrp} showQuad={showQuad} staff={staff}
                    set={(p) => set(i, p)} onOpen={() => setOpen(i)}
                    onDelete={() => remove((d) => { d.nights.splice(i, 1) })} />
                ))}
              </tbody>
            </SortableContext>
          </DndContext>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 p-3">
        <Button size="sm" variant="secondary" onClick={addNight}><Plus size={16} />{t('addNight')}</Button>
        {!showTrp && <Button size="sm" variant="tertiary" onClick={() => setAdded({ ...added, trp: true })}><Plus size={16} />{t('addRoomColumn', { room: t('roomTriple') })}</Button>}
        {!showQuad && <Button size="sm" variant="tertiary" onClick={() => setAdded({ ...added, quad: true })}><Plus size={16} />{t('addRoomColumn', { room: t('roomQuad') })}</Button>}
        {staff > 0 && doc.nights.length > 1 && (
          <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">{t('staffStayAll')}
            <Select size="sm" className="w-52" value="" onChange={(e) => {
              const v = e.target.value as StaffStay
              if (v) edit((d) => { d.nights.forEach((x) => { x.staff_stay = v }) })
            }}>
              <option value="">—</option>
              {STAFF_STAYS.map((v) => <option key={v} value={v}>{t(`staffStay_${v}` as TKey)}</option>)}
            </Select>
          </label>
        )}
        {trpGaps.length > 0 && <p className="w-full text-xs text-amber-800">{t('roomGaps', { room: t('roomTriple'), list: trpGaps.join(', ') })}</p>}
        {quadGaps.length > 0 && <p className="w-full text-xs text-amber-800">{t('roomGaps', { room: t('roomQuad'), list: quadGaps.join(', ') })}</p>}
        {(doc.seasons?.length ?? 0) > 0 && <span className="w-full text-xs text-amber-700">{t('seasonPricesOnBuild')}</span>}
      </div>
      {open !== null && doc.nights[open] && <NightDrawer doc={doc} index={open} edit={edit} onClose={() => setOpen(null)} />}
    </Card>
  )
}

/** A room column's head; one added but still empty can be taken away again. */
function RoomHead({ label, onRemove }: { label: string; onRemove?: () => void }) {
  const { t } = useI18n()
  return (
    <th className="w-24 px-1 py-2 text-right">
      <span className="inline-flex items-center gap-0.5">{label}
        {onRemove && <IconButton size="sm" label={`${t('remove')}: ${label}`} onClick={onRemove}><X size={14} /></IconButton>}
      </span>
    </th>
  )
}

function NightRow({ id, i, n, hotels, showTrp, showQuad, staff, set, onOpen, onDelete }: {
  id: string; i: number; n: QuoteNight; hotels: Vendor[]; showTrp: boolean; showQuad: boolean; staff: number
  set: (p: Partial<QuoteNight>) => void; onOpen: () => void; onDelete: () => void
}) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const name = n.hotel_name || n.city || t('nightN', { n: i + 1 })
  const pick = (vid: string | null) => {
    const v = hotels.find((h) => h.id === vid)
    set({ vendor_id: vid, hotel_name: v?.name ?? n.hotel_name, city: n.city || v?.city || '' })
  }
  // An empty single room costs what the double does (the engine's rule): shown greyed in the box.
  const price = (k: PriceKey, label: string) => (
    <td key={k} className="px-1 py-1">
      <Input size="sm" className="text-right" type="number" min={0} step="any" value={n[k] ?? ''} aria-label={`${t('nightN', { n: i + 1 })} · ${label}`}
        placeholder={k === 'price_sgl' && n.price_dbl != null ? String(n.price_dbl) : k === 'price_dbl' ? t('noPriceShort') : ''}
        title={k === 'price_sgl' ? t('singleSameAsDouble') : k === 'price_dbl' ? t('doubleEmptyHelp') : undefined}
        onChange={(e) => set({ [k]: e.target.value === '' ? null : e.target.value })} />
    </td>
  )
  const stay = n.staff_stay ?? 'none'
  const paid = (stay === 'own' || stay === 'allowance') && n.staff_price ? ` · ${money(Number(n.staff_price))} ${n.staff_currency ?? n.currency}` : ''
  return (
    <tr ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('bg-white', isDragging && 'relative z-10 shadow-lg')}>
      <td className="pl-1">
        <button type="button" {...attributes} {...listeners} aria-label={t('dragNight', { name })} title={t('dragNightTip')}
          className="flex h-9 w-7 cursor-grab touch-none items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing">
          <GripVertical size={16} aria-hidden />
        </button>
      </td>
      <td className="px-1 font-semibold tabular-nums">{i + 1}</td>
      <td className="px-1 py-1"><Input size="sm" value={n.city} onChange={(e) => set({ city: e.target.value })} aria-label={t('city')} /></td>
      <td className="px-1 py-1">
        {/* One field: the catalogue hotel, or a name typed in (with the catalogue a click away). */}
        {n.vendor_id ? (
          <VendorSelect className="h-8 w-full" vendors={hotels} types={['hotel']} value={n.vendor_id} cities={[n.city]} onChange={pick} />
        ) : (
          <div className="flex gap-1">
            <Input size="sm" value={n.hotel_name} placeholder={t('hotelNotInCatalog')} onChange={(e) => set({ hotel_name: e.target.value })} className="min-w-0 flex-1" aria-label={t('hotel')} />
            <span title={t('pickFromCatalogue')} className="shrink-0">
              <VendorSelect className="h-8 w-14" vendors={hotels} types={['hotel']} value={null} cities={[n.city]} onChange={pick} />
            </span>
          </div>
        )}
      </td>
      {price('price_dbl', t('roomDouble'))}{price('price_sgl', t('roomSingle'))}
      {showTrp && price('price_trp', t('roomTriple'))}{showQuad && price('price_quad', t('roomQuad'))}
      <td className="px-1 py-1">
        <Select size="sm" value={n.currency} onChange={(e) => set({ currency: e.target.value })} aria-label={t('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
      </td>
      {staff > 0 && (
        <td className="px-1 py-1">
          <button type="button" onClick={onOpen} className="w-full truncate rounded px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100">
            {t(`staffStay_${stay}` as TKey)}{paid}{n.staff_twin ? ` · ${t('staffTwin')}` : ''}
          </button>
        </td>
      )}
      <td className="px-1">
        <div className="flex items-center justify-end">
          <IconButton size="sm" label={`${t('edit')}: ${name}`} onClick={onOpen}><Pencil size={16} /></IconButton>
          <IconButton size="sm" label={`${t('delete')}: ${name}`} tone="danger" onClick={onDelete}><Trash2 size={16} /></IconButton>
        </div>
      </td>
    </tr>
  )
}
