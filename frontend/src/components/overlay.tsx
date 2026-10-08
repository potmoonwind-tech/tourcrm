/**
 * Overlays and small building blocks of the design system (see DESIGN.md):
 *  - Drawer: a side panel to view or edit ONE record while the list stays visible
 *    (monday's item card). Wide forms, many fields, related lists.
 *  - Dialog: a centered, blocking popup for a decision or a short task (create
 *    something new, confirm, a wizard that needs full attention).
 *  - ask / askText: styled confirmations instead of the browser's confirm()/prompt().
 *  - Menu: the "⋯" button for secondary and destructive actions.
 *  - Label: monday's coloured status label.
 */
import { AlertTriangle, Check, MoreHorizontal, Plus, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Button, IconButton, Input } from './ui'

// Open overlays, innermost last: Escape closes only the top one (a confirmation, not the drawer under it).
const stack: symbol[] = []

function useEscape(onClose: () => void) {
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useEffect(() => {
    const me = Symbol('overlay')
    stack.push(me)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack[stack.length - 1] === me) close.current() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      stack.splice(stack.indexOf(me), 1)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [])
}

const DRAWER_WIDTH = { md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl', full: 'sm:max-w-[min(96vw,1500px)]' }   // full: big working screens (route builder)

export function Drawer({ title, subtitle, onClose, children, footer, size = 'lg', headerActions }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode
  footer?: ReactNode; size?: keyof typeof DRAWER_WIDTH; headerActions?: ReactNode
}) {
  const { t } = useI18n()
  useEscape(onClose)
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="animate-fade absolute inset-0 bg-slate-900/30" onMouseDown={onClose} />
      <aside role="dialog" aria-modal="true"
        className={cn('animate-drawer relative flex h-full w-full flex-col bg-white shadow-xl', DRAWER_WIDTH[size])}>
        <header className="flex items-start gap-3 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold text-slate-800">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
          </div>
          {headerActions}
          <IconButton label={t('close')} onClick={onClose}><X size={20} /></IconButton>
        </header>
        {/* No top padding on the scroller itself: sticky bars inside stick flush to its edge. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6"><div className="py-5">{children}</div></div>
        {footer && <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white px-5 py-3 sm:px-6">{footer}</footer>}
      </aside>
    </div>
  )
}

export function Dialog({ title, onClose, children, wide, footer, top, size }: {
  title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode
  size?: 'xl'     // a working screen in a dialog (the menu builder)
  top?: boolean   // above drawers and dialogs (confirmations)
}) {
  const { t } = useI18n()
  useEscape(onClose)
  return (
    <div className={cn('fixed inset-0 flex items-end justify-center sm:items-center sm:p-4', top ? 'z-[60]' : 'z-50')}>
      <div className="animate-fade absolute inset-0 bg-slate-900/40" onMouseDown={onClose} />
      <div role="dialog" aria-modal="true"
        className={cn('animate-dialog relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl',
          size === 'xl' ? 'sm:max-w-6xl' : wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
          <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
          <IconButton label={t('close')} onClick={onClose}><X size={20} /></IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-6 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

// --- confirmations ----------------------------------------------------------------------

interface AskOptions {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  input?: { placeholder?: string; required?: boolean }
}
type Pending = AskOptions & { resolve: (v: string | null) => void }

let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function open(o: AskOptions): Promise<string | null> {
  return new Promise((resolve) => { pending = { ...o, resolve }; emit() })
}

/** True once `value` differs from what it was when the form opened. */
export function useUnsaved<T>(value: T): boolean {
  const [start] = useState(() => JSON.stringify(value))
  return JSON.stringify(value) !== start
}

/** A close (Esc, ×, backdrop, Cancel) that asks before throwing away unsaved changes. */
export function useGuardedClose(dirty: boolean, onClose: () => void): () => void {
  const { t } = useI18n()
  return () => {
    if (!dirty) return onClose()
    void ask({ title: t('discardChanges'), message: t('discardUnsavedMsg'), confirmLabel: t('discard'), danger: true })
      .then((ok) => ok && onClose())
  }
}

/** Styled confirm: resolves true when confirmed. Pass a string for a simple question. */
export function ask(o: AskOptions | string): Promise<boolean> {
  return open(typeof o === 'string' ? { title: o } : o).then((v) => v !== null)
}

/** Styled prompt: resolves the text, or null when cancelled. */
export function askText(o: AskOptions): Promise<string | null> {
  return open({ ...o, input: o.input ?? { required: true } })
}

/* ---------- Toasts: short feedback after an action ("Saved"). ---------- */
type ToastAction = { label: string; onClick: () => void }
type Toast = { id: number; key: string; tone: 'ok' | 'error'; action?: ToastAction }
let toasts: Toast[] = []
let toastSeq = 0
const toastListeners = new Set<() => void>()

const dropToast = (id: number) => { toasts = toasts.filter((x) => x.id !== id); toastListeners.forEach((l) => l()) }

/** Show a short notice; `key` is an i18n key. Repeats of the same notice replace each other.
 * With an action ("Deleted · Undo") it stays longer and the action is a button. */
export function toast(key: string, tone: Toast['tone'] = 'ok', action?: ToastAction) {
  const id = ++toastSeq
  toasts = [...toasts.filter((x) => x.key !== key), { id, key, tone, action }].slice(-3)
  toastListeners.forEach((l) => l())
  setTimeout(() => dropToast(id), action ? 6000 : 2200)
}

/** Mounted once near the app root (bottom-centre on phones, bottom-right on desktop). */
export function ToastHost() {
  const { t } = useI18n()
  const list = useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l) }, () => toasts)
  if (!list.length) return null
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4 md:right-6 md:left-auto md:items-end">
      {list.map((x) => (
        <div key={x.id} className={cn('animate-rise flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg',
          x.tone === 'ok' ? 'bg-slate-800' : 'bg-red-600', x.action && 'pointer-events-auto py-1.5 pr-1.5')}>
          {x.tone === 'ok' ? <Check size={16} className="text-emerald-400" /> : <X size={16} />}
          {t(x.key as Parameters<typeof t>[0])}
          {x.action && (
            <button type="button" onClick={() => { dropToast(x.id); x.action!.onClick() }}
              className="ml-2 h-8 rounded px-3 font-semibold text-sky-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">
              {x.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Mounted once near the app root; shows whatever ask()/askText() is waiting for. */
export function ConfirmHost() {
  const { t } = useI18n()
  const p = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => pending)
  const [text, setText] = useState('')
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { setText(''); if (p && !p.input) setTimeout(() => ref.current?.focus(), 0) }, [p])
  if (!p) return null
  const done = (v: string | null) => { const r = p.resolve; pending = null; emit(); r(v) }
  const blocked = !!p.input?.required && !text.trim()
  return (
    <Dialog top title={p.title} onClose={() => done(null)}>
      <form onSubmit={(e) => { e.preventDefault(); if (!blocked) done(p.input ? text.trim() : '') }} className="space-y-4">
        {p.message && (
          <p className="flex gap-2 text-sm text-slate-600">
            {p.danger && <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-500" />}{p.message}
          </p>
        )}
        {p.input && <Input autoFocus value={text} placeholder={p.input.placeholder} onChange={(e) => setText(e.target.value)} maxLength={500} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => done(null)}>{t('cancel')}</Button>
          <Button type="submit" ref={ref} variant={p.danger ? 'danger' : 'primary'} disabled={blocked}>{p.confirmLabel ?? t('confirm')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

// --- overflow menu ----------------------------------------------------------------------

export interface MenuItem { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; hidden?: boolean; disabled?: boolean }

/**
 * A list of actions behind one button.
 *  - "⋯" (`kind="more"`, outlined, page headers) or `kind="icon"` (quiet, inside panels and rows):
 *    secondary and destructive actions, so each screen has one clear primary button.
 *  - `kind="add"`: "+ Add …" with a short list of what can be added (tertiary text button).
 *  - `trigger`: any look (e.g. a full-width "+ Add" at the foot of a day column).
 * Arrow keys move between items, Escape closes.
 */
export function Menu({ items, label, kind = 'more', icon, trigger, triggerClassName, full }: {
  items: MenuItem[]; label?: string; kind?: 'more' | 'icon' | 'add'; icon?: ReactNode
  trigger?: ReactNode; triggerClassName?: string; full?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  // The list sits on top of the page (never cut off by a scrolling column), under its button — or above
  // it when there is no room below — and follows it when the page scrolls.
  const [at, setAt] = useState<{ top?: number; bottom?: number; left: number } | null>(null)
  const place = () => {
    const b = ref.current?.getBoundingClientRect()
    if (!b) return
    const h = (list.current?.offsetHeight ?? 0) || 44 + 36 * items.filter((i) => !i.hidden).length
    const w = Math.max(list.current?.offsetWidth ?? 0, 208)
    const left = Math.min(Math.max(8, b.right - w), window.innerWidth - w - 8)
    const below = window.innerHeight - b.bottom
    setAt(below >= h + 8 || below >= b.top ? { top: b.bottom + 4, left } : { bottom: window.innerHeight - b.top + 4, left })
  }
  useLayoutEffect(() => { if (open) place() }, [open])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    setTimeout(() => { place(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, 0)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps
  const shown = items.filter((i) => !i.hidden)
  if (!shown.length) return null
  // "+ Add" with only one thing to add: the button does it, no list of one.
  if (kind === 'add' && !trigger && shown.length === 1) {
    const only = shown[0]
    return (
      <Button variant="tertiary" size="sm" disabled={only.disabled} onClick={only.onClick} title={only.label === label ? undefined : only.label}>
        {icon ?? <Plus size={16} />}{label}
      </Button>
    )
  }
  const toggle = () => setOpen(!open)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); (ref.current?.querySelector('[aria-haspopup]') as HTMLElement | null)?.focus() }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const btns = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const at = btns.indexOf(document.activeElement as HTMLButtonElement)
    btns[(at + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus()
    e.preventDefault()
  }
  const name = label ?? t('moreActions')
  return (
    <div ref={ref} className={cn('relative', full && 'w-full')} onKeyDown={onKey}>
      {trigger ? (
        <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle}
          className={cn('focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600', triggerClassName)}>{trigger}</button>
      ) : kind === 'icon' ? (
        <IconButton size="sm" label={name} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>{icon ?? <MoreHorizontal size={16} />}</IconButton>
      ) : kind === 'add' ? (
        <Button variant="tertiary" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>{icon ?? <Plus size={16} />}{label}</Button>
      ) : (
        <Button type="button" variant="secondary" className={cn("min-w-10", label ? "" : "w-10 px-0")} aria-label={name} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <MoreHorizontal size={16} />{label}
        </Button>
      )}
      {open && createPortal(
        <ul ref={list} role="menu" onKeyDown={onKey} style={at ?? { top: -9999, left: -9999 }}
          className="animate-pop fixed z-[70] max-h-[min(24rem,80vh)] min-w-52 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {shown.map((i) => (
            <li key={i.label}>
              <button type="button" role="menuitem" disabled={i.disabled} onClick={() => { setOpen(false); i.onClick() }}
                className={cn('flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-40',
                  i.danger ? 'text-red-600' : 'text-slate-700')}>
                {i.icon && <span className={cn('flex w-4 justify-center', !i.danger && 'text-slate-500')}>{i.icon}</span>}{i.label}
              </button>
            </li>
          ))}
        </ul>, document.body,
      )}
    </div>
  )
}

// --- status label ------------------------------------------------------------------------

/** monday's status colours: done, working on it, stuck, and the rest of the palette. */
export const TONE = {
  green: 'bg-emerald-500 text-white',
  orange: 'bg-amber-500 text-white',
  red: 'bg-red-500 text-white',
  blue: 'bg-sky-500 text-white',
  purple: 'bg-violet-500 text-white',
  dark: 'bg-slate-700 text-white',
  grey: 'bg-slate-300 text-slate-800',
  light: 'bg-slate-100 text-slate-600',
} as const
export type Tone = keyof typeof TONE

/** A status label: solid colour, white text, fixed width so a column of them lines up. */
export function Label({ tone, children, className, wide = true }: { tone: Tone; children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <span className={cn('inline-flex items-center justify-center whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium',
      wide && 'min-w-24', TONE[tone], className)}>
      {children}
    </span>
  )
}
