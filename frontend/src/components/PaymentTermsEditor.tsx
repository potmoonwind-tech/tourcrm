import type { PaymentTerms } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { Input } from './ui'

/** Payment terms as one sentence: deposit X% within N days of booking, balance M days before arrival. */
export function PaymentTermsEditor({ value, onChange, disabled }: {
  value: PaymentTerms; onChange: (v: PaymentTerms) => void; disabled?: boolean
}) {
  const { t } = useI18n()
  const num = (k: keyof PaymentTerms, max: number) => (
    <Input type="number" min={0} max={max} value={value[k]} disabled={disabled}
      onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })} className="h-8 w-20 px-2 text-right" />
  )
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
      {t('termsDeposit')} {num('deposit_percent', 100)} % {t('termsDepositDue')} {num('deposit_days', 365)} {t('termsAfterBooking')}
      <span className="basis-full sm:basis-auto" />
      {t('termsBalance')} {num('balance_days_before', 365)} {t('termsBeforeArrival')}
      {value.deposit_percent === 0 && <span className="basis-full text-xs text-slate-500">{t('termsNoDeposit')}</span>}
    </div>
  )
}
