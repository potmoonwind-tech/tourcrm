import { Navigate, Outlet, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { FullPageSpinner, Spinner } from './components/ui'
import { useEffect } from 'react'
import { useI18n } from './lib/i18n'
import { applyTheme } from './lib/theme'
import { LoginPage, SignupPage } from './pages/Auth'
import { ClientsPage, VendorsPage } from './pages/Catalog'
import { FieldPage } from './pages/Field'
import { SeriesPage } from './pages/SeriesPage'
import { DashboardPage } from './pages/Home'
import { DayViewPage } from './pages/DayView'
import { CalcEditorPage } from './pages/CalcEditor'
import { CalculationsPage } from './pages/Calculations'
import { FinancePage } from './pages/Finance'
import { PriceListPrintPage } from './pages/PriceListPrint'
import { ImportPage } from './pages/ImportPage'
import { InvoicePrintPage } from './pages/InvoicePrint'
import { PaymentsPage } from './pages/Payments'
import { IncidentsPage } from './pages/Incidents'
import { TasksPage } from './pages/Tasks'
import { AssistantPage } from './pages/Assistant'
import { PriceCatalogPage } from './pages/PriceCatalog'
import { RoutesPage } from './pages/Routes'
import { TimelinePage } from './pages/Timeline'
import { RoomsByNightPage } from './pages/RoomsByNight'
import { EmailSettingsPage } from './pages/EmailSettings'
import { PricingPage } from './pages/Pricing'
import { TourDetailPage } from './pages/TourDetail'
import { ToursPage } from './pages/Tours'
import { InvitePage, NewWorkspacePage } from './pages/Onboarding'
import { GeneralSettingsPage, TeamPage } from './pages/Settings'
import { useMe } from './lib/session'

/** The server didn't answer (restarting, deploy, network): not a logout. Keep the page and retry. */
function Unreachable({ retry }: { retry: () => void }) {
  const { t } = useI18n()
  useEffect(() => { const id = setInterval(retry, 3000); return () => clearInterval(id) }, [retry])
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <Spinner />
      <p className="text-sm text-slate-600">{t('serverUnreachable')}</p>
    </div>
  )
}

function RequireAuth() {
  const { data: me, isLoading, isError, refetch } = useMe()
  const loc = useLocation()
  // The colour saved on the account (chosen on another device too).
  const theme = me?.user.theme
  useEffect(() => { if (theme) applyTheme(theme) }, [theme])
  if (isLoading) return <FullPageSpinner />
  // Only a 401 means "logged out" (useMe returns null); other failures are the network.
  if (me === undefined && isError) return <Unreachable retry={refetch} />
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />
  return <Outlet />
}

function GuestOnly() {
  const { data: me, isLoading } = useMe()
  // Router state, not window.location: after login the URL changes before the
  // router re-renders, and reading the browser URL here raced the redirect.
  const [params] = useSearchParams()
  if (isLoading) return <FullPageSpinner />
  // Logged-in users still reach login/signup when following an invite flow.
  if (me && !params.get('next')) return <Navigate to="/" replace />
  return <Outlet />
}

function Home() {
  const { data: me } = useMe()
  let last: string | null = null
  try { last = localStorage.getItem('lastWorkspace') } catch { /* ignore */ }
  const target = me!.workspaces.find((w) => w.id === last) ?? me!.workspaces[0]
  return <Navigate to={target ? `/w/${target.id}` : '/new-workspace'} replace />
}

function WorkspaceRoute() {
  const { workspaceId } = useParams()
  const { data: me } = useMe()
  if (!me!.workspaces.some((w) => w.id === workspaceId)) return <Navigate to="/" replace />
  try { localStorage.setItem('lastWorkspace', workspaceId!) } catch { /* ignore */ }
  return <AppShell />
}

function InviteRoute() {
  const { token } = useParams()
  return <InvitePage token={token!} />
}

export default function App() {
  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
      </Route>
      <Route path="/invite/:token" element={<InviteRoute />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/f/:token" element={<FieldPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
        <Route path="/new-workspace" element={<NewWorkspacePage />} />
        <Route path="/w/:workspaceId/print/invoice/:invoiceId" element={<InvoicePrintPage />} />
        <Route path="/w/:workspaceId/print/quote/:quoteId" element={<PriceListPrintPage />} />
        <Route path="/w/:workspaceId" element={<WorkspaceRoute />}>
          <Route index element={<DashboardPage />} />
          <Route path="tours" element={<ToursPage />} />
          <Route path="tours/:tourId" element={<TourDetailPage />} />
          <Route path="timeline" element={<TimelinePage />} />
          <Route path="rooms" element={<RoomsByNightPage />} />
          <Route path="day" element={<DayViewPage />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="series/:seriesId" element={<SeriesPage />} />
          <Route path="vendors" element={<VendorsPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="assistant" element={<AssistantPage />} />
          <Route path="prices" element={<PriceCatalogPage />} />
          <Route path="finance" element={<FinancePage />} />
          <Route path="calculations" element={<CalculationsPage />} />
          <Route path="calculations/:quoteId" element={<CalcEditorPage />} />
          <Route path="settings/team" element={<TeamPage />} />
          <Route path="settings/import" element={<ImportPage />} />
          <Route path="settings/general" element={<GeneralSettingsPage />} />
          <Route path="settings/email" element={<EmailSettingsPage />} />
          <Route path="settings" element={<Navigate to="general" replace />} />
          <Route path="*" element={<ToAgencyHome />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/** An address that doesn't exist inside an agency: its Home (a relative "." stayed on the bad address, blank). */
function ToAgencyHome() {
  const { workspaceId } = useParams()
  return <Navigate to={`/w/${workspaceId}`} replace />
}

