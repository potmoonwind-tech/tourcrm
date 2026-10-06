/**
 * The app's colour, chosen by each person (Settings → Appearance, or the account menu): blue (Vibe's,
 * the default), green or violet. A theme only swaps the brand colour's shades (index.css), so every
 * button, link and highlight follows. Kept on the account (it follows the person to any device) and in
 * this browser, so the page opens in the right colour before the account has loaded.
 */
export const THEMES = ['blue', 'green', 'violet'] as const
export type Theme = (typeof THEMES)[number]

/** The swatch shown in the picker (the theme's main colour). */
export const SWATCH: Record<Theme, string> = { blue: '#0073ea', green: '#00804a', violet: '#7c3aed' }

export function applyTheme(theme: string | null | undefined) {
  const t: Theme = (THEMES as readonly string[]).includes(theme ?? '') ? (theme as Theme) : 'blue'
  if (t === 'blue') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try { localStorage.setItem('theme', t) } catch { /* private window */ }
}

/** Right away on start: the colour this browser last used. */
export function applySavedTheme() {
  try { applyTheme(localStorage.getItem('theme')) } catch { /* private window */ }
}

/** The brand colour now in use, for things drawn outside CSS (the map's route line). */
export const brandColor = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--color-brand-600').trim() || SWATCH.blue

export type TextSize = 'normal' | 'large' | 'larger'

/** Easier to see (stronger contrast, focus, no motion) and the text size; kept like the colour. */
export function applyView(easy: boolean | null | undefined, text: string | null | undefined) {
  const size: TextSize = text === 'large' || text === 'larger' ? text : 'normal'
  const root = document.documentElement
  if (easy) root.dataset.easy = 'on'
  else delete root.dataset.easy
  if (size === 'normal') delete root.dataset.text
  else root.dataset.text = size
  try { localStorage.setItem('easyView', easy ? '1' : ''); localStorage.setItem('textSize', size) } catch { /* private window */ }
}

export function applySavedView() {
  try { applyView(localStorage.getItem('easyView') === '1', localStorage.getItem('textSize')) } catch { /* private window */ }
}
