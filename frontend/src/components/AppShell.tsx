import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Sparkles,
  AlertOctagon, BarChart3, Building2, Calculator, Check, ChevronsUpDown, Contact,
  Inbox, LayoutDashboard, ListTodo, LogOut, UserPlus, Map as MapIcon, Menu, Plus, Settings, X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, atLeast, can, type Job } from '../lib/api'
import { useI18n, type TKey } from '../lib/i18n'
import { setViewAs, useMe, useViewAs, useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { LangToggle } from './ui'
import { AlertBell } from './Alerts'
import { useTaskSummary } from '../lib/data'
import { SearchButton } from './Search'
import { sectionOf, type Section } from './SectionNav'
import { Tooltip } from './Tooltip'

interface NavItem { to: string; label: TKey; icon: ReactNode; soon?: boolean; badge?: number; tone?: 'orange' | 'red'; section?: Section }

/** What needs attention, as counts on the menu: open incidents; overdue vendor payments. */
function useNavCounts(office: boolean, manager: boolean) {
  const ws = useWorkspace()!
  const incidents = useQuery({
    queryKey: ['incidents', ws.id, 'status=open'], enabled: office, staleTime: 60_000,
    queryFn: () => api<unknown[]>(`/workspaces/${ws.id}/incidents?status=open`),
  })
  const overdue = useQuery({
    queryKey: ['schedule', ws.id, 'status=overdue'], enabled: manager, staleTime: 60_000,
    queryFn: () => api<{ items: unknown[] }>(`/workspaces/${ws.id}/payments/schedule?status=overdue`),
  })
  return { incidents: incidents.data?.length ?? 0, overdue: overdue.data?.items.length ?? 0 }
}

export function AppShell() {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const base = `/w/${ws.id}`
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setMenuOpen(false), [pathname])
  // A new page starts at the top of the panel (the panel scrolls, not the window).
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.scrollTo({ top: 0 }) }, [pathname])
  // Guides use their own (upcoming) portal; the office screens would only 403 for them.
  const office = atLeast(ws.role, 'staff')
  // One entry per section, most used first; a section's pages are tabs on its page (DESIGN.md).
  const ops = can(ws, 'operations'), fin = can(ws, 'finance'), sells = can(ws, 'sales')
  const counts = useNavCounts(office, fin)
  const tasks = useTaskSummary(office)
  const groups: NavItem[][] = [
    [
      { to: base, label: 'dashboard', icon: <LayoutDashboard size={18} /> },
      ...(office ? [{ to: `${base}/tasks`, label: 'myTasks', icon: <ListTodo size={18} />, badge: tasks.data?.mine, tone: tasks.data?.late ? 'red' : 'orange' } satisfies NavItem] : []),
      ...(ops ? [{ to: `${base}/assistant`, label: 'assistant', icon: <Sparkles size={18} /> } satisfies NavItem] : []),
    ],
    ...(office ? [
      [
        { to: `${base}/tours`, label: 'tours', icon: <MapIcon size={18} />, section: 'tours' },
        { to: `${base}/incidents`, label: 'incidents', icon: <AlertOctagon size={18} />, badge: counts.incidents, tone: 'orange' },
      ] satisfies NavItem[],
      [
        ...(ops || sells || fin ? [{ to: `${base}/calculations`, label: 'calculations', icon: <Calculator size={18} /> } satisfies NavItem] : []),
        { to: `${base}/clients`, label: 'clients', icon: <Contact size={18} /> },
        { to: `${base}/routes`, label: 'catalog', icon: <Building2 size={18} />, section: 'catalog' },
      ] satisfies NavItem[],
      ...(fin || sells ? [[
        { to: `${base}/finance`, label: 'finance', icon: <BarChart3 size={18} />, section: 'finance', badge: counts.overdue, tone: 'red' },
      ] satisfies NavItem[]] : []),
    ] : []),
  ]
  const settings: NavItem = { to: `${base}/settings/general`, label: 'settings', icon: <Settings size={18} />, section: 'settings' }

  return (
    // monday-style: a top bar across the page, the menu under it, and pages on a white panel.
    // From md up the window never scrolls: the white panel scrolls inside, so its rounded corners always show.
    <div className="min-h-screen bg-[var(--color-app-bg)] md:h-screen md:overflow-hidden">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 bg-[var(--color-app-bg)] px-2 md:gap-3 md:px-4">
        <button type="button" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 md:hidden" onClick={() => setMenuOpen(true)} aria-label={t('menu')}>
          <Menu size={20} />
        </button>
        {/* The agency is the identity here (not the product): its name, your role, and the switcher. */}
        <div className="w-auto shrink-0 md:w-56"><WorkspaceSwitcher /></div>
        <div className="flex min-w-0 flex-1 justify-center px-2">
          {office && <SearchButton variant="pill" className="hidden w-full max-w-xl md:flex" />}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {office && <SearchButton shortcut={false} className="md:hidden" />}
          {office && (
            <Link to={`${base}/tasks`} title={t('myTasks')} aria-label={t('myTasks')}
              className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100">
              <Inbox size={19} />
              {!!tasks.data?.mine && (
                <span className={cn('absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-white',
                  tasks.data.late ? 'bg-red-500' : 'bg-brand-600')}>{tasks.data.mine}</span>
              )}
            </Link>
          )}
          {office && <AlertBell />}
          {atLeast(ws.realRole ?? ws.role, 'admin') && <ViewAsSwitch />}
          {atLeast(ws.role, 'admin') && (
            <Link to={`${base}/settings/team`} title={t('stepInvite')} aria-label={t('stepInvite')}
              className="hidden rounded-lg p-2 text-slate-600 hover:bg-slate-100 sm:block"><UserPlus size={19} /></Link>
          )}
          <span className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />
          <UserMenu />
        </div>
      </header>
      {ws.viewAs && (
        <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-violet-700 px-4 py-1.5 text-sm text-white">
          <Eye size={16} aria-hidden />
          <span>{t('viewingAs', { who: t(`viewAs_${ws.viewAs}` as TKey) })}</span>
          <button type="button" onClick={() => setViewAs(null)} className="rounded-md bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25">{t('viewAsBack')}</button>
        </div>
      )}
      <div className="flex">
        {menuOpen && <div className="fixed inset-0 z-40 bg-slate-900/40 md:hidden" onClick={() => setMenuOpen(false)} />}
        {/* Off-canvas on phones; under the top bar from md up. */}
        <aside className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-[var(--color-app-bg)] transition-transform',
          'md:static md:z-30 md:h-[calc(100vh-3.5rem)] md:w-60 md:shrink-0 md:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}>
          <div className="flex items-center justify-end p-2 md:hidden">
            <button type="button" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" onClick={() => setMenuOpen(false)} aria-label={t('close')}>
              <X size={18} />
            </button>
          </div>
          <div className="h-2 max-md:hidden" />
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
            {groups.map((g, i) => (
              <div key={i} className={cn('space-y-0.5', i > 0 && 'mt-2 border-t border-slate-200 pt-2')}>
                {g.map((n) => <NavRow key={n.to} item={n} end={n.to === base} />)}
              </div>
            ))}
          </nav>
          <div className="border-t border-slate-200 px-3 py-2"><NavRow item={settings} /></div>
        </aside>
        <main className="min-w-0 flex-1 md:h-[calc(100vh-3.5rem)] md:pb-3 md:pr-3">
          {/* relative: hidden screen-reader text (absolute) stays inside the scrolling panel instead of
              stretching the whole window, which made a second scrollbar and empty space below. */}
          <div ref={panel} className="relative min-h-[calc(100vh-3.5rem)] bg-white md:h-full md:min-h-0 md:overflow-y-auto md:rounded-2xl md:border md:border-slate-200">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

function NavRow({ item, end }: { item: NavItem; end?: boolean }) {
  const { t } = useI18n()
  const ws = useWorkspace()!
  const { pathname } = useLocation()
  // A section entry stays active on every page of the section (its views).
  const inSection = !!item.section && sectionOf(pathname.replace(`/w/${ws.id}/`, '')) === item.section
  if (item.soon) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400">
        {item.icon}<span className="flex-1">{t(item.label)}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase">{t('soon')}</span>
      </div>
    )
  }
  return (
    <NavLink to={item.to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors',
        isActive || inSection ? 'bg-brand-100 font-medium text-slate-800' : 'text-slate-700 hover:bg-slate-100',
      )}>
      {item.icon}<span className="flex-1">{t(item.label)}</span>
      {!!item.badge && (
        <span className={cn('min-w-5 rounded-full px-1.5 text-center text-xs font-semibold leading-5 text-white',
          item.tone === 'red' ? 'bg-red-500' : 'bg-amber-500')}>{item.badge}</span>
      )}
    </NavLink>
  )
}

export function WorkspaceAvatar({ name, className }: { name: string; className?: string }) {
  // Stable colour per workspace so agencies are easy to tell apart in the switcher.
  const palette = ['bg-brand-600', 'bg-emerald-600', 'bg-amber-500', 'bg-rose-500', 'bg-sky-600', 'bg-violet-600']
  const idx = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length
  return (
    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white', palette[idx], className)}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

function WorkspaceSwitcher() {
  const { data: me } = useMe()
  const ws = useWorkspace()!
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-slate-100">
        <WorkspaceAvatar name={ws.name} />
        <span className="min-w-0 flex-1 max-sm:hidden">
          <span className="block truncate text-sm font-semibold">{ws.name}</span>
          <span className="block text-xs text-slate-500">{t(`role_${ws.role}`)}</span>
        </span>
        <ChevronsUpDown size={16} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {me?.workspaces.map((w) => (
            <Link key={w.id} to={`/w/${w.id}`} onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg p-2 text-sm hover:bg-slate-100">
              <WorkspaceAvatar name={w.name} className="h-6 w-6 text-xs" />
              <span className="flex-1 truncate">{w.name}</span>
              {w.id === ws.id && <Check size={16} className="text-brand-600" />}
            </Link>
          ))}
          <div className="my-1 border-t border-slate-100" />
          <Link to="/new-workspace" onClick={() => setOpen(false)}
            className="flex items-center gap-3 rounded-lg p-2 text-sm text-slate-600 hover:bg-slate-100">
            <Plus size={16} className="mx-1" />{t('newWorkspace')}
          </Link>
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const { data: me } = useMe()
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' })
    qc.clear()
    navigate('/login')
  }
  const name = me?.user.full_name || me?.user.email || ''
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t('account')} aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-500 text-sm font-semibold text-white ring-2 ring-white hover:bg-violet-600">
        {initials || '?'}
      </button>
      {open && (
        <div className="animate-fade absolute right-0 z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-semibold">{me?.user.full_name || me?.user.email}</p>
            <p className="truncate text-xs text-slate-500">{me?.user.email} · {t(`role_${ws.role}`)}</p>
          </div>
          <div className="flex items-center justify-between px-2 py-2 text-sm text-slate-600">{t('language')}<LangToggle /></div>
          <div className="my-1 border-t border-slate-100" />
          <Link to={`/w/${ws.id}/settings/general`} onClick={() => setOpen(false)}
            className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-slate-100"><Settings size={16} />{t('settings')}</Link>
          <button type="button" onClick={logout}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-slate-100"><LogOut size={16} />{t('logout')}</button>
        </div>
      )}
    </div>
  )
}

/** Owners and admins see the app as someone with one job would: menus, tabs and Home change. */
function ViewAsSwitch() {
  const { t } = useI18n()
  const v = useViewAs()
  return (
    <Tooltip label={t('viewAsTip')}>
      <label className="hidden items-center gap-1 rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 lg:flex">
        <Eye size={17} aria-hidden />
        <span className="sr-only">{t('viewAs')}</span>
        <select value={v ?? ''} onChange={(e) => setViewAs((e.target.value || null) as Job | 'guide' | null)} aria-label={t('viewAs')}
          className="border-0 bg-transparent py-0 pl-1 pr-6 text-sm font-medium text-slate-700 focus:ring-2 focus:ring-brand-100">
          <option value="">{t('viewAsMe')}</option>
          {(['operations', 'finance', 'sales', 'guide'] as const).map((j) => <option key={j} value={j}>{t(`viewAs_${j}` as TKey)}</option>)}
        </select>
      </label>
    </Tooltip>
  )
}
