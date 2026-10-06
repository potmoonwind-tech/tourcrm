/**
 * The calculation being edited, with undo and redo. Typing in one box within a moment is one step;
 * a delete is always its own step, so "Deleted · Undo" brings back exactly what went.
 */
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { toast } from '../../components/overlay'
import { useI18n, type TKey } from '../../lib/i18n'

export type EditFn<T> = (fn: (d: T) => void, checkpoint?: boolean) => void

export function useUndoDoc<T>() {
  const [doc, setDoc] = useState<T | null>(null)
  const cur = useRef<T | null>(null)
  const past = useRef<T[]>([])
  const future = useRef<T[]>([])
  const lastAt = useRef(0)
  const [depth, setDepth] = useState<[number, number]>([0, 0])   // how many steps back and forward, for the buttons
  const sync = () => setDepth([past.current.length, future.current.length])

  /** A new starting point (opened, saved, restored): nothing to undo before it. */
  const load = useCallback((d: T | null) => {
    cur.current = d; past.current = []; future.current = []; lastAt.current = 0
    setDoc(d)
    sync()
  }, [])

  const edit: EditFn<T> = (fn, checkpoint = false) => {
    const before = cur.current
    if (!before) return
    const next = structuredClone(before)
    fn(next)
    const now = Date.now()
    if (checkpoint || now - lastAt.current > 800) {
      past.current.push(before)
      if (past.current.length > 100) past.current.shift()
    }
    lastAt.current = checkpoint ? 0 : now
    future.current = []
    cur.current = next
    setDoc(next)
    sync()
  }

  const step = (from: React.RefObject<T[]>, to: React.RefObject<T[]>) => {
    const d = from.current.pop()
    if (d === undefined || !cur.current) return
    to.current.push(cur.current)
    cur.current = d
    lastAt.current = 0
    setDoc(d)
    sync()
  }
  const undo = useCallback(() => step(past, future), [])
  const redo = useCallback(() => step(future, past), [])

  return { doc, load, edit, undo, redo, canUndo: depth[0] > 0, canRedo: depth[1] > 0 }
}

/** Remove something at once and offer "Undo" in the toast, instead of asking first. */
export const UndoContext = createContext<() => void>(() => {})

export function useRemove<T>(edit: EditFn<T>) {
  const undo = useContext(UndoContext)
  const { t } = useI18n()
  return (fn: (d: T) => void, what: TKey = 'deletedToast') => {
    edit(fn, true)
    toast(what, 'ok', { label: t('undo'), onClick: undo })
  }
}
