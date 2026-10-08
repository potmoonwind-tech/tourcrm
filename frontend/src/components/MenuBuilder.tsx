/**
 * A restaurant's menu builder: on the left its dishes with their prices (by hand, from an Excel file or a photo
 * of the menu - checked before they're added; each price keeps its history), on the right its set menus, built
 * by dragging dishes in. Each dish in a menu shares a plate its own way (1 / 5); the menu shows what it comes to
 * per person and can take that as its price.
 */
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, FileSpreadsheet, GripVertical, History, Plus, Search, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { api, type Dish, type Service, type Vendor } from '../lib/api'
import { wsPath } from '../lib/data'
import { fmt } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Dialog, toast } from './overlay'
import { Button, ErrorText, Input, Spinner } from './ui'

interface RDish { id: string; name: string; category: string; price: string | null; currency: string; per_plate: number | null; position: number
  history: { price: string | null; currency: string; changed_at: string }[] }
interface ReadDish { name: string; category: string; price: string | null }
type MenuDish = Dish & { dish_id?: string | null }

const SHARES = [1, 2, 3, 4, 5, 6, 8]
const SYSTEM = new Set(['staff_meal', 'room_DBL', 'room_TWN', 'room_SGL', 'room_TRP', 'room_QUAD', 'staff_room', 'day'])
const num = (s: string | number | null | undefined) => (s === null || s === undefined || s === '' ? null : Number(s))

export function MenuBuilder({ vendor, onClose }: { vendor: Vendor; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const base = wsPath(ws.id, `/vendors/${vendor.id}`)
  const dishes = useQuery({ queryKey: ['restaurant-dishes', ws.id, vendor.id], queryFn: () => api<RDish[]>(`${base}/dishes`) })
  const services = useQuery({ queryKey: ['vendorServices', vendor.id], queryFn: () => api<Service[]>(`${base}/services`) })
  const share = ws.plate_share || 1
  const [q, setQ] = useState('')
  const [reading, setReading] = useState<ReadDish[] | null>(null)
  const [dragging, setDragging] = useState<RDish | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['restaurant-dishes', ws.id, vendor.id] })
    void qc.invalidateQueries({ queryKey: ['vendorServices', vendor.id] })
    void qc.invalidateQueries({ queryKey: ['services', ws.id] })
  }

  const read = useMutation({
    mutationFn: async (f: File) => {
      const body = new FormData()
      body.append('file', f)
      const res = await fetch(`/api${base}/dishes/read`, { method: 'POST', credentials: 'include', body })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? res.statusText)
      return (await res.json()) as { dishes: ReadDish[]; by_ai: boolean }
    },
    onSuccess: (d) => (d.dishes.length ? setReading(d.dishes) : toast('mbNothingRead', 'error')),
  })
  const add = useMutation({
    mutationFn: (rows: { name: string; category: string; price: string | null }[]) => api<RDish[]>(`${base}/dishes`, { method: 'POST', body: rows }),
    onSuccess: () => { setReading(null); refresh() },
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<RDish> }) => api<RDish>(`${base}/dishes/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  })
  const del = useMutation({ mutationFn: (id: string) => api(`${base}/dishes/${id}`, { method: 'DELETE' }), onSuccess: refresh })
  const saveMenu = useMutation({
    mutationFn: ({ id, dishes, price, name }: { id: string; dishes: MenuDish[]; price?: number; name?: string }) =>
      api(`${base}/menus/${id}`, { method: 'PUT', body: { dishes, ...(price !== undefined ? { price } : {}), ...(name ? { name } : {}) } }),
    onSuccess: refresh,
  })
  const newMenu = useMutation({
    mutationFn: ({ meal, dish }: { meal: 'lunch' | 'dinner'; dish: RDish }) =>
      api(`${base}/menu`, { method: 'POST', body: { meal, dishes: [toMenu(dish)] } }),
    onSuccess: refresh,
  })

  const list = dishes.data ?? []
  const shown = list.filter((d) => !q.trim() || `${d.name} ${d.category}`.toLowerCase().includes(q.trim().toLowerCase()))
  const sections = useMemo(() => {
    const m = new Map<string, RDish[]>()
    for (const d of shown) m.set(d.category || t('mbNoSection'), [...(m.get(d.category || t('mbNoSection')) ?? []), d])
    return [...m.entries()]
  }, [shown, t])
  const menus = (services.data ?? []).filter((s) => s.category === 'meal' && !SYSTEM.has(s.code ?? ''))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }))
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const d = list.find((x) => `dish:${x.id}` === e.active.id)
    if (d && e.over) put(d, String(e.over.id))
  }
  const put = (d: RDish, over: string) => {
    if (over === 'new:lunch' || over === 'new:dinner') { newMenu.mutate({ meal: over.slice(4) as 'lunch' | 'dinner', dish: d }); return }
    const m = menus.find((x) => `menu:${x.id}` === over)
    if (!m) return
    const cur = (m.dishes ?? []) as MenuDish[]
    if (cur.some((x) => x.dish_id === d.id || x.name.toLowerCase() === d.name.toLowerCase())) { toast('mbAlreadyIn'); return }
    saveMenu.mutate({ id: m.id!, dishes: [...cur, toMenu(d)] })
  }

  return (
    <Dialog size="xl" title={t('mbTitle', { name: vendor.name })} onClose={onClose}
      footer={<Button onClick={onClose}>{t('done')}</Button>}>
      <DndContext sensors={sensors} onDragStart={(e) => setDragging(list.find((x) => `dish:${x.id}` === e.active.id) ?? null)}
        onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          {/* The restaurant's dishes */}
          <section className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-auto font-semibold text-slate-900">{t('mbDishes', { n: list.length })}</h3>
              <input ref={file} type="file" accept=".xlsx,.xlsm,.csv,image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) read.mutate(f); e.target.value = '' }} />
              <Button size="sm" variant="secondary" disabled={read.isPending} onClick={() => file.current?.click()}>
                <FileSpreadsheet size={14} aria-hidden /><Camera size={14} aria-hidden />{read.isPending ? t('mbReading') : t('mbUpload')}
              </Button>
            </div>
            <p className="text-xs text-slate-500">{t('mbUploadHelp')}</p>
            <ErrorText error={read.error} />
            {reading && <ReadPreview rows={reading} busy={add.isPending} onCancel={() => setReading(null)} onAdd={(rows) => add.mutate(rows)} />}
            <AddDish onAdd={(row) => add.mutate([row])} sections={[...new Set(list.map((d) => d.category).filter(Boolean))]} />
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('mbSearch')} className="h-9 pl-8 text-sm" />
            </div>
            {dishes.isLoading ? <Spinner /> : !list.length ? <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">{t('mbNoDishes')}</p> : (
              <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
                {sections.map(([section, rows]) => (
                  <div key={section}>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{section}</p>
                    <div className="space-y-1">
                      {rows.map((d) => <DishRow key={d.id} d={d} menus={menus} onPut={(over) => put(d, over)} onPrice={(price) => patch.mutate({ id: d.id, body: { price } })}
                        onName={(name) => patch.mutate({ id: d.id, body: { name } })} onDelete={() => del.mutate(d.id)} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <ErrorText error={add.error || patch.error || del.error} />
          </section>

          {/* Its set menus: drop dishes in */}
          <section className="min-w-0 space-y-2">
            <h3 className="font-semibold text-slate-900">{t('mbMenus')} <span className="text-xs font-normal text-slate-500">{t('mbDragHint')}</span></h3>
            {services.isLoading ? <Spinner /> : (
              <div className="grid gap-3 sm:grid-cols-2">
                {menus.map((m) => <MenuCard key={m.id} m={m} share={share} currency={vendor.currency || ws.base_currency}
                  onDishes={(dishes) => saveMenu.mutate({ id: m.id!, dishes })} onPrice={(price) => saveMenu.mutate({ id: m.id!, dishes: (m.dishes ?? []) as MenuDish[], price })}
                  onName={(name) => saveMenu.mutate({ id: m.id!, dishes: (m.dishes ?? []) as MenuDish[], name })} />)}
                <NewMenuDrop meal="lunch" />
                <NewMenuDrop meal="dinner" />
              </div>
            )}
            <ErrorText error={saveMenu.error || newMenu.error} />
          </section>
        </div>
        <DragOverlay>{dragging && <div className="rounded-lg border border-brand-300 bg-white px-3 py-1.5 text-sm shadow-lg">{dragging.name}</div>}</DragOverlay>
      </DndContext>
    </Dialog>
  )
}

const toMenu = (d: RDish): MenuDish => ({ name: d.name.slice(0, 80), price: num(d.price), per_plate: d.per_plate, dish_id: d.id })

function DishRow({ d, menus, onPut, onPrice, onName, onDelete }: {
  d: RDish; menus: Service[]; onPut: (over: string) => void
  onPrice: (p: string | null) => void; onName: (n: string) => void; onDelete: () => void
}) {
  const { t, lang } = useI18n()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `dish:${d.id}` })
  const [price, setPrice] = useState(d.price ?? '')
  const [name, setName] = useState(d.name)
  const [hist, setHist] = useState(false)
  return (
    <div ref={setNodeRef} className={cn('rounded-lg border border-slate-200 bg-white', isDragging && 'opacity-40')}>
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <button type="button" {...listeners} {...attributes} aria-label={t('mbDrag', { name: d.name })}
          className="cursor-grab touch-none rounded p-1 text-slate-400 hover:bg-slate-50 active:cursor-grabbing"><GripVertical size={14} /></button>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== d.name && onName(name.trim())}
          className="min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 text-sm hover:border-slate-200 focus:border-brand-300 focus:outline-none" aria-label={t('mbDishName')} />
        <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} placeholder="—"
          onBlur={() => { const p = price.trim() === '' ? null : price.replace(',', '.'); if (p !== (d.price ?? null) && (p === null || !Number.isNaN(Number(p)))) onPrice(p) }}
          className="w-16 rounded border border-slate-200 px-1.5 py-0.5 text-right text-sm tabular-nums focus:border-brand-300 focus:outline-none" aria-label={t('mbPrice')} />
        <span className="w-8 text-xs text-slate-400">{d.currency}</span>
        {/* Without dragging (a phone): "+ to a menu". */}
        <select value="" onChange={(e) => { if (e.target.value) onPut(e.target.value) }} aria-label={t('mbAddTo', { name: d.name })} title={t('mbAddTo', { name: d.name })}
          className="h-6 w-7 cursor-pointer appearance-none rounded border border-slate-200 bg-white text-center text-sm font-semibold text-brand-700 hover:bg-brand-50">
          <option value="">+</option>
          {menus.map((m) => <option key={m.id} value={`menu:${m.id}`}>{m.name}</option>)}
          <option value="new:lunch">{t('mbNewLunchShort')}</option>
          <option value="new:dinner">{t('mbNewDinnerShort')}</option>
        </select>
        {d.history.length > 1 && (
          <button type="button" onClick={() => setHist(!hist)} title={t('mbHistory')} aria-label={t('mbHistory')}
            className={cn('rounded p-1 text-slate-400 hover:bg-slate-50', hist && 'text-brand-700')}><History size={14} /></button>
        )}
        <button type="button" onClick={onDelete} aria-label={`${t('delete')} ${d.name}`} className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-600"><X size={13} /></button>
      </div>
      {hist && (
        // The price over time, newest first.
        <ul className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-600">
          {d.history.map((h, i) => (
            <li key={i} className="flex justify-between gap-3 py-0.5">
              <span>{fmt(h.changed_at.slice(0, 10), lang, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              <span className={cn('tabular-nums', i === 0 && 'font-semibold text-slate-900')}>{h.price ?? '—'} {h.currency}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AddDish({ onAdd, sections }: { onAdd: (row: { name: string; category: string; price: string | null }) => void; sections: string[] }) {
  const { t } = useI18n()
  const [f, setF] = useState({ name: '', category: '', price: '' })
  return (
    <form className="flex flex-wrap gap-1.5" onSubmit={(e) => {
      e.preventDefault()
      if (!f.name.trim()) return
      onAdd({ name: f.name.trim(), category: f.category.trim(), price: f.price.trim() ? f.price.replace(',', '.') : null })
      setF({ name: '', category: f.category, price: '' })
    }}>
      <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('mbDishPh')} className="h-8 min-w-36 flex-1 text-sm" aria-label={t('mbDishName')} />
      <Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder={t('mbSectionPh')} list="mb-sections" className="h-8 w-32 text-sm" aria-label={t('mbSection')} />
      <datalist id="mb-sections">{sections.map((s) => <option key={s} value={s} />)}</datalist>
      <Input value={f.price} inputMode="decimal" onChange={(e) => setF({ ...f, price: e.target.value })} placeholder={t('mbPrice')} className="h-8 w-20 text-right text-sm" aria-label={t('mbPrice')} />
      <Button size="sm" type="submit"><Plus size={14} />{t('add')}</Button>
    </form>
  )
}

/** What the file or photo lists: tick, correct, then add. */
function ReadPreview({ rows: start, busy, onAdd, onCancel }: {
  rows: ReadDish[]; busy: boolean; onAdd: (rows: ReadDish[]) => void; onCancel: () => void
}) {
  const { t } = useI18n()
  const [rows, setRows] = useState(start.map((r) => ({ ...r, on: true })))
  const set = (i: number, p: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const picked = rows.filter((r) => r.on && r.name.trim())
  return (
    <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2">
      <p className="text-sm font-medium text-violet-900">{t('mbReadCheck', { n: rows.length })}</p>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-violet-100">
                <td className="w-6 py-1"><input type="checkbox" className="size-4" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} aria-label={r.name} /></td>
                <td className="py-1 pr-1"><input value={r.name} onChange={(e) => set(i, { name: e.target.value })} className="w-full rounded border border-slate-200 bg-white px-1 py-0.5" /></td>
                <td className="w-28 py-1 pr-1"><input value={r.category} onChange={(e) => set(i, { category: e.target.value })} className="w-full rounded border border-slate-200 bg-white px-1 py-0.5" /></td>
                <td className="w-16 py-1"><input value={r.price ?? ''} onChange={(e) => set(i, { price: e.target.value || null })} className="w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-right tabular-nums" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button size="sm" disabled={busy || !picked.length} onClick={() => onAdd(picked.map(({ name, category, price }) => ({ name: name.trim(), category, price: price ? String(price).replace(',', '.') : null })))}>
          {t('mbAddN', { n: picked.length })}
        </Button>
      </div>
    </div>
  )
}

function MenuCard({ m, share, currency, onDishes, onPrice, onName }: {
  m: Service; share: number; currency: string
  onDishes: (d: MenuDish[]) => void; onPrice: (p: number) => void; onName: (n: string) => void
}) {
  const { t } = useI18n()
  const { setNodeRef, isOver } = useDroppable({ id: `menu:${m.id}` })
  const dishes = (m.dishes ?? []) as MenuDish[]
  const [name, setName] = useState(m.name)
  // Per person: each dish's plate shared by its people (one portion each = the full price).
  const priced = dishes.every((d) => d.price !== null && d.price !== undefined)
  const pp = dishes.reduce((s, d) => s + (d.price ?? 0) / (d.per_plate ?? share), 0)
  const rate = m.rates.length === 1 ? num(m.rates[0].price) : null
  return (
    <div ref={setNodeRef} className={cn('flex min-h-40 flex-col rounded-xl border bg-white p-2.5 transition-colors', isOver ? 'border-brand-400 bg-brand-50/60' : 'border-slate-200')}>
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== m.name && onName(name.trim())}
        disabled={!!m.code} className="mb-1 rounded border border-transparent px-1 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-brand-300 focus:outline-none disabled:bg-transparent" aria-label={t('mbMenuName')} />
      <ul className="flex-1 divide-y divide-slate-100 text-sm">
        {dishes.map((d, i) => (
          <li key={`${d.name}-${i}`} className="flex items-center gap-1.5 py-1">
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <select value={d.per_plate ?? share} aria-label={`${d.name}: ${t('mpShare')}`}
              onChange={(e) => onDishes(dishes.map((x, j) => (j === i ? { ...x, per_plate: Number(e.target.value) } : x)))}
              className={cn('h-6 rounded border border-slate-200 px-1 text-xs tabular-nums', (d.per_plate ?? share) > 1 && 'border-amber-300 bg-amber-50 text-amber-900')}>
              {SHARES.map((n) => <option key={n} value={n}>1 / {n}</option>)}
            </select>
            <span className="w-12 text-right text-xs tabular-nums text-slate-500">{d.price ?? '—'}</span>
            <button type="button" onClick={() => onDishes(dishes.filter((_, j) => j !== i))} aria-label={`${t('delete')} ${d.name}`}
              className="rounded p-0.5 text-slate-300 hover:bg-red-50 hover:text-red-600"><X size={12} /></button>
          </li>
        ))}
        {!dishes.length && <li className="py-6 text-center text-xs text-slate-400">{t('mbDropHere')}</li>}
      </ul>
      {dishes.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-1.5 text-xs">
          <span className="text-slate-600">{t('mbPerPerson', { price: `${pp.toFixed(2)} ${currency}` })}{!priced && ` · ${t('mbSomeNoPrice')}`}</span>
          <span className="ml-auto text-slate-500">{t('mbMenuPrice')}: <b className="text-slate-800">{rate !== null ? `${rate.toFixed(2)} ${m.rates[0].currency}` : m.rates.length > 1 ? t('mbSeveralPrices') : '—'}</b></span>
          {priced && m.rates.length <= 1 && Math.abs((rate ?? -1) - pp) >= 0.01 && (
            <button type="button" onClick={() => onPrice(Math.round(pp * 100) / 100)} className="font-medium text-brand-700 hover:underline">{t('mbUseAsPrice')}</button>
          )}
        </div>
      )}
    </div>
  )
}

function NewMenuDrop({ meal }: { meal: 'lunch' | 'dinner' }) {
  const { t } = useI18n()
  const { setNodeRef, isOver } = useDroppable({ id: `new:${meal}` })
  return (
    <div ref={setNodeRef} className={cn('flex min-h-24 items-center justify-center rounded-xl border-2 border-dashed px-3 text-center text-xs',
      isOver ? 'border-brand-400 bg-brand-50/60 text-brand-800' : 'border-slate-200 text-slate-400')}>
      <span><Plus size={14} className="mx-auto mb-1" />{t(meal === 'lunch' ? 'mbNewLunch' : 'mbNewDinner')}</span>
    </div>
  )
}
