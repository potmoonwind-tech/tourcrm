/**
 * Tooltips: a short explanation on hover (after a moment), on keyboard focus (at once) and, for
 * InfoTip, on tap. They add to visible text, never replace it (DESIGN.md: hints are visible text).
 * The trigger gets aria-describedby, so screen readers read the tip too; Escape hides it.
 */
import { Info } from 'lucide-react'
import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

type Side = 'top' | 'bottom'

export function Tooltip({ label, children, side = 'top', pinned, onPinnedChange, describe = true }: {
  label: ReactNode
  describe?: boolean                     // false when the trigger's own name already says it (InfoTip)
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: Side
  pinned?: boolean                       // InfoTip: opened by a tap, stays until tapped again / Escape / outside
  onPinnedChange?: (v: boolean) => void
}) {
  const id = useId()
  const [hover, setHover] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [pos, setPos] = useState<{ left: number; top: number; side: Side } | null>(null)
  const open = (hover || !!pinned) && !!label

  const show = (delay: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setHover(true), delay) }
  const hide = () => { window.clearTimeout(timer.current); setHover(false) }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Place it above (or below when there's no room), kept inside the window.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return setPos(null)
    const a = anchor.current.getBoundingClientRect(), t = tip.current.getBoundingClientRect()
    const below = side === 'bottom' || a.top - t.height - 8 < 4
    const left = Math.min(Math.max(a.left + a.width / 2 - t.width / 2, 8), window.innerWidth - t.width - 8)
    setPos({ left, top: below ? a.bottom + 6 : a.top - t.height - 6, side: below ? 'bottom' : 'top' })
  }, [open, side, label])

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { hide(); onPinnedChange?.(false) } }
    const away = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node)) { hide(); onPinnedChange?.(false) } }
    const scroll = () => { hide(); onPinnedChange?.(false) }
    window.addEventListener('keydown', esc)
    window.addEventListener('pointerdown', away)
    window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('keydown', esc); window.removeEventListener('pointerdown', away); window.removeEventListener('scroll', scroll, true) }
  }, [open, onPinnedChange])

  return (
    <span ref={anchor} className="inline-flex" onMouseEnter={() => show(350)} onMouseLeave={hide}
      onFocus={(e) => { if ((e.target as HTMLElement).matches(':focus-visible')) show(0) }} onBlur={hide}>
      {cloneElement(children, { 'aria-describedby': open && describe ? id : children.props['aria-describedby'] })}
      {open && createPortal(
        <div ref={tip} id={id} role="tooltip" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          className={cn('pointer-events-none fixed z-[200] max-w-72 rounded-lg bg-slate-800 px-2.5 py-1.5 text-[13px] leading-snug text-white shadow-lg',
            !pos && 'invisible')}>
          {label}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** An ⓘ button that explains a term: hover or focus shows it, a tap keeps it open (phones). */
export function InfoTip({ label, className }: { label: string; className?: string }) {
  const [pinned, setPinned] = useState(false)
  return (
    <Tooltip label={label} pinned={pinned} onPinnedChange={setPinned} describe={false}>
      <button type="button" aria-label={label} aria-expanded={pinned} onClick={() => setPinned(!pinned)}
        className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800', className)}>
        <Info size={16} aria-hidden />
      </button>
    </Tooltip>
  )
}
