import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmHost, toast, ToastHost } from './components/overlay'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { I18nProvider } from './lib/i18n'
import { applySavedTheme } from './lib/theme'

applySavedTheme()   // this browser's colour before anything draws

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  // Every change confirms itself with a short "Saved"; checks and previews opt out with meta: { silent: true }.
  mutationCache: new MutationCache({
    onSuccess: (_d, _v, _c, m) => {
      if (m.meta?.silent) return
      toast('savedToast')
      queryClient.invalidateQueries({ queryKey: ['setup'] })   // "Get started" and the next-step bar follow every change
    },
  }),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ConfirmHost />
        <ToastHost />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
)
