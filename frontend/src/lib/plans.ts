/** The plans on the public pricing page (GEL, per agency per month). Change the numbers here. */
export type PlanId = 'start' | 'team' | 'business'

export interface Plan {
  id: PlanId
  monthly: number          // GEL a month, paid monthly
  users: number            // office users included
  extraUser?: number       // GEL a month per user above that
  aiAllowance: number      // GEL of AI assistant use a month
  jobs: boolean            // jobs and permissions (operator / finance / sales)
  onboarding: 'email' | 'call' | 'done_for_you'
  popular?: boolean
}

export const PLANS: Plan[] = [
  { id: 'start', monthly: 99, users: 3, aiAllowance: 10, jobs: false, onboarding: 'email' },
  { id: 'team', monthly: 249, users: 10, aiAllowance: 30, jobs: true, onboarding: 'call', popular: true },
  { id: 'business', monthly: 499, users: 25, extraUser: 15, aiAllowance: 70, jobs: true, onboarding: 'done_for_you' },
]

export const TRIAL_DAYS = 30
export const YEARLY_MONTHS = 10        // a year costs 10 months: 2 months free
export const VAT_PERCENT = 18          // shown as "+ VAT" for business customers

/** What a month costs when paid for a year, rounded to whole lari. */
export const yearlyPerMonth = (p: Plan) => Math.round((p.monthly * YEARLY_MONTHS) / 12)
