import { isValidElement, type ComponentProps, type ReactNode, type SelectHTMLAttributes } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Check, ChevronRight, Minus, Plus } from 'lucide-react'
import type { Role } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { InfoTip, Tooltip } from './Tooltip'

/*
 * Building blocks, sized to the design system (DESIGN.md, monday's Vibe):
 *   controls 40px (md) or 32px (sm) tall · 4px corners · 14px text · icons 16px
 *   one focus style (brand ring) · one disabled style · cards 8px corners
 * Screens compose these; they don't restyle them.
 */

type Variant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'
// Vibe button kinds: primary (one per screen), secondary (outlined), tertiary/ghost (text), danger.
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-100',
  tertiary: 'text-brand-700 hover:bg-brand-50',   // "+ Add …" inside a panel: text only, brand colour
  ghost: 'text-slate-700 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
}
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600'
const disabled = 'disabled:pointer-events-none disabled:opacity-40'

const buttonClass = (variant: Variant, size: Size, className?: string) => cn(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded font-medium transition duration-150 ease-out active:scale-[0.98]',
  focus, disabled,
  size === 'md' ? 'h-10 px-4 text-sm' : 'h-8 px-2 text-sm',
  variants[variant], className,
)

/** A plain button unless it says type="submit": an action inside a form (add a step, re-time) must
 * never save and close the whole form. */
export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...props }:
  ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />
}

/** A link that looks like a button (for "go there" actions, e.g. in empty states). */
export function ButtonLink({ variant = 'secondary', size = 'md', className, ...props }:
  LinkProps & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />
}

/** An icon-only button: 32/36/40px target, 16px icon, always labelled - read aloud and shown as a tooltip. */
export function IconButton({ label, size = 'md', tone = 'default', className, children, type = 'button', ...props }:
  Omit<ComponentProps<'button'>, 'aria-label'> & { label: string; size?: 'sm' | 'md' | 'lg'; tone?: 'default' | 'danger' }) {
  return (
    <Tooltip label={label} describe={false}>
      <button type={type} aria-label={label} {...props}
        className={cn('inline-flex shrink-0 items-center justify-center rounded text-slate-600 transition duration-150 ease-out active:scale-95', focus, disabled,
          size === 'sm' ? 'h-8 w-8' : size === 'md' ? 'h-9 w-9' : 'h-10 w-10',
          tone === 'danger' ? 'hover:bg-red-50 hover:text-red-600' : 'hover:bg-slate-100 hover:text-slate-800', className)}>
        {children}
      </button>
    </Tooltip>
  )
}

const fieldBase = 'w-full rounded border border-slate-300 bg-white text-sm text-slate-800 ' +
  'placeholder:text-slate-500 hover:border-slate-800 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 ' +
  'disabled:bg-slate-50 disabled:text-slate-500 disabled:hover:border-slate-300 aria-[invalid=true]:border-red-500'
const fieldSize = (size: Size) => (size === 'md' ? 'h-10 px-3' : 'h-8 px-2')
/** The text-field look, for the few inputs that can't use Input (40px). */
export const field = cn(fieldBase, 'h-10 px-3')

// ComponentProps includes `ref`, which React 19 passes through like any prop.
export function Input({ className, size = 'md', ...props }: Omit<ComponentProps<'input'>, 'size'> & { size?: Size }) {
  return <input className={cn(fieldBase, fieldSize(size), props.type === 'number' && 'tabular-nums', className)} {...props} />
}

export function Select({ className, size = 'md', ...props }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: Size }) {
  return <select className={cn(fieldBase, fieldSize(size), 'select-chevron cursor-pointer pr-8', className)} {...props} />
}

export function Textarea({ className, size = 'md', ...props }: Omit<ComponentProps<'textarea'>, 'size'> & { size?: Size }) {
  return <textarea className={cn(fieldBase, size === 'md' ? 'min-h-20 px-3 py-2' : 'min-h-16 px-2 py-1.5', 'resize-y', className)} {...props} />
}

/** A number with its unit joined on the right ("40 | USD", "15 | %"). */
export function NumberInput({ unit, size = 'md', className, ...props }: Omit<ComponentProps<'input'>, 'size' | 'type'> & { unit?: ReactNode; size?: Size }) {
  return (
    <span className={cn('inline-flex items-stretch', className)}>
      <input type="number" {...props}
        className={cn(fieldBase, fieldSize(size), 'min-w-0 text-right tabular-nums', unit !== undefined && 'rounded-r-none')} />
      {unit !== undefined && (
        <span className={cn('inline-flex items-center rounded-r border border-l-0 border-slate-300 bg-slate-50 text-sm text-slate-500', size === 'md' ? 'px-3' : 'px-2')}>{unit}</span>
      )}
    </span>
  )
}

export function Field({ label, hint, info, children, required, className }: {
  label: string; hint?: string; info?: string; children: ReactNode; required?: boolean; className?: string
}) {
  const must = required ?? (isValidElement<{ required?: boolean }>(children) && !!children.props.required)
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="flex min-h-5 items-center gap-0.5 text-sm font-medium text-slate-700">{label}{must && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
        {info && <InfoTip label={info} className="-my-1.5" />}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

/** Compact field: a small caption above the input (for one-row forms). */
export function MiniField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-slate-200 bg-white', className)}>{children}</div>
}

/**
 * A part of a working screen, always built the same way:
 *
 *   [›] [icon] Title                               value   [+ Add]  [⋯]
 *              one line: what's in it / what it's for
 *   ───────────────────────────────────────────────────────────────────
 *   content (16px padding)
 *
 * Left = what it is and fold/unfold (the arrow belongs to the title, like monday's groups);
 * right = what it adds up to, then its actions: at most one "+ Add" (tertiary) and a "⋯" menu.
 */
export function Panel({ id, icon, title, subtitle, value, actions, open = true, onToggle, children, className }: {
  id?: string; icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; value?: ReactNode; actions?: ReactNode
  open?: boolean; onToggle?: () => void; children?: ReactNode; className?: string
}) {
  const head = (
    <>
      {onToggle && <ChevronRight size={16} aria-hidden className={cn('shrink-0 text-slate-500 transition-transform', open && 'rotate-90')} />}
      {icon && <span className="flex w-5 shrink-0 justify-center text-slate-500" aria-hidden>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold leading-6 text-slate-800">{title}</span>
        {subtitle && <span className="block truncate text-sm text-slate-500">{subtitle}</span>}
      </span>
    </>
  )
  return (
    <section id={id} className={cn('scroll-mt-16 rounded-xl border border-slate-200 bg-white', className)}>
      <div className="flex min-h-16 items-center gap-2 py-2 pl-3 pr-3 sm:pl-4">
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded={open}
            className={cn('-my-2 -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded py-2 pl-1 text-left', focus)}>{head}</button>
        ) : <div className="flex min-w-0 flex-1 items-center gap-2">{head}</div>}
        {value !== undefined && value !== null && <span className="hidden shrink-0 text-sm font-medium tabular-nums text-slate-700 sm:inline">{value}</span>}
        {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
      </div>
      {open && children && <div className="animate-reveal border-t border-slate-200 p-4">{children}</div>}
    </section>
  )
}

/** A row in a list you edit: what it is on the left, a short read-out of its settings, a quick
 * control (a count) and "⋯". The row itself opens the full editor (a drawer). */
export function ListRow({ lead, title, meta, onOpen, control, menu, muted }: {
  lead?: ReactNode; title: ReactNode; meta?: ReactNode; onOpen?: () => void; control?: ReactNode; menu?: ReactNode; muted?: boolean
}) {
  return (
    <div className={cn('group flex min-h-14 items-center gap-3 rounded-lg border border-slate-200 bg-white pl-3 pr-1 transition duration-200 ease-out hover:-translate-y-px hover:border-slate-300 hover:shadow-md', muted && 'opacity-60')}>
      {lead}
      <button type="button" onClick={onOpen} disabled={!onOpen} className={cn('min-w-0 flex-1 rounded py-2 text-left', focus)}>
        <span className="block truncate text-sm font-medium text-slate-800">{title}</span>
        {meta && <span className="block truncate text-sm text-slate-500">{meta}</span>}
      </button>
      {control}
      {menu}
    </div>
  )
}

/** A toggle or filter: 32px pill; on = light brand with a check (never solid: that's the primary button's colour). */
export function Chip({ on, onClick, children, className, title }: { on?: boolean; onClick?: () => void; children: ReactNode; className?: string; title?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} title={title}
      className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition duration-150 ease-out active:scale-[0.97]', focus,
        on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50', className)}>
      {on && <Check size={14} aria-hidden />}{children}
    </button>
  )
}

/** Small metadata or a count next to a title (status uses Label). */
export function Badge({ tone = 'neutral', className, children }: { tone?: 'neutral' | 'brand' | 'red' | 'amber' | 'green'; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex h-5 min-w-5 items-center justify-center whitespace-nowrap rounded-full px-1.5 text-xs font-semibold tabular-nums',
      { neutral: 'bg-slate-100 text-slate-700', brand: 'bg-brand-100 text-brand-800', red: 'bg-red-600 text-white',
        amber: 'bg-amber-100 text-amber-900', green: 'bg-emerald-50 text-emerald-700' }[tone], className)}>
      {children}
    </span>
  )
}

/** One choice of a few, side by side (Day / Week, Pays / Free / Works). */
export function SegmentedControl<V extends string>({ value, options, onChange, size = 'md', label, className }: {
  value: V; options: [V, ReactNode][]; onChange: (v: V) => void; size?: Size; label: string; className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className={cn('no-scrollbar inline-flex max-w-full overflow-x-auto rounded border border-slate-300 bg-white p-0.5', size === 'md' ? 'h-10' : 'h-8', className)}>
      {options.map(([v, text]) => (
        <button type="button" role="radio" aria-checked={v === value} key={v} onClick={() => onChange(v)}
          onKeyDown={(e) => {
            const i = options.findIndex(([x]) => x === value)
            if (e.key === 'ArrowRight') onChange(options[(i + 1) % options.length][0])
            if (e.key === 'ArrowLeft') onChange(options[(i - 1 + options.length) % options.length][0])
          }}
          className={cn('shrink-0 whitespace-nowrap rounded-sm px-3 text-sm font-medium transition-colors', focus,
            v === value ? 'bg-brand-100 text-brand-800' : 'text-slate-700 hover:bg-slate-100')}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** − value + (counts: buses, people). */
export function Stepper({ value, onChange, min = 0, max = 99, label, size = 'sm' }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; label: string; size?: Size
}) {
  const { t } = useI18n()
  return (
    <span className="inline-flex items-center gap-0.5" role="group" aria-label={label}
      onKeyDown={(e) => { if (e.key === 'ArrowUp' && value < max) onChange(value + 1); if (e.key === 'ArrowDown' && value > min) onChange(value - 1) }}>
      <IconButton size={size} label={`${t('fewer')} · ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={16} /></IconButton>
      <span className="w-8 text-center text-sm font-semibold tabular-nums">{value}</span>
      <IconButton size={size} label={`${t('more')} · ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={16} /></IconButton>
    </span>
  )
}

/** A key number: caption, value (24px, or 32px hero), small line under it. */
export function Stat({ label, value, sub, hero, tone, className }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; hero?: boolean; tone?: 'good' | 'bad'; className?: string
}) {
  return (
    <div className={className}>
      <div className="text-sm text-slate-500">{label}</div>
      <div className={cn('font-semibold tabular-nums', hero ? 'text-[32px] leading-10' : 'text-2xl leading-8',
        tone === 'good' && 'text-emerald-700', tone === 'bad' && 'text-red-600')}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

/** A choice with consequences, as a card (DESIGN: "choices with consequences are cards"). */
export function ChoiceCard({ selected, onClick, icon, title, hint }: { selected: boolean; onClick: () => void; icon?: ReactNode; title: string; hint?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={cn('flex items-start gap-3 rounded-xl border p-4 text-left transition-colors', focus,
        selected ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:border-slate-300')}>
      {icon && <span className={cn('mt-0.5 shrink-0', selected ? 'text-brand-600' : 'text-slate-500')}>{icon}</span>}
      <span className="min-w-0"><span className="block text-sm font-semibold">{title}</span>{hint && <span className="mt-0.5 block text-sm text-slate-500">{hint}</span>}</span>
    </button>
  )
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
      {error instanceof Error ? error.message : String(error)}
    </p>
  )
}

// Monday-style coloured status pills, one colour per role.
const roleColors: Record<Role, string> = {
  owner: 'bg-violet-100 text-violet-800',
  admin: 'bg-brand-100 text-brand-800',
  manager: 'bg-emerald-50 text-emerald-700',
  staff: 'bg-amber-100 text-amber-900',
  guide: 'bg-slate-100 text-slate-700',
}

export function RoleBadge({ role }: { role: Role }) {
  const { t } = useI18n()
  return (
    <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold', roleColors[role])}>
      {t(`role_${role}`)}
    </span>
  )
}

export function Spinner() {
  return <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600" />
}

export function FullPageSpinner() {
  return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>
}

export function LangToggle({ className }: { className?: string }) {
  const { lang, setLang } = useI18n()
  return (
    <SegmentedControl size="sm" label="Language" value={lang} onChange={(l) => setLang(l)} className={className}
      options={[['ka', 'KA'], ['en', 'EN']]} />
  )
}
