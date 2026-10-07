/**
 * Who eats where: one row per person (the tour leaders, each guide, driver, assistant), one column per
 * place - with the group, at the staff table, not with us. On the Staff tab it sets where they usually
 * eat; on a meal it sets that meal (who sits elsewhere than usual is marked).
 */
import { MEAL_SEATS, type MealSeat } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'

export interface SeatRow { key: string; label: string; sub?: string; seat: MealSeat; usual?: MealSeat }

export function SeatGrid({ rows, onChange, disabled }: { rows: SeatRow[]; onChange: (key: string, seat: MealSeat) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-slate-500">
          <th className="py-1.5 pr-2 text-left font-medium">{t('seatPerson')}</th>
          {MEAL_SEATS.map((s) => <th key={s} className="w-24 px-1 py-1.5 text-center font-medium">{t(`mealSeatCol_${s}`)}</th>)}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="py-2 pr-2">
              <span className="font-medium text-slate-800">{r.label}</span>
              {r.sub && <span className="block text-xs text-slate-500">{r.sub}</span>}
              {r.usual && r.usual !== r.seat && (
                <span className="block text-xs text-amber-700">{t('seatUsually', { where: t(`mealSeat_${r.usual}`).toLowerCase() })}</span>
              )}
            </td>
            {MEAL_SEATS.map((s) => (
              <td key={s} className="px-1 py-2 text-center">
                <input type="radio" name={`seat-${r.key}`} checked={r.seat === s} disabled={disabled}
                  aria-label={`${r.label}: ${t(`mealSeat_${s}`)}`} onChange={() => onChange(r.key, s)}
                  className={cn('h-4 w-4 accent-brand-600', disabled && 'opacity-50')} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
