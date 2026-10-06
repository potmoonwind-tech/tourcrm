import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ask } from '../components/overlay'

/** The value, but only after it stopped changing for `ms` (live previews while typing). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value)
  useEffect(() => { const h = setTimeout(() => setV(value), ms); return () => clearTimeout(h) }, [value, ms])
  return v
}

/** Unsaved changes: ask before leaving — closing or reloading the page (the browser asks), and
 * clicking a link inside the app (our dialog; the router alone would just leave). */
export function useLeaveGuard(dirty: boolean, title: string, message?: string) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!dirty) return
    const unload = (e: BeforeUnloadEvent) => e.preventDefault()
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a')
      if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
      const url = new URL(a.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return
      e.preventDefault()
      e.stopPropagation()      // before the router's own click handler
      void ask({ title, message, danger: true }).then((ok) => ok && navigate(url.pathname + url.search + url.hash))
    }
    window.addEventListener('beforeunload', unload)
    document.addEventListener('click', click, true)
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true) }
  }, [dirty, title, message, navigate])
}

