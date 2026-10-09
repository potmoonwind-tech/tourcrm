import { useCallback, useRef } from 'react'

/**
 * Bars that stay at the top stack under each other: each one publishes its real height as a CSS variable
 * (`--tabs-h`, `--bar-h`), and the next bar sits at `top: var(...)`. Heights change with "Easy to see",
 * the language and the screen width, so they're measured, not guessed.
 */
export function useStickyHeight(name: string) {
  const ro = useRef<ResizeObserver | null>(null)
  return useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    const set = () => document.documentElement.style.setProperty(name, `${Math.round(el.getBoundingClientRect().height)}px`)
    ro.current = new ResizeObserver(set)
    ro.current.observe(el)
    set()
  }, [name])
}
