export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    let msg = res.statusText
    if (typeof data?.detail === 'string') msg = data.detail
    else if (Array.isArray(data?.detail)) msg = data.detail.map((d: { msg: string }) => d.msg).join(', ')
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export type Role = 'guide' | 'staff' | 'manager' | 'admin' | 'owner'
export const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'guide']
const RANK: Record<Role, number> = { guide: 0, staff: 1, manager: 2, admin: 3, owner: 4 }
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min]
/** What someone does in an agency: runs tours and all supplier prices · the money · sells. */
export type Job = 'operations' | 'finance' | 'sales'
export const JOBS: Job[] = ['operations', 'finance', 'sales']
/** Does this person (in an office role) do any of these jobs here? Owners and admins do all. */
export const can = (ws: { role: Role; jobs?: Job[] } | null | undefined, ...jobs: Job[]) =>
  !!ws && atLeast(ws.role, 'staff') && jobs.some((j) => (ws.jobs ?? []).includes(j))

export interface User { id: string; email: string; full_name: string; theme?: string; easy_view?: boolean; text_size?: string }
export interface Workspace {
  id: string; name: string; slug: string; base_currency: string; language: 'en' | 'ka'; role: Role
  jobs?: Job[]                 // what this person does here (owners and admins: all)
  realRole?: Role; viewAs?: Job | 'guide'   // set while an owner looks at the app "as" someone else
  incident_approval_limit: number | null; cancellation_scale: ScaleRow[]; payment_terms: PaymentTerms; bill_tolerance_pct: number
  task_owners: Partial<Record<WorkKind | 'payments', string | null>>
  task_types?: TaskType[]
  fuel_l_per_100km: number
  countries?: string[]          // where the agency works: the map searches only there
  drive_factor?: number         // coach time vs the map's car time (1.25 = +25%)
  vat_rate?: number | null      // VAT % inside suppliers' prices, claimed back; null = no VAT
  plate_share?: number          // family-style meals: people sharing one plate (1 = everyone their own)
  phone?: string
  ai_key_hint?: string    // last 4 characters of the agency's own AI key (the key never comes back)
  ai_workspace_id?: string   // Anthropic Console workspace, for organization-level keys
}
export type TaskTypeColor = 'green' | 'orange' | 'red' | 'blue' | 'purple' | 'dark' | 'grey'
export interface TaskType { id: string; name: string; color: TaskTypeColor }
export interface Me { user: User; workspaces: Workspace[] }
export interface Member { id: string; user_id: string; email: string; full_name: string; role: Role; created_at: string; jobs: Job[]; jobs_set: boolean }
export interface Invite { id: string; email: string; role: Role; created_at: string; expires_at: string; link: string }
export interface InvitePublic { workspace_name: string; email: string; role: Role; status: 'pending' | 'accepted' | 'expired' }

// --- Milestone 2 ---------------------------------------------------------------
export type VendorType = 'hotel' | 'restaurant' | 'transport' | 'guide' | 'driver' | 'activity' | 'airline' | 'rail' | 'other'
export const VENDOR_TYPES: VendorType[] = ['hotel', 'restaurant', 'transport', 'guide', 'driver', 'activity', 'airline', 'rail', 'other']
export type TourStatus = 'inquiry' | 'confirmed' | 'cancelled'
export const TOUR_STATUSES: TourStatus[] = ['confirmed', 'inquiry', 'cancelled']
export type SeriesColor = 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet' | 'teal' | 'orange' | 'slate' | 'lime'
export const SERIES_COLORS: SeriesColor[] = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet', 'teal', 'orange', 'lime', 'slate']

export interface Vendor {
  id: string; name: string; type: VendorType; city: string; address?: string; contact_person: string
  phone: string; phone2: string; email: string; payment_timing: 'before' | 'after'
  payment_days: number; currency: string; notes: string; is_active: boolean; cancel_terms: ScaleRow[]
  languages?: string[]; unavailable?: Away[]     // guides / drivers
  vat_invoice?: boolean         // gives VAT invoices: its costs carry the agency's VAT rate
  visit_minutes?: number | null // a sight or activity: how long a visit usually takes
  category?: string             // an activity place: museum, cable_car... (lib/activities.tsx) or the agency's own word
  company_id?: string | null    // a driver's (or guide's) company: the bus company that sends them
}
/** Dates a guide or driver can't work, both days included. */
export interface Away { start: string; end: string; note: string }
/** A conflict or something needing attention on a tour (server: app/routers/alerts.py). */
export interface TourAlert {
  code: string; severity: 'error' | 'warning' | 'info'; tour_id: string; tour_code: string; start_date: string
  day: number | null; link: string; params: Record<string, string | number>
}
/** Deposit X% within N days of booking; balance M days before arrival (0% = one invoice). */
export interface PaymentTerms { deposit_percent: number; deposit_days: number; balance_days_before: number }
export interface ScheduleOut {
  terms: PaymentTerms; source: 'client' | 'agency'; client: { id: string; name: string } | null
  total: number | null; currency: string; description: string; created: string[]
  parts: { kind: 'deposit' | 'balance' | 'full'; percent: number; amount: number; due_date: string }[]
  existing: DocRef[]
}
/** Cancelled within N days (of arrival, or of a vendor's first service) → percent. */
export interface ScaleRow { within_days: number; percent: number }
export interface VendorRef { id: string; name: string; type: VendorType; phone: string }
export interface Client {
  id: string; name: string; type: 'agency' | 'direct'; country: string
  contact_person: string; email: string; phone: string; notes: string; cancellation_scale: ScaleRow[] | null
  payment_terms: PaymentTerms | null
}
/** A catalog service used on a day; quantity null = worked out from the service's unit. */
export interface DayExtra { id?: string; service_id: string; quantity: string | number | null; notes: string; optional?: boolean }
export interface DayFields {
  city: string; hotel_id: string | null; lunch_id: string | null; dinner_id: string | null
  breakfast_id?: string | null; breakfast_menu_id?: string | null
  breakfast_mode?: BreakfastMode    // at the hotel (room price — the usual), or a restaurant like the other meals
  border_crossing: string; notes: string; extras: DayExtra[]
  lunch_menu_id?: string | null; dinner_menu_id?: string | null
  km?: number | null          // road km driven that day (from the previous day's city)
  drive_minutes?: number[]    // car minutes of each leg that day (to each stop, then the city), from the map
  drive_km?: number[]         // road km of the same legs
  stops?: string[]            // other places visited that day, before the night's city
  lunch_mode?: MealMode; dinner_mode?: MealMode
  flights?: Flight[]
  schedule?: ScheduleItem[]   // the day's programme in order (empty: not arranged yet)
  staff_stay?: DayStaffStay; staff_hotel_id?: string | null; staff_twin?: boolean   // where the driver and guide sleep
  meal_dishes?: Partial<Record<'breakfast' | 'lunch' | 'dinner', Dish[]>>   // this tour's own dishes for a meal (not the menu's)
  meal_tbd?: Partial<Record<'breakfast' | 'lunch' | 'dinner', string>>   // place to be decided, in this town ("TBD · Yerevan")
  seating?: Partial<Record<'breakfast' | 'lunch' | 'dinner', Record<string, unknown>>>   // who sits elsewhere than usual, and guests
}
export type ScheduleKind = 'breakfast' | 'meal' | 'visit' | 'transfer' | 'free' | 'checkin' | 'checkout' | 'flight' | 'other'
/** One step of a day's programme; `ref` points at the day's own content (lunch, hotel, extra:<id>…). */
export interface ScheduleItem { id: string; kind: ScheduleKind; time: string; end: string; title: string; ref: string | null; place: string; notes: string; fixed?: boolean }
/** A group flight that day (on a route, every departure copies it). */
export interface Flight { direction: 'arrival' | 'departure'; number: string; time: string; airport: string; other: string; notes?: string }
/** Who pays a meal: we do (a cost), the tourists on the spot (we only reserve), or a free meal time. */
export type MealMode = 'included' | 'tourists' | 'own'
/** Breakfast: at last night's hotel (in the room price — the usual), or like lunch and dinner. */
export type BreakfastMode = 'hotel' | MealMode
export interface Series {
  id: string; code: string; name: string; color: SeriesColor; notes: string; days: (DayFields & { day_number: number })[]
  staff_plan?: StaffPlanItem[]
  bus_return?: BusReturn | null
}
/** The bus back to its garage after the last day: that day, or the next (one more bus day). */
export interface BusReturn { on: 'last' | 'next'; to: string; km: number | null }
/** Who works which days of a route (vendor_id null: still to choose — priced as "Guide · days 6–7"). */
export interface StaffPlanItem { role: StaffRole; from_day: number; to_day: number | null; vendor_id: string | null; label: string }
export interface TourSummary {
  id: string; code: string; name: string; series_id: string | null; series_code: string | null
  color: SeriesColor; client_id: string | null; client_name: string | null
  start_date: string; end_date: string; status: TourStatus; pax: number; pax_estimated?: boolean; rooms: string; quote_id?: string | null
  staff: StaffAssignment[]; participant_count: number; phase: TourPhase; closed_at: string | null
}
export type TourPhase = 'inquiry' | 'confirmed' | 'operating' | 'settling' | 'closed' | 'cancelled'
export interface CloseCheck {
  phase: TourPhase; closed_at: string | null; closed_by: string | null; close_note: string
  final_revenue: number | null; final_cost: number | null; ready: boolean; can_force: boolean
  revenue: number; cost: number; profit: number
  items: { key: string; ok: boolean; blocking: boolean; detail: string; count: number; link: string }[]
}
export interface TourDay {
  id: string; day_number: number; date: string; city: string
  hotel: VendorRef | null; lunch: VendorRef | null; dinner: VendorRef | null
  breakfast?: VendorRef | null; breakfast_menu_id?: string | null; breakfast_mode?: BreakfastMode
  lunch_menu_id: string | null; dinner_menu_id: string | null
  border_crossing: string; notes: string; extras: DayExtra[]; km?: number | null; drive_minutes?: number[]; drive_km?: number[]; stops?: string[]
  lunch_mode?: MealMode; dinner_mode?: MealMode; flights?: Flight[]; schedule?: ScheduleItem[]
  staff_stay?: DayStaffStay; staff_hotel?: VendorRef | null; staff_twin?: boolean
  meal_dishes?: DayFields['meal_dishes']; seating?: DayFields['seating']; meal_tbd?: DayFields['meal_tbd']
}
export interface Tour extends TourSummary {
  notes: string; days: TourDay[]
  bus_return?: BusReturn | null
  price_pp: number | null; price_currency: string | null   // managers only
  leaders?: number; staff_table?: boolean   // of pax, free tour leaders · leader + driver + guide eat at their own table
  leader_seat?: MealSeat | null             // where the tour leaders eat (null: the staff table)
  plate_share?: number | null               // this group's people per plate (null: the agency's)
  route_changed?: boolean   // its route's days were edited after this tour copied them
}
export interface DayViewRow { tour: TourSummary; day: TourDay; staff_today: StaffAssignment[]; is_first_day: boolean; is_last_day: boolean; prev_hotel?: VendorRef | null }

// --- Milestone 3 ---------------------------------------------------------------
export type StaffRole = 'guide' | 'driver' | 'transport' | 'tour_leader' | 'assistant' | 'other'
export const STAFF_ROLES: StaffRole[] = ['guide', 'driver', 'transport', 'tour_leader', 'assistant', 'other']
/** Which vendor types make sense for each staff role. */
export const ROLE_VENDOR_TYPES: Record<StaffRole, VendorType[]> = {
  guide: ['guide'], driver: ['driver'], transport: ['transport', 'driver'],
  tour_leader: ['guide', 'other'], assistant: ['guide', 'other'], other: VENDOR_TYPES,
}
/** Where someone eats at the meals: with the group, at the staff table, or not with us. */
export type MealSeat = 'group' | 'staff' | 'none'
export interface StaffAssignment { id: string; role: StaffRole; vendor: VendorRef; start_day: number; end_day: number | null; notes: string; meal_seat?: MealSeat | null }

export type RoomType = '' | 'SGL' | 'DBL' | 'TWN' | 'TRP' | 'QUAD'
export const ROOM_TYPES: RoomType[] = ['SGL', 'DBL', 'TWN', 'TRP', 'QUAD']
export interface Participant {
  id: string; full_name: string; local_name?: string   // the name in the traveller's own script (王丽)
  gender: '' | 'M' | 'F'; birth_date: string | null; nationality: string
  passport_number: string; passport_expiry: string | null; room_type: RoomType; room_group: string
  room_note?: string   // for the hotel, the same on everyone in the room
  phone: string; notes: string
}
export interface RoomingSummary { rooms: Record<string, number>; text: string; unassigned: number; passport_warnings: number }

export type ImportEntity = 'participants' | 'tours' | 'vendors' | 'clients'
export interface ImportIssue { row: number; message: string }
export interface ImportResult {
  total: number; valid: number; created: number; committed: boolean
  columns: Record<string, string | null>; errors: ImportIssue[]; warnings: ImportIssue[]
  preview: Record<string, string | number | null>[]
  by_ai?: boolean      // AI said which column is which (the reading itself is the usual one)
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const body = new FormData()
  body.append('file', file)
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', body })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : res.statusText)
  return data as T
}

// --- Milestone 4 ---------------------------------------------------------------
export type RateKind = 'room_SGL' | 'room_DBL' | 'room_TWN' | 'room_TRP' | 'room_QUAD' | 'breakfast' | 'lunch' | 'dinner' | 'day' | 'person' | 'group'
  | 'staff_room' | 'staff_meal'
export const RATE_KINDS: RateKind[] = ['room_DBL', 'room_TWN', 'room_SGL', 'room_TRP', 'room_QUAD', 'breakfast', 'lunch', 'dinner', 'day', 'person', 'group', 'staff_room', 'staff_meal']
/** Sensible price kinds to offer first for each vendor type. */
export const RATE_KINDS_FOR: Record<VendorType, RateKind[]> = {
  hotel: ['room_DBL', 'room_TWN', 'room_SGL', 'room_TRP', 'room_QUAD', 'breakfast', 'lunch', 'dinner', 'staff_room', 'staff_meal'],
  restaurant: ['breakfast', 'lunch', 'dinner', 'staff_meal', 'person', 'group'],
  transport: ['day', 'group'], driver: ['day'], guide: ['day', 'group'],
  activity: ['person', 'group'], airline: ['person', 'group'], rail: ['person', 'group'], other: RATE_KINDS,
}
export type CostCategory = 'hotel' | 'meal' | 'transport' | 'guide' | 'ticket' | 'visa' | 'other'
export const COST_CATEGORIES: CostCategory[] = ['hotel', 'meal', 'transport', 'guide', 'ticket', 'visa', 'other']
export type PayMethod = 'bank' | 'cash' | 'card' | 'other'
export type PayableStatus = 'paid' | 'partial' | 'unpaid' | 'overdue'

// --- Price catalog (Phase B1): services with prices by season and group size ---
export type ServiceUnit = 'room_night' | 'person' | 'vehicle_day' | 'day' | 'group' | 'item' | 'km' | 'litre'
export const SERVICE_UNITS: ServiceUnit[] = ['room_night', 'person', 'vehicle_day', 'day', 'group', 'item', 'km', 'litre']
export type ServiceCategory = 'hotel' | 'meal' | 'transport' | 'guide' | 'ticket' | 'activity' | 'tips' | 'border' | 'other'
export const SERVICE_CATEGORIES: ServiceCategory[] = ['hotel', 'meal', 'transport', 'guide', 'ticket', 'activity', 'tips', 'border', 'other']
/** Unit and category a system code implies, so picking "DBL room" fills in the rest. */
export const CODE_DEFAULTS: Record<RateKind, { unit: ServiceUnit; category: ServiceCategory }> = {
  room_SGL: { unit: 'room_night', category: 'hotel' }, room_DBL: { unit: 'room_night', category: 'hotel' },
  room_TWN: { unit: 'room_night', category: 'hotel' }, room_TRP: { unit: 'room_night', category: 'hotel' },
  room_QUAD: { unit: 'room_night', category: 'hotel' }, breakfast: { unit: 'person', category: 'meal' }, lunch: { unit: 'person', category: 'meal' },
  dinner: { unit: 'person', category: 'meal' }, day: { unit: 'day', category: 'other' },
  person: { unit: 'person', category: 'other' }, group: { unit: 'group', category: 'other' },
  staff_room: { unit: 'room_night', category: 'hotel' }, staff_meal: { unit: 'person', category: 'meal' },
}
export interface ServiceRate {
  id?: string; valid_from: string | null; valid_to: string | null; min_pax: number | null; max_pax: number | null
  price: number; currency: string; notes: string
}
export interface Service {
  id?: string; vendor_id?: string; code: RateKind | null; name: string; category: ServiceCategory; unit: ServiceUnit
  notes: string; dishes?: Dish[]; is_active: boolean; rates: ServiceRate[]
  minutes?: number | null    // how long it takes (an activity): the day programme gives it this time
}
/** A dish on a set menu: the price of one plate (one portion) in the menu's currency (optional), and how many
 * people share one plate (null = the tour's / agency's usual; 1 = everyone their own). */
export interface Dish { name: string; price: number | null; per_plate?: number | null }
/** A service without prices (what staff see when planning days). */
export interface ServiceBrief {
  id: string; code: RateKind | null; name: string; category: ServiceCategory; unit: ServiceUnit; vendor: VendorRef
  notes: string; dishes: Dish[]
  minutes?: number | null    // how long it takes (an activity)
}
/** A tour's lunches and dinners, dish by dish (GET /tours/{id}/meals). */
export interface MealDish { name: string; price: number | null; same_day: boolean; prev_day: boolean; per_plate?: number; plates?: number }
export interface MealRow {
  day: number; date: string; meal: 'breakfast' | 'lunch' | 'dinner'; vendor: VendorRef; menu_id: string | null; menu_name: string | null
  dishes: MealDish[]; people: number; price_pp: number | null; dish_sum: number | null; currency: string | null; total: number | null; tourists_pay?: boolean
  shared?: boolean      // family style: priced plate by plate
  tables?: number[]     // people at each table: [group] or [group, staff]
  seats?: { key: string; role: string; name: string; count: number; seat: MealSeat; usual: MealSeat }[]
}
export interface DishSummary {
  name: string; days: number[]; servings: number; places: { vendor: VendorRef; menu_name: string; price: number | null }[]
  min_price: number | null; max_price: number | null
}
export interface TourMeals {
  rows: MealRow[]; dishes: DishSummary[]; totals: Record<string, number>; sees_prices: boolean
  plate_share?: number | null; agency_plate_share?: number   // people per plate: this tour's (null = the agency's)
}
export interface CatalogRow { service: Service; vendor: VendorRef; price: number | null; currency: string | null; rate_id: string | null }
export interface ExchangeRate { currency: string; rate: number; updated_at: string }
export interface CostLine {
  id: string; vendor: VendorRef | null; category: CostCategory; description: string
  service_date: string; service_end: string | null; quantity: number; unit_price: number
  currency: string; rate_to_base: number; amount: number; amount_base: number; notes: string
  auto: boolean; locked: boolean; budget_line_id: string | null; reason: '' | 'incident' | 'vendor_credit' | 'bill_adjustment'; incident_id: string | null
  vat_rate?: number | null; vat?: number | null; vat_by_hand?: boolean   // null = the agency doesn't use VAT
}
export interface Payable {
  tour_id: string; tour_code: string; tour_color: SeriesColor; vendor: VendorRef; currency: string
  total: number; paid: number; balance: number; first_service: string | null; last_service: string | null
  due_date: string | null; status: PayableStatus
  billed: number; bill_state: BillState; bill_difference: number
}
export type BillState = '' | 'no_bill' | 'matched' | 'difference' | 'disputed'
export interface VendorBill {
  id: string; vendor: VendorRef; number: string; bill_date: string; due_date: string | null; currency: string
  amount: number; notes: string; disputed: boolean; dispute_note: string
}
export interface TourBills { bills: VendorBill[]; payables: Payable[]; tolerance_pct: number }
/** Who handed over the money when not the company account: a team member, or a guide/driver from their cash. */
export interface PaidBy { kind: 'user' | 'staff'; id: string; name: string }
export interface Payment { id: string; vendor: VendorRef; currency: string; amount: number; paid_on: string; method: PayMethod; reference: string; notes: string; paid_by?: PaidBy | null }
export interface TourCosts {
  lines: CostLine[]; payables: Payable[]; payments: Payment[]
  totals: { by_currency: Record<string, number>; base_currency: string; base_total: number; missing_rates: string[]; vat_base?: number | null }
}
export interface GenerateResult { created: number; updated: number; removed: number; kept: number; linked: number; warnings: string[] }
export interface Schedule { items: Payable[]; overdue: Record<string, number>; due_7: Record<string, number>; due_30: Record<string, number> }

// --- Milestone 5 ---------------------------------------------------------------
export type InvoiceState = 'draft' | 'issued' | 'void'
export type InvoiceDisplay = 'draft' | 'void' | 'unpaid' | 'partial' | 'paid' | 'overdue' | 'refund_due' | 'credit_note'
export interface InvoiceLine { description: string; quantity: number; unit_price: number; amount: number }
export interface ClientPayment { id: string; amount: number; received_on: string; method: PayMethod; reference: string; notes: string }
export interface InvoiceSummary {
  id: string; number: string | null; status: InvoiceState; display_status: InvoiceDisplay
  kind: 'invoice' | 'credit_note'; credits: DocRef | null
  client: { id: string; name: string }; tour: { id: string; code: string; color: SeriesColor } | null
  issue_date: string; due_date: string; currency: string; rate_to_base: number
  total: number; paid: number; credited: number; balance: number; total_base: number
}
export interface DocRef { id: string; number: string | null; status: InvoiceState; total: number }
export interface Invoice extends InvoiceSummary {
  notes: string; lines: InvoiceLine[]; payments: ClientPayment[]; credit_notes: DocRef[]; creditable: number
}
export interface ClientDebt {
  client: { id: string; name: string }; open: Record<string, number>; overdue: Record<string, number>
  open_invoices: number; oldest_due: string | null; refund_due: Record<string, number>
}
export interface ProfitRow {
  key: string; label: string; color: SeriesColor | null; start_date: string | null; tours: number; pax: number
  revenue: number; cost: number; profit: number; margin: number | null; uninvoiced: number; missing_rates: boolean
  missing_currencies: string[]
  expected_revenue?: number | null; expected_paying?: number | null; expected_profit?: number | null
  vat?: number | null; profit_after_vat?: number | null    // null = the agency doesn't use VAT
}
export interface ProfitReport { base_currency: string; group: 'tour' | 'month' | 'route'; rows: ProfitRow[]; totals: ProfitRow }

// --- Tour price calculations ------------------------------------------------------
// Decimal fields travel as strings so nothing is rounded on the way.
export type Num = string
export type QuoteBasis = 'group' | 'per_person' | 'per_vehicle'
export type QuoteWho = 'tourists' | 'persons' | 'everyone' | 'staff' | 'crew'
export type LeaderRoom = 'single' | 'shared' | 'free'
/** Driver/guide this night: not counted here / the group's hotel / another hotel or a staff price / free from the hotel. */
export type StaffStay = 'none' | 'same' | 'own' | 'free' | 'allowance'   // allowance: per person per night, they find a hotel
/** On a tour's day (the allowance is a calculation's plan; the tour records what was really paid). */
export type DayStaffStay = Exclude<StaffStay, 'allowance'>
export type QuoteCategory = 'hotel' | 'meal' | 'transport' | 'guide' | 'ticket' | 'activity' | 'tips' | 'border' | 'other'
export const QUOTE_CATEGORIES: QuoteCategory[] = ['transport', 'guide', 'meal', 'hotel', 'ticket', 'activity', 'tips', 'border', 'other']
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'archived'
/** The agency's own types of person: who pays, who travels free, who works. */
export type PersonRole = 'pay' | 'free' | 'staff'
export type RoomUse = 'dbl' | 'sgl' | 'trp' | 'free' | 'none' | 'staff'
export interface PersonType { id: string; name: string; role: PersonRole; count: number | null; per?: number | null; room: RoomUse; weight?: Num }
export type UseMode = 'full' | 'half' | 'own' | 'none'
export interface Usage { mode: UseMode; price?: Num | null }
export type StepKind = 'profit' | 'markup' | 'add_pp' | 'add_group' | 'commission' | 'vat_margin' | 'vat' | 'discount' | 'relative' | 'round' | 'formula'
export interface PriceStep {
  id: string; kind: StepKind; label: string; on: boolean; value: Num; group?: Num; min_pp?: Num
  mode?: 'floor' | 'nearest' | 'ceil'; ref?: string | null; formula?: string; only: string[]; min_pax?: number | null; max_pax?: number | null
  cats?: string[]   // markup: only on these kinds of cost
}
export interface QuoteTier { max_pax: number; unit_price: Num | null; quantity: string | null; label: string }
export interface QuoteItem {
  id: string; category: QuoteCategory; name: string; vendor_id: string | null; service_id?: string | null; currency: string; unit_price: Num
  quantity: string; basis: QuoteBasis; who: QuoteWho; capacity: number | null; extra: number
  tiers: QuoteTier[]; included: boolean; vehicle: boolean; day: number | null; notes: string
  uses?: Record<string, Usage>
  optional?: boolean   // not in the tour price: offered on top, priced on its own
  free?: boolean       // priced at 0 on purpose (a free museum): not "no price yet"
  price_formula?: string   // the price as a formula of the inputs ("558 if crossings == 2 else 316")
  standard?: boolean       // one of the agency's standard lines: in every new calculation
  season_prices?: Record<string, Num>
  kind?: string | null     // the agency's own kind of cost (Flight, Visa…); `category` is what it counts as
  travel?: TravelInfo | null   // tickets: the journey, taxes, ticket-by date
  with_line?: string | null    // comes with that line: in the price only when it is
}
/** A formula the agency keeps to reuse. */
export interface SavedFormula { name: string; formula: string; note: string }
export type TravelMode = 'flight' | 'train' | 'ferry' | 'coach' | 'other'
/** One flight / train / ferry of a ticket. */
export interface TravelLeg { from_place: string; to_place: string; on: string | null; carrier: string; number: string; depart: string; arrive: string }
export interface TravelInfo { mode: TravelMode; legs: TravelLeg[]; cabin: string; baggage: string; taxes: Num; ticket_by: string | null }
/** A kind of cost the agency adds (Flight, Train, Visa, Insurance…), counted as `base` in budgets and finance. */
export interface CostKind { id: string; name: string; base: QuoteCategory; icon: string; color: string; basis: QuoteBasis; travel: boolean }
/** A vehicle the bus company offers. max_pax: chosen automatically for groups up to this size. */
export interface Vehicle { id: string; name: string; seats: number; day_price: Num; currency: string; fuel_l_100km: Num | null; max_pax: number | null; vendor_id?: string | null }
/** The group's vehicles for the whole trip: rent per day and fuel by distance. */
export interface TransportPlan {
  vehicles: Vehicle[]; mode: 'auto' | 'fixed'; fixed: { vehicle_id: string; count: number }[]; extra_seats: number
  days: Num | null; extra_days: Num; km: Num; extra_km: Num; fuel_price: Num | null; fuel_currency: string | null; fuel_date: string | null
}
/** A part of the year with its own prices; the calculation's own prices are the base. */
export interface Season { id: string; name: string; from_date: string | null; to_date: string | null }
export interface SeasonRoom { price_dbl?: Num | null; price_sgl?: Num | null; price_trp?: Num | null; price_quad?: Num | null }
export interface SellCurrency { currency: string; rate?: Num | null; step: Num; mode: 'floor' | 'nearest' | 'ceil' }
export interface QuoteNight {
  id: string; city: string; vendor_id: string | null; hotel_name: string; currency: string
  price_dbl: Num | null; price_sgl: Num | null; price_trp: Num | null
  staff_stay?: StaffStay; staff_hotel?: string; staff_price?: Num | null; staff_currency?: string | null; staff_twin?: boolean
  price_quad?: Num | null; season_prices?: Record<string, SeasonRoom>
}
export interface QuoteDoc {
  name: string; series_id: string | null; client_id: string | null; status: QuoteStatus; currency: string
  valid_from: string | null; valid_to: string | null; days: number; pax_min: number; pax_max: number
  leaders: number; leader_single: boolean; leader_room?: LeaderRoom | null; leaders_per?: number | null
  staff: number; profit_group: Num; profit_min_pp: Num
  margin_floor_pct: Num; single_profit: boolean; rounding_mode: 'floor' | 'nearest' | 'ceil'; rounding_step: Num
  fx: Record<string, Num>; variables: Record<string, Num>; variable_notes: Record<string, string>; languages: string[]
  texts: Record<string, Record<string, string>>; notes: string; nights: QuoteNight[]; items: QuoteItem[]
  people?: PersonType[]; recipe?: PriceStep[]; extra_markup?: Num
  seasons?: Season[]; sell_in?: SellCurrency[]; per_room?: boolean; transport?: TransportPlan | null
}
export interface OtherCurrency { currency: string; price_dbl: number; price_sgl: number; price_trp: number | null; price_quad: number | null }
export interface ExtraPrice { id: string; name: string; cost: number; price: number }
export interface TypePrice { id: string; name: string; count: number; cost: number; price: number }
export interface QuoteTierRow {
  tourists: number; leaders: number; label: string; cost_dbl: number; cost_sgl: number; cost_trp: number | null
  profit_pp: number; price_dbl: number; price_sgl: number; price_trp: number | null; single_supplement: number
  group_cost: number; group_revenue: number; vehicle: string; types?: TypePrice[]; extras?: ExtraPrice[]
  price_quad?: number | null; other?: OtherCurrency[]
}
export interface QuoteResult {
  currency: string; tiers: QuoteTierRow[]; errors: string[]; nights_priced: number; hotel_dbl_pp: number; hotel_sgl_pp: number
  seasons?: { id: string; name: string; from_date: string | null; to_date: string | null; tiers: QuoteTierRow[] }[]
}
export interface QuoteOut extends QuoteDoc { id: string; updated_at: string; version: number; result: QuoteResult; notices?: string[] }
export interface QuoteSummary {
  id: string; name: string; status: QuoteStatus; series_id?: string | null; series_code: string | null; series_color: SeriesColor | null
  client_name: string | null; days: number; pax_min: number; pax_max: number; leaders: number; currency: string
  price_from?: number | null; price_to?: number | null
  valid_from: string | null; valid_to: string | null; updated_at: string; tours: number
}
export interface ItemCalc {
  index: number; name: string; category: QuoteCategory; kind?: string | null; included: boolean; quantity: number | null
  unit_price: number | null; currency: string; multiplier: number | null; amount: number; error: string | null
}
export interface PriceSteps {
  lines_total: number; leader_room: number; staff_room?: number; shared_pp: number; hotel_dbl_pp: number; hotel_sgl_pp: number
  profit_group_pp: number; profit_min_pp: number; profit_floor_pp: number; profit_rule: 'group' | 'minimum' | 'floor'
  unrounded_dbl: number; unrounded_sgl: number; rounding_mode: 'floor' | 'nearest' | 'ceil'; rounding_step: number; single_profit: boolean
  recipe?: { label: string; kind: string; amount: number; price: number }[]
}
export interface PersonCost { id: string; name: string; role: PersonRole; count: number; own: number; shared: number; for_others: number }
export interface Breakdown {
  tier: QuoteTierRow; items: ItemCalc[]; leader_room: number
  hotel_nights: { night: number; city: string; hotel: string; dbl_pp: number; sgl: number; staff?: number }[]; steps: PriceSteps
  people?: PersonCost[]
}
export interface FormulaCheck {
  ok: boolean; values: { tourists: number; value: number }[]
  error_code: string | null; error: string | null; error_params: Record<string, string | number>
  names: { name: string; value: number; note: string; builtin: boolean }[]
}
export interface PriceListData {
  lang: string; title: string; texts: Record<string, string>; labels: Record<string, string>; currency: string
  valid_from: string | null; valid_to: string | null; leaders: number; hotels: { city: string; hotel: string }[]
  tiers: QuoteTierRow[]; errors: string[]; show_trp: boolean
  sections?: { title: string; columns: string[]; rows: (string | number | null)[][] }[]
  extras?: { name: string; from: number; to: number }[]
}
// --- Incidents (Phase C) ---------------------------------------------------------
export type IncidentKind = 'extra_service' | 'vendor_failure' | 'client_request' | 'delay' | 'damage' | 'penalty' | 'cancellation' | 'other'
export const INCIDENT_KINDS: IncidentKind[] = ['extra_service', 'vendor_failure', 'client_request', 'delay', 'damage', 'penalty', 'other']
export type CarriedBy = 'client' | 'agency' | 'vendor'
export type IncidentStatus = 'open' | 'approved' | 'rejected' | 'settled'
export interface IncidentCost {
  vendor_id: string | null; category: CostCategory; description: string; quantity: string | number; unit_price: string | number; currency: string
  amount?: number
}
export interface Incident {
  id: string; tour_id: string; tour_code: string; day: number | null; date: string | null; kind: IncidentKind
  title: string; description: string; carried_by: CarriedBy; vendor: VendorRef | null; status: IncidentStatus
  reported_by: string | null; reported_at: string; decided_by: string | null; decided_at: string | null; decision_note: string
  costs: IncidentCost[] | null; client_charge: number | null; client_credit: number | null; client_currency: string; vendor_claim: number | null
  claim_currency: string; invoice_id: string | null; total_base: number | null; needs: 'manager' | 'admin'; can_decide: boolean
}

export interface CancelPreview {
  days_left: number; scale_source: 'client' | 'agency'; scale: ScaleRow[]; rule: ScaleRow | null; percent: number
  client: { invoice_id: string | null; number: string | null; currency: string; base: number; paid: number; keep: number; credit: number; refund: number; new_invoice: boolean }[]
  drafts_removed: string[]; free_lines: number; client_penalty_base: number; vendor_penalty_base: number
  vendors: { vendor: VendorRef; currency: string; booked: number; first_service: string; days_left: number; percent: number; rule: ScaleRow | null; penalty: number; paid: number; owes_back: number }[]
  needs: 'manager' | 'admin'; can_apply: boolean; warnings: string[]
}

/** A tour's budget: its calculation frozen at the size sold, against the actual cost lines. */
export interface BudgetLine {
  id: string; kind: 'item' | 'hotel'; category: string; name: string; vendor: VendorRef | null; day: number | null
  quantity: number; unit_price: number; currency: string; amount: number; notes: string
  planned_base: number; actual_base: number | null; variance_base: number | null; costs: number
  status: 'no_cost' | 'on_budget' | 'over' | 'under'
}
export interface Budget {
  has_quote: boolean; quote_id: string | null; quote_name: string | null; quote_range: [number, number] | null
  set: boolean; source: string; set_at: string | null; tourists: number | null; leaders: number | null
  actual_tourists: number; currency: string; lines: BudgetLine[]; unbudgeted: CostLine[]; missing_rates: boolean; warnings: string[]
  incidents: { id: string; title: string; status: IncidentStatus; carried_by: CarriedBy; cost: number; vendor_credit: number; client_charge: number; client_charge_draft: number; net: number }[]
  totals: {
    planned: number; planned_costed: number; actual_budgeted: number; variance: number; not_costed: number
    unbudgeted: number; incidents: number; actual: number; revenue_planned: number; revenue_actual: number; profit_planned: number; profit_actual: number
  }
}

// --- History & scenarios ---------------------------------------------------------
export interface Change {
  area: 'settings' | 'variables' | 'fx' | 'items' | 'nights' | 'texts'
  action: 'added' | 'removed' | 'changed'; key: string; label: string
  field: string | null; before: string | null; after: string | null
}
export interface PriceImpact { tourists: number; label: string; before: number | null; after: number | null }
export interface QuoteVersion { number: number; note: string; created_at: string; created_by: string | null; changes: number }
export interface VersionDiff { number: number; against: number | null; changes: Change[]; impact: PriceImpact[] }
export interface ScenarioPatch {
  settings: Partial<Pick<QuoteDoc, 'days' | 'leaders' | 'leader_single' | 'staff' | 'profit_group' | 'profit_min_pp' | 'margin_floor_pct' | 'single_profit' | 'rounding_mode' | 'rounding_step'>>
  variables: Record<string, Num>; fx: Record<string, Num>
  items: Record<string, { included?: boolean; unit_price?: Num; quantity?: string }>
  nights: Record<string, { hotel_name?: string; vendor_id?: string; price_dbl?: Num; price_sgl?: Num; price_trp?: Num }>
}
export interface Scenario { id: string; name: string; patch: ScenarioPatch; changes: Change[]; stale: string[]; updated_at: string }
export interface ScenarioResult { id: string | null; name: string; result: QuoteResult; changes: Change[] }
export interface CompareOut { base: QuoteResult; scenarios: ScenarioResult[] }

// --- Bookings and tasks -------------------------------------------------------------
export type WorkKind = 'hotel' | 'meal' | 'transport' | 'guide' | 'activity' | 'other'
export const WORK_KINDS: WorkKind[] = ['hotel', 'meal', 'transport', 'guide', 'activity', 'other']
export type BookingStatus = 'to_book' | 'requested' | 'confirmed' | 'problem' | 'cancelled'
export const BOOKING_STATUSES: BookingStatus[] = ['to_book', 'requested', 'confirmed', 'problem', 'cancelled']
export type BookingState = 'ok' | 'to_book' | 'waiting' | 'changed' | 'cancel' | 'problem' | 'cancelled'
export type PayWhen = '' | 'asap' | 'before' | 'after' | 'on_site'
export type PayMethod2 = 'transfer' | 'cash' | 'card'
export interface BookingDetails {
  nights?: number; rooms?: Record<string, number>; breakfasts?: number; lunches?: number; dinners?: number; people?: number
  stays?: { check_in: string; check_out: string; nights: number }[]
  tourists_pay?: number    // of the meals: the tourists pay the restaurant themselves (reservation only)   // hotels: separate stays, as the hotel reads them
  services?: Record<string, number>; staff?: { role: StaffRole; from: number; to: number }[]
}
export interface Booking {
  id: string; vendor: { id: string; name: string; type: VendorType; phone: string; email: string; contact_person: string }
  kind: WorkKind; first_date: string | null; last_date: string | null; details: BookingDetails; in_itinerary: boolean
  status: BookingStatus; state: BookingState; reference: string; note: string
  assignee_id: string | null; default_assignee_id: string | null; book_by: string; book_by_custom: boolean
  pay_when: PayWhen; pay_method: PayMethod2; paid_by: 'office' | 'guide'; confirmed_at: string | null
}
export interface TourBookings { bookings: Booking[]; confirmed: number; total: number }
export type TaskKind = 'book' | 'chase' | 'reconfirm' | 'cancel' | 'problem' | 'pay' | 'own'
export interface TaskItem {
  key: string; kind: TaskKind; title: string; note: string; tour_id: string | null; tour_code: string | null
  tour_start: string | null; booking_id: string | null; task_id: string | null; vendor_kind: WorkKind | null
  amount: number | null; currency: string | null; due_date: string | null
  assignee_id: string | null; assignee_name: string | null; done: boolean; link: string
  type_id?: string | null
  count?: number | null      // a series task: how many departures it covers
  vendor_id?: string | null
  stage: TaskStage           // on the board: to do, in progress, waiting, done
  passed_by?: string | null  // who handed it over, and their note
  passed_note?: string
}
export type TaskStage = 'todo' | 'doing' | 'waiting' | 'done'
export interface TaskSummary { mine: number; late: number; nobody: number }

/** A saved day ("Kutaisi day"): a day's hotel, meals, activities and timeline, to fill another tour's day. */
export interface DayTemplate { id: string; name: string; city: string; data: Partial<DayFields>; created_at: string }
