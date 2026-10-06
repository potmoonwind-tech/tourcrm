import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type Client, type Member, type Series, type ServiceBrief, type TaskSummary, type Vendor } from './api'
import { useWorkspace } from './session'

/** API path under the current workspace, e.g. wsPath(ws, '/tours'). */
export const wsPath = (wsId: string, path: string) => `/workspaces/${wsId}${path}`

export function useVendors(includeInactive = false) {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['vendors', ws.id, includeInactive],
    queryFn: () => api<Vendor[]>(wsPath(ws.id, `/vendors?include_inactive=${includeInactive}`)),
    staleTime: 30_000,
  })
}

export function useClients() {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['clients', ws.id],
    queryFn: () => api<Client[]>(wsPath(ws.id, '/clients')),
    staleTime: 30_000,
  })
}

/** Every active service in the price catalog, without prices. */
export function useServiceList() {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['services', ws.id],
    queryFn: () => api<ServiceBrief[]>(wsPath(ws.id, '/services')),
    staleTime: 30_000,
  })
}

export function useSeries() {
  const ws = useWorkspace()!
  return useQuery({
    queryKey: ['series', ws.id],
    queryFn: () => api<Series[]>(wsPath(ws.id, '/series')),
    staleTime: 30_000,
  })
}

/** "?open=<id>" (from search or a link) opens that record once the list has loaded, then leaves the URL clean. */
export function useOpenFromUrl<T extends { id: string }>(items: T[] | undefined, open: (x: T) => void) {
  const [params, setParams] = useSearchParams()
  const id = params.get('open')
  useEffect(() => {
    if (!id || !items) return
    const x = items.find((i) => i.id === id)
    if (x) open(x)
    const next = new URLSearchParams(params)
    next.delete('open')
    setParams(next, { replace: true })
  }, [id, items]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Same, when only the id is needed (e.g. an invoice opened by id). */
export function useOpenIdFromUrl(open: (id: string) => void) {
  const [params, setParams] = useSearchParams()
  const id = params.get('open')
  useEffect(() => {
    if (!id) return
    open(id)
    const next = new URLSearchParams(params)
    next.delete('open')
    setParams(next, { replace: true })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The agency's people (for "who does it" pickers). */
export function useMembers() {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['members', ws.id], queryFn: () => api<Member[]>(wsPath(ws.id, '/members')), staleTime: 60_000 })
}

/** My open tasks (menu badge, Home). */
export function useTaskSummary(enabled = true) {
  const ws = useWorkspace()!
  return useQuery({ queryKey: ['tasks', ws.id, 'summary'], enabled, staleTime: 30_000,
    queryFn: () => api<TaskSummary>(wsPath(ws.id, '/tasks/summary')) })
}
