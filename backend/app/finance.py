"""Tour costs, what is owed to whom, and when.

The unit of payment is (tour, vendor, currency), the same thing ki.360 marked
paid / unpaid. Cost lines are the detail behind it; payments are recorded
against it. Due dates come from the vendor's terms: N days before the first
service of that tour, or N days after the last one.
"""
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from . import budget, catalog, seating
from . import dishes as dish_util
from .models import ExchangeRate, Service, Tour, TourBooking, TourCost, Vendor, VendorPayment, Workspace
from .routers.people import rooming
from .schemas import CostOut, CostTotals, GenerateResult, PaidBy, Payable, PaymentOut, VendorRef

CENT = Decimal("0.01")
ZERO = Decimal(0)


# --- exchange rates -------------------------------------------------------------------

def rates(db: Session, ws: Workspace) -> dict[str, Decimal]:
    table = {r.currency: r.rate for r in db.scalars(select(ExchangeRate).where(ExchangeRate.workspace_id == ws.id))}
    table[ws.base_currency] = Decimal(1)
    return table


def rate_for(table: dict[str, Decimal], currency: str) -> Decimal:
    """0 when unknown: the line is then flagged as missing a rate, never silently valued at 1."""
    return table.get(currency, ZERO)


# --- output helpers ---------------------------------------------------------------------

def vat_rate_of(c: TourCost, ws_rate: Decimal | None) -> Decimal | None:
    """The VAT percent inside a cost line: set on the line, else the agency's rate when the supplier
    gives VAT invoices, else 0. None = the agency doesn't use VAT."""
    if ws_rate is None:
        return None
    if c.vat_rate is not None:
        return c.vat_rate
    return ws_rate if (c.vendor is not None and c.vendor.vat_invoice) else ZERO


def vat_of(c: TourCost, ws_rate: Decimal | None) -> Decimal | None:
    """VAT inside the line's amount (line currency): amount × rate / (100 + rate)."""
    r = vat_rate_of(c, ws_rate)
    if r is None:
        return None
    return (c.amount * r / (100 + r)).quantize(CENT) if r else ZERO


def vat_base(costs, ws_rate: Decimal | None) -> Decimal | None:
    """VAT inside all the lines, in the base currency (None = the agency doesn't use VAT)."""
    if ws_rate is None:
        return None
    return sum(((vat_of(c, ws_rate) or ZERO) * c.rate_to_base for c in costs), ZERO).quantize(CENT)


def cost_out(c: TourCost, ws_rate: Decimal | None = None) -> CostOut:
    vat_r = vat_rate_of(c, ws_rate)
    return CostOut(
        id=c.id, vendor=VendorRef.model_validate(c.vendor) if c.vendor else None, category=c.category,
        description=c.description, service_date=c.service_date, service_end=c.service_end,
        quantity=c.quantity, unit_price=c.unit_price, currency=c.currency, rate_to_base=c.rate_to_base,
        amount=c.amount, amount_base=c.amount_base, notes=c.notes, auto=c.auto_key is not None, locked=c.locked,
        budget_line_id=c.budget_line_id, reason=c.reason, incident_id=c.incident_id,
        vat_rate=vat_r, vat=vat_of(c, ws_rate), vat_by_hand=c.vat_rate is not None,
    )


def paid_by(p: VendorPayment) -> PaidBy | None:
    if p.paid_by_vendor is not None:
        return PaidBy(kind="staff", id=p.paid_by_vendor.id, name=p.paid_by_vendor.name)
    if p.paid_by_user is not None:
        return PaidBy(kind="user", id=p.paid_by_user.id, name=p.paid_by_user.full_name or p.paid_by_user.email)
    return None


def payment_out(p: VendorPayment, vendor: Vendor) -> PaymentOut:
    return PaymentOut(id=p.id, vendor=VendorRef.model_validate(vendor), currency=p.currency, amount=p.amount,
                      paid_on=p.paid_on, method=p.method, reference=p.reference, notes=p.notes, paid_by=paid_by(p))


def totals(t: Tour, ws: Workspace) -> CostTotals:
    by_cur: dict[str, Decimal] = defaultdict(Decimal)
    base = ZERO
    missing = set()
    for c in t.costs:
        by_cur[c.currency] += c.amount
        base += c.amount_base
        if c.rate_to_base == 0 and c.amount:
            missing.add(c.currency)
    vat = vat_base(t.costs, ws.vat_rate)
    return CostTotals(by_currency={k: float(v) for k, v in sorted(by_cur.items())}, base_currency=ws.base_currency,
                      base_total=float(base), missing_rates=sorted(missing), vat_base=float(vat) if vat is not None else None)


# --- payables ---------------------------------------------------------------------------

def due_date(v: Vendor, first: date | None, last: date | None) -> date | None:
    if first is None:
        return None
    if v.payment_timing == "before":
        return first - timedelta(days=v.payment_days)
    return (last or first) + timedelta(days=v.payment_days)


def status_of(total: Decimal, paid: Decimal, due: date | None, today: date) -> str:
    if total < -CENT / 2:                       # the supplier owes us (a claim, a refund)
        return "paid" if paid <= total + CENT / 2 else "owed_to_us"
    if paid >= total - CENT / 2 and (total > 0 or paid > 0):
        return "paid"
    if due and due < today:
        return "overdue"
    return "partial" if paid > 0 else "unpaid"


def bill_tolerance(expected: Decimal, pct: Decimal) -> Decimal:
    """How far a vendor's bill may differ and still match: pct of the amount, never under 1.00."""
    return max(Decimal(1), abs(expected) * pct / 100)


def payables(t: Tour, vendors: dict[str, Vendor], today: date | None = None,
             tolerance_pct: Decimal = Decimal(1)) -> list[Payable]:
    today = today or date.today()
    bills: dict[tuple[str, str], list] = defaultdict(list)
    for b in t.bills:
        bills[(b.vendor_id, b.currency)].append(b)
    lines: dict[tuple[str, str], list[TourCost]] = defaultdict(list)
    for c in t.costs:
        if c.vendor_id:
            lines[(c.vendor_id, c.currency)].append(c)
    paid: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    for p in t.payments:
        paid[(p.vendor_id, p.currency)] += p.amount
        # A guide/driver paid it from the cash they hold: that much of their advance is spent for us.
        if p.paid_by_vendor_id and p.paid_by_vendor_id != p.vendor_id:
            paid[(p.paid_by_vendor_id, p.currency)] -= p.amount
    out = []
    for key in sorted(set(lines) | set(paid) | set(bills), key=lambda k: (vendors[k[0]].type, vendors[k[0]].name, k[1])):
        vendor_id, currency = key
        v = vendors[vendor_id]
        ls = lines.get(key, [])
        total = sum((c.amount for c in ls), ZERO)
        first = min((c.service_date for c in ls), default=None)
        last = max((c.service_end or c.service_date for c in ls), default=None)
        bs = bills.get(key, [])
        # A bill's own due date beats the vendor's usual terms.
        due = min((b.due_date for b in bs if b.due_date), default=None) or due_date(v, first, last)
        p = paid.get(key, ZERO)
        billed = sum((b.amount for b in bs), ZERO)
        diff = billed - total
        state = ("disputed" if any(b.disputed for b in bs)
                 else ("no_bill" if total > 0 else "") if not bs
                 else "matched" if abs(diff) <= bill_tolerance(total, tolerance_pct) else "difference")
        out.append(Payable(
            tour_id=t.id, tour_code=t.code, tour_color=t.series.color if t.series else "slate",
            vendor=VendorRef.model_validate(v), currency=currency, total=total, paid=p, balance=total - p,
            first_service=first, last_service=last, due_date=due, status=status_of(total, p, due, today),
            billed=billed, bill_state=state, bill_difference=diff,
        ))
    return out


def vendor_map(db: Session, t: Tour) -> dict[str, Vendor]:
    ids = ({c.vendor_id for c in t.costs if c.vendor_id} | {p.vendor_id for p in t.payments} | {b.vendor_id for b in t.bills}
           | {p.paid_by_vendor_id for p in t.payments if p.paid_by_vendor_id})
    return {v.id: v for v in db.scalars(select(Vendor).where(Vendor.id.in_(ids)))} if ids else {}


# --- generating cost lines from the itinerary ----------------------------------------------

# "12 DBL + 2 SGL", "8 double + 2 single", "8 ორადგილიანი + 2 ერთადგილიანი", "8 двухместных"…
ROOM_RE = re.compile(r"(\d+)\s*-?\s*([^\W\d_]+)", re.I)
_ROOM_WORDS = [  # (word prefix, room type): longest prefixes first where they overlap
    ("sngl", "SGL"), ("sgl", "SGL"), ("single", "SGL"), ("ერთადგ", "SGL"), ("одномест", "SGL"),
    ("dbl", "DBL"), ("double", "DBL"), ("ორადგ", "DBL"), ("двухмест", "DBL"), ("дабл", "DBL"),
    ("twn", "TWN"), ("twin", "TWN"), ("твин", "TWN"),
    ("trp", "TRP"), ("tpl", "TRP"), ("triple", "TRP"), ("სამადგ", "TRP"), ("трехмест", "TRP"), ("трёхмест", "TRP"),
    ("quad", "QUAD"), ("ოთხადგ", "QUAD"),
]


def room_kind(word: str) -> str | None:
    w = word.lower()
    return next((kind for prefix, kind in _ROOM_WORDS if w.startswith(prefix)), None)
from .seating import MEAL_STAFF  # noqa: E402 - staff roles that eat at the meals (kept here for imports)
STAFF_CATEGORY = {"guide": "guide", "tour_leader": "guide", "assistant": "guide",
                  "driver": "transport", "transport": "transport", "other": "other"}


def staff_room_kind(hotel: Vendor, twin: bool) -> str:
    """The rate for a driver/guide room: the hotel's staff price when it has one, else its SGL (or DBL to share)."""
    if catalog.service_by_code(hotel, "staff_room"):
        return "staff_room"
    return "room_DBL" if twin else "room_SGL"


def room_counts(t: Tour) -> dict[str, int]:
    """Rooms per type: from the participant list when there is one, else the tour's
    free-text rooms field ("12 DBL + 2 SGL")."""
    if t.participants:
        return dict(rooming(t).rooms)
    counts: dict[str, int] = defaultdict(int)
    for n, word in ROOM_RE.findall(t.rooms or ""):
        if kind := room_kind(word):
            counts[kind] += int(n)
    return dict(counts)


def everyone(t: Tour) -> int:
    """Everyone travelling as the group: the guests and their free tour leaders on top (19+1 → 20). The
    participants list, when there is one, already has the leaders in it."""
    return len(t.participants) or ((t.pax or 0) + (t.leaders or 0))


def group_size(t: Tour) -> int | None:
    """The group's people (guests + tour leaders), for counts and prices that depend on group size."""
    return everyone(t) or None


@dataclass
class _Plan:
    key: str
    vendor: Vendor
    category: str
    description: str
    service_date: date
    service_end: date | None
    quantity: Decimal
    rate_kind: str
    service: Service | None = None   # a catalog service picked on the day (else priced by rate_kind)
    fixed: tuple[Decimal, str] | None = None   # a price already worked out (a shared menu, plate by plate)


# Catalog categories → cost-line categories.
SERVICE_COST_CATEGORY = {"hotel": "hotel", "meal": "meal", "transport": "transport", "guide": "guide",
                         "ticket": "ticket", "activity": "ticket", "border": "visa"}


def auto_quantity(unit: str, pax: Decimal, rooms: int, km: int | None = None,
                  fuel_l_per_100km: Decimal | None = None) -> Decimal | None:
    """How many of a service a day needs, from its unit; None when it can't be known.
    Per km = the day's road km; per litre = km × the vehicle's litres per 100 km."""
    if unit == "km":
        return Decimal(km) if km else None
    if unit == "litre":
        if not km or not fuel_l_per_100km:
            return None
        return (Decimal(km) * Decimal(fuel_l_per_100km) / 100).quantize(Decimal("0.01"))
    return {"person": pax, "room_night": Decimal(rooms), "group": Decimal(1), "vehicle_day": Decimal(1),
            "day": Decimal(1)}.get(unit)


def day_services(db: Session, t: Tour) -> dict[str, Service]:
    ids = {x["service_id"] for d in t.days for x in d.extras or []}
    if not ids:
        return {}
    stmt = (select(Service).join(Vendor).where(Service.id.in_(ids), Vendor.workspace_id == t.workspace_id)
            .options(selectinload(Service.rates), selectinload(Service.vendor)))
    return {s.id: s for s in db.scalars(stmt)}


@dataclass
class _Ctx:
    warnings: list[str] = field(default_factory=list)
    fuel_l_per_100km: Decimal | None = None
    plate_share: int = 1             # the agency's people per plate (Workspace.plate_share)
    missing: set[tuple[str, str]] = field(default_factory=set)


def _plan(t: Tour, services: dict[str, Service], ctx: _Ctx) -> list[_Plan]:
    pax = Decimal(everyone(t))
    rooms = room_counts(t)
    plans: list[_Plan] = []
    for d in t.days:
        for x in d.extras or []:
            if x.get("optional"):       # offered only: a cost once the group takes it (untick "optional")
                continue
            s = services.get(x["service_id"])
            if s is None:
                ctx.warnings.append(f"Day {d.day_number}: a service was removed from the price catalog")
                continue
            # km and fuel on the last day include the drive back to the garage.
            km = (d.km or 0) + ((t.bus_return or {}).get("km") or 0) if d.day_number == len(t.days) and t.bus_return else d.km
            qty = Decimal(str(x["quantity"])) if x.get("quantity") is not None else auto_quantity(
                s.unit, pax, sum(rooms.values()), km, ctx.fuel_l_per_100km)
            if qty is None:
                qty = Decimal(1)
                ctx.warnings.append(f"Day {d.day_number}: set how many '{s.name}' (counted as 1)")
            if not qty:
                continue
            plans.append(_Plan(f"svc:{d.id}:{x['id']}", s.vendor, SERVICE_COST_CATEGORY.get(s.category, "other"),
                               f"{s.name} × {qty.normalize():f}", d.date, None, qty, s.code or "", s))
        if d.hotel:
            for rtype, n in rooms.items():
                plans.append(_Plan(f"hotel:{d.id}:{rtype}", d.hotel, "hotel", f"{rtype} × {n}", d.date, None,
                                   Decimal(n), f"room_{rtype}"))
        # Guides and drivers working that day eat with the group (as calculations count them).
        eating_staff = sum(1 for a in t.staff if a.role in MEAL_STAFF and a.covers(d.day_number))
        # ...and sleep where the day says (not after the last day: no night).
        if d.day_number < len(t.days) and (d.staff_stay or "none") in ("same", "own") and eating_staff:
            where = d.hotel if d.staff_stay == "same" else (d.staff_hotel or d.hotel)
            if where is None:
                ctx.warnings.append(f"Day {d.day_number}: choose the driver and guide's hotel")
            else:
                n_rooms = -(-eating_staff // 2) if d.staff_twin else eating_staff
                kind = staff_room_kind(where, bool(d.staff_twin))
                plans.append(_Plan(f"staffroom:{d.id}", where, "hotel",
                                   f"staff {'TWN' if d.staff_twin else 'SGL'} × {n_rooms} ({eating_staff} staff)",
                                   d.date, None, Decimal(n_rooms), kind))
        for meal, vendor, menu in (("breakfast", d.breakfast, d.breakfast_menu), ("lunch", d.lunch, d.lunch_menu),
                                   ("dinner", d.dinner, d.dinner_menu)):
            # Tourists paying on the spot, or a free meal time: nothing for us to pay.
            if (getattr(d, f"{meal}_mode", None) or "included") != "included":
                continue
            # Who sits where at this meal (app/seating.py): the group's table, and the staff table when some eat apart.
            seat = seating.tables(t, d.day_number, int(pax), meal)
            crew = seat.staff
            with_us = sum(n for r, n in seat.group_roles.items() if r != "leader")     # staff at the group's table
            if vendor and pax:
                staff_price = bool(crew) and catalog.service_by_code(vendor, "staff_meal") is not None
                if staff_price:
                    # Their own table at the restaurant's staff price: a line of its own.
                    plans.append(_Plan(f"{meal}_staff:{d.id}", vendor, "meal", f"{meal} · staff table × {crew}", d.date, None,
                                       Decimal(crew), "staff_meal"))
                    n = seat.group
                    what = f"{meal} × {n}" + (f" ({n - with_us} + {with_us} staff)" if with_us else "")
                else:
                    # One price for everyone: one line (the tables only decide the plates).
                    n = seat.group + crew
                    staff = with_us + crew
                    what = f"{meal} × {n}" + (f" ({n - staff} + {staff} staff)" if staff else "")
                if menu is not None and menu.vendor_id == vendor.id:
                    served = dish_util.served(d, meal, menu)      # this tour's own dishes, else the menu's
                    # Shared dishes, all priced: the plates, counted table by table (the staff table eats too).
                    # Otherwise (a dish without a price, or one portion each) the menu's price per person.
                    tables = seat.tables if not staff_price else seat.tables[:1]
                    shared = None
                    if dish_util.sharing(served, t.plate_share, ctx.plate_share):
                        cost, _, by_plates = dish_util.meal_cost(None, None, int(n), 0, tables, served, t.plate_share, ctx.plate_share)
                        shared = cost if by_plates else None     # a dish without a price: the menu's price per person
                    if shared is not None:
                        # Family style: so many plates of each dish, not a price per person.
                        share = t.plate_share or ctx.plate_share or 1
                        cur = (menu.rates[0].currency if menu.rates else None) or vendor.currency or ""
                        plans.append(_Plan(f"{meal}:{d.id}", vendor, "meal",
                                           f"{what} · {menu.name} · {sum(dish_util.plates(x, share) for x in tables)} plates of each dish (1 per {share})",
                                           d.date, None, Decimal(1), meal, menu, fixed=(shared, cur)))
                        continue
                    plans.append(_Plan(f"{meal}:{d.id}", vendor, "meal", f"{what} · {menu.name}", d.date, None, n, meal, menu))
                else:
                    plans.append(_Plan(f"{meal}:{d.id}", vendor, "meal", what, d.date, None, n, meal))
    n_days = len(t.days)
    back = t.bus_return or {}
    for a in t.staff:
        end = a.end_day or n_days
        days = end - a.start_day + 1
        if days <= 0:
            continue
        what = f"{a.role} × {days} days"
        # The bus (and its driver) drive back to the garage the day after the group leaves: one more day.
        if back.get("on") == "next" and a.role in ("transport", "driver") and end >= n_days:
            end, days = end + 1, days + 1
            what = f"{a.role} × {days} days (incl. the drive back{' to ' + back['to'] if back.get('to') else ''})"
        start_date = t.start_date + timedelta(days=a.start_day - 1)
        end_date = t.start_date + timedelta(days=end - 1)
        plans.append(_Plan(f"staff:{a.id}", a.vendor, STAFF_CATEGORY[a.role], what,
                           start_date, end_date if end_date != start_date else None, Decimal(days), "day"))
    return plans


def generate(db: Session, ws: Workspace, t: Tour) -> GenerateResult:
    """Create / refresh the itinerary-based cost lines of a tour.

    Never touches: hand-made lines, lines someone edited (locked), and anything
    for a vendor that already has a payment on this tour.
    """
    rate_table = rates(db, ws)
    ctx = _Ctx(fuel_l_per_100km=ws.fuel_l_per_100km, plate_share=ws.plate_share or 1)
    paid_vendors = {p.vendor_id for p in t.payments}
    confirmed = set(db.scalars(select(TourBooking.vendor_id).where(TourBooking.tour_id == t.id,
                                                                    TourBooking.status == "confirmed")))
    existing = {c.auto_key: c for c in t.costs if c.auto_key}
    created = updated = kept = 0
    seen: set[str] = set()
    pax = group_size(t)

    if not t.days:
        ctx.warnings.append("The tour has no itinerary days")
    if not room_counts(t) and any(d.hotel_id for d in t.days):
        ctx.warnings.append("No rooms known: add participants with room types, or fill the tour's Rooms field")

    plans = _plan(t, day_services(db, t), ctx)
    for plan in plans:
        seen.add(plan.key)
        line = existing.get(plan.key)
        if plan.vendor.id in paid_vendors or (line and line.locked):
            if line is not None:
                kept += 1
            continue
        # The price that applies on the service date for this group size (seasons, pax bands).
        if plan.service:
            rate = catalog.pick(plan.service.rates, plan.service_date, pax)
        else:
            rate = catalog.price_for(plan.vendor, plan.rate_kind, plan.service_date, pax)
        what = plan.service.name if plan.service else plan.rate_kind
        if rate is None and plan.fixed is None and (plan.vendor.id, what) not in ctx.missing:
            ctx.missing.add((plan.vendor.id, what))
            ctx.warnings.append(f"{plan.vendor.name}: no price for '{what}' on "
                                f"{plan.service_date.isoformat()} (line added at 0)")
        price = rate.price if rate else ZERO
        currency = rate.currency if rate else (plan.vendor.currency or ws.base_currency)
        if plan.fixed is not None:
            price, currency = plan.fixed[0], plan.fixed[1] or plan.vendor.currency or ws.base_currency
        if line is not None and plan.vendor.id in confirmed and line.unit_price:   # 0 = never priced, not agreed
            # The supplier confirmed this price: quantities and dates follow the tour, the price stays.
            if rate and (rate.price != line.unit_price or rate.currency != line.currency):
                ctx.warnings.append(f"{plan.vendor.name}: confirmed at {line.unit_price} {line.currency}, the catalog now says "
                                    f"{rate.price} {rate.currency} — kept the confirmed price (edit the line if it changed)")
            price, currency = line.unit_price, line.currency
        values = dict(vendor_id=plan.vendor.id, category=plan.category, description=plan.description,
                      service_date=plan.service_date, service_end=plan.service_end, quantity=plan.quantity,
                      unit_price=price, currency=currency, rate_to_base=rate_for(rate_table, currency))
        if line is None:
            t.costs.append(TourCost(tour_id=t.id, auto_key=plan.key, **values))
            created += 1
        elif any(getattr(line, k) != v for k, v in values.items()):
            for k, v in values.items():
                setattr(line, k, v)
            updated += 1

    removed = 0
    for key, line in existing.items():
        if key in seen:
            continue
        if line.locked or line.vendor_id in paid_vendors:
            kept += 1
            continue
        t.costs.remove(line)
        removed += 1
    for cur in sorted({c.currency for c in t.costs if c.rate_to_base == 0}):
        ctx.warnings.append(f"No exchange rate for {cur} → {ws.base_currency}; set it in Settings")
    if paid_vendors:
        ctx.warnings.append("Vendors with payments on this tour were left unchanged")
    linked = 0
    if t.budget:  # each new cost line points to the planned line it is the actual for
        db.flush()
        linked = budget.link_unlinked(t, {p.key: p.service.id for p in plans if p.service})
    return GenerateResult(created=created, updated=updated, removed=removed, kept=kept, linked=linked,
                          warnings=ctx.warnings)

