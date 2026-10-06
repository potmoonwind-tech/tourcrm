import { MapPin, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DayExtra, ServiceBrief } from '../lib/api'
import { useServiceList, useVendors } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { cn, slotId } from '../lib/utils'
import { Tooltip } from './Tooltip'

/** Units whose quantity the system can work out by itself (group size, rooms, 1 per day/group). */
const AUTO_UNITS = new Set(['person', 'room_night', 'group', 'vehicle_day', 'day', 'km', 'litre'])   // km/litre: from the day's km

/**
 * The day's places and what the group does there: "KTW Patardzeuli" with wine tasting and bread baking
 * ticked, a churchkhela class offered as optional. A place is one card with its activities as a checklist
 * (everything the supplier offers), so a stop with several activities reads — and is set up — as one stop.
 * Quantity left empty = counted from the unit.
 */
export function DayServices({ value, onChange, disabled, onAddNew }: {
  value: DayExtra[]; onChange: (v: DayExtra[]) => void; disabled?: boolean
  onAddNew?: (vendorId?: string) => void   // a new service: for this place, or any supplier
}) {
  const { t } = useI18n()
  const services = useServiceList()
  const all = services.data ?? []
  const byId = new Map(all.map((s) => [s.id, s]))
  // What a place offers. Rooms and menus have the day's own hotel, lunch and dinner slots: left out here,
  // unless one is on the day already.
  const offers = new Map<string, ServiceBrief[]>()
  for (const s of all) {
    if ((s.category === 'hotel' || s.category === 'meal') && !value.some((x) => x.service_id === s.id)) continue
    offers.set(s.vendor.id, [...(offers.get(s.vendor.id) ?? []), s])
  }
  // Places in the order they were added; one just picked shows (empty) until something is ticked.
  const [picked, setPicked] = useState<string[]>([])
  const used = [...new Set(value.map((x) => byId.get(x.service_id)?.vendor.id).filter((v): v is string => !!v))]
  // Catalogue places with no priced activity yet (a winery entered without its tastings): listed too, so
  // the place is picked from the catalogue and only its activity and price are added - not a second place.
  const vendors = useVendors()
  const bare = new Map((vendors.data ?? [])
    .filter((v) => !['hotel', 'restaurant', 'transport', 'guide', 'driver'].includes(v.type) && !offers.has(v.id))
    .map((v) => [v.id, v]))
  const places = [...used, ...picked.filter((v) => !used.includes(v) && (offers.has(v) || bare.has(v)))]
  const gone = value.filter((x) => services.data && !byId.has(x.service_id))
  const [adding, setAdding] = useState(false)

  const tick = (s: ServiceBrief, on: boolean) => onChange(on
    ? [...value, { id: slotId(), service_id: s.id, quantity: null, notes: '' }]
    : value.filter((x) => x.service_id !== s.id))
  const patch = (serviceId: string, p: Partial<DayExtra>) => onChange(value.map((x) => (x.service_id === serviceId ? { ...x, ...p } : x)))
  const drop = (vendorId: string) => {
    setPicked((l) => l.filter((v) => v !== vendorId))
    onChange(value.filter((x) => byId.get(x.service_id)?.vendor.id !== vendorId))
  }

  return (
    <div className="space-y-2">
      {places.map((vid) => {
        const list = offers.get(vid) ?? []
        const vendor = list[0]?.vendor ?? bare.get(vid)
        const on = list.filter((s) => value.some((x) => x.service_id === s.id))
        // A place with one service needs no checklist: it's simply there (remove the place to drop it).
        const single = list.length === 1
        return (
          <div key={vid} className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <MapPin size={14} className="shrink-0 text-brand-700" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{vendor?.name}</span>
              {!single && <span className="shrink-0 text-xs text-slate-500">{t('placeActivitiesOn', { n: on.length, of: list.length })}</span>}
              {!disabled && (
                <Tooltip label={t('placeRemove')}>
                  <button type="button" onClick={() => drop(vid)} aria-label={t('placeRemoveOf', { name: vendor?.name ?? '' })}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><X size={14} /></button>
                </Tooltip>
              )}
            </div>
            <ul className="border-t border-slate-100 px-2.5 py-1">
              {list.map((s) => {
                const slot = value.find((x) => x.service_id === s.id)
                return (
                  <li key={s.id} className="flex min-h-8 items-center gap-2 py-0.5">
                    <label className={cn('flex min-w-0 flex-1 items-center gap-2 text-sm', slot ? 'text-slate-800' : 'text-slate-500')}>
                      {!single && <input type="checkbox" checked={!!slot} disabled={disabled} onChange={(e) => tick(s, e.target.checked)}
                        className="h-4 w-4 shrink-0 accent-brand-600" />}
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 text-xs text-slate-400">· {t(`unit_${s.unit}`)}</span>
                    </label>
                    {slot && <>
                      <Qty value={slot.quantity} auto={AUTO_UNITS.has(s.unit)} unit={t(`unit_${s.unit}`)} disabled={disabled}
                        onChange={(q) => patch(s.id, { quantity: q })} />
                      <Tooltip label={t('activityOptionalTip')}>
                        <button type="button" disabled={disabled} aria-pressed={!!slot.optional} onClick={() => patch(s.id, { optional: !slot.optional })}
                          className={cn('h-6 shrink-0 rounded-full border px-2 text-xs font-medium',
                            slot.optional ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}>
                          {t('activityOptional')}
                        </button>
                      </Tooltip>
                    </>}
                  </li>
                )
              })}
              {list.length === 0 && <li className="py-1 text-xs text-slate-500">{t('placeNoPrices')}</li>}
              {!disabled && onAddNew && (
                <li><button type="button" onClick={() => onAddNew(vid)}
                  className="inline-flex h-7 items-center gap-1 rounded px-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
                  <Plus size={12} />{t(list.length ? 'placeAddActivity' : 'placeAddFirst')}</button></li>
              )}
            </ul>
          </div>
        )
      })}
      {gone.map((x, i) => (
        <span key={x.id ?? i} className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 py-0.5 pl-2 pr-1 text-xs text-red-700">
          {t('serviceRemoved')}
          {!disabled && <button type="button" onClick={() => onChange(value.filter((y) => y !== x))} aria-label={t('delete')}
            className="rounded-full p-0.5 hover:bg-white"><X size={12} /></button>}
        </span>
      ))}
      {!disabled && (adding ? (
        <select autoFocus className="h-8 w-full max-w-72 rounded-md border border-slate-300 bg-white px-2 text-sm" value=""
          onBlur={() => setAdding(false)}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__new__') onAddNew?.()
            else if (v && offers.get(v)?.length === 1) onChange([...value, { id: slotId(), service_id: offers.get(v)![0].id, quantity: null, notes: '' }])
            else if (v && bare.has(v)) setPicked((l) => [...l, v])
            else if (v) setPicked((l) => [...l, v])
            setAdding(false)
          }}>
          <option value="">{t('placePick')}</option>
          {[...offers].filter(([vid]) => !places.includes(vid)).map(([vid, list]) => (
            <option key={vid} value={vid}>{list[0].vendor.name} ({list.length === 1 ? list[0].name : t('placeActivitiesCount', { n: list.length })})</option>
          ))}
          {[...bare.values()].filter((v) => !places.includes(v.id)).map((v) => (
            <option key={v.id} value={v.id}>{v.name} ({t('placeNoPriceOption')})</option>
          ))}
          {onAddNew && <option value="__new__">{t('addNewOption')}</option>}
        </select>
      ) : (
        <span className="flex flex-wrap items-center gap-x-2">
          <button type="button" onClick={() => (all.length || bare.size ? setAdding(true) : onAddNew?.())} disabled={!all.length && !bare.size && !onAddNew}
            title={all.length || bare.size ? undefined : t('noServicesYet')}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:text-slate-400">
            <Plus size={14} />{t('placeAdd')}
          </button>
          {/* Empty: say what goes here and where it counts. */}
          {places.length === 0 && <span className="text-xs text-slate-500">{t('servicesEmptyHint')}</span>}
        </span>
      ))}
    </div>
  )
}

/** Quantity box: empty means "auto". Commits on blur. */
function Qty({ value, auto, unit, disabled, onChange }: {
  value: DayExtra['quantity']; auto: boolean; unit: string; disabled?: boolean; onChange: (q: string | null) => void
}) {
  const { t } = useI18n()
  const shown = value === null || value === undefined ? '' : String(Number(value))
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  return (
    <input type="number" min="0" step="any" disabled={disabled} value={text} placeholder={auto ? t('autoQty') : '1?'}
      title={auto ? t('autoQtyHelp', { unit }) : t('setQtyHelp', { unit })} aria-label={t('quantity')}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== shown) onChange(text && Number(text) > 0 ? text : null) }}
      className={cn('h-6 w-14 shrink-0 rounded border bg-white px-1 text-right text-xs tabular-nums',
        !auto && !text ? 'border-amber-400' : 'border-slate-200')} />
  )
}
