"""A tour's budget: its calculation frozen for the group size sold, and costs measured against it.

Planned = budget lines (from the calculation). Actual = cost lines (from the
itinerary and the catalog, or typed in), each pointing to the budget line it
belongs to. A cost with no budget line is "not in the budget"; a budget line
with no cost yet is "not costed yet" — never counted as a saving.
"""
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from .models import Tour, TourBudgetLine, TourCost, utcnow
from .quote_engine import compute, following, lines_for, people_for, staff_rooms, to_quote_currency, variables, with_transport

ROOM_WORD = {"dbl": "sharing DBL", "sgl": "SGL", "trp": "in TRP", "free": "free room", "none": "no bed"}
from .quote_schemas import QuoteIn

ZERO = Decimal(0)
COST_CATEGORY = {"hotel": "hotel", "meal": "meal", "transport": "transport", "guide": "guide",
                 "ticket": "ticket", "activity": "ticket", "border": "visa"}


ROLE_LINE_NAMES = {"guide": ("guide",), "assistant": ("assistant", "guide"),
                   "transport": ("bus", "transport", "coach"), "driver": ("driver", "bus")}


@dataclass
class Snapshot:
    lines: list[TourBudgetLine]
    revenue: Decimal          # group revenue at that size, calculation currency
    warnings: list[str]


def budget_rates(doc: QuoteIn, ws_rates: dict[str, Decimal]) -> dict[str, Decimal]:
    """Rates to base for the budget: Settings first; for a currency Settings doesn't
    have, the calculation's own exchange rate (so planned matches what was sold)."""
    out = dict(ws_rates)
    q = ws_rates.get(doc.currency)
    if q:
        for cur, per_quote in doc.fx.items():
            if cur not in out and per_quote:
                out[cur] = (q / per_quote).quantize(Decimal("0.000001"))
    return out


def snapshot(doc: QuoteIn, tourists: int, rates: dict[str, Decimal]) -> Snapshot:
    """The calculation's costs for `tourists` (+ its leaders), one budget line per
    included calculation line and per priced hotel night. Their total equals the
    calculation's group cost for that size."""
    doc = with_transport(doc)          # the bus and fuel are budget lines like any other
    v = variables(doc, tourists)
    people = people_for(doc, tourists)
    out: list[TourBudgetLine] = []
    warnings: list[str] = []

    def add(**kw):
        cur = kw["currency"]
        out.append(TourBudgetLine(position=len(out), rate_to_base=rates.get(cur, ZERO), **kw))

    for i, n in enumerate(doc.nights, 1):
        if n.price_dbl is None:
            continue
        sgl = n.price_sgl if n.price_sgl is not None else n.price_dbl
        trp = n.price_trp / 3 if n.price_trp is not None else n.price_dbl / 2
        # Everyone's beds but the staff's (theirs follow the night's staff stay, below).
        bed = {"dbl": n.price_dbl / 2, "sgl": sgl, "trp": trp, "free": ZERO, "none": ZERO}
        total, parts = ZERO, []
        for p in people:
            if not p.count or p.room == "staff":
                continue
            kind = "dbl" if p.group else p.room
            total += bed[kind] * p.count
            parts.append(f"{p.count} {'in DBL' if p.group else p.name + ' ' + ROOM_WORD[kind]}")
        who = " + ".join(parts)
        hotel = (n.hotel_name or n.city or 'Hotel')[:180]
        add(source_id=n.id, kind="hotel", category="hotel", name=f"{hotel} · night {i}",
            vendor_id=n.vendor_id, service_id=None, day=i, quantity=Decimal(1), unit_price=total,
            currency=n.currency, notes=who)
        # Driver/guide rooms: own line (another hotel is another supplier to pay).
        rooms = sum(staff_rooms(doc, n, p.count) for p in people if p.room == "staff" and p.count)
        staff_n = sum(p.count for p in people if p.room == "staff" and p.count)
        if n.staff_stay == "allowance" and staff_n and n.staff_price is not None:
            # Planned at the allowance; the real hotel they find is entered on the tour as the actual cost.
            add(source_id=f"{n.id}:staff", kind="hotel", category="hotel", name=f"Staff allowance · night {i}",
                vendor_id=None, service_id=None, day=i, quantity=Decimal(staff_n), unit_price=n.staff_price,
                currency=n.staff_currency or n.currency, notes=f"{staff_n} staff × allowance per night")
        if n.staff_stay in ("same", "own") and rooms:
            each = (n.price_dbl if n.staff_twin else sgl) if n.staff_stay == "same" else n.staff_price
            if each is not None:
                where = hotel if n.staff_stay == "same" else (n.staff_hotel or hotel)[:180]
                add(source_id=f"{n.id}:staff", kind="hotel", category="hotel", name=f"Staff · {where} · night {i}",
                    vendor_id=n.vendor_id if n.staff_stay == "same" else None, service_id=None, day=i, quantity=Decimal(rooms),
                    unit_price=each, currency=n.currency if n.staff_stay == "same" else (n.staff_currency or n.currency),
                    notes=f"{sum(p.count for p in people if p.room == 'staff')} staff · {rooms} {'TWN' if n.staff_twin else 'SGL'}")
    doc = following(doc)
    lines = lines_for(doc, tourists, v)
    for k, item in enumerate(doc.items):
        if not item.included:
            continue
        ln = lines[k]
        if ln.error:
            warnings.append(f"{item.name}: {ln.error} (left out)")
            continue
        if item.uses and item.basis == "per_person":
            # Some people at half or their own price: the line's exact amount, in its own currency.
            rate = to_quote_currency(doc, Decimal(1), item.currency) or Decimal(1)
            add(source_id=item.id, kind="item", category=item.category, name=_named(item), vendor_id=item.vendor_id,
                service_id=item.service_id, day=item.day, quantity=Decimal(1),
                unit_price=(ln.amount / rate).quantize(Decimal("0.01")), currency=item.currency,
                notes=(f"{ln.multiplier.normalize():f} people, some at their own price · " + _noted(item))[:300])
            continue
        add(source_id=item.id, kind="item", category=item.category, name=_named(item), vendor_id=item.vendor_id,
            service_id=item.service_id, day=item.day, quantity=(ln.quantity * ln.multiplier).quantize(Decimal("0.01")),
            unit_price=ln.unit_price, currency=item.currency, notes=_noted(item)[:300])
    missing = sorted({b.currency for b in out if b.rate_to_base == 0})
    if missing:
        warnings.append(f"No exchange rate for {', '.join(missing)} in Settings: those lines count as 0 in totals")
    tier = next((t for t in compute(doc).tiers if t.tourists == tourists), None)
    return Snapshot(out, Decimal(str(tier.group_revenue)) if tier else ZERO, warnings)


def _named(item) -> str:
    """A ticket's budget line says where it goes: "Flight · Tbilisi → Yerevan · Yerevan → Tbilisi"."""
    from .travel import journey
    j = journey(item)
    return f"{item.name} · {j}"[:200] if j else item.name


def _noted(item) -> str:
    tr = item.travel
    if not tr:
        return item.notes
    bits = [f"{x.number} {x.on or ''} {x.depart}".strip() for x in tr.legs if x.number]
    bits += [tr.cabin, tr.baggage, f"taxes {tr.taxes.normalize():f} incl." if tr.taxes else "",
             f"issue tickets by {tr.ticket_by}" if tr.ticket_by else "", item.notes]
    return " · ".join(b for b in bits if b)


def apply(t: Tour, doc: QuoteIn, tourists: int, rates: dict[str, Decimal], source: str) -> Snapshot:
    """Replace the tour's budget. Lines from the same calculation line keep their id,
    so costs already linked to them stay linked."""
    rates = budget_rates(doc, rates)
    snap = snapshot(doc, tourists, rates)
    old = {b.source_id: b for b in t.budget}
    keep = []
    for new in snap.lines:
        b = old.pop(new.source_id, None) or TourBudgetLine(tour_id=t.id)
        for k in ("position", "source_id", "kind", "category", "name", "vendor_id", "service_id", "day",
                  "quantity", "unit_price", "currency", "rate_to_base", "notes"):
            setattr(b, k, getattr(new, k))
        keep.append(b)
    for gone in old.values():           # their costs become "not in the budget"
        for c in t.costs:
            if c.budget_line_id == gone.id:
                c.budget_line_id = None
    t.budget = keep
    t.budget_tourists = tourists
    t.budget_leaders = sum(p.count for p in people_for(doc, tourists) if p.role == "free")
    t.leaders = t.budget_leaders      # the calculation says how many of the group travel free
    t.budget_revenue, t.budget_currency = snap.revenue.quantize(Decimal("0.01")), doc.currency
    t.budget_rate_to_base = rates.get(doc.currency, ZERO)
    t.budget_source, t.budget_set_at = source[:300], utcnow()
    return snap


# --- linking costs to budget lines ---------------------------------------------------------

def _day(t: Tour, c: TourCost) -> int:
    return (c.service_date - t.start_date).days + 1


def match(t: Tour, c: TourCost, service_id: str | None = None) -> TourBudgetLine | None:
    """The budget line a cost belongs to, by the most specific rule that finds exactly one:
    same catalog service (and day) → same hotel and night → the same restaurant's lunch or dinner →
    same vendor and day →
    same vendor and category → the planned hotel of that night → the only budget line
    of that category without a vendor → the line named like the staff role.
    Ambiguous costs stay unlinked for a person to choose: a wrong link is worse than none."""
    day = _day(t, c)
    lines = t.budget

    def one(found):
        return found[0] if len(found) == 1 else None

    def day_ok(b):
        return b.day is None or b.day == day

    rules = []
    if service_id:
        rules.append([b for b in lines if b.service_id == service_id and day_ok(b)])
    if c.vendor_id:
        if c.category == "hotel":
            rules.append([b for b in lines if b.kind == "hotel" and b.vendor_id == c.vendor_id and b.day == day])
        # One restaurant, lunch and dinner the same day: "lunch × 21" is the "Lunch: …" line.
        meal = (c.description.split(" ") or [""])[0].lower()
        if c.category == "meal" and meal in ("lunch", "dinner"):
            rules.append([b for b in lines if b.vendor_id == c.vendor_id and day_ok(b) and b.name.lower().startswith(meal)
                          and COST_CATEGORY.get(b.category, "other") == "meal"])
        rules.append([b for b in lines if b.vendor_id == c.vendor_id and b.day == day
                      and COST_CATEGORY.get(b.category, "other") == c.category])
        rules.append([b for b in lines if b.vendor_id == c.vendor_id and day_ok(b)
                      and COST_CATEGORY.get(b.category, "other") == c.category])
    if c.category == "hotel":  # the night's planned hotel, even if the group moved hotel
        rules.append([b for b in lines if b.kind == "hotel" and b.day == day])
    no_vendor = [b for b in lines if b.vendor_id is None and b.kind == "item"
                 and COST_CATEGORY.get(b.category, "other") == c.category]
    rules.append(no_vendor)
    # A guide's or bus's days: the line named just like the role ("Guide", "Bus").
    role = (c.description.split(" ") or [""])[0].lower()
    names = ROLE_LINE_NAMES.get(role, ())
    rules.append([b for b in no_vendor if b.name.strip().lower() in names])
    for found in rules:
        if (b := one(found)) is not None:
            return b
    return None


def link_unlinked(t: Tour, services: dict[str, str] | None = None) -> int:
    """Link cost lines that have no budget line yet (never overriding a choice someone made).
    services: cost auto_key → catalog service id, for lines generated from day services."""
    n = 0
    for c in t.costs:
        if c.budget_line_id is None and not c.budget_by_hand:
            b = match(t, c, (services or {}).get(c.auto_key or ""))
            if b:
                c.budget_line_id = b.id
                n += 1
    return n


def cost_from(t: Tour, b: TourBudgetLine) -> TourCost:
    """A cost line with the planned values, for a budget line nothing else covers
    (a guide or bus agreed in the calculation but not on the itinerary)."""
    start = t.start_date + timedelta(days=b.day - 1) if b.day else t.start_date
    return TourCost(tour_id=t.id, vendor_id=b.vendor_id, category=COST_CATEGORY.get(b.category, "other"),
                    description=b.name[:300], service_date=start, service_end=None if b.day else t.end_date,
                    quantity=b.quantity, unit_price=b.unit_price.quantize(Decimal("0.01")), currency=b.currency,
                    rate_to_base=b.rate_to_base, budget_line_id=b.id, notes="From the budget")
