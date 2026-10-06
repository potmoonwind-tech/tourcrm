import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { api, type Me } from '../lib/api'
import { useI18n, type TKey } from '../lib/i18n'
import { useMe } from '../lib/session'
import { applyTheme, SWATCH, THEMES, type Theme } from '../lib/theme'
import { cn } from '../lib/utils'

/** Three colour swatches; the choice shows at once and is saved on your account. */
export function ThemePicker({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const me = useMe()
  const current = (me.data?.user.theme ?? 'blue') as Theme
  const save = useMutation({
    mutationFn: (theme: Theme) => api<Me>('/auth/me', { method: 'PATCH', body: { theme } }),
    onMutate: (theme) => applyTheme(theme),
    onSuccess: (m) => qc.setQueryData(['me'], m),
    onError: () => applyTheme(current),   // not saved: back to what the account has
  })
  return (
    <div role="radiogroup" aria-label={t('theme')} className="flex items-center gap-2"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
        const i = THEMES.indexOf(current)
        const next = THEMES[(i + (e.key === 'ArrowRight' ? 1 : THEMES.length - 1)) % THEMES.length]
        save.mutate(next)
        setTimeout(() => document.getElementById(`theme-${next}`)?.focus(), 0)
      }}>
      {THEMES.map((th) => {
        const on = th === current
        return (
          <button key={th} id={`theme-${th}`} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
            aria-label={t(`theme_${th}` as TKey)} title={t(`theme_${th}` as TKey)} onClick={() => save.mutate(th)}
            className={cn('flex items-center justify-center rounded-full ring-offset-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-800',
              size === 'sm' ? 'h-7 w-7' : 'h-9 w-9', on ? 'ring-2 ring-slate-800' : 'hover:scale-110')}
            style={{ background: SWATCH[th] }}>
            {on && <Check size={size === 'sm' ? 14 : 16} className="text-white" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}
