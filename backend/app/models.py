import uuid
from datetime import date, datetime, timezone

from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

# Ordered lowest -> highest. A role satisfies every requirement at or below it.
ROLES = ("guide", "staff", "manager", "admin", "owner")
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}


def _uuid() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200), default="")
    theme: Mapped[str] = mapped_column(String(20), default="blue", server_default="blue")   # the app's colour, per person
    # Easier to see: stronger text, borders and focus, no motion; and the text size (normal / large / larger).
    easy_view: Mapped[bool] = mapped_column(default=False, server_default="0")
    text_size: Mapped[str] = mapped_column(String(10), default="normal", server_default="normal")
    # How a tour day's date reads: "dmy" 7/11/26, "mdy" 11/7/26, "text" 7 Nov (always with the weekday).
    date_style: Mapped[str] = mapped_column(String(8), default="dmy", server_default="dmy")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(default=True)
    # Part of every session token; raising it (log out, password change) ends all old sessions.
    session_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="user", cascade="all, delete-orphan")


DEFAULT_CANCELLATION_SCALE = (
    {"within_days": 60, "percent": 10}, {"within_days": 30, "percent": 30},
    {"within_days": 14, "percent": 50}, {"within_days": 7, "percent": 100},
)


DEFAULT_PAYMENT_TERMS = {"deposit_percent": 0, "deposit_days": 7, "balance_days_before": 14}


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    base_currency: Mapped[str] = mapped_column(String(3), default="USD")
    language: Mapped[str] = mapped_column(String(5), default="en")
    # Incidents whose money (in base currency) is above this need an admin or the
    # owner to approve; managers approve the rest. NULL = managers approve any amount.
    incident_approval_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    # What a client pays when they cancel: [{"within_days": 30, "percent": 30}, ...] — cancelled
    # within N days of arrival → percent of the price. Clients may have their own (Client.cancellation_scale).
    cancellation_scale: Mapped[list] = mapped_column(JSON, default=lambda: [dict(r) for r in DEFAULT_CANCELLATION_SCALE])
    # How clients pay: {"deposit_percent": 30, "deposit_days": 7, "balance_days_before": 30} — a deposit
    # due N days after booking, the balance M days before arrival. Clients may have their own.
    payment_terms: Mapped[dict] = mapped_column(JSON, default=lambda: dict(DEFAULT_PAYMENT_TERMS))
    # A vendor's bill within this percent of what we expected (and never less than 1.00) is matched.
    bill_tolerance_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal(1), server_default="1")
    # Who does what: {"hotel"|"meal"|"transport"|"guide"|"activity"|"other"|"payments": user_id}.
    # Bookings and payments go to these people unless a booking names someone else.
    task_owners: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    # The agency's own kinds of task ("Visa", "Tickets"…): [{"id", "name", "color"}].
    task_types: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Litres per 100 km of the group's vehicle: services priced per litre get km × this / 100.
    fuel_l_per_100km: Mapped[Decimal] = mapped_column(Numeric(5, 1), default=Decimal(30), server_default="30")
    # Where the agency works (ISO codes, "ge", "am"): the map only searches there.
    countries: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # The language the map's place names come in (one for everyone, so lists don't mix English, Georgian,
    # Armenian...): "en", "ka", "ru", "hy"; empty = the agency's language.
    place_lang: Mapped[str] = mapped_column(String(5), default="", server_default="")
    # The time zone the tours run in ("Asia/Tbilisi"), for "now" on the Today board whatever the computer's
    # clock says; empty = from the countries (GE → Tbilisi), else the computer's.
    timezone: Mapped[str] = mapped_column(String(40), default="", server_default="")
    # A coach is slower than the map's car times (mountain roads, stops): times are shown × this.
    drive_factor: Mapped[Decimal] = mapped_column(Numeric(4, 2), default=Decimal("1.25"), server_default="1.25")
    # Family-style meals: how many people share one plate of a set menu's dish (1 = everyone their own).
    plate_share: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # "Our way" of pricing: the people and price recipe every new calculation starts from
    # ({"people": [...], "recipe": [...], "single_profit": true}). NULL = the app's defaults.
    calc_style: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # VAT percent inside suppliers' prices (Georgia: 18). The agency claims it back, so a cost line from
    # a supplier that gives VAT invoices carries amount × rate / (100 + rate) of VAT. NULL = no VAT used.
    vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    phone: Mapped[str] = mapped_column(String(50), default="", server_default="")   # the office line guides and drivers call
    # The agency's own Anthropic key for the AI assistant, encrypted (app/ai/keys.py); hint = its last 4 characters.
    ai_key_enc: Mapped[str | None] = mapped_column(String(600), nullable=True)
    ai_key_hint: Mapped[str] = mapped_column(String(8), default="", server_default="")
    # Only for organization-level keys: the Anthropic Console workspace the requests go to.
    ai_workspace_id: Mapped[str] = mapped_column(String(80), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="workspace", cascade="all, delete-orphan")
    invites: Mapped[list["Invite"]] = relationship(back_populates="workspace", cascade="all, delete-orphan")


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # This person's Home in this agency: [{"id": widget, "size": "half"|"full"}]; None = role default.
    dashboard: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # What they do here: ["operations", "finance", "sales"] (see deps.jobs_of). None = from the role
    # (a manager from before jobs existed does all three; staff none).
    jobs: Mapped[list | None] = mapped_column(JSON, nullable=True)

    workspace: Mapped[Workspace] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships")


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20))
    jobs: Mapped[list | None] = mapped_column(JSON, nullable=True)     # given to the member on joining
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    invited_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    workspace: Mapped[Workspace] = relationship(back_populates="invites")


# --- Milestone 2: catalog & tours ----------------------------------------------
# Every business row carries workspace_id, and every FK to another business row
# must point inside the same workspace (checked in routers/_scoped.py).

VENDOR_TYPES = ("hotel", "restaurant", "transport", "guide", "driver", "activity", "other")
TOUR_STATUSES = ("draft", "inquiry", "confirmed", "cancelled")
# Tours that are really happening (or may): they take hotels, guides and buses, need bookings and show on
# the timeline. A draft is a plan being worked on (often a copy of another tour): only in the tours list.
LIVE_STATUSES = ("inquiry", "confirmed")


class Vendor(Base):
    __tablename__ = "vendors"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(20), index=True)
    city: Mapped[str] = mapped_column(String(100), default="")
    address: Mapped[str] = mapped_column(String(300), default="", server_default="")   # for the driver's map
    # Guides / drivers: languages they work in, and dates they can't work [{"start", "end", "note"}].
    languages: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    unavailable: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    contact_person: Mapped[str] = mapped_column(String(200), default="")
    phone: Mapped[str] = mapped_column(String(50), default="")
    phone2: Mapped[str] = mapped_column(String(50), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    # When the agency pays this vendor: N days before or after the service date.
    payment_timing: Mapped[str] = mapped_column(String(10), default="after")
    payment_days: Mapped[int] = mapped_column(Integer, default=0)
    # Release terms: cancelled within N days of the first service → percent of what was booked.
    cancel_terms: Mapped[list] = mapped_column(JSON, default=list)
    currency: Mapped[str] = mapped_column(String(3), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # Gives VAT invoices: its cost lines carry the agency's VAT rate (Workspace.vat_rate).
    vat_invoice: Mapped[bool] = mapped_column(default=False, server_default="0")
    # A sight or activity: how long a visit usually takes (minutes). Day programmes use it as the
    # visit's length. A sight with no price (Bodbe, Jvari) is an activity supplier with no services.
    visit_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # What kind of activity place: one of the ready keys (museum, church, cable_car...) or the agency's own word.
    category: Mapped[str] = mapped_column(String(40), default="", server_default="")
    # A stand-in for a person not named yet ("Guide (to be named)"): a tour's staff before the agency knows
    # who. Not in the catalogue, never booked, never "busy on two tours".
    placeholder: Mapped[bool] = mapped_column(default=False, server_default="0")
    # A driver (or guide) who works for a company of ours — the bus company that sends them.
    company_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True, index=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    services: Mapped[list["Service"]] = relationship(back_populates="vendor", cascade="all, delete-orphan",
                                                    order_by="(Service.category, Service.name)")


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(20), default="agency")  # agency | direct
    country: Mapped[str] = mapped_column(String(100), default="")
    contact_person: Mapped[str] = mapped_column(String(200), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    phone: Mapped[str] = mapped_column(String(50), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # This client's own cancellation scale (their contract); NULL = the agency's.
    cancellation_scale: Mapped[list | None] = mapped_column(JSON, nullable=True)
    payment_terms: Mapped[dict | None] = mapped_column(JSON, nullable=True)   # NULL = the agency's
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# Money columns: amounts to the cent; rates and unit prices with 6 decimals.
Money = Numeric(14, 2)
CENT = Decimal("0.01")
Rate = Numeric(14, 6)


class Series(Base):
    """A reusable route ("HM", "Classic Georgia 8D"). Tours are stamped from it."""
    __tablename__ = "series"
    __table_args__ = (UniqueConstraint("workspace_id", "code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200), default="")
    color: Mapped[str] = mapped_column(String(20), default="indigo")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # When the days last changed: tours made before that don't follow (they're copies).
    days_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Who works which days on this route: [{role, from_day, to_day, vendor_id, label}] - a Georgian guide
    # days 1-5, an Armenian one days 6-7. Calculations price it; new departures get these people.
    staff_plan: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # The bus back to its garage after the last day ({"on": "last"|"next", "to": town, "km": n}); None: not needed.
    bus_return: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # The bus coming to where the tour starts (a border, an airport) from its garage
    # ({"on": "first"|"before", "town": garage town, "km": n}); None: it starts where the bus is.
    bus_start: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    days: Mapped[list["SeriesDay"]] = relationship(
        back_populates="series", cascade="all, delete-orphan", order_by="SeriesDay.day_number")


class _DayFields:
    """Columns shared by a template day and a real tour day."""
    city: Mapped[str] = mapped_column(String(100), default="")
    hotel_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    # Breakfast somewhere else than last night's hotel (a café, a restaurant on the road); see breakfast_mode.
    breakfast_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    breakfast_menu_id: Mapped[str | None] = mapped_column(ForeignKey("services.id", ondelete="SET NULL"), nullable=True)
    lunch_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    dinner_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    # The set menu chosen at that restaurant (a "meal" service of it); NULL = its usual lunch/dinner price.
    lunch_menu_id: Mapped[str | None] = mapped_column(ForeignKey("services.id", ondelete="SET NULL"), nullable=True)
    dinner_menu_id: Mapped[str | None] = mapped_column(ForeignKey("services.id", ondelete="SET NULL"), nullable=True)
    border_crossing: Mapped[str] = mapped_column(String(100), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # Any other services that day, from the price catalog: a boat ticket, a wine
    # tasting, a museum. [{id, service_id, quantity (None = by the service's unit), notes}]
    extras: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Road kilometres driven that day (from the previous day's city); suggested from the map, editable.
    km: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Car driving minutes of each leg that day (to each stop, then to the night's city), from the map.
    drive_minutes: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Road km of each of those legs (same order), from the map: the day's km is their sum.
    drive_km: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Other places visited that day, in order, before the night's city ("Mtskheta", "Gori"):
    # an excursion or a lunch on the road. city stays where the group sleeps.
    stops: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Who pays each meal: "included" (we do — a cost), "tourists" (we reserve, they pay on the spot —
    # a booking but no cost), "own" (free time: no restaurant at all).
    lunch_mode: Mapped[str] = mapped_column(String(10), default="included", server_default="included")
    # Breakfast: "hotel" (at last night's hotel, in the room price — the usual), or like the other meals:
    # "included" at breakfast_id (we pay), "tourists" (they pay there), "own".
    breakfast_mode: Mapped[str] = mapped_column(String(10), default="hotel", server_default="hotel")
    dinner_mode: Mapped[str] = mapped_column(String(10), default="included", server_default="included")
    # Flights that day: [{direction: arrival|departure, number: "CZ6040", time: "22:45", airport: "TBS",
    # other: "Urumqi"}]. On a route, every departure copies them.
    flights: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # The day's programme in order, with times: [{id, kind, time, end, title, ref, place, notes}].
    # `ref` points at the day's own content ("lunch", "dinner", "hotel", "extra:<slot id>",
    # "flight:<number>") so the restaurant or ticket stays one thing; free items (free time, a
    # walk, a transfer) have none. Empty = not arranged yet (the screen suggests an order).
    schedule: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Who sits elsewhere than usual at a meal: {"dinner": {"leader": "staff", "<staff id>": "none"}} (app/seating.py).
    seating: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    # This tour's own dishes for a meal, instead of the chosen menu's: {"dinner": [{name, per_plate, price}]}.
    meal_dishes: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    # Where each staff member sleeps that night, when not all alike: {"<staff id or role>": {"stay": "same"|"own"|
    # "free"|"none", "hotel_id": id}} - the guide with the group, the driver elsewhere. Anyone not in it: staff_stay.
    staff_stays: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    # A meal whose place isn't known yet, by the town it will be in: {"lunch": "Yerevan"} ("TBD · Yerevan").
    meal_tbd: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    # Where the driver and guide sleep after this day: "none" (not counted), "same" (the group's hotel),
    # "own" (staff_hotel_id: another hotel, or the same one at a staff price), "free" (the hotel gives it).
    staff_stay: Mapped[str] = mapped_column(String(10), default="none", server_default="none")
    staff_hotel_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    staff_twin: Mapped[bool] = mapped_column(default=False, server_default="0")   # they share one room


class SeriesDay(_DayFields, Base):
    __tablename__ = "series_days"
    __table_args__ = (UniqueConstraint("series_id", "day_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    series_id: Mapped[str] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), index=True)
    day_number: Mapped[int] = mapped_column(Integer)

    series: Mapped[Series] = relationship(back_populates="days")


class Tour(Base):
    __tablename__ = "tours"
    __table_args__ = (UniqueConstraint("workspace_id", "code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(200), default="")
    series_id: Mapped[str | None] = mapped_column(ForeignKey("series.id", ondelete="SET NULL"), nullable=True)
    client_id: Mapped[str | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    start_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(20), default="confirmed")
    pax: Mapped[int] = mapped_column(Integer, default=0)
    # The count is a guess for now (an inquiry, a group still filling up): shown as "~20".
    pax_estimated: Mapped[bool] = mapped_column(default=False, server_default="0")
    # When its days were last copied from the route again ("Update departures from the route").
    route_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rooms: Mapped[str] = mapped_column(String(200), default="")
    bus_return: Mapped[dict | None] = mapped_column(JSON, nullable=True)   # as the route's (copied from it)
    bus_start: Mapped[dict | None] = mapped_column(JSON, nullable=True)    # as the route's (copied from it)
    # This group shares plates differently from the agency's usual (None = the agency's).
    plate_share: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # The free tour leaders who travel with the group, on top of `pax` (the guests): 19+1 → pax 19, leaders 1.
    # They sleep in the group's hotel and, by default, eat at the staff table with the guide and driver.
    leaders: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Leader, driver and guide eat at their own table (a restaurant's "staff_meal" price when it has one).
    staff_table: Mapped[bool] = mapped_column(default=False, server_default="0")
    # Where the tour leaders eat: "group", "staff" (table), "none"; NULL = as staff_table says (app/seating.py).
    leader_seat: Mapped[str | None] = mapped_column(String(10), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    # What the client pays per tourist (managers only). Expected revenue = pax × price until invoiced.
    price_pp: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    price_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    # The calculation this group was sold from, and for how many paying tourists.
    quote_id: Mapped[str | None] = mapped_column(ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True, index=True)
    quote_tourists: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # The budget: the calculation's lines frozen for this group (see TourBudgetLine).
    # Planned revenue is kept in the calculation's currency with its rate to base.
    budget_tourists: Mapped[int | None] = mapped_column(Integer, nullable=True)
    budget_leaders: Mapped[int | None] = mapped_column(Integer, nullable=True)
    budget_revenue: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    budget_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    budget_rate_to_base: Mapped[Decimal | None] = mapped_column(Rate, nullable=True)
    budget_source: Mapped[str] = mapped_column(String(300), default="", server_default="")
    budget_set_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Closed: everything is settled and the result is final; nothing about the tour
    # changes until an admin reopens it (enforced in app/locks.py). Final money in base.
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    closed_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    close_note: Mapped[str] = mapped_column(String(500), default="", server_default="")
    final_revenue: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    final_cost: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    series: Mapped[Series | None] = relationship()
    client: Mapped[Client | None] = relationship()
    days: Mapped[list["TourDay"]] = relationship(
        back_populates="tour", cascade="all, delete-orphan", order_by="TourDay.day_number")
    staff: Mapped[list["StaffAssignment"]] = relationship(
        back_populates="tour", cascade="all, delete-orphan",
        order_by="(StaffAssignment.start_day, StaffAssignment.role)")
    participants: Mapped[list["Participant"]] = relationship(
        back_populates="tour", cascade="all, delete-orphan",
        order_by="(Participant.position, Participant.created_at)")
    costs: Mapped[list["TourCost"]] = relationship(
        cascade="all, delete-orphan", order_by="(TourCost.service_date, TourCost.category, TourCost.created_at)")
    payments: Mapped[list["VendorPayment"]] = relationship(
        cascade="all, delete-orphan", order_by="VendorPayment.paid_on")
    bills: Mapped[list["VendorBill"]] = relationship(cascade="all, delete-orphan", order_by="VendorBill.bill_date")
    budget: Mapped[list["TourBudgetLine"]] = relationship(
        cascade="all, delete-orphan", order_by="TourBudgetLine.position")


class TourDay(_DayFields, Base):
    __tablename__ = "tour_days"
    __table_args__ = (UniqueConstraint("tour_id", "day_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    day_number: Mapped[int] = mapped_column(Integer)
    date: Mapped[date] = mapped_column(Date, index=True)

    tour: Mapped[Tour] = relationship(back_populates="days")
    hotel: Mapped[Vendor | None] = relationship(foreign_keys="TourDay.hotel_id")
    breakfast: Mapped[Vendor | None] = relationship(foreign_keys="TourDay.breakfast_id")
    breakfast_menu: Mapped["Service | None"] = relationship(foreign_keys="TourDay.breakfast_menu_id")
    lunch: Mapped[Vendor | None] = relationship(foreign_keys="TourDay.lunch_id")
    dinner: Mapped[Vendor | None] = relationship(foreign_keys="TourDay.dinner_id")
    lunch_menu: Mapped["Service | None"] = relationship(foreign_keys="TourDay.lunch_menu_id")
    dinner_menu: Mapped["Service | None"] = relationship(foreign_keys="TourDay.dinner_menu_id")
    staff_hotel: Mapped[Vendor | None] = relationship(foreign_keys="TourDay.staff_hotel_id")


# --- Milestone 3: who travels and who works the tour -----------------------------

STAFF_ROLES = ("guide", "driver", "transport", "tour_leader", "assistant", "other")
ROOM_TYPES = ("SGL", "DBL", "TWN", "TRP", "QUAD")


class StaffAssignment(Base):
    """A guide / driver / bus working part or all of a tour.

    Stored as day numbers, not dates, so the assignment moves with the tour
    when its dates shift. end_day NULL means "until the last day".
    """
    __tablename__ = "staff_assignments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    start_day: Mapped[int] = mapped_column(Integer, default=1)
    end_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    # Where they eat at the meals: "group", "staff" (table), "none"; NULL = as the tour's staff_table says.
    meal_seat: Mapped[str | None] = mapped_column(String(10), nullable=True)

    tour: Mapped[Tour] = relationship(back_populates="staff")
    vendor: Mapped[Vendor] = relationship()

    def __init__(self, **kw):
        # Column defaults only apply at INSERT; date syncing reads start_day
        # before that, so set it on the object too.
        kw.setdefault("start_day", 1)
        super().__init__(**kw)

    def covers(self, day_number: int) -> bool:
        return self.start_day <= day_number and (self.end_day is None or day_number <= self.end_day)


class Participant(Base):
    __tablename__ = "participants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    # The name in the traveller's own script (王丽) - the guide's list; hotels get the passport name.
    local_name: Mapped[str] = mapped_column(String(100), default="", server_default="")
    gender: Mapped[str] = mapped_column(String(1), default="")  # M | F | "
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    nationality: Mapped[str] = mapped_column(String(100), default="")
    passport_number: Mapped[str] = mapped_column(String(50), default="")
    passport_expiry: Mapped[date | None] = mapped_column(Date, nullable=True)
    room_type: Mapped[str] = mapped_column(String(10), default="")
    # Free label shared by roommates ("R1", "Wang family"); same label = same room.
    room_group: Mapped[str] = mapped_column(String(40), default="")
    # For the hotel, the same on everyone in the room ("couple: one big bed", "honeymoon").
    room_note: Mapped[str] = mapped_column(String(300), default="", server_default="")
    phone: Mapped[str] = mapped_column(String(50), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    tour: Mapped[Tour] = relationship(back_populates="participants")


# --- Milestone 4: money ----------------------------------------------------------
# Amounts are Decimal (NUMERIC) in the database and never floats, so totals add
# up to the cent. Every cost line keeps the exchange rate it was valued at.


# What a vendor price is "per". Room kinds match participant room types.
# Codes the system looks up by itself (tour costs, filling a calculation from a route).
# Services without a code are the agency's own (a boat ticket, a wine tasting).
RATE_KINDS = ("room_SGL", "room_DBL", "room_TWN", "room_TRP", "room_QUAD",
              "breakfast", "lunch", "dinner", "day", "person", "group",
              "staff_room", "staff_meal")   # driver/guide prices: a room for them, the staff table
SERVICE_UNITS = ("room_night", "person", "vehicle_day", "day", "group", "item", "km", "litre")
COST_CATEGORIES = ("hotel", "meal", "transport", "guide", "ticket", "visa", "other")


class ExchangeRate(Base):
    """1 unit of `currency` = `rate` units of the workspace base currency."""
    __tablename__ = "exchange_rates"
    __table_args__ = (UniqueConstraint("workspace_id", "currency"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    currency: Mapped[str] = mapped_column(String(3))
    rate: Mapped[Decimal] = mapped_column(Rate)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Service(Base):
    """Something a vendor sells: "DBL room", "Lunch", "45-seat bus day", "Boat ticket".

    Prices live in ServiceRate rows by season and group size, so the price for a
    tour depends on when it travels and how big it is.
    """
    __tablename__ = "services"
    __table_args__ = (UniqueConstraint("vendor_id", "code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), index=True)
    code: Mapped[str | None] = mapped_column(String(20), nullable=True)   # one of RATE_KINDS, or None
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(20), default="other")    # as quote categories
    unit: Mapped[str] = mapped_column(String(20), default="person")
    notes: Mapped[str] = mapped_column(Text, default="")
    # A set menu's dishes ("Khinkali", "Mtsvadi"), so the same food isn't served twice in a day.
    dishes: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    is_active: Mapped[bool] = mapped_column(default=True)
    # How long it takes (a wine tasting 60, bread baking 120): the day programme gives it this time.
    minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    vendor: Mapped[Vendor] = relationship(back_populates="services")
    rates: Mapped[list["ServiceRate"]] = relationship(
        back_populates="service", cascade="all, delete-orphan",
        order_by="(ServiceRate.valid_from, ServiceRate.min_pax)")


class ServiceRate(Base):
    """One price: for a season (valid_from–valid_to, both optional = all year) and
    optionally a group-size range. The most specific matching row wins."""
    __tablename__ = "service_rates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(ForeignKey("services.id", ondelete="CASCADE"), index=True)
    valid_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    valid_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    min_pax: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_pax: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price: Mapped[Decimal] = mapped_column(Money)
    currency: Mapped[str] = mapped_column(String(3))
    notes: Mapped[str] = mapped_column(String(300), default="")

    service: Mapped[Service] = relationship(back_populates="rates")


class TourBudgetLine(Base):
    """One planned cost of a tour, frozen from its calculation for the group size sold.

    The calculation can change later without rewriting what was planned. Cost lines
    point here (TourCost.budget_line_id), so every difference shows on its own line.
    """
    __tablename__ = "tour_budget_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    source_id: Mapped[str] = mapped_column(String(40), default="")   # calculation line / night id
    kind: Mapped[str] = mapped_column(String(10), default="item")   # item | hotel
    category: Mapped[str] = mapped_column(String(20), default="other")
    name: Mapped[str] = mapped_column(String(200))
    vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    service_id: Mapped[str | None] = mapped_column(ForeignKey("services.id", ondelete="SET NULL"), nullable=True)
    day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(1))
    unit_price: Mapped[Decimal] = mapped_column(Rate, default=Decimal(0))
    currency: Mapped[str] = mapped_column(String(3))
    rate_to_base: Mapped[Decimal] = mapped_column(Rate, default=Decimal(0))
    notes: Mapped[str] = mapped_column(String(300), default="")

    vendor: Mapped[Vendor | None] = relationship()

    @property
    def amount(self) -> Decimal:
        return (self.quantity * self.unit_price).quantize(CENT, ROUND_HALF_UP)

    @property
    def amount_base(self) -> Decimal:
        return (self.amount * self.rate_to_base).quantize(CENT, ROUND_HALF_UP)


class TourCost(Base):
    __tablename__ = "tour_costs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    # Nullable: small cash costs (tickets, tips) have no vendor to pay later.
    vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True, index=True)
    category: Mapped[str] = mapped_column(String(20), default="other")
    description: Mapped[str] = mapped_column(String(300), default="")
    service_date: Mapped[date] = mapped_column(Date)
    service_end: Mapped[date | None] = mapped_column(Date, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(1))
    unit_price: Mapped[Decimal] = mapped_column(Money, default=Decimal(0))
    currency: Mapped[str] = mapped_column(String(3))
    rate_to_base: Mapped[Decimal] = mapped_column(Rate, default=Decimal(1))
    notes: Mapped[str] = mapped_column(Text, default="")
    # Set on lines built from the itinerary ("hotel:<day>:DBL"), so regenerating
    # updates them in place; NULL for lines typed by hand.
    auto_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # An auto line someone edited by hand: regenerating leaves it alone.
    locked: Mapped[bool] = mapped_column(default=False)
    # The planned line this cost is the actual for; NULL = not in the budget.
    budget_line_id: Mapped[str | None] = mapped_column(
        ForeignKey("tour_budget_lines.id", ondelete="SET NULL"), nullable=True, index=True)
    # Someone chose the budget line (or "none") by hand: automatic linking leaves it alone.
    budget_by_hand: Mapped[bool] = mapped_column(default=False, server_default="0")
    # Why this cost exists beyond the plan: "" (normal), "incident" (cost of an incident),
    # "vendor_credit" (what a vendor owes back for an incident: a negative line).
    reason: Mapped[str] = mapped_column(String(20), default="", server_default="")
    incident_id: Mapped[str | None] = mapped_column(ForeignKey("incidents.id", ondelete="SET NULL"),
                                                    nullable=True, index=True)
    # VAT percent inside this line, set by hand (0 = no VAT invoice this time); NULL = the supplier's usual.
    vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    vendor: Mapped[Vendor | None] = relationship()

    @property
    def amount(self) -> Decimal:
        return (self.quantity * self.unit_price).quantize(CENT, ROUND_HALF_UP)

    @property
    def amount_base(self) -> Decimal:
        return (self.amount * self.rate_to_base).quantize(CENT, ROUND_HALF_UP)


INCIDENT_KINDS = ("extra_service", "vendor_failure", "client_request", "delay", "damage", "penalty", "cancellation", "other")


class Incident(Base):
    """Something that happened beyond the plan, and its money on both sides.

    While open it holds proposed effects (cost lines, a charge to the client, a
    claim against a vendor). Approving creates them together: cost lines with
    reason "incident", a draft invoice for the client, a negative vendor line
    for the claim. Who carries it says whose problem it is.
    """
    __tablename__ = "incidents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kind: Mapped[str] = mapped_column(String(20), default="other")
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    carried_by: Mapped[str] = mapped_column(String(10), default="agency")   # client | agency | vendor
    vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="open")         # open | approved | rejected | settled
    # Proposed cost lines while open: [{vendor_id, category, description, quantity, unit_price, currency}]
    costs: Mapped[list] = mapped_column(JSON, default=list)
    client_charge: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    # Compensation to the client (we or a vendor are at fault): a credit note on approval.
    client_credit: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    client_currency: Mapped[str] = mapped_column(String(3), default="")
    vendor_claim: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    claim_currency: Mapped[str] = mapped_column(String(3), default="")
    invoice_id: Mapped[str | None] = mapped_column(ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True)
    reported_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    decided_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decision_note: Mapped[str] = mapped_column(String(500), default="")

    tour: Mapped[Tour] = relationship()
    vendor: Mapped[Vendor | None] = relationship()
    reported_by: Mapped["User | None"] = relationship(foreign_keys=[reported_by_id])
    decided_by: Mapped["User | None"] = relationship(foreign_keys=[decided_by_id])


class VendorBill(Base):
    """An invoice a vendor sent us for a tour. Bills are compared with what we expected
    to pay that vendor (our cost lines) per currency; differences are accepted (an
    adjustment cost line) or disputed."""
    __tablename__ = "vendor_bills"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), index=True)
    number: Mapped[str] = mapped_column(String(80), default="")
    bill_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    currency: Mapped[str] = mapped_column(String(3))
    amount: Mapped[Decimal] = mapped_column(Money)
    notes: Mapped[str] = mapped_column(Text, default="")
    disputed: Mapped[bool] = mapped_column(default=False)
    dispute_note: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    vendor: Mapped[Vendor] = relationship()


class VendorPayment(Base):
    """Money paid to a vendor for one tour (the unit ki.360 tracked too)."""
    __tablename__ = "vendor_payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), index=True)
    currency: Mapped[str] = mapped_column(String(3))
    amount: Mapped[Decimal] = mapped_column(Money)
    paid_on: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(20), default="bank")  # bank | cash | card | other
    reference: Mapped[str] = mapped_column(String(200), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # Who handed over the money when it wasn't the company account: a team member (office cash, own
    # card) or a guide/driver from the cash they hold — then it counts against that person's advance.
    paid_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    paid_by_vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True, index=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    paid_by_user: Mapped["User | None"] = relationship(foreign_keys=[paid_by_user_id])
    paid_by_vendor: Mapped[Vendor | None] = relationship(foreign_keys=[paid_by_vendor_id])


# --- Milestone 5: what clients owe us ---------------------------------------------

INVOICE_STATUSES = ("draft", "issued", "void")


class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (UniqueConstraint("workspace_id", "number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    # Given when the invoice is issued, sequential per agency and year ("2026-0007").
    # Drafts have none, and issued invoices are voided rather than deleted, so the
    # issued numbers form an unbroken sequence, as tax authorities expect.
    number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # RESTRICT: a client with invoices can't be deleted out from under them.
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="RESTRICT"), index=True)
    tour_id: Mapped[str | None] = mapped_column(ForeignKey("tours.id", ondelete="SET NULL"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(10), default="draft")
    # A credit note corrects one issued invoice (refund, smaller group, compensation).
    # Its lines are positive on the document; it reduces revenue and that invoice's
    # balance once issued. Numbered in its own series ("CN-2026-0001").
    kind: Mapped[str] = mapped_column(String(12), default="invoice", server_default="invoice")
    credits_id: Mapped[str | None] = mapped_column(ForeignKey("invoices.id", ondelete="RESTRICT"),
                                                   nullable=True, index=True)
    issue_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(3))
    rate_to_base: Mapped[Decimal] = mapped_column(Rate, default=Decimal(1))
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    client: Mapped[Client] = relationship()
    tour: Mapped[Tour | None] = relationship()
    lines: Mapped[list["InvoiceLine"]] = relationship(cascade="all, delete-orphan", order_by="InvoiceLine.position")
    payments: Mapped[list["ClientPayment"]] = relationship(cascade="all, delete-orphan", order_by="ClientPayment.received_on")
    credits: Mapped["Invoice | None"] = relationship(remote_side="Invoice.id", back_populates="credit_notes")
    credit_notes: Mapped[list["Invoice"]] = relationship(back_populates="credits", order_by="Invoice.created_at")

    @property
    def total(self) -> Decimal:
        return sum((ln.amount for ln in self.lines), Decimal(0))

    @property
    def is_credit_note(self) -> bool:
        return self.kind == "credit_note"

    @property
    def credited(self) -> Decimal:
        """Issued credit notes against this invoice."""
        return sum((cn.total for cn in self.credit_notes if cn.status == "issued"), Decimal(0))

    @property
    def balance(self) -> Decimal:
        """Still to receive; negative = the client paid more than they now owe (refund due)."""
        return self.total - self.credited - self.paid

    @property
    def signed_total_base(self) -> Decimal:
        """Effect on revenue: credit notes count negative."""
        return -self.total_base if self.is_credit_note else self.total_base

    @property
    def paid(self) -> Decimal:
        return sum((p.amount for p in self.payments), Decimal(0))

    @property
    def total_base(self) -> Decimal:
        return (self.total * self.rate_to_base).quantize(CENT, ROUND_HALF_UP)


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    description: Mapped[str] = mapped_column(String(300))
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(1))
    unit_price: Mapped[Decimal] = mapped_column(Money)

    @property
    def amount(self) -> Decimal:
        return (self.quantity * self.unit_price).quantize(CENT, ROUND_HALF_UP)


class ClientPayment(Base):
    __tablename__ = "client_payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    received_on: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(20), default="bank")
    reference: Mapped[str] = mapped_column(String(200), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# --- Tour price calculations ("quotes") -------------------------------------------

class Quote(Base):
    """A price calculation for a route and a range of group sizes.

    The editable content (nights, items, variables, exchange rates, price-list
    texts) lives in `doc`, validated by quote_schemas.QuoteIn; the columns copy
    the parts used for listing and filtering.
    """
    __tablename__ = "quotes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(10), default="draft")
    series_id: Mapped[str | None] = mapped_column(ForeignKey("series.id", ondelete="SET NULL"), nullable=True)
    client_id: Mapped[str | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    currency: Mapped[str] = mapped_column(String(3))
    valid_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    valid_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    doc: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    series: Mapped[Series | None] = relationship()
    client: Mapped[Client | None] = relationship()


class QuoteVersion(Base):
    """A saved state of a calculation; every save that changes something adds one."""
    __tablename__ = "quote_versions"
    __table_args__ = (UniqueConstraint("quote_id", "number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    quote_id: Mapped[str] = mapped_column(ForeignKey("quotes.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    doc: Mapped[dict] = mapped_column(JSON)
    note: Mapped[str] = mapped_column(String(300), default="")
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    created_by: Mapped[User | None] = relationship()


class QuoteScenario(Base):
    """A what-if on top of a calculation, stored as only the differences (a patch),
    so later changes to the calculation flow into every scenario."""
    __tablename__ = "quote_scenarios"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    quote_id: Mapped[str] = mapped_column(ForeignKey("quotes.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    patch: Mapped[dict] = mapped_column(JSON)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


BOOKING_STATUSES = ("to_book", "requested", "confirmed", "problem", "cancelled")


class TourBooking(Base):
    """One supplier on one tour: is it booked? Who books it, by when, and how it is paid.
    Rows follow the itinerary and staff (app/bookings.py); what is booked (nights, rooms,
    meals, days) is worked out from them, so it never goes stale."""
    __tablename__ = "tour_bookings"
    __table_args__ = (UniqueConstraint("tour_id", "vendor_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="to_book")
    reference: Mapped[str] = mapped_column(String(100), default="")       # the supplier's confirmation number
    note: Mapped[str] = mapped_column(String(1000), default="")
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    book_by: Mapped[date | None] = mapped_column(Date, nullable=True)         # None = default for its kind
    # Payment plan. pay_when: "" = the supplier's terms | asap | before | after | on_site
    pay_when: Mapped[str] = mapped_column(String(10), default="")
    pay_method: Mapped[str] = mapped_column(String(10), default="transfer")  # transfer | cash | card
    paid_by: Mapped[str] = mapped_column(String(10), default="office")      # office | guide (cash on the spot)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_what: Mapped[str] = mapped_column(Text, default="")           # what was confirmed (to spot changes)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    tour: Mapped[Tour] = relationship()
    vendor: Mapped[Vendor] = relationship()
    assignee: Mapped[User | None] = relationship()


class Task(Base):
    """A to-do someone writes ("Send the visa list to the embassy"). Booking and payment tasks are
    not stored: they are worked out from bookings and payables (app/routers/tasks.py)."""
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    note: Mapped[str] = mapped_column(Text, default="")
    tour_id: Mapped[str | None] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), nullable=True, index=True)
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    type_id: Mapped[str | None] = mapped_column(String(20), nullable=True)   # one of Workspace.task_types
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    tour: Mapped[Tour | None] = relationship()


class TaskAssignment(Base):
    """Who does one worked-out task when it isn't the default owner of that kind of work —
    e.g. this tour's payment to the hotel goes to Nino, not to the usual accountant.
    Keyed by the task's key ("pay:<tour>:<vendor>:<currency>"). Booking tasks keep their
    person on the booking itself."""
    __tablename__ = "task_assignments"
    __table_args__ = (UniqueConstraint("workspace_id", "key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(160))
    assignee_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TextTranslation(Base):
    """A text of the agency's (a place name, a programme line) in another language, kept so it is
    translated - and paid for - once. Keyed by a hash of the text."""
    __tablename__ = "text_translations"
    __table_args__ = (UniqueConstraint("workspace_id", "lang", "source_hash"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lang: Mapped[str] = mapped_column(String(5))
    source_hash: Mapped[str] = mapped_column(String(40))
    source: Mapped[str] = mapped_column(Text)
    result: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TaskStage(Base):
    """Where a task is on the board when that isn't worked out from the work itself: "in progress", or
    "waiting" for an own task or a payment. Keyed like TaskAssignment ("task:<id>", "booking:<id>"…)."""
    __tablename__ = "task_stages"
    __table_args__ = (UniqueConstraint("workspace_id", "key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(160))
    stage: Mapped[str] = mapped_column(String(10))          # doing | waiting
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TaskEvent(Base):
    """A task's history: created, passed to someone (with a note), moved, done, reopened."""
    __tablename__ = "task_events"
    __table_args__ = (Index("ix_task_events_key", "workspace_id", "key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(12))            # created | passed | moved | done | reopened
    by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    to_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    stage: Mapped[str | None] = mapped_column(String(10), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GeoPlace(Base):
    """Where a place name is on the map (OpenStreetMap), cached: shared, public data."""
    __tablename__ = "geo_places"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)     # normalised name
    name: Mapped[str] = mapped_column(String(300), default="")           # what the map calls it
    lat: Mapped[float | None] = mapped_column(Numeric(9, 6), nullable=True)
    lon: Mapped[float | None] = mapped_column(Numeric(9, 6), nullable=True)   # both None = not found
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Google's id for a picked place: its coordinates may be kept 30 days only, the id for ever,
    # so a pinned place is looked up again by its id when its coordinates are old.
    place_id: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # When it's open, as the map says (a picked place): {"periods": [{"day": 0-6 (Sunday 0), "open": "10:00",
    # "close": "18:00"}], "text": ["Monday: Closed", ...]} - the day's timeline warns about a visit when it's closed.
    hours: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class RoadDistance(Base):
    """Road kilometres between two places (OSRM on OpenStreetMap), cached."""
    __tablename__ = "road_distances"

    from_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    to_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    km: Mapped[int | None] = mapped_column(Integer, nullable=True)       # None = no road found
    minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)  # driving time by car
    # The road's shape for maps: an encoded polyline (precision 5), simplified by OSRM.
    geometry: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FieldLink(Base):
    """A private phone link for one guide/driver on one tour (app/routers/field.py).
    Only the token's hash is kept; a new link replaces the old one."""
    __tablename__ = "field_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    staff_id: Mapped[str] = mapped_column(ForeignKey("staff_assignments.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_on: Mapped[date] = mapped_column(Date)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Changes up to this moment are acknowledged ("Got it" on the phone page).
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RestaurantDish(Base):
    """A dish on a restaurant's own list (app/routers/menu_builder.py): set menus are built from these."""
    __tablename__ = "restaurant_dishes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40), default="", server_default="")     # Salads, Mains…
    price: Mapped[Decimal | None] = mapped_column(Money, nullable=True)                   # one plate (portion)
    currency: Mapped[str] = mapped_column(String(3), default="", server_default="")
    per_plate: Mapped[int | None] = mapped_column(Integer, nullable=True)                 # usually shared: one plate for N
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    history: Mapped[list["DishPriceChange"]] = relationship(cascade="all, delete-orphan", lazy="selectin")


class DishPriceChange(Base):
    """A dish's price from a moment on: its history."""
    __tablename__ = "dish_price_changes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    dish_id: Mapped[str] = mapped_column(ForeignKey("restaurant_dishes.id", ondelete="CASCADE"), index=True)
    price: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="")
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    changed_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class DayTemplate(Base):
    """A saved day for a city ("Kutaisi day"): its hotel, meals, activities and timeline, to fill a day of
    another tour in one tap (app/routers/day_templates.py). `data` is the builder's day as it was saved."""
    __tablename__ = "day_templates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    city: Mapped[str] = mapped_column(String(120), default="", server_default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProgrammeShare(Base):
    """A programme shared by link (/p/<token>): anyone with it sees the programme as it was made - the
    request is kept and built again on each visit (no prices or team details are in a programme)."""
    __tablename__ = "programme_shares"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[dict] = mapped_column(JSON)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    views: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FieldExpense(Base):
    """Money a guide reports from the phone page (app/routers/field.py): something they paid
    ("expense", with a receipt photo) or extra pay for extra work ("extra"). The office approves:
    it becomes a locked cost line for the guide, so the guide's balance (costs − advances paid)
    says who owes whom."""
    __tablename__ = "field_expenses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    staff_id: Mapped[str] = mapped_column(ForeignKey("staff_assignments.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))                 # expense | extra
    category: Mapped[str] = mapped_column(String(20), default="other")
    day_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    description: Mapped[str] = mapped_column(String(300))
    amount: Mapped[Decimal] = mapped_column(Money)
    currency: Mapped[str] = mapped_column(String(3))
    receipt_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="pending")   # pending | approved | rejected
    office_note: Mapped[str] = mapped_column(String(300), default="")
    cost_id: Mapped[str | None] = mapped_column(ForeignKey("tour_costs.id", ondelete="SET NULL"), nullable=True)
    decided_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AiSession(Base):
    """A conversation with the setup assistant (app/ai): what was said, the files it was given,
    and the changes it proposes. Nothing it proposes is saved until a person confirms it."""
    __tablename__ = "ai_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(10), default="idle")       # idle | running | error
    error: Mapped[str] = mapped_column(String(500), default="")
    history: Mapped[list] = mapped_column(JSON, default=list)              # Messages API turns, appended only
    chat: Mapped[list] = mapped_column(JSON, default=list)                 # what the screen shows
    plan: Mapped[list] = mapped_column(JSON, default=list)                 # proposals (see app/ai/tools.py)
    files: Mapped[list] = mapped_column(JSON, default=list)                # uploads: name, kind, file id / sheet rows
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AiUsage(Base):
    """AI spend per agency per month, against the monthly allowance (settings.ai_monthly_usd)."""
    __tablename__ = "ai_usage"
    __table_args__ = (UniqueConstraint("workspace_id", "month"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    month: Mapped[str] = mapped_column(String(7))                          # "2026-10"
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_micro_usd: Mapped[int] = mapped_column(Integer, default=0)


class TourChange(Base):
    """One change to a tour's days, in words (app/changes.py): shown to its guides and drivers."""
    __tablename__ = "tour_changes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tour_id: Mapped[str] = mapped_column(ForeignKey("tours.id", ondelete="CASCADE"), index=True)
    day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kind: Mapped[str] = mapped_column(String(12), default="other")   # hotel meal time programme flight route other
    text: Mapped[str] = mapped_column(String(300))
    by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    # How to take it back ("Return"): {"set": {field: old}, "now": {field: new}} on the day; none for the
    # programme's times (one change moves many steps).
    undo: Mapped[dict | None] = mapped_column(JSON, nullable=True)



# --- email from the CRM: each person's own mailbox, the agency's templates, what was sent ----------

class MailAccount(Base):
    """A member's own mailbox, used to send from the CRM (SMTP: Gmail / Outlook app password, or another
    server). The password is stored encrypted (app/mail.py) and never sent back to the browser."""
    __tablename__ = "mail_accounts"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(10), default="gmail")       # gmail | outlook | other
    email: Mapped[str] = mapped_column(String(255))
    from_name: Mapped[str] = mapped_column(String(120), default="")
    smtp_host: Mapped[str] = mapped_column(String(120))
    smtp_port: Mapped[int] = mapped_column(Integer, default=587)
    username: Mapped[str] = mapped_column(String(255))
    secret_enc: Mapped[str] = mapped_column(String(600))
    signature: Mapped[str] = mapped_column(Text, default="")
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MailTemplate(Base):
    """An agency's own wording of an email kind in a language (the built-in one until edited)."""
    __tablename__ = "mail_templates"
    __table_args__ = (UniqueConstraint("workspace_id", "kind", "language"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))        # booking_request | booking_change | booking_cancel | restaurant | payment
    language: Mapped[str] = mapped_column(String(5))     # en | ka | ru
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class MailLog(Base):
    """An email sent from the CRM (or one that failed), on the tour and supplier it was about."""
    __tablename__ = "mail_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    tour_id: Mapped[str | None] = mapped_column(ForeignKey("tours.id", ondelete="SET NULL"), nullable=True, index=True)
    vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(30), default="")
    sender: Mapped[str] = mapped_column(String(255))
    to: Mapped[str] = mapped_column(String(600))
    cc: Mapped[str] = mapped_column(String(600), default="")
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    error: Mapped[str] = mapped_column(String(500), default="")       # "" = sent
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


# --- photos: of the catalogue's places and the route's towns and sights (the tour presentation) ------------

class Photo(Base):
    """A photo of a hotel, restaurant or sight of the catalogue (vendor_id), or of a town or sight on the way
    known only by its name (place: geo.key of it). Uploaded by the agency (storage_key), or a free photo from
    Wikimedia Commons (url, with its author and licence in `credit`). The first one (position) is the main one.
    A Wikimedia row with no url records that the automatic search found nothing (not searched again)."""
    __tablename__ = "photos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), nullable=True, index=True)
    place: Mapped[str] = mapped_column(String(200), default="", index=True)
    source: Mapped[str] = mapped_column(String(12), default="upload")        # upload | wikimedia
    storage_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    url: Mapped[str] = mapped_column(String(1000), default="")
    thumb: Mapped[str] = mapped_column(String(1000), default="")
    credit: Mapped[str] = mapped_column(String(300), default="")             # "Photo: Jane Doe · CC BY-SA 4.0"
    link: Mapped[str] = mapped_column(String(1000), default="")              # the photo's page (licence)
    auto: Mapped[bool] = mapped_column(default=False, server_default="0")    # picked by the app, not by a person
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
