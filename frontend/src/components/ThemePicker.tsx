import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { api, type Me } from '../lib/api'
import { useI18n, type TKey } from '../lib/i18n'
import { useMe } from '../lib/session'
import { applyTheme, applyView, SWATCH, THEMES, type TextSize, type Theme } from '../lib/theme'
import type { ReactNode } from 'react'
import { Card, SegmentedControl } from './ui'
import { cn } from '../lib/utils'

/** Three colour swatches; the choice shows at once and is saved on your account. */
export function ThemePicker({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const me = useMe()
  const current = (me.data?.user.theme ?? 'blue') as Theme
  const save = useMutation({
    mutationFn: (theme: Theme) => api<Me>('/auth/me', { method: 'PATCH', body: { theme } }),
    onMutate: (theme) => {
      const before = qc.getQueryData<Me>(['me'])
      if (before) qc.setQueryData<Me>(['me'], { ...before, user: { ...before.user, theme } })
      applyTheme(theme)
      return before
    },
    onError: (_e, _t, before) => { if (before) qc.setQueryData(['me'], before); applyTheme(before?.user.theme) },   // not saved
    onSettled: () => qc.invalidateQueries({ queryKey: ['me'] }),
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

/**
 * Settings → Appearance, just for you: the colour, the text size and "Easy to see" (for weaker eyesight).
 * Each change shows at once and is saved on your account.
 */
export function AppearanceCard() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const me = useMe()
  const easy = !!me.data?.user.easy_view
  const size = (me.data?.user.text_size ?? 'normal') as TextSize
  // Each change goes into the account at once (so two quick changes don't undo each other), then is saved.
  const save = useMutation({
    mutationFn: (p: { easy_view?: boolean; text_size?: TextSize }) => api<Me>('/auth/me', { method: 'PATCH', body: p }),
    onMutate: (p) => {
      const before = qc.getQueryData<Me>(['me'])
      if (before) qc.setQueryData<Me>(['me'], { ...before, user: { ...before.user, ...p } })
      const u = qc.getQueryData<Me>(['me'])?.user
      applyView(u?.easy_view, u?.text_size)
      return before
    },
    onError: (_e, _p, before) => { if (before) qc.setQueryData(['me'], before); applyView(before?.user.easy_view, before?.user.text_size) },
    onSettled: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })
  return (
    <Card className="divide-y divide-slate-100">
      <div className="p-5 pb-4">
        <h2 className="text-base font-semibold text-slate-800">{t('appearance')}</h2>
        <p className="text-sm text-slate-500">{t('appearanceHelp')}</p>
      </div>
      <Row label={t('theme')}><ThemePicker /></Row>
      <Row label={t('textSize')} help={t('textSizeHelp')}>
        <SegmentedControl label={t('textSize')} value={size} onChange={(v) => save.mutate({ text_size: v })}
          options={[['normal', <span key="n" className="text-sm">Aa · {t('textNormal')}</span>],
            ['large', <span key="l" className="text-base">Aa · {t('textLarge')}</span>],
            ['larger', <span key="x" className="text-lg">Aa · {t('textLarger')}</span>]]} />
      </Row>
      <Row label={t('easyView')} help={t('easyViewHelp')}>
        <button type="button" role="switch" aria-checked={easy} aria-label={t('easyView')} onClick={() => save.mutate({ easy_view: !easy })}
          className={cn('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 transition-colors',
            easy ? 'border-brand-700 bg-brand-600' : 'border-slate-400 bg-slate-200')}>
          <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', easy ? 'translate-x-5' : 'translate-x-0.5')} />
        </button>
      </Row>
    </Card>
  )
}

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        {help && <p className="text-sm text-slate-500">{help}</p>}
      </div>
      {children}
    </div>
  )
}
