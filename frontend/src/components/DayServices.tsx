import type { ReactNode } from 'react'
import { MapPin, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DayExtra, ServiceBrief, Vendor } from '../lib/api'
import { useServiceList, useVendors } from '../lib/data'
import { catLabel, catOf } from '../lib/activities'
import { OpeningHoursBox } from './OpeningHours'
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
export function DayServices({ value, onChange, disabled, onAddNew, grip, visits = [], onAddVisit, onRemoveVisit }: {
  value: DayExtra[]; onChange: (v: DayExtra[]) => void; disabled?: boolean
  onAddNew?: (vendorId?: string) => void   // a new service: for this place, or any supplier
  grip?: (vendorId: string, serviceIds: string[]) => ReactNode   // a handle to drag the place (with its activities) to another day
  // The day's visits in its timeline that aren't priced activities (Gelati, a photo stop): shown here too, so
  // "what they do" is the whole day. A catalogue place picked here with nothing priced becomes such a visit.
  visits?: { id: string; title: string; vendorId?: string }[]
  onAddVisit?: (v: Vendor) => void
  onRemoveVisit?: (stepId: string) => void
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
  // A visit in the timeline at a catalogue place: that place's card (tick its activities right here).
  const visited = visits.map((x) => x.vendorId).filter((v): v is string => !!v && (offers.has(v) || bare.has(v)))
  const places = [...used, ...[...picked, ...visited].filter((v, i, a) => a.indexOf(v) === i && !used.includes(v) && (offers.has(v) || bare.has(v)))]
  const loose = visits.filter((x) => !x.vendorId || !places.includes(x.vendorId))
  const gone = value.filter((x) => services.data && !byId.has(x.service_id))
  const [adding, setAdding] = useState(false)

  const tick = (s: ServiceBrief, on: boolean) => onChange(on
    ? [...value, { id: slotId(), service_id: s.id, quantity: null, notes: '' }]
    : value.filter((x) => x.service_id !== s.id))
  const patch = (serviceId: string, p: Partial<DayExtra>) => onChange(value.map((x) => (x.service_id === serviceId ? { ...x, ...p } : x)))
  const drop = (vendorId: string) => {
    setPicked((l) => l.filter((v) => v !== vendorId))
    for (const x of visits) if (x.vendorId === vendorId) onRemoveVisit?.(x.id)
    onChange(value.filter((x) => byId.get(x.service_id)?.vendor.id !== vendorId))
  }

  // One row of chips - every place of the day with what is done there; tap one for its details (how many,
  // optional, a price). A place is free until a price is added.
  const [open, setOpen] = useState<string | null>(null)
  const icon = (vid?: string) => {
    const k = catOf(vendors.data?.find((x) => x.id === vid)?.category)
    return k ? <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', k.tone)} title={catLabel(t, k.key)}><k.icon size={11} aria-hidden /></span>
      : <MapPin size={13} className="shrink-0 text-slate-400" aria-hidden />
  }
  const chip = 'inline-flex max-w-full items-center gap-0.5 rounded-full border py-0.5 pl-1 pr-0.5 text-sm'
  const remove = (label: string, onClick: () => void) => !disabled && (
    <Tooltip label={t('placeRemove')}>
      <button type="button" onClick={onClick} aria-label={t('placeRemoveOf', { name: label })}
        className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><X size={12} /></button>
    </Tooltip>
  )
  const shown = open && places.includes(open) ? open : null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {places.map((vid) => {
          const list = offers.get(vid) ?? []
          const name = list[0]?.vendor.name ?? bare.get(vid)?.name ?? ''
          const on = list.filter((s) => value.some((x) => x.service_id === s.id))
          // What is done there: the activities when the place has several, "free" when nothing priced is on.
          const what = on.length === 0 ? t('visitFree') : list.length > 1 ? on.map((s) => s.name).join(', ') : ''
          const optional = on.some((s) => value.find((x) => x.service_id === s.id)?.optional)
          return (
            <span key={vid} className={cn(chip, shown === vid ? 'border-brand-400 bg-brand-50' : on.length ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-white')}>
              {grip && on.length > 0 && grip(vid, on.map((x) => x.id))}
              <button type="button" onClick={() => setOpen(shown === vid ? null : vid)} aria-expanded={shown === vid}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-left hover:text-brand-800">
                {icon(vid)}
                <span className="truncate font-medium text-slate-800">{name}</span>
                {what && <span className="truncate text-xs text-slate-500">· {what}</span>}
                {optional && <span className="shrink-0 text-xs text-amber-700">· {t('activityOptional').toLowerCase()}</span>}
              </button>
              {remove(name, () => { drop(vid); if (shown === vid) setOpen(null) })}
            </span>
          )
        })}
        {loose.map((x) => (
          <span key={x.id} className={cn(chip, 'border-dashed border-slate-300 bg-white')} title={t('visitFreeInTimeline')}>
            <span className="inline-flex min-w-0 items-center gap-1.5 px-1 py-0.5">
              {icon(x.vendorId)}<span className="truncate font-medium text-slate-800">{x.title}</span>
              <span className="shrink-0 text-xs text-slate-500">· {t('visitFree')}</span>
            </span>
            {onRemoveVisit && remove(x.title, () => onRemoveVisit(x.id))}
          </span>
        ))}
        {gone.map((x, i) => (
          <span key={x.id ?? i} className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 py-0.5 pl-2 pr-1 text-xs text-red-700">
            {t('serviceRemoved')}
            {!disabled && <button type="button" onClick={() => onChange(value.filter((y) => y !== x))} aria-label={t('delete')}
              className="rounded-full p-0.5 hover:bg-white"><X size={12} /></button>}
          </span>
        ))}
        {!disabled && (adding ? (
          <select autoFocus className="h-8 w-full max-w-72 rounded-full border border-slate-300 bg-white px-3 text-sm" value=""
            onBlur={() => setAdding(false)}
            onChange={(e) => {
              const v = e.target.value
              if (v === '__new__') onAddNew?.()
              else if (v && offers.get(v)?.length === 1) onChange([...value, { id: slotId(), service_id: offers.get(v)![0].id, quantity: null, notes: '' }])
              else if (v && bare.has(v)) { setPicked((l) => [...l, v]); onAddVisit?.(bare.get(v)!) }
              else if (v) { setPicked((l) => [...l, v]); setOpen(v) }
              setAdding(false)
            }}>
            <option value="">{t('placePick')}</option>
            {[...offers].filter(([vid]) => !places.includes(vid)).map(([vid, list]) => (
              <option key={vid} value={vid}>{list[0].vendor.name} ({list.length === 1 ? list[0].name : t('placeActivitiesCount', { n: list.length })})</option>
            ))}
            {[...bare.values()].filter((v) => !places.includes(v.id)).map((v) => (
              <option key={v.id} value={v.id}>{v.name} ({t('visitFree')})</option>
            ))}
            {onAddNew && <option value="__new__">{t('addNewOption')}</option>}
          </select>
        ) : (
          <button type="button" onClick={() => (all.length || bare.size ? setAdding(true) : onAddNew?.())} disabled={!all.length && !bare.size && !onAddNew}
            title={all.length || bare.size ? undefined : t('noServicesYet')}
            className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 text-sm text-slate-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-800 disabled:text-slate-400">
            <Plus size={14} />{t('placeAdd')}
          </button>
        ))}
        {places.length === 0 && loose.length === 0 && !adding && <span className="text-xs text-slate-500">{t('servicesEmptyHint')}</span>}
      </div>

      {/* The tapped place: its activities - how many, optional - and a price only when they pay there. */}
      {shown && (() => {
        const list = offers.get(shown) ?? []
        const single = list.length === 1
        return (
          <div className="animate-reveal rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
            <ul>
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
              {list.length === 0 && <li className="py-1 text-xs text-slate-500">{t('placeFreeHint')}</li>}
            </ul>
            <div className="mt-1 border-t border-slate-100 pt-1">
              <OpeningHoursBox compact names={[list[0]?.vendor.name ?? bare.get(shown)?.name ?? '']} vendorId={disabled ? undefined : shown} />
            </div>
            {!disabled && onAddNew && (
              <button type="button" onClick={() => onAddNew(shown)} className="mt-0.5 text-xs text-slate-500 hover:text-brand-700 hover:underline">
                {t('placeAddPrice')}
              </button>
            )}
          </div>
        )
      })()}
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
      className={cn('h-6 w-14 shrink-0 rounded-md border bg-white px-1 text-right text-xs tabular-nums',
        !auto && !text ? 'border-amber-400' : 'border-slate-200')} />
  )
}
