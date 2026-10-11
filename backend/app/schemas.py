from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

Role = Literal["guide", "staff", "manager", "admin", "owner"]
Job = Literal["operations", "finance", "sales"]
Language = Literal["en", "ka"]


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def _currency(v: str) -> str:
    v = v.strip().upper()
    if len(v) != 3 or not v.isalpha():
        raise ValueError("Currency must be a 3-letter ISO code, e.g. USD")
    return v


# --- auth -------------------------------------------------------------------

class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    full_name: str = Field(default="", max_length=200)
    # Optional so an invited person can sign up without creating their own agency.
    workspace_name: str | None = Field(default=None, max_length=200)
    base_currency: str = "USD"        # the new agency's currency (asked at sign-up)
    language: Language = "en"

    _cur = field_validator("base_currency")(_currency)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(_Out):
    id: str
    email: str
    full_name: str
    theme: str = "blue"
    easy_view: bool = False
    text_size: str = "normal"
    date_style: str = "dmy"


Theme = Literal["blue", "green", "violet"]


class MeUpdate(BaseModel):
    """Your own preferences."""
    theme: Theme | None = None
    easy_view: bool | None = None
    text_size: Literal["normal", "large", "larger"] | None = None
    date_style: Literal["dmy", "mdy", "text"] | None = None


# --- workspaces --------------------------------------------------------------

class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    base_currency: str = "USD"
    language: Language = "en"

    _cur = field_validator("base_currency")(_currency)


class ScaleRow(BaseModel):
    """Cancelled within this many days of arrival (or of the first service) → this percent."""
    within_days: int = Field(ge=0, le=730)
    percent: float = Field(ge=0, le=100)


def _scale(v: list[ScaleRow] | None) -> list[ScaleRow] | None:
    if v is None:
        return v
    days = [r.within_days for r in v]
    if len(days) != len(set(days)):
        raise ValueError("each 'within N days' can appear once")
    return sorted(v, key=lambda r: -r.within_days)


Scale = Annotated[list[ScaleRow], Field(max_length=20)]


class PaymentTerms(BaseModel):
    """A deposit of deposit_percent due deposit_days after booking; the balance
    balance_days_before arrival. deposit_percent 0 = one invoice, due before arrival."""
    deposit_percent: float = Field(default=0, ge=0, le=100)
    deposit_days: int = Field(default=7, ge=0, le=365)
    balance_days_before: int = Field(default=14, ge=0, le=365)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_currency: str | None = None
    language: Language | None = None
    # Incidents above this (base currency) need an admin/owner; null = managers approve any.
    incident_approval_limit: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    cancellation_scale: Scale | None = None
    payment_terms: PaymentTerms | None = None
    bill_tolerance_pct: Decimal | None = Field(default=None, ge=0, le=50, max_digits=5, decimal_places=2)
    # Who does what: kind of work → user id (hotel, meal, transport, guide, activity, other, payments).
    task_owners: dict[Literal["hotel", "meal", "transport", "guide", "activity", "other", "payments"], str | None] | None = None
    fuel_l_per_100km: Decimal | None = Field(default=None, gt=0, le=200, max_digits=5, decimal_places=1)
    countries: list[str] | None = Field(default=None, max_length=20)
    place_lang: Literal["", "en", "ka", "ru", "hy"] | None = None
    drive_factor: Decimal | None = Field(default=None, ge=1, le=3, max_digits=4, decimal_places=2)
    phone: str | None = Field(default=None, max_length=50)
    vat_rate: Decimal | None = Field(default=None, ge=0, le=50, max_digits=5, decimal_places=2)   # null clears (no VAT)
    plate_share: int | None = Field(default=None, ge=1, le=20)     # people sharing one plate (1 = own portions)

    @field_validator("countries")
    @classmethod
    def _countries(cls, v):
        if v is None:
            return v
        out = []
        for c in v:
            c = c.strip().lower()
            if len(c) != 2 or not c.isalpha():
                raise ValueError("Countries are 2-letter codes, e.g. GE, AM")
            if c not in out:
                out.append(c)
        return out

    _scale = field_validator("cancellation_scale")(_scale)

    @field_validator("base_currency")
    @classmethod
    def _cur(cls, v):
        return None if v is None else _currency(v)


class WorkspaceOut(_Out):
    id: str
    name: str
    slug: str
    base_currency: str
    language: str
    # Money settings: None for roles below manager (routers/auth.workspace_view).
    incident_approval_limit: float | None = None
    cancellation_scale: list[ScaleRow] | None = None
    payment_terms: PaymentTerms | None = None
    bill_tolerance_pct: float | None = None
    task_owners: dict[str, str | None] = {}
    task_types: list[dict] = []
    fuel_l_per_100km: float = 30
    countries: list[str] = []
    place_lang: str = ""
    drive_factor: float = 1.25
    phone: str = ""
    vat_rate: float | None = None
    plate_share: int = 1
    ai_key_hint: str = ""             # last 4 characters of the agency's own AI key; the key itself never leaves the server
    ai_workspace_id: str = ""         # Anthropic Console workspace, for organization-level keys


class MyWorkspaceOut(WorkspaceOut):
    role: Role
    jobs: list[Job] = []          # what this person does here (owners and admins: all)


class MeOut(BaseModel):
    user: UserOut
    workspaces: list[MyWorkspaceOut]


# --- members & invites ---------------------------------------------------------

class MemberOut(BaseModel):
    id: str
    user_id: str
    email: str
    full_name: str
    role: Role
    created_at: datetime
    jobs: list[Job] = []          # in effect (from the role when none were given)
    jobs_set: bool = False        # given by hand (else: from the role)


class RoleUpdate(BaseModel):
    role: Role | None = None
    jobs: list[Job] | None = None


class InviteCreate(BaseModel):
    email: EmailStr
    role: Role = "staff"
    jobs: list[Job] | None = None


class InviteOut(_Out):
    id: str
    email: str
    role: Role
    created_at: datetime
    expires_at: datetime
    link: str


class InvitePublic(BaseModel):
    workspace_name: str
    email: str
    role: Role
    status: Literal["pending", "accepted", "expired"]


# --- Milestone 2: vendors, clients, series, tours ---------------------------------

VendorType = Literal["hotel", "restaurant", "transport", "guide", "driver", "activity", "airline", "rail", "other"]
TourStatus = Literal["inquiry", "confirmed", "cancelled"]
SeriesColor = Literal["indigo", "emerald", "amber", "rose", "sky", "violet", "teal", "orange", "slate", "lime"]


def _opt_currency(v: str | None) -> str | None:
    return v if v in (None, "") else _currency(v)


class Away(BaseModel):
    """Dates a guide or driver can't work (vacation, another job), both days included."""
    start: date
    end: date
    note: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def _order(self):
        if self.end < self.start:
            raise ValueError("The last day is before the first")
        return self


class VendorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: VendorType | None = None
    city: str | None = Field(default=None, max_length=100)
    contact_person: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=50)
    phone2: str | None = Field(default=None, max_length=50)
    address: str | None = Field(default=None, max_length=300)
    email: str | None = Field(default=None, max_length=255)
    payment_timing: Literal["before", "after"] | None = None
    payment_days: int | None = Field(default=None, ge=0, le=365)
    currency: str | None = None
    notes: str | None = Field(default=None, max_length=5000)
    is_active: bool | None = None
    cancel_terms: Scale | None = None
    languages: list[Annotated[str, Field(min_length=1, max_length=30)]] | None = Field(default=None, max_length=15)
    unavailable: list[Away] | None = Field(default=None, max_length=100)
    vat_invoice: bool | None = None
    visit_minutes: int | None = Field(default=None, ge=5, le=720)   # how long a visit usually takes
    company_id: str | None = None      # a driver's (or guide's) company: the transport supplier that sends them
    category: str | None = Field(default=None, max_length=40)        # activity places: museum, cable_car... or the agency's own

    _cur = field_validator("currency")(_opt_currency)
    _terms = field_validator("cancel_terms")(_scale)

    @field_validator("languages")
    @classmethod
    def _langs(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        out: list[str] = []
        for x in (s.strip() for s in v):
            if x and x.lower() not in {o.lower() for o in out}:
                out.append(x)
        return out

    @field_validator("unavailable")
    @classmethod
    def _sorted(cls, v: list[Away] | None) -> list[Away] | None:
        return sorted(v, key=lambda a: a.start) if v is not None else v


class VendorCreate(VendorUpdate):
    name: str = Field(min_length=1, max_length=200)
    type: VendorType


class VendorOut(_Out):
    id: str
    name: str
    type: VendorType
    city: str
    address: str = ""
    contact_person: str
    phone: str
    phone2: str
    email: str
    payment_timing: Literal["before", "after"]
    payment_days: int
    currency: str
    notes: str
    is_active: bool
    cancel_terms: list[ScaleRow] = []
    languages: list[str] = []
    unavailable: list[Away] = []
    vat_invoice: bool = False
    visit_minutes: int | None = None
    company_id: str | None = None
    category: str = ""
    placeholder: bool = False


class VendorRef(_Out):
    id: str
    name: str
    type: VendorType
    phone: str
    placeholder: bool = False       # a person not named yet ("Guide (to be named)")


class ClientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: Literal["agency", "direct"] | None = None
    country: str | None = Field(default=None, max_length=100)
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=50)
    notes: str | None = Field(default=None, max_length=5000)
    cancellation_scale: Scale | None = None   # null = the agency's scale
    payment_terms: PaymentTerms | None = None  # null = the agency's terms

    _scale = field_validator("cancellation_scale")(_scale)


class ClientCreate(ClientUpdate):
    name: str = Field(min_length=1, max_length=200)


class ClientOut(_Out):
    id: str
    name: str
    type: Literal["agency", "direct"]
    country: str
    contact_person: str
    email: str
    phone: str
    notes: str
    cancellation_scale: list[ScaleRow] | None = None
    payment_terms: PaymentTerms | None = None


def _slot_id() -> str:
    return uuid4().hex[:12]


class DayExtra(BaseModel):
    """A catalog service used on a day. quantity None = worked out from the service's
    unit (per person → group size, per room/night → rooms, per group/day → 1)."""
    id: str = Field(default_factory=_slot_id, min_length=1, max_length=40)
    service_id: str = Field(min_length=1, max_length=36)
    quantity: Annotated[Decimal, Field(gt=0, max_digits=10, decimal_places=2)] | None = None
    notes: str = Field(default="", max_length=300)
    # Offered, not booked: "churchkhela class, if the group wants". Shown as optional on the programme,
    # priced as an optional extra in calculations, and not in the tour's costs until it's taken.
    optional: bool = False


MealMode = Literal["included", "tourists", "own"]
BreakfastMode = Literal["hotel", "included", "tourists", "own"]   # at the hotel (room price) · or like the other meals   # we pay · tourists pay on the spot · free time
StaffStay = Literal["none", "same", "own", "free"]


class ScheduleItem(BaseModel):
    """One step of a day's programme."""
    id: str = Field(min_length=1, max_length=40)
    kind: Literal["breakfast", "meal", "visit", "transfer", "free", "checkin", "checkout", "flight", "other"] = "other"
    time: str = Field(default="", pattern=r"^(|([01]\d|2[0-3]):[0-5]\d)$")
    end: str = Field(default="", pattern=r"^(|([01]\d|2[0-3]):[0-5]\d)$")
    title: str = Field(default="", max_length=200)
    ref: str | None = Field(default=None, max_length=80)
    place: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=300)
    fixed: bool = False      # a time typed by hand: it stays when the rest of the day is re-timed


class Flight(BaseModel):
    """A group flight on a day: arriving into or leaving from the tour."""
    direction: Literal["arrival", "departure"]
    number: str = Field(min_length=2, max_length=12)
    time: str = Field(default="", pattern=r"^(|([01]\d|2[0-3]):[0-5]\d)$")    # local time, 24 h
    airport: str = Field(default="", max_length=40)       # ours: TBS, EVN, KUT, BUS…
    other: str = Field(default="", max_length=60)         # where from / where to
    notes: str = Field(default="", max_length=200)

    @field_validator("number")
    @classmethod
    def _no(cls, v: str) -> str:
        return v.strip().upper().replace(" ", "")


def _stops(v: list[str] | None) -> list[str] | None:
    """Places visited on the way, trimmed; empty entries dropped."""
    return [" ".join(x.split())[:100] for x in v if x and x.strip()] if v is not None else v


def _unique_slots(v: list[DayExtra] | None) -> list[DayExtra] | None:
    seen = set()
    for x in v or []:
        if x.id in seen:
            x.id = _slot_id()
        seen.add(x.id)
    return v


class MealDish(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: float | None = Field(default=None, ge=0, le=100000)   # one plate, in the menu's currency
    per_plate: int | None = Field(default=None, ge=1, le=20)      # people sharing one plate (None = the tour's / agency's)


def _per_meal(v: dict) -> dict:
    """Only breakfast / lunch / dinner, and not too much of anything."""
    if any(k not in ("breakfast", "lunch", "dinner") for k in v):
        raise ValueError("meals are breakfast, lunch or dinner")
    if any(isinstance(x, list) and len(x) > 40 for x in v.values()) or len(str(v)) > 20000:
        raise ValueError("too many dishes or people")
    return v


class DayFields(BaseModel):
    city: str = Field(default="", max_length=100)
    hotel_id: str | None = None
    breakfast_id: str | None = None
    breakfast_menu_id: str | None = None
    lunch_id: str | None = None
    dinner_id: str | None = None
    lunch_menu_id: str | None = None    # a set menu of the lunch restaurant
    dinner_menu_id: str | None = None
    border_crossing: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=2000)
    extras: list[DayExtra] = Field(default_factory=list, max_length=30)
    km: int | None = Field(default=None, ge=0, le=5000)
    drive_minutes: list[int] = Field(default_factory=list, max_length=9)   # car minutes per leg, from the map
    drive_km: list[int] = Field(default_factory=list, max_length=9)        # road km per leg, same order

    stops: list[str] = Field(default_factory=list, max_length=8)
    breakfast_mode: BreakfastMode = "hotel"
    lunch_mode: MealMode = "included"
    dinner_mode: MealMode = "included"
    flights: list[Flight] = Field(default_factory=list, max_length=6)
    schedule: list[ScheduleItem] = Field(default_factory=list, max_length=30)
    staff_stay: StaffStay = "none"
    staff_hotel_id: str | None = None
    staff_twin: bool = False
    # Per meal: this tour's own dishes (instead of the menu's), and who sits elsewhere than usual
    # (app/seating.py) - {"dinner": {"<staff id>": "group", "_extra": [{"name": "Photographer", "seat": "staff"}]}}.
    meal_dishes: dict[str, list[MealDish]] = Field(default_factory=dict)
    seating: dict[str, dict] = Field(default_factory=dict)
    meal_tbd: dict[str, str] = Field(default_factory=dict)   # {"lunch": "Yerevan"}: place to be decided, in that town
    staff_stays: dict[str, dict] = Field(default_factory=dict)   # {"<staff id or role>": {"stay": "own", "hotel_id": …}}

    _stops_ok = field_validator("stops")(_stops)

    @field_validator("staff_stays")
    @classmethod
    def _stays(cls, v: dict[str, dict]) -> dict[str, dict]:
        if len(v) > 20:
            raise ValueError("too many staff")
        out = {}
        for k, x in v.items():
            stay = (x or {}).get("stay")
            if not isinstance(k, str) or len(k) > 40 or stay not in ("none", "same", "own", "free"):
                raise ValueError("staff_stays: each is {stay: none|same|own|free, hotel_id}")
            hid = x.get("hotel_id") if stay == "own" else None
            out[k] = {"stay": stay, "hotel_id": hid if isinstance(hid, str) and hid else None}
        return out

    @field_validator("meal_tbd")
    @classmethod
    def _tbd(cls, v: dict[str, str]) -> dict[str, str]:
        out = {k: " ".join(t.split())[:100] for k, t in v.items() if k in ("breakfast", "lunch", "dinner")}
        return {k: t for k, t in out.items() if t}
    _slots = field_validator("extras")(_unique_slots)
    _meals = field_validator("meal_dishes", "seating")(_per_meal)


class SeriesDayOut(DayFields, _Out):
    day_number: int


class StaffPlanItem(BaseModel):
    """One person (or one kind of person, still unnamed) working part of a route."""
    role: Literal["guide", "driver", "transport", "tour_leader", "assistant", "other"] = "guide"
    from_day: int = Field(default=1, ge=1, le=60)
    to_day: int | None = Field(default=None, ge=1, le=60)    # None = until the last day
    vendor_id: str | None = None
    label: str = Field(default="", max_length=100)            # "Armenian guide"

    @model_validator(mode="after")
    def _order(self):
        if self.to_day is not None and self.to_day < self.from_day:
            raise ValueError("The last day comes before the first")
        return self


class BusReturn(BaseModel):
    """The bus driving back to its garage when the tour ends elsewhere: on the last day, or the next day
    (one more bus day to pay). Its km count with the trip's."""
    on: Literal["last", "next"] = "last"
    to: str = Field(default="", max_length=100)
    km: int | None = Field(default=None, ge=0, le=5000)


class SeriesIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(default="", max_length=200)
    color: SeriesColor = "indigo"
    notes: str = Field(default="", max_length=5000)
    days: list[DayFields] = Field(default_factory=list, max_length=60)
    staff_plan: list[StaffPlanItem] | None = Field(default=None, max_length=20)   # None: leave as it is
    bus_return: BusReturn | None = None

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        return v.strip().upper()


class SeriesOut(_Out):
    id: str
    code: str
    name: str
    color: SeriesColor
    notes: str
    days: list[SeriesDayOut]
    staff_plan: list[StaffPlanItem] = []
    bus_return: BusReturn | None = None


class TourUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=40)
    name: str | None = Field(default=None, max_length=200)
    client_id: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    status: TourStatus | None = None
    pax: int | None = Field(default=None, ge=0, le=10000)
    pax_estimated: bool | None = None
    rooms: str | None = Field(default=None, max_length=200)
    plate_share: int | None = Field(default=None, ge=0, le=20)     # 0 = back to the agency's usual
    leaders: int | None = Field(default=None, ge=0, le=20)         # of pax, free tour leaders
    staff_table: bool | None = None
    leader_seat: Literal["group", "staff", "none"] | None = None   # where the tour leaders eat
    notes: str | None = Field(default=None, max_length=5000)
    price_pp: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    price_currency: str | None = None

    _price_cur = field_validator("price_currency")(lambda v: _currency(v) if v else v)

    @field_validator("code")
    @classmethod
    def _code(cls, v):
        return None if v is None else v.strip().upper()


class TourCreate(TourUpdate):
    # Code is generated from the series + start date when left empty (e.g. HM-0906).
    code: str | None = Field(default=None, max_length=40)
    series_id: str | None = None
    start_date: date
    # Derived from the series length when omitted.
    end_date: date | None = None
    status: TourStatus = "confirmed"


class TourDayUpdate(BaseModel):
    city: str | None = Field(default=None, max_length=100)
    hotel_id: str | None = None
    breakfast_id: str | None = None
    breakfast_menu_id: str | None = None
    lunch_id: str | None = None
    dinner_id: str | None = None
    lunch_menu_id: str | None = None
    dinner_menu_id: str | None = None
    border_crossing: str | None = Field(default=None, max_length=100)
    notes: str | None = Field(default=None, max_length=2000)
    extras: list[DayExtra] | None = Field(default=None, max_length=30)
    km: int | None = Field(default=None, ge=0, le=5000)
    drive_minutes: list[int] | None = Field(default=None, max_length=9)
    drive_km: list[int] | None = Field(default=None, max_length=9)
    stops: list[str] | None = Field(default=None, max_length=8)
    breakfast_mode: BreakfastMode | None = None
    lunch_mode: MealMode | None = None
    dinner_mode: MealMode | None = None
    flights: list[Flight] | None = Field(default=None, max_length=6)
    schedule: list[ScheduleItem] | None = Field(default=None, max_length=30)
    staff_stay: StaffStay | None = None
    staff_hotel_id: str | None = None
    staff_twin: bool | None = None

    _slots = field_validator("extras")(_unique_slots)
    _stops_ok = field_validator("stops")(_stops)


class TourDayOut(_Out):
    id: str
    day_number: int
    date: date
    city: str
    hotel: VendorRef | None
    breakfast: VendorRef | None = None
    breakfast_menu_id: str | None = None
    lunch: VendorRef | None
    dinner: VendorRef | None
    lunch_menu_id: str | None = None
    dinner_menu_id: str | None = None
    border_crossing: str
    notes: str
    extras: list[DayExtra]
    km: int | None = None
    drive_minutes: list[int] = []
    drive_km: list[int] = []
    stops: list[str] = []
    breakfast_mode: str = "hotel"
    lunch_mode: str = "included"
    dinner_mode: str = "included"
    flights: list[dict] = []
    schedule: list[dict] = []
    staff_stay: str = "none"
    staff_hotel: VendorRef | None = None
    staff_twin: bool = False
    meal_dishes: dict = {}
    seating: dict = {}
    meal_tbd: dict = {}
    staff_stays: dict = {}


class TourSummary(BaseModel):
    id: str
    code: str
    name: str
    series_id: str | None
    series_code: str | None
    color: SeriesColor
    client_id: str | None
    client_name: str | None
    start_date: date
    end_date: date
    status: TourStatus
    pax: int
    pax_estimated: bool = False
    rooms: str
    quote_id: str | None = None         # the calculation it was sold from / given
    staff: list["StaffOut"]
    participant_count: int
    phase: str = "confirmed"            # inquiry | confirmed | operating | settling | closed | cancelled
    closed_at: datetime | None = None


class TourOut(TourSummary):
    plate_share: int | None = None       # this group's people per plate (None = the agency's)
    bus_return: BusReturn | None = None
    leaders: int = 0
    staff_table: bool = False
    leader_seat: str | None = None
    notes: str
    price_pp: float | None = None       # managers only (None for others)
    price_currency: str | None = None
    days: list[TourDayOut]
    route_changed: bool = False   # its route's days were edited after this tour copied them


class DayViewRow(BaseModel):
    tour: TourSummary
    day: TourDayOut
    # Only the staff working this particular day.
    staff_today: list["StaffOut"]
    is_first_day: bool
    is_last_day: bool
    prev_hotel: VendorRef | None = None    # where the group slept: breakfast "at the hotel" is there


# --- Milestone 3: staff, participants, import --------------------------------------

StaffRole = Literal["guide", "driver", "transport", "tour_leader", "assistant", "other"]
RoomType = Literal["", "SGL", "DBL", "TWN", "TRP", "QUAD"]
Gender = Literal["", "M", "F"]


class StaffUpdate(BaseModel):
    vendor_id: str | None = None
    role: StaffRole | None = None
    start_day: int | None = Field(default=None, ge=1, le=60)
    end_day: int | None = Field(default=None, ge=1, le=60)  # explicit null = until the last day
    notes: str | None = Field(default=None, max_length=2000)
    meal_seat: Literal["group", "staff", "none"] | None = None   # where they eat at the meals


class StaffIn(StaffUpdate):
    vendor_id: str | None = None      # none: the role without a name yet ("Guide (to be named)"), named later
    role: StaffRole
    start_day: int = Field(default=1, ge=1, le=60)


class StaffOut(_Out):
    id: str
    role: StaffRole
    vendor: VendorRef
    start_day: int
    end_day: int | None
    notes: str
    meal_seat: str | None = None


class ParticipantUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    local_name: str | None = Field(default=None, max_length=100)
    gender: Gender | None = None
    birth_date: date | None = None
    nationality: str | None = Field(default=None, max_length=100)
    passport_number: str | None = Field(default=None, max_length=50)
    passport_expiry: date | None = None
    room_type: RoomType | None = None
    room_group: str | None = Field(default=None, max_length=40)
    room_note: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=50)
    notes: str | None = Field(default=None, max_length=2000)


class ParticipantIn(ParticipantUpdate):
    full_name: str = Field(min_length=1, max_length=200)


class ParticipantOut(_Out):
    id: str
    full_name: str
    local_name: str = ""
    gender: Gender
    birth_date: date | None
    nationality: str
    passport_number: str
    passport_expiry: date | None
    room_type: RoomType
    room_group: str
    room_note: str = ""
    phone: str
    notes: str


class RoomingSummary(BaseModel):
    rooms: dict[str, int]       # {"DBL": 12, "SGL": 2}
    text: str                   # "12 DBL + 2 SGL"
    unassigned: int             # participants without a room type
    passport_warnings: int      # passports expiring within 6 months of tour end


class ImportIssue(BaseModel):
    row: int
    message: str


class ImportResult(BaseModel):
    total: int
    valid: int
    created: int
    committed: bool
    columns: dict[str, str | None]   # spreadsheet header -> field it was matched to
    errors: list[ImportIssue]
    warnings: list[ImportIssue]
    preview: list[dict]
    by_ai: bool = False              # the columns were recognised by AI (the reading itself is the usual one)


TourSummary.model_rebuild()
TourOut.model_rebuild()
DayViewRow.model_rebuild()


# --- Milestone 4: rates, costs, payments ------------------------------------------------

RateKind = Literal["room_SGL", "room_DBL", "room_TWN", "room_TRP", "room_QUAD",
                   "breakfast", "lunch", "dinner", "day", "person", "group", "staff_room", "staff_meal"]
CostCategory = Literal["hotel", "meal", "transport", "guide", "ticket", "visa", "other"]
PayMethod = Literal["bank", "cash", "card", "other"]
PayableStatus = Literal["paid", "partial", "unpaid", "overdue", "owed_to_us"]
Amount = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]


class ExchangeRateIn(BaseModel):
    currency: str
    rate: Decimal = Field(gt=0, max_digits=14, decimal_places=6)

    _cur = field_validator("currency")(_currency)


class ExchangeRateOut(_Out):
    currency: str
    rate: float
    updated_at: datetime


class CostUpdate(BaseModel):
    vendor_id: str | None = None
    category: CostCategory | None = None
    description: str | None = Field(default=None, max_length=300)
    service_date: date | None = None
    service_end: date | None = None
    quantity: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
    unit_price: Amount | None = None
    currency: str | None = None
    rate_to_base: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=6)
    notes: str | None = Field(default=None, max_length=2000)
    budget_line_id: str | None = None   # the planned line this cost belongs to
    # VAT percent inside the line (0 = no VAT invoice); null = the supplier's usual.
    vat_rate: Decimal | None = Field(default=None, ge=0, le=50, max_digits=5, decimal_places=2)

    @field_validator("currency")
    @classmethod
    def _cur(cls, v):
        return None if v is None else _currency(v)


class CostIn(CostUpdate):
    category: CostCategory = "other"
    service_date: date
    quantity: Decimal = Field(default=Decimal(1), gt=0, max_digits=10, decimal_places=2)
    unit_price: Amount
    currency: str


class CostOut(BaseModel):
    id: str
    vendor: VendorRef | None
    category: CostCategory
    description: str
    service_date: date
    service_end: date | None
    quantity: float
    unit_price: float
    currency: str
    rate_to_base: float
    amount: float
    amount_base: float
    notes: str
    auto: bool
    locked: bool
    budget_line_id: str | None
    reason: str = ""            # "" | incident | vendor_credit | bill_adjustment
    incident_id: str | None = None
    vat_rate: float | None = None   # the VAT percent in effect (None = the agency doesn't use VAT)
    vat: float | None = None        # VAT inside the amount, line currency
    vat_by_hand: bool = False       # set on this line, not the supplier's usual


class PaidBy(BaseModel):
    kind: Literal["user", "staff"]
    id: str
    name: str


class PaymentIn(BaseModel):
    vendor_id: str
    currency: str
    # Negative = money the supplier paid back to us (a refund, a claim).
    amount: Decimal = Field(max_digits=14, decimal_places=2)
    paid_on: date

    @field_validator("amount")
    @classmethod
    def _not_zero(cls, v: Decimal) -> Decimal:
        if v == 0:
            raise ValueError("Amount can't be 0")
        return v
    method: PayMethod = "bank"
    reference: str = Field(default="", max_length=200)
    # Paid by a team member (office cash, own card) or a guide/driver from the cash they hold.
    paid_by_user_id: str | None = None
    paid_by_vendor_id: str | None = None
    notes: str = Field(default="", max_length=2000)

    _cur = field_validator("currency")(_currency)


class PaymentOut(BaseModel):
    id: str
    vendor: VendorRef
    currency: str
    amount: float
    paid_on: date
    method: PayMethod
    reference: str
    notes: str
    paid_by: PaidBy | None = None


class Payable(BaseModel):
    """What one tour owes one vendor in one currency."""
    tour_id: str
    tour_code: str
    tour_color: SeriesColor
    vendor: VendorRef
    currency: str
    total: float
    paid: float
    balance: float
    first_service: date | None
    last_service: date | None
    due_date: date | None
    status: PayableStatus
    # The vendor's own invoices against it: billed in total, and how that compares.
    billed: float = 0
    bill_state: Literal["", "no_bill", "matched", "difference", "disputed"] = ""
    bill_difference: float = 0   # billed − expected


class CostTotals(BaseModel):
    by_currency: dict[str, float]
    base_currency: str
    base_total: float
    vat_base: float | None = None    # VAT inside the lines, claimed back (None = the agency doesn't use VAT)
    # Currencies on this tour that had no exchange rate when valued (counted as 0).
    missing_rates: list[str]


class TourCostsOut(BaseModel):
    lines: list[CostOut]
    payables: list[Payable]
    payments: list[PaymentOut]
    totals: CostTotals


class GenerateResult(BaseModel):
    created: int
    updated: int
    removed: int
    kept: int
    linked: int = 0        # new lines matched to a budget line
    warnings: list[str]


class ScheduleOut(BaseModel):
    items: list[Payable]
    # Open balances per currency: overdue, due in 7 days, due in 30 days.
    overdue: dict[str, float]
    due_7: dict[str, float]
    due_30: dict[str, float]


# --- Milestone 5: invoices, debts, profit -----------------------------------------------

InvoiceState = Literal["draft", "issued", "void"]
# What the user sees: the stored state, refined by payments and the due date.
InvoiceDisplay = Literal["draft", "void", "unpaid", "partial", "paid", "overdue", "refund_due", "credit_note"]


class InvoiceLineIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    quantity: Decimal = Field(default=Decimal(1), gt=0, max_digits=10, decimal_places=2)
    # Negative for deductions ("Less deposit, invoice 2026-0004"); the invoice total stays positive.
    unit_price: Decimal = Field(ge=-10**11, le=10**11, max_digits=14, decimal_places=2)


class InvoiceLineOut(BaseModel):
    description: str
    quantity: float
    unit_price: float
    amount: float


class InvoiceIn(BaseModel):
    client_id: str
    tour_id: str | None = None
    issue_date: date
    due_date: date
    currency: str
    rate_to_base: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=6)
    notes: str = Field(default="", max_length=5000)
    lines: list[InvoiceLineIn] = Field(default_factory=list, max_length=100)

    _cur = field_validator("currency")(_currency)


class InvoicePatch(BaseModel):
    """What may still change once an invoice is issued."""
    due_date: date | None = None
    notes: str | None = Field(default=None, max_length=5000)


class ClientPaymentIn(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    received_on: date
    method: PayMethod = "bank"
    reference: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=2000)


class ClientPaymentOut(_Out):
    id: str
    amount: float
    received_on: date
    method: PayMethod
    reference: str
    notes: str


class Ref(BaseModel):
    id: str
    name: str


class TourRef(BaseModel):
    id: str
    code: str
    color: SeriesColor


class DocRef(BaseModel):
    id: str
    number: str | None
    status: InvoiceState
    total: float


class InvoiceSummary(BaseModel):
    id: str
    number: str | None  # None while draft
    kind: Literal["invoice", "credit_note"] = "invoice"
    credits: DocRef | None = None   # a credit note: the invoice it corrects
    status: InvoiceState
    display_status: InvoiceDisplay
    client: Ref
    tour: TourRef | None
    issue_date: date
    due_date: date
    currency: str
    rate_to_base: float
    total: float
    paid: float
    credited: float = 0       # issued credit notes against it
    balance: float            # total − credited − paid; negative = refund due
    total_base: float


class InvoiceOut(InvoiceSummary):
    notes: str
    lines: list[InvoiceLineOut]
    payments: list[ClientPaymentOut]
    credit_notes: list[DocRef] = []
    creditable: float = 0     # what can still be credited (issued invoices)


class CreditNoteIn(BaseModel):
    """Lines to credit; empty = a copy of the invoice's lines to edit down."""
    lines: list[InvoiceLineIn] | None = Field(default=None, max_length=100)
    notes: str = Field(default="", max_length=5000)


class RefundIn(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    paid_on: date
    method: PayMethod = "bank"
    reference: str = Field(default="", max_length=200)


class ClientDebt(BaseModel):
    client: Ref
    open: dict[str, float]
    overdue: dict[str, float]
    refund_due: dict[str, float] = {}   # we owe the client back (credited after they paid)
    open_invoices: int
    oldest_due: date | None


class ProfitRow(BaseModel):
    key: str
    label: str
    color: SeriesColor | None = None
    start_date: date | None = None
    tours: int
    pax: int
    revenue: float
    cost: float
    profit: float
    margin: float | None   # profit / revenue, None when there is no revenue
    uninvoiced: int        # tours in this row with costs but no issued invoice
    missing_rates: bool    # some amount couldn't be converted to the base currency
    missing_currencies: list[str] = []   # …which currencies: ask for exactly these rates
    # One tour, not invoiced yet: what pax × price per person would bring (base currency).
    expected_revenue: float | None = None
    expected_paying: int | None = None      # how many pay: tourists only, free leaders not counted
    expected_profit: float | None = None
    # VAT inside the costs, claimed back; profit after VAT = profit + it. None = the agency doesn't use VAT.
    vat: float | None = None
    profit_after_vat: float | None = None


class ProfitReport(BaseModel):
    base_currency: str
    group: Literal["tour", "month", "route"]
    rows: list[ProfitRow]
    totals: ProfitRow
