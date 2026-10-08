/**
 * Home: the widgets this person chose (or their role's default), and a "Customize" drawer
 * to switch widgets on and off, reorder them by dragging and make them half or full width.
 * The layout is saved on the server per person and agency, so it follows them to any device.
 */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Columns2, GripVertical, LayoutGrid, Plus, RectangleHorizontal, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { ask, Drawer } from '../components/overlay'
import { Button } from '../components/ui'
import { allowedFor, defaultLayout, GROUPS, widgetById, type WidgetPick } from '../components/widgets'
import { useSetup } from '../components/GetStarted'
import { api } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n, type TKey } from '../lib/i18n'
import { useMe, useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { PageHeader } from './Dashboard'

function useLayout() {
  const ws = useWorkspace()!
  const qc = useQueryClient()
  const key = ['homeLayout', ws.id]
  const q = useQuery({ queryKey: key, queryFn: () => api<{ widgets: WidgetPick[] | null }>(wsPath(ws.id, '/dashboard/layout')) })
  const save = useMutation({
    mutationFn: (widgets: WidgetPick[] | null) => widgets === null
      ? api(wsPath(ws.id, '/dashboard/layout'), { method: 'DELETE' }).then(() => ({ widgets: null }))
      : api<{ widgets: WidgetPick[] | null }>(wsPath(ws.id, '/dashboard/layout'), { method: 'PUT', body: { widgets } }),
    onMutate: (widgets) => qc.setQueryData(key, { widgets }),      // instant; the server copy follows
    onSuccess: (data) => qc.setQueryData(key, data),
    meta: { silent: true },
  })
  const allowed = new Set(allowedFor(ws).map((w) => w.id))
  // Widgets that no longer exist or that the role may not see are skipped, never shown.
  const custom = q.data?.widgets?.filter((w) => allowed.has(w.id)) ?? null
  // Day one: until the first tour exists, the default Home is just the setup guide — no empty charts.
  const setup = useSetup()
  const fresh = setup.data?.tours === 0
  const widgets = custom ?? (fresh ? defaultLayout(ws).filter((w) => w.id === 'get_started') : defaultLayout(ws))
  return { ready: q.isSuccess && setup.isSuccess, widgets, isDefault: custom === null, fresh: custom === null && fresh, save: save.mutate }
}

export function DashboardPage() {
  const ws = useWorkspace()!
  const { data: me } = useMe()
  const { t } = useI18n()
  const firstName = (me?.user.full_name || '').split(' ')[0]
  const isGuide = ws.role === 'guide'
  const layout = useLayout()
  const [customizing, setCustomizing] = useState(false)

  return (
    <>
      <PageHeader title={`${t('hello')}${firstName ? `, ${firstName}` : ''}`} subtitle={ws.name}
        action={!isGuide && !layout.fresh && <Button variant="secondary" onClick={() => setCustomizing(true)}><LayoutGrid size={16} />{t('customizeHome')}</Button>} />
      <div className="p-4 md:p-8">
        {isGuide ? <p className="text-slate-600">{t('guideNotice')}</p> : layout.ready && (
          layout.widgets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
              <p className="font-semibold text-slate-700">{t('homeEmpty')}</p>
              <p className="mt-1 text-sm text-slate-500">{t('homeEmptyHint')}</p>
              <Button className="mt-4" onClick={() => setCustomizing(true)}><Plus size={16} />{t('addWidgets')}</Button>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2 min-[1800px]:grid-cols-3">
              {layout.widgets.map((w) => (
                // empty:hidden — a widget with nothing to say (e.g. "Get started" when done) leaves no gap.
                <div key={w.id} className={cn('min-w-0 empty:hidden', w.size === 'full' && 'col-span-full')}>
                  {widgetById.get(w.id)?.render()}
                </div>
              ))}
            </div>
          )
        )}
      </div>
      {customizing && <CustomizeDrawer layout={layout} onClose={() => setCustomizing(false)} />}
    </>
  )
}

function CustomizeDrawer({ layout, onClose }: { layout: ReturnType<typeof useLayout>; onClose: () => void }) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const shown = layout.widgets
  const set = (next: WidgetPick[]) => layout.save(next)
  const hidden = allowedFor(ws).filter((w) => !shown.some((s) => s.id === w.id))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = shown.findIndex((w) => w.id === active.id)
    const to = shown.findIndex((w) => w.id === over.id)
    set(arrayMove(shown, from, to))
  }
  const reset = () => void ask({ title: t('resetHome'), message: t('resetHomeMsg') }).then((ok) => ok && layout.save(null))

  return (
    <Drawer size="md" title={t('customizeHome')} subtitle={t('customizeHomeHelp')} onClose={onClose}>
      <div className="space-y-6">
        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('onYourHome')} · {shown.length}</h3>
          {shown.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">{t('homeEmptyHint')}</p>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown.map((w) => w.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {shown.map((w) => (
                  <ShownRow key={w.id} w={w}
                    onSize={(size) => set(shown.map((x) => (x.id === w.id ? { ...x, size } : x)))}
                    onRemove={() => set(shown.filter((x) => x.id !== w.id))} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </section>

        {hidden.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('addWidgets')}</h3>
            <div className="space-y-4">
              {GROUPS.map((g) => {
                const list = hidden.filter((w) => w.group === g)
                if (!list.length) return null
                return (
                  <div key={g}>
                    <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">{t(`wgroup_${g}` as TKey)}</p>
                    <ul className="space-y-2">
                      {list.map((w) => (
                        <li key={w.id} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{t(`w_${w.id}` as TKey)}</span>
                            <span className="block text-xs text-slate-500">{t(`wd_${w.id}` as TKey)}</span>
                          </span>
                          <Button size="sm" variant="secondary" onClick={() => set([...shown, { id: w.id, size: w.size }])}><Plus size={14} />{t('add')}</Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <span className="text-xs text-slate-500">{layout.isDefault ? t('homeIsDefault') : t('homeIsCustom')}</span>
          {!layout.isDefault && <Button size="sm" variant="ghost" onClick={reset}><RotateCcw size={14} />{t('resetHomeShort')}</Button>}
        </div>
      </div>
    </Drawer>
  )
}

function ShownRow({ w, onSize, onRemove }: { w: WidgetPick; onSize: (s: WidgetPick['size']) => void; onRemove: () => void }) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-2 rounded-lg border bg-white px-2 py-2', isDragging ? 'z-10 border-brand-400 shadow-lg' : 'border-slate-200')}>
      <button type="button" {...attributes} {...listeners} aria-label={t('dragWidget')} title={t('dragWidget')}
        className="cursor-grab touch-none rounded-md p-1 text-slate-400 hover:bg-slate-100 active:cursor-grabbing"><GripVertical size={16} /></button>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{t(`w_${w.id}` as TKey)}</span>
        <span className="block truncate text-xs text-slate-500">{t(`wd_${w.id}` as TKey)}</span>
      </span>
      <div className="hidden overflow-hidden rounded-md border border-slate-200 lg:flex" role="group" aria-label={t('widgetWidth')}>
        {(['half', 'full'] as const).map((s) => (
          <button key={s} type="button" onClick={() => onSize(s)} title={t(s === 'half' ? 'widthHalf' : 'widthFull')} aria-pressed={w.size === s}
            className={cn('p-1.5', w.size === s ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:bg-slate-50')}>
            {s === 'half' ? <Columns2 size={15} /> : <RectangleHorizontal size={15} />}
          </button>
        ))}
      </div>
      <button type="button" onClick={onRemove} aria-label={t('removeWidget')} title={t('removeWidget')}
        className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={15} /></button>
    </li>
  )
}
