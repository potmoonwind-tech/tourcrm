import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { AlertTriangle, BedDouble, Cake, Check, GripVertical, Plus, Wand2, X } from 'lucide-react'
import { createContext, useContext, useState } from 'react'
import { api, ROOM_TYPES, type Participant, type RoomType } from '../lib/api'
import { useI18n, type TKey } from '../lib/i18n'
import { fmt } from '../lib/dates'
import { cn } from '../lib/utils'
import { Button, Select } from './ui'

/** Beds per room type. */
const CAP: Record<string, number> = { SGL: 1, DBL: 2, TWN: 2, TRP: 3, QUAD: 4 }

interface Room { id: string; type: RoomType; people: Participant[] }

/**
 * The rooming list as rooms: who sleeps with whom. People are dragged into a room (or added with the room's
 * picker, from the keyboard too); a room says when it holds more or fewer people than its beds. Saved in
 * each person's room type and room code — the same fields the rooming list (Excel) and the room count read.
 */
/** Whose birthday falls on the tour: a cake on their chip ({ participant id: date }). */
const Birthdays = createContext<Record<string, string>>({})

export function RoomsBoard({ people, base, onChange, birthdays = {} }: {
  people: Participant[]; base: string; onChange: () => void; birthdays?: Record<string, string>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [empty, setEmpty] = useState<{ id: string; type: RoomType }[]>([])   // made here, nobody in them yet
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }), useSensor(KeyboardSensor))

  const groups = new Map<string, Participant[]>()
  for (const p of people) if (p.room_group.trim()) groups.set(p.room_group.trim(), [...(groups.get(p.room_group.trim()) ?? []), p])
  const typeOf = (ps: Participant[]): RoomType => {
    const counts = new Map<RoomType, number>()
    for (const p of ps) if (p.room_type) counts.set(p.room_type, (counts.get(p.room_type) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (({ 1: 'SGL', 2: 'DBL', 3: 'TRP' } as Record<number, RoomType>)[ps.length] ?? 'QUAD')
  }
  const num = (id: string) => { const m = /^\D*(\d+)$/.exec(id); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER }
  const rooms: Room[] = [
    ...[...groups.entries()].map(([id, ps]) => ({ id, type: typeOf(ps), people: ps })),
    ...empty.filter((e) => !groups.has(e.id)).map((e) => ({ ...e, people: [] })),
  ].sort((a, b) => num(a.id) - num(b.id) || a.id.localeCompare(b.id))
  const loose = people.filter((p) => !p.room_group.trim())
  // New rooms are numbered after the last one, in the same style ("R15" after "R14").
  const ids = [...groups.keys(), ...empty.map((e) => e.id)]
  const prefix = /^([A-Za-z]?)\d+$/.exec(ids[0] ?? '')?.[1] ?? ''
  const nextId = () => `${prefix}${Math.max(0, ...ids.map((x) => { const m = /^\D*(\d+)$/.exec(x); return m ? Number(m[1]) : 0 })) + 1}`

  const run = async (patches: [string, Record<string, string>][]) => {
    if (!patches.length) return
    setBusy(true)
    try {
      await Promise.all(patches.map(([id, body]) => api(`${base}/participants/${id}`, { method: 'PATCH', body })))
    } finally {
      setBusy(false)
      onChange()
    }
  }
  const put = (p: Participant, room: Room) => run([[p.id, { room_group: room.id, room_type: room.type, room_note: room.people[0]?.room_note ?? '' }]])
  const note = (room: Room, text: string) => run(room.people.map((p) => [p.id, { room_note: text }]))
  const out = (p: Participant) => run([[p.id, { room_group: '', room_note: '' }]])
  const retype = (room: Room, type: RoomType) => room.people.length
    ? run(room.people.map((p) => [p.id, { room_type: type }]))
    : setEmpty((l) => l.map((e) => (e.id === room.id ? { ...e, type } : e)))
  const addRoom = (type: RoomType) => setEmpty((l) => [...l, { id: nextId(), type }])
  // The rest, by their room type in list order: first the rooms of that type with a free bed, then new rooms.
  const autoFill = () => {
    const patches: [string, Record<string, string>][] = []
    const space = rooms.map((r) => ({ id: r.id, type: r.type, free: CAP[r.type] - r.people.length }))
    let next = num(nextId())
    for (const p of loose) {
      if (!p.room_type) continue
      let room = space.find((r) => r.type === p.room_type && r.free > 0)
      if (!room) { room = { id: `${prefix}${next++}`, type: p.room_type, free: CAP[p.room_type] }; space.push(room) }
      room.free -= 1
      patches.push([p.id, { room_group: room.id, room_type: room.type }])
    }
    void run(patches)
  }
  const onDragEnd = (e: DragEndEvent) => {
    const p = people.find((x) => x.id === e.active.id)
    const to = e.over?.id
    if (!p || !to) return
    if (to === 'loose') { if (p.room_group.trim()) void out(p) }
    else { const room = rooms.find((r) => `room-${r.id}` === to); if (room && room.id !== p.room_group.trim()) void put(p, room) }
  }
  const typedLoose = loose.filter((p) => p.room_type).length

  return (
    <Birthdays.Provider value={birthdays}>
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className={cn('space-y-4', busy && 'pointer-events-none opacity-70')} aria-busy={busy}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-600">{t('roomsBoardHelp')}</span>
          <div className="flex-1" />
          {typedLoose > 0 && (
            <Button size="sm" variant="secondary" onClick={autoFill}><Wand2 size={14} aria-hidden />{t('roomsAutoFill', { n: typedLoose })}</Button>
          )}
          <span className="flex items-center gap-1" role="group" aria-label={t('roomsAddRoom')}>
            <span className="text-sm text-slate-500">{t('roomsAddRoom')}:</span>
            {ROOM_TYPES.map((r) => (
              <Button key={r} size="sm" variant="tertiary" onClick={() => addRoom(r)}><Plus size={14} aria-hidden />{t(`roomTypeName_${r}` as TKey)}</Button>
            ))}
          </span>
        </div>

        <Pool people={loose} />

        {rooms.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">{t('roomsNoneYet')}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rooms.map((room) => <RoomCard key={room.id} room={room} loose={loose} onPut={(p) => void put(p, room)} onOut={(p) => void out(p)}
              onNote={(text) => void note(room, text)}
              onType={(type) => void retype(room, type)} onDrop={() => setEmpty((l) => l.filter((e) => e.id !== room.id))} />)}
          </ul>
        )}
      </div>
    </DndContext>
    </Birthdays.Provider>
  )
}

/** People without a room yet (drop a person here to take them out of a room). */
function Pool({ people }: { people: Participant[] }) {
  const { t } = useI18n()
  const { setNodeRef, isOver } = useDroppable({ id: 'loose' })
  return (
    <section ref={setNodeRef} aria-label={t('roomsWithout')}
      className={cn('rounded-xl border px-4 py-3', isOver ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white')}>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">{t('roomsWithout')} · {people.length}</h3>
      {people.length === 0
        ? <p className="flex items-center gap-1.5 text-sm text-emerald-700"><Check size={15} aria-hidden />{t('roomsAllPlaced')}</p>
        : <div className="flex flex-wrap gap-1.5">{people.map((p) => <Person key={p.id} p={p} />)}</div>}
    </section>
  )
}

function RoomCard({ room, loose, onPut, onOut, onType, onDrop, onNote }: {
  room: Room; loose: Participant[]; onPut: (p: Participant) => void; onOut: (p: Participant) => void
  onType: (type: RoomType) => void; onDrop: () => void; onNote: (text: string) => void
}) {
  const { t } = useI18n()
  const { setNodeRef, isOver } = useDroppable({ id: `room-${room.id}` })
  const n = room.people.length, cap = CAP[room.type]
  const name = `${t('roomWord')} ${/^[A-Za-z]?(\d+)$/.exec(room.id)?.[1] ?? room.id}`
  const saved = room.people[0]?.room_note ?? ''
  const [text, setText] = useState(saved)
  const [was, setWas] = useState(saved)
  if (saved !== was) { setWas(saved); setText(saved) }   // changed elsewhere: show it
  return (
    <li ref={setNodeRef} aria-label={name}
      className={cn('rounded-xl border bg-white p-3', isOver ? 'border-brand-500 bg-brand-50' : n > cap ? 'border-red-300' : 'border-slate-200')}>
      <div className="flex items-center gap-2">
        <BedDouble size={16} className="shrink-0 text-slate-500" aria-hidden />
        <span className="text-sm font-semibold text-slate-800">{name}</span>
        <Select size="sm" value={room.type} onChange={(e) => onType(e.target.value as RoomType)} className="w-32" aria-label={`${name} · ${t('roomType')}`}>
          {ROOM_TYPES.map((r) => <option key={r} value={r}>{t(`roomTypeName_${r}` as TKey)}</option>)}
        </Select>
        <span className={cn('ml-auto text-xs tabular-nums', n > cap ? 'font-medium text-red-700' : n < cap ? 'text-amber-700' : 'text-emerald-700')}>{n}/{cap}</span>
        {n === 0 && <button type="button" onClick={onDrop} aria-label={t('delete')} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"><X size={14} /></button>}
      </div>
      {n > cap && <p className="mt-1 flex items-center gap-1 text-xs text-red-700"><AlertTriangle size={12} aria-hidden />{t('roomsTooManyIn', { n, cap })}</p>}
      <p className="mt-0.5 text-xs text-slate-500">{t(`bedsOf_${room.type}` as TKey)}</p>
      <div className="mt-2 flex min-h-9 flex-wrap gap-1.5">
        {room.people.map((p) => <Person key={p.id} p={p} onOut={() => onOut(p)} />)}
      </div>
      {n > 0 && (
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
          onBlur={() => text !== saved && onNote(text)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder={t('roomNotePh')} aria-label={`${name} · ${t('roomNote')}`}
          className="mt-2 h-8 w-full rounded-md border border-slate-200 px-2 text-xs text-slate-700 placeholder:text-slate-400 hover:border-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100" />
      )}
      {n < cap && loose.length > 0 && (
        <Select size="sm" value="" onChange={(e) => { const p = loose.find((x) => x.id === e.target.value); if (p) onPut(p) }}
          className="mt-2 w-full" aria-label={`${name} · ${t('roomsAddPerson')}`}>
          <option value="">+ {t('roomsAddPerson')}</option>
          {loose.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.room_type ? ` · ${p.room_type}` : ''}</option>)}
        </Select>
      )}
    </li>
  )
}

function Person({ p, onOut }: { p: Participant; onOut?: () => void }) {
  const { t, lang } = useI18n()
  const bday = useContext(Birthdays)[p.id]
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: p.id })
  return (
    <span ref={setNodeRef} style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn('inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-1 pl-1 pr-2 text-sm text-slate-800',
        isDragging && 'z-20 shadow-lg ring-2 ring-brand-300')}>
      <button type="button" {...listeners} {...attributes} aria-label={t('roomsMovePerson', { name: p.full_name })}
        className="cursor-grab touch-none rounded-full p-0.5 text-slate-400 hover:bg-white active:cursor-grabbing"><GripVertical size={14} /></button>
      <span className="truncate">{p.full_name}</span>
      {p.gender && <span className="text-xs text-slate-500">{p.gender}</span>}
      {bday && <span title={t('birthdayOnTour')} className="inline-flex items-center gap-0.5 rounded-full bg-pink-50 px-1.5 text-xs font-medium text-pink-800"><Cake size={12} aria-hidden />{fmt(bday, lang)}</span>}
      {onOut && <button type="button" onClick={onOut} aria-label={t('roomsTakeOut', { name: p.full_name })}
        className="rounded-full p-0.5 text-slate-400 hover:bg-white hover:text-red-600"><X size={13} /></button>}
    </span>
  )
}
