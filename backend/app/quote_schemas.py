"""Shapes of a tour calculation ("quote"): what the user edits and what the engine returns."""
import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .schemas import SeriesColor, _currency

Basis = Literal["group", "per_person", "per_vehicle"]
# Who a per-person / per-vehicle line is counted for. "crew" = leaders + staff (the staff table).
Who = Literal["tourists", "persons", "everyone", "staff", "crew"]
# Where the free tour leader sleeps: own single, half a double shared with a tourist, or free from the hotel.
LeaderRoom = Literal["single", "shared", "free"]
# Where the driver/guide sleep on a night: not counted here (priced by a line), the group's hotel,
# another hotel or a staff price (own price per room), or free from the hotel.
# "allowance": a fixed amount per person per night (staff_price); they find their own hotel.
StaffStay = Literal["none", "same", "own", "free", "allowance"]
QuoteCategory = Literal["hotel", "meal", "transport", "guide", "ticket", "activity", "tips", "border", "other"]
QuoteStatus = Literal["draft", "sent", "accepted", "archived"]
RoundingMode = Literal["floor", "nearest", "ceil"]

def Price(**kw):  # noqa: N802  (reads like a type in field declarations)
    return Field(max_digits=16, decimal_places=6, **kw)


BUILTIN_VARS = ("days", "nights", "tourists", "leaders", "staff", "persons", "everyone", "crew", "group")

# --- flexible model: the agency's own people, who uses what, and its own price recipe -------------
# Who a type of person is for the money: pays (gets a price), travels free (their costs are shared by
# the payers, like the 19+1 leader), or works (driver, guide: costs shared the same way).
Role = Literal["pay", "free", "staff"]
# How they sleep: half a double, a single, a third of a triple, no bed, or as the night says for staff.
RoomUse = Literal["dbl", "sgl", "trp", "free", "none", "staff"]   # free: a room the hotel gives
UseMode = Literal["full", "half", "own", "none"]
StepKind = Literal["profit", "markup", "add_pp", "add_group", "commission", "vat_margin", "vat", "discount",
                   "relative", "round", "formula"]


class PersonType(BaseModel):
    """One kind of person on the trip ("Adults", "Children 2-11", "Tour leader", "Driver")."""
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=60)
    role: Role = "pay"
    count: int | None = Field(default=None, ge=0, le=500)   # None: the group size (one paying type only)
    per: int | None = Field(default=None, ge=1, le=100)     # at least one per this many of the group (19+1, 30+2)
    room: RoomUse = "dbl"
    weight: Decimal = Field(default=Decimal(1), ge=0, le=10, max_digits=5, decimal_places=3)  # share of shared costs


class Usage(BaseModel):
    """What one type of person takes of a per-person line: all of it, half, its own price, or none."""
    mode: UseMode = "full"
    price: Decimal | None = Price(default=None)              # "own": the price for them, in the line's currency


BUILT_IN_KINDS = {"hotel", "meal", "transport", "guide", "ticket", "activity", "tips", "border", "other"}


class CostKind(BaseModel):
    """A kind of cost the agency adds to the built-in ones (Flight, Train, Visa, Insurance…). Lines of
    this kind count as `base` for budgets and finance; recipes can mark the kind up on its own."""
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,29}$")
    name: str = Field(min_length=1, max_length=40)
    base: "QuoteCategory" = "other"
    icon: str = Field(default="tag", max_length=20)
    color: str = Field(default="slate", max_length=20)
    basis: "Basis" = "per_person"
    travel: bool = False    # its lines are tickets with legs (flight, train, ferry)

    @model_validator(mode="after")
    def _not_built_in(self):
        if self.id in BUILT_IN_KINDS:
            raise ValueError(f"'{self.id}' is a built-in kind")
        return self


class SavedFormula(BaseModel):
    """A formula the agency keeps to reuse ("Insurance 3% of costs": cost_total * 0.03)."""
    name: str = Field(min_length=1, max_length=60)
    formula: str = Field(min_length=1, max_length=300)
    note: str = Field(default="", max_length=200)


class CalcStyle(BaseModel):
    """The agency's own way of pricing, saved once: new calculations start from it."""
    people: list["PersonType"] = Field(default_factory=list, max_length=20)
    recipe: list["PriceStep"] = Field(default_factory=list, max_length=30)
    single_profit: bool = True
    transport: "TransportPlan | None" = None   # the agency's vehicles and fuel price (km come from each route)
    items: list["QuoteItemIn"] = Field(default_factory=list, max_length=60)      # its standard lines
    variables: dict[str, Decimal] = Field(default_factory=dict)                   # and the inputs they use
    variable_notes: dict[str, str] = Field(default_factory=dict)
    kinds: list[CostKind] = Field(default_factory=list, max_length=40)          # its own kinds of cost
    formulas: list["SavedFormula"] = Field(default_factory=list, max_length=60)  # its formula library

    @model_validator(mode="after")
    def _people_ok(self):
        if self.people:
            groups = [p for p in self.people if p.count is None]
            if len(groups) != 1 or groups[0].role != "pay":
                raise ValueError("exactly one paying type of person is the group")
        return self


class PriceStep(BaseModel):
    """One step from cost to selling price. Steps run in order; each can be limited to some types of
    person or some group sizes, or switched off."""
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12], min_length=1, max_length=40)
    kind: StepKind
    label: str = Field(default="", max_length=80)
    on: bool = True
    value: Decimal = Field(default=Decimal(0), max_digits=14, decimal_places=4)
    # profit: the best of group profit (÷ payers), minimum per person, and value % of the cost
    group: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    min_pp: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    mode: RoundingMode = "ceil"                              # round
    ref: str | None = Field(default=None, max_length=40)    # relative: value % of this type's price
    formula: str = Field(default="", max_length=300)        # formula: the new price (cost, price, profit, …)
    # markup: only on these kinds of cost (hotel, meal, transport…); empty = on the whole price so far
    cats: list[str] = Field(default_factory=list, max_length=12)
    only: list[str] = Field(default_factory=list, max_length=20)   # these types of person; empty = all who pay
    min_pax: int | None = Field(default=None, ge=1, le=500)        # only for groups of this size…
    max_pax: int | None = Field(default=None, ge=1, le=500)        # …up to this size

_VAR = re.compile(r"^[a-z_][a-z0-9_]{0,39}$")


class QuoteTier(BaseModel):
    """Overrides for groups up to `max_pax` tourists (e.g. minibus vs big bus)."""
    max_pax: int = Field(ge=1, le=500)
    unit_price: Decimal | None = Price(default=None)
    quantity: str | None = Field(default=None, max_length=300)
    label: str = Field(default="", max_length=100)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


class TravelLeg(BaseModel):
    """One flight / train / ferry: Tbilisi → Yerevan, 12 Oct, A9 123, 10:40 → 11:45."""
    from_place: str = Field(default="", max_length=80)
    to_place: str = Field(default="", max_length=80)
    on: date | None = None                  # the day it leaves
    carrier: str = Field(default="", max_length=80)
    number: str = Field(default="", max_length=20)
    depart: str = Field(default="", max_length=5)
    arrive: str = Field(default="", max_length=5)


class TravelInfo(BaseModel):
    """A ticket line's journey: its legs, class and baggage, taxes on top of the fare, and the day
    the tickets must be issued by (group fares expire)."""
    mode: Literal["flight", "train", "ferry", "coach", "other"] = "flight"
    legs: list[TravelLeg] = Field(default_factory=list, max_length=8)
    cabin: str = Field(default="", max_length=40)
    baggage: str = Field(default="", max_length=80)
    taxes: Decimal = Price(default=Decimal(0))      # per ticket, in the line's currency, on top of each fare
    ticket_by: date | None = None


class QuoteItemIn(BaseModel):
    # Stable id: scenarios and history refer to lines by it, not by position.
    id: str = Field(default_factory=_new_id, min_length=1, max_length=40)
    category: QuoteCategory = "other"
    name: str = Field(min_length=1, max_length=200)
    vendor_id: str | None = None
    service_id: str | None = None   # the catalog service it was priced from ("update prices" re-reads it)
    currency: str
    unit_price: Decimal = Price()
    quantity: str = Field(default="1", max_length=300)
    basis: Basis = "group"
    who: Who = "persons"
    capacity: int | None = Field(default=None, ge=1, le=200)  # seats per vehicle
    extra: int = Field(default=0, ge=0, le=50)                # extra seats taken (e.g. the guide)
    tiers: list[QuoteTier] = Field(default_factory=list, max_length=20)
    included: bool = True
    vehicle: bool = False   # its tier label is the vehicle shown on the price list
    # Per-person lines: how each type of person uses it (missing types follow `who`).
    uses: dict[str, Usage] = Field(default_factory=dict)
    # Not in the tour price, but offered on top ("wine tasting +45 per person"): priced on its own.
    optional: bool = False
    # The price itself as a formula ("558 if crossings == 2 else 316"); empty = unit_price.
    price_formula: str = Field(default="", max_length=300)
    # One of the agency's standard lines (tips, water, border…): "our way" puts it in every new calculation.
    standard: bool = False
    kind: str | None = Field(default=None, max_length=40)   # the agency's own kind (CostKind.id); `category` is its base
    with_line: str | None = Field(default=None, max_length=40)  # comes with that line: in the price only when it is
    travel: TravelInfo | None = None                          # tickets: legs, taxes, ticket-by date
    season_prices: dict[str, Decimal] = Field(default_factory=dict)      # unit price by season id
    day: int | None = Field(default=None, ge=1, le=60)
    notes: str = Field(default="", max_length=1000)

    _cur = field_validator("currency")(_currency)

    @model_validator(mode="after")
    def _vehicle_needs_capacity(self):
        if self.basis == "per_vehicle" and not self.capacity:
            raise ValueError(f"'{self.name}': per-vehicle lines need the number of seats")
        return self


class Season(BaseModel):
    """A part of the year with its own prices ("High season", 1 Jun - 31 Aug)."""
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=60)
    from_date: date | None = None
    to_date: date | None = None


class SeasonRoom(BaseModel):
    price_dbl: Decimal | None = Price(default=None)
    price_sgl: Decimal | None = Price(default=None)
    price_trp: Decimal | None = Price(default=None)
    price_quad: Decimal | None = Price(default=None)


class SellCurrency(BaseModel):
    """Also sell in this currency ("EUR for Europe"): its rate and its own rounding."""
    currency: str
    rate: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=6)   # per 1 of the calculation's currency; None = from fx
    step: Decimal = Field(default=Decimal(1), ge=0, max_digits=8, decimal_places=2)
    mode: RoundingMode = "ceil"

    _cur = field_validator("currency")(_currency)


class Vehicle(BaseModel):
    """A vehicle the bus company offers: seats, price per day, fuel use."""
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)           # "17-seater minibus"
    seats: int = Field(ge=1, le=100)                         # for passengers (the driver not counted)
    day_price: Decimal = Price()
    currency: str
    fuel_l_100km: Decimal | None = Field(default=None, ge=0, le=200, max_digits=6, decimal_places=2)
    max_pax: int | None = Field(default=None, ge=1, le=500)  # automatic choice: for groups up to this size
    vendor_id: str | None = None

    _cur = field_validator("currency")(_currency)


class VehicleCount(BaseModel):
    vehicle_id: str = Field(min_length=1, max_length=40)
    count: int = Field(default=1, ge=1, le=20)


class TransportPlan(BaseModel):
    """The group's vehicles for the whole trip: rent per day and fuel by distance, chosen by group
    size (minibus up to 12, bus above) or fixed ("2 buses", "car + minibus")."""
    vehicles: list[Vehicle] = Field(default_factory=list, max_length=10)
    mode: Literal["auto", "fixed"] = "auto"
    fixed: list[VehicleCount] = Field(default_factory=list, max_length=6)
    extra_seats: int = Field(default=1, ge=0, le=20)        # besides the guests: the guide…
    days: Decimal | None = Field(default=None, ge=0, le=100, max_digits=6, decimal_places=2)   # None = the tour's days
    extra_days: Decimal = Field(default=Decimal(0), ge=-50, le=50, max_digits=6, decimal_places=2)  # empty return, half days off (-0.5)
    km: Decimal = Field(default=Decimal(0), ge=0, max_digits=8, decimal_places=1)               # the route
    extra_km: Decimal = Field(default=Decimal(0), ge=0, max_digits=8, decimal_places=1)         # reserve
    fuel_price: Decimal | None = Price(default=None)
    fuel_currency: str | None = None
    fuel_date: date | None = None                           # the day the fuel price was true


class QuoteNightIn(BaseModel):
    id: str = Field(default_factory=_new_id, min_length=1, max_length=40)
    city: str = Field(default="", max_length=100)
    vendor_id: str | None = None
    hotel_name: str = Field(default="", max_length=200)
    currency: str
    # Room prices per night; a night without a DBL price isn't counted.
    price_dbl: Decimal | None = Price(default=None)
    price_sgl: Decimal | None = Price(default=None)
    price_trp: Decimal | None = Price(default=None)
    # The driver and guide this night (see StaffStay). "own": staff_price per room, in the night's currency.
    staff_stay: StaffStay = "none"
    staff_hotel: str = Field(default="", max_length=200)
    staff_price: Decimal | None = Price(default=None)
    staff_currency: str | None = None    # of staff_price ("40 USD" on a GEL night); None = the night's currency
    staff_twin: bool = False            # they share one room (two per room) instead of one each
    price_quad: Decimal | None = Price(default=None)     # a room for four (families)
    season_prices: dict[str, SeasonRoom] = Field(default_factory=dict)   # by season id; empty fields keep these prices

    _cur = field_validator("currency")(_currency)


class QuoteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    series_id: str | None = None
    client_id: str | None = None
    status: QuoteStatus = "draft"
    currency: str = "USD"
    valid_from: date | None = None
    valid_to: date | None = None
    days: int = Field(ge=1, le=60)
    pax_min: int = Field(default=9, ge=1, le=500)
    pax_max: int = Field(default=25, ge=1, le=500)
    leaders: int = Field(default=1, ge=0, le=10)          # free places (tour leaders): the "+1"
    leader_single: bool = True
    leader_room: LeaderRoom | None = None                 # None: from leader_single (older calculations)
    # One more free leader per this many paying tourists (19+1, 30+2…); never fewer than `leaders`.
    leaders_per: int | None = Field(default=None, ge=1, le=100)
    staff: int = Field(default=2, ge=0, le=20)            # driver, guide… who eat and travel with the group
    profit_group: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    profit_min_pp: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    margin_floor_pct: Decimal = Field(default=Decimal(0), ge=0, le=500, max_digits=6, decimal_places=2)
    single_profit: bool = True
    rounding_mode: RoundingMode = "floor"
    rounding_step: Decimal = Field(default=Decimal(1), ge=0, max_digits=8, decimal_places=2)
    # Units of a currency per 1 unit of the quote currency: {"GEL": 2.65} = 1 USD is 2.65 GEL.
    fx: dict[str, Decimal] = Field(default_factory=dict)
    variables: dict[str, Decimal] = Field(default_factory=dict)
    # What each variable means, in the agency's words ("meals eaten in Armenia").
    variable_notes: dict[str, str] = Field(default_factory=dict)
    languages: list[str] = Field(default_factory=lambda: ["en"], max_length=10)
    # Price-list texts per language: {"en": {"title": "...", "included": "...", ...}}
    texts: dict[str, dict[str, str]] = Field(default_factory=dict)
    notes: str = Field(default="", max_length=5000)
    nights: list[QuoteNightIn] = Field(default_factory=list, max_length=60)
    items: list[QuoteItemIn] = Field(default_factory=list, max_length=300)
    # The agency's own way (empty: from the fields above - tourists, leaders, staff, profit, rounding).
    people: list[PersonType] = Field(default_factory=list, max_length=20)
    recipe: list[PriceStep] = Field(default_factory=list, max_length=30)
    # Optional extras: this markup %, then the recipe's markups, commission, VAT and rounding.
    extra_markup: Decimal = Field(default=Decimal(0), ge=0, le=500, max_digits=6, decimal_places=2)
    # Other parts of the year with their own prices; the prices above are the base ("low season").
    seasons: list[Season] = Field(default_factory=list, max_length=12)
    sell_in: list[SellCurrency] = Field(default_factory=list, max_length=6)
    per_room: bool = False      # the price list shows prices per room (DBL = 2 people…), not per person
    transport: TransportPlan | None = None

    _cur = field_validator("currency")(_currency)

    @model_validator(mode="after")
    def _people_ok(self):
        if self.people:
            ids = [p.id for p in self.people]
            if len(ids) != len(set(ids)):
                raise ValueError("each type of person needs its own id")
            groups = [p for p in self.people if p.count is None]
            if len(groups) != 1 or groups[0].role != "pay":
                raise ValueError("exactly one paying type of person is the group (its number changes with the group size)")
        return self

    @model_validator(mode="after")
    def _leader_room(self):
        if self.leader_room is None:
            self.leader_room = "single" if self.leader_single else "shared"
        elif self.leader_room != "free":
            self.leader_single = self.leader_room == "single"
        return self

    def leader_kind(self) -> str:
        """single / shared / free. leader_single still decides single vs shared (scenarios and older
        calculations change only it); "free" (the hotel gives the room) is leader_room's own."""
        if self.leader_room == "free":
            return "free"
        return "single" if self.leader_single else "shared"

    def _counted(self, p: "PersonType", tourists: int) -> int:
        return max(p.count or 0, tourists // p.per) if p.per else (p.count or 0)

    def leaders_for(self, tourists: int) -> int:
        """Free places for a group of `tourists` (the "+1")."""
        if self.people:
            return sum(self._counted(p, tourists) for p in self.people if p.role == "free" and p.count is not None)
        if self.leaders_per:
            return min(max(self.leaders, tourists // self.leaders_per), 10)
        return self.leaders

    def others_for(self, tourists: int) -> int:
        """Everyone besides the group who travels as a guest: other paying types (children…) and free places."""
        if self.people:
            return sum(self._counted(p, tourists) for p in self.people if p.role != "staff" and p.count is not None)
        return self.leaders_for(tourists)

    def tourists_in(self, pax: int) -> int | None:
        """The group size in a tour of `pax` people (the group + children, free leaders…)."""
        return next((n for n in range(pax, 0, -1) if n + self.others_for(n) == pax), None)

    @field_validator("fx")
    @classmethod
    def _fx(cls, v):
        out = {}
        for cur, rate in v.items():
            if rate <= 0:
                raise ValueError(f"exchange rate for {cur} must be positive")
            out[_currency(cur)] = rate
        return out

    @field_validator("variables")
    @classmethod
    def _vars(cls, v):
        for name in v:
            if not _VAR.match(name):
                raise ValueError(f"variable '{name}': use lowercase letters, digits and _")
            if name in BUILTIN_VARS or name in ("ceil", "floor", "min", "max", "round", "abs"):
                raise ValueError(f"'{name}' is a built-in name")
        return v

    @field_validator("variable_notes")
    @classmethod
    def _notes(cls, v):
        if any(len(text) > 200 for text in v.values()):
            raise ValueError("variable descriptions are limited to 200 characters")
        return v

    @field_validator("languages")
    @classmethod
    def _langs(cls, v):
        for code in v:
            if not re.match(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$", code):
                raise ValueError(f"'{code}' is not a language code like en, zh or ka")
        return list(dict.fromkeys(v)) or ["en"]

    @model_validator(mode="after")
    def _unique_ids(self):
        # A duplicated line arrives with its original's id: give the copy a new one.
        for rows in (self.items, self.nights):
            seen: set[str] = set()
            for r in rows:
                if r.id in seen:
                    r.id = _new_id()
                seen.add(r.id)
        return self

    @model_validator(mode="after")
    def _ranges(self):
        if self.pax_max < self.pax_min:
            raise ValueError("pax_max is below pax_min")
        if self.pax_max - self.pax_min > 60:
            raise ValueError("at most 61 group sizes per calculation")
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("valid_to is before valid_from")
        return self


# --- results ---------------------------------------------------------------------------

class ItemCalc(BaseModel):
    index: int
    name: str
    category: QuoteCategory
    kind: str | None = None
    included: bool
    quantity: float | None
    unit_price: float | None      # in the item's own currency, after tier override
    currency: str
    multiplier: float | None      # persons or vehicles the line was multiplied by
    amount: float                 # for the whole group, in the quote currency
    error: str | None = None


class TierRow(BaseModel):
    tourists: int
    leaders: int
    label: str                    # "19+1"
    cost_dbl: float               # per paying tourist
    cost_sgl: float
    cost_trp: float | None
    profit_pp: float
    price_dbl: float
    price_sgl: float
    price_trp: float | None
    single_supplement: float
    group_cost: float             # everything the agency pays for this group
    group_revenue: float          # what the paying tourists pay (all in DBL)
    vehicle: str
    types: list["TypePrice"] = []  # every paying type of person (the group first)
    extras: list["ExtraPrice"] = []  # optional extras, per person of the group
    price_quad: float | None = None
    other: list["OtherCurrency"] = []  # the same prices in the other selling currencies


class OtherCurrency(BaseModel):
    currency: str
    price_dbl: float
    price_sgl: float
    price_trp: float | None = None
    price_quad: float | None = None


class ExtraPrice(BaseModel):
    id: str
    name: str
    cost: float                   # per person
    price: float


class TypePrice(BaseModel):
    id: str
    name: str
    count: int
    cost: float                   # per person
    price: float


class SeasonResult(BaseModel):
    id: str
    name: str
    from_date: date | None = None
    to_date: date | None = None
    tiers: list[TierRow]


class QuoteResult(BaseModel):
    currency: str
    tiers: list[TierRow]
    errors: list[str]
    nights_priced: int
    hotel_dbl_pp: float
    hotel_sgl_pp: float
    seasons: list[SeasonResult] = []


class PriceSteps(BaseModel):
    """How one group size's price is built, step by step ("explain this price")."""
    lines_total: float        # all included lines, for the group
    leader_room: float        # free leaders' hotel rooms, for the group
    staff_room: float = 0     # driver/guide hotel rooms, for the group
    shared_pp: float          # (lines + leader rooms) / paying tourists
    hotel_dbl_pp: float       # Σ DBL room / 2
    hotel_sgl_pp: float       # Σ SGL room
    profit_group_pp: float    # group profit / tourists
    profit_min_pp: float      # minimum per person
    profit_floor_pp: float    # DBL cost × margin floor %
    profit_rule: Literal["group", "minimum", "floor"]   # which of the three set the profit
    unrounded_dbl: float
    unrounded_sgl: float
    rounding_mode: RoundingMode
    rounding_step: float
    single_profit: bool
    recipe: list["RecipeLine"] = []   # the group's DBL price, step by step


class RecipeLine(BaseModel):
    label: str
    kind: str
    amount: float                 # what the step added (negative: took off)
    price: float                  # the price after it


class PersonCost(BaseModel):
    id: str
    name: str
    role: str
    count: int
    own: float                    # their own costs, per person (paying types)
    shared: float                 # their share of shared costs, per person (paying types)
    for_others: float             # free/staff types: what they cost the payers, in total


class Breakdown(BaseModel):
    tier: TierRow
    items: list[ItemCalc]
    leader_room: float
    hotel_nights: list[dict]
    steps: PriceSteps
    people: list[PersonCost] = []


class FormulaCheckIn(BaseModel):
    doc: "QuoteIn"
    expression: str = Field(max_length=300)
    tourists: int = Field(ge=1, le=500)


class FormulaValue(BaseModel):
    tourists: int
    value: float


class FormulaName(BaseModel):
    name: str
    value: float
    note: str
    builtin: bool


class FormulaCheck(BaseModel):
    ok: bool
    values: list[FormulaValue]         # smallest, chosen and largest group size
    error_code: str | None = None
    error: str | None = None
    error_params: dict = Field(default_factory=dict)
    names: list[FormulaName]           # every name a formula may use, with its value for the chosen size


class QuoteSummary(BaseModel):
    id: str
    name: str
    status: QuoteStatus
    price_from: float | None = None     # per person, the biggest group (the lowest price)
    price_to: float | None = None       # per person, the smallest group
    series_id: str | None = None
    series_code: str | None
    series_color: SeriesColor | None
    client_name: str | None
    days: int
    pax_min: int
    pax_max: int
    leaders: int
    currency: str
    valid_from: date | None
    valid_to: date | None
    updated_at: datetime
    tours: int


class QuoteOut(QuoteIn):
    id: str
    updated_at: datetime
    version: int              # latest saved version number
    result: QuoteResult
    notices: list[str] = []   # e.g. prices missing when it was built from a route


FormulaCheckIn.model_rebuild()


# --- history & scenarios -----------------------------------------------------------------

class Change(BaseModel):
    """One difference between two states of a calculation, for plain-language display."""
    area: Literal["settings", "variables", "fx", "items", "nights", "texts"]
    action: Literal["added", "removed", "changed"]
    key: str                  # field, variable, currency, line/night id, or language
    label: str                # what the user calls it (line name, "3. Batumi · GreenWood"…)
    field: str | None = None  # for a changed line/night: which part
    before: str | None = None
    after: str | None = None


class PriceImpact(BaseModel):
    tourists: int
    label: str
    before: float | None
    after: float | None


class VersionOut(BaseModel):
    number: int
    note: str
    created_at: datetime
    created_by: str | None
    changes: int


class VersionDiff(BaseModel):
    number: int
    against: int | None       # the version compared with; None for the first version
    changes: list[Change]
    impact: list[PriceImpact]


class ScenarioSettings(BaseModel):
    days: int | None = Field(default=None, ge=1, le=60)
    leaders: int | None = Field(default=None, ge=0, le=10)
    leader_single: bool | None = None
    staff: int | None = Field(default=None, ge=0, le=20)
    profit_group: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    profit_min_pp: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    margin_floor_pct: Decimal | None = Field(default=None, ge=0, le=500, max_digits=6, decimal_places=2)
    single_profit: bool | None = None
    rounding_mode: RoundingMode | None = None
    rounding_step: Decimal | None = Field(default=None, ge=0, max_digits=8, decimal_places=2)


class ScenarioItemPatch(BaseModel):
    included: bool | None = None
    unit_price: Decimal | None = Price(default=None)
    quantity: str | None = Field(default=None, max_length=300)


class ScenarioNightPatch(BaseModel):
    hotel_name: str | None = Field(default=None, max_length=200)
    vendor_id: str | None = None
    price_dbl: Decimal | None = Price(default=None)
    price_sgl: Decimal | None = Price(default=None)
    price_trp: Decimal | None = Price(default=None)


class ScenarioPatch(BaseModel):
    """Only what differs from the calculation. Lines and nights are addressed by id."""
    settings: ScenarioSettings = Field(default_factory=ScenarioSettings)
    variables: dict[str, Decimal] = Field(default_factory=dict)
    fx: dict[str, Decimal] = Field(default_factory=dict)
    items: dict[str, ScenarioItemPatch] = Field(default_factory=dict)
    nights: dict[str, ScenarioNightPatch] = Field(default_factory=dict)


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    patch: ScenarioPatch = Field(default_factory=ScenarioPatch)


class ScenarioOut(BaseModel):
    id: str
    name: str
    patch: ScenarioPatch
    changes: list[Change]     # what the scenario changes, against the current calculation
    stale: list[str]          # patched lines/nights/variables the calculation no longer has
    updated_at: datetime


class ScenarioResult(BaseModel):
    id: str | None
    name: str
    result: QuoteResult
    changes: list[Change]


class CompareOut(BaseModel):
    base: QuoteResult
    scenarios: list[ScenarioResult]

ExtraPrice.model_rebuild()
OtherCurrency.model_rebuild()
TierRow.model_rebuild()
PriceSteps.model_rebuild()
QuoteResult.model_rebuild()
Breakdown.model_rebuild()
CalcStyle.model_rebuild()
