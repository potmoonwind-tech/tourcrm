import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useParams } from 'react-router-dom'
import { api, ApiError, atLeast, type Job, type Me } from './api'

// "View as": an owner or admin sees the app as someone with one job (or a guide) — the menus, tabs and
// Home they would get. Only the screens change; the server still knows who is really looking.
type ViewAs = Job | 'guide' | null
const VIEW_KEY = 'tourcrm.viewAs'
let viewAs: ViewAs = (() => { try { return (localStorage.getItem(VIEW_KEY) as ViewAs) || null } catch { return null } })()
const viewSubs = new Set<() => void>()
export function setViewAs(v: ViewAs) {
  viewAs = v
  try { if (v) localStorage.setItem(VIEW_KEY, v); else localStorage.removeItem(VIEW_KEY) } catch { /* private window */ }
  viewSubs.forEach((f) => f())
}
export const useViewAs = () => useSyncExternalStore((f) => { viewSubs.add(f); return () => viewSubs.delete(f) }, () => viewAs)

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
  })
}

/** The workspace selected in the URL (/w/:workspaceId/...). */
export function useWorkspace() {
  const { workspaceId } = useParams()
  const { data } = useMe()
  const v = useViewAs()
  const ws = data?.workspaces.find((w) => w.id === workspaceId)
  if (ws && v && atLeast(ws.role, 'admin')) {
    return { ...ws, realRole: ws.role, viewAs: v, role: v === 'guide' ? 'guide' as const : 'staff' as const, jobs: v === 'guide' ? [] : [v] }
  }
  return ws
}

export function useRefreshMe() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['me'] })
}

/** The person's date format for tour days ("dmy" by default). */
export function useDateStyle() {
  return useMe().data?.user.date_style ?? 'dmy'
}
