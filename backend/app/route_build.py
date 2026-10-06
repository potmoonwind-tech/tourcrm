"""Calculation lines from a route and the price catalog.

A route day says which hotel, restaurants and services the group uses; the
catalog says what they cost on a date for a group size. This turns both into
calculation nights and lines, with group-size price bands as line tiers, and
re-prices an existing calculation for another travel date.
"""
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from . import catalog
from .models import Series, Service, Vendor
from .quote_schemas import QuoteIn, QuoteItemIn, QuoteNightIn, QuoteTier

ROOM_CODES = {"price_dbl": ("room_DBL", "room_TWN"), "price_sgl": ("room_SGL",), "price_trp": ("room_TRP",)}
LAST_TIER = 500  # tiers cover groups "up to max_pax"; the last band runs to the end


@dataclass
class Priced:
    unit_price: Decimal
    currency: str | None
    tiers: list[QuoteTier] = field(default_factory=list)
    missing: list[int] = field(default_factory=list)   # group sizes with no price
    mixed: bool = False                                  # bands in different currencies


def priced(rates, on: date, pax_min: int, pax_max: int) -> Priced:
    """The price for every group size in the calculation, folded into tiers:
    one tier per run of sizes with the same price. One run = no tiers."""
    runs: list[tuple[int, Decimal | None, str | None]] = []  # (last size, price, currency)
    for n in range(pax_min, pax_max + 1):
        r = catalog.pick(rates, on, n)
        key = (r.price, r.currency) if r else (None, None)
        if runs and (runs[-1][1], runs[-1][2]) == key:
            runs[-1] = (n, *key)
        else:
            runs.append((n, *key))
    missing = [n for n in range(pax_min, pax_max + 1) if catalog.pick(rates, on, n) is None]
    found = [r for r in runs if r[1] is not None]
    if not found:
        return Priced(Decimal(0), None, missing=missing)
    currency = found[0][2]
    mixed = any(r[2] != currency for r in found)
    base = found[0][1]
    if len(runs) == 1:
        return Priced(base, currency, missing=missing)
    tiers = []
    for i, (last, price, cur) in enumerate(runs):
        ok = price is not None and cur == currency
        tiers.append(QuoteTier(max_pax=LAST_TIER if i == len(runs) - 1 else last,
                               unit_price=price if ok else Decimal(0), label=""))
    return Priced(base, currency, tiers, missing, mixed)


def _warn(p: Priced, what: str, on: date, warnings: list[str]) -> None:
    if p.currency is None:
        warnings.append(f"{what}: no price on {on.isoformat()} (added at 0)")
    elif p.missing:
        warnings.append(f"{what}: no price for {_sizes(p.missing)} tourists on {on.isoformat()} (0 there)")
    if p.mixed:
        warnings.append(f"{what}: group-size prices are in different currencies; check the tiers")


def _sizes(ns: list[int]) -> str:
    return f"{ns[0]}–{ns[-1]}" if len(ns) > 1 else str(ns[0])


def _night_prices(v: Vendor, on: date, pax: int | None = None) -> dict[str, tuple[Decimal, str]]:
    """Room prices per night. A night has one price, so a group-size band applies only
    when a group size is given (e.g. a group rate from 20 tourists)."""
    out = {}
    for field_name, codes in ROOM_CODES.items():
        r = next((x for c in codes if (x := catalog.price_for(v, c, on, pax))), None)
        if r:
            out[field_name] = (r.price, r.currency)
    return out


def _item_for_service(s: Service, slot: dict, day_number: int, on: date, q: QuoteIn, warnings: list[str]) -> QuoteItemIn:
    p = priced(s.rates, on, q.pax_min, q.pax_max)
    # "Entrance" three times says nothing: the supplier's name goes first ("Garni Temple: Entrance").
    vendor = s.vendor.name if s.vendor else ""
    name = s.name if not vendor or vendor.lower() in s.name.lower() else f"{vendor}: {s.name}"
    _warn(p, f"Day {day_number} · {name}", on, warnings)
    fixed = slot.get("quantity")
    if fixed is not None:
        basis, who, qty = "group", "persons", str(Decimal(str(fixed)).normalize())
    elif s.unit == "person":
        basis, who, qty = "per_person", "everyone" if s.category == "meal" else "persons", "1"
    else:
        basis, who, qty = "group", "persons", "1"
        if s.unit not in ("group", "day", "vehicle_day"):
            warnings.append(f"Day {day_number} · {s.name}: counted as 1 — set how many")
    return QuoteItemIn(category=s.category, name=name[:200], vendor_id=s.vendor_id, service_id=s.id,
                       currency=p.currency or q.currency, unit_price=p.unit_price, quantity=qty, basis=basis,
                       who=who, tiers=p.tiers, day=day_number, notes=slot.get("notes") or "")


@dataclass
class Built:
    nights: list[QuoteNightIn]
    items: list[QuoteItemIn]
    warnings: list[str]
    staff: list[QuoteItemIn] = field(default_factory=list)   # the route's guides (also in items)


def _staff_stay(d, hotel: Vendor, vendors: dict[str, Vendor], on: date, cur: str, warnings: list[str]) -> dict:
    """The day's driver/guide stay as the calculation's night fields, priced like the tour's costs:
    the hotel's staff price when it has one, else its single (or double, to share)."""
    stay = getattr(d, "staff_stay", None) or "none"
    twin = bool(getattr(d, "staff_twin", False))
    out: dict = {"staff_stay": stay, "staff_twin": twin}
    where = hotel if stay == "same" else vendors.get(getattr(d, "staff_hotel_id", None) or "") or hotel
    if stay == "own" or (stay == "same" and catalog.service_by_code(hotel, "staff_room")):
        # A staff price (another hotel, or this one's staff rate): its own per-room price.
        code = "staff_room" if catalog.service_by_code(where, "staff_room") else ("room_DBL" if twin else "room_SGL")
        rate = catalog.price_for(where, code, on)
        out.update(staff_stay="own", staff_hotel=where.name)
        if rate is None or rate.currency != cur:
            warnings.append(f"Day {d.day_number} · {where.name}: no staff room price" + ("" if rate is None else f" in {cur}"))
        else:
            out["staff_price"] = rate.price
    return out


def load_route(db: Session, series: Series) -> tuple[dict[str, Vendor], dict[str, Service]]:
    vendor_ids = {x for d in series.days
                  for x in (d.hotel_id, d.breakfast_id, d.lunch_id, d.dinner_id, getattr(d, "staff_hotel_id", None)) if x}
    vendors = {v.id: v for v in db.scalars(
        select(Vendor).where(Vendor.id.in_(vendor_ids), Vendor.workspace_id == series.workspace_id)
        .options(selectinload(Vendor.services).selectinload(Service.rates)))} if vendor_ids else {}
    service_ids = {x["service_id"] for d in series.days for x in d.extras or []}
    services = {s.id: s for s in db.scalars(
        select(Service).join(Vendor).where(Service.id.in_(service_ids), Vendor.workspace_id == series.workspace_id)
        .options(selectinload(Service.rates), selectinload(Service.vendor)))} if service_ids else {}
    return vendors, services


def build(db: Session, series: Series, q: QuoteIn, on: date, meals: bool = True, extras: bool = True,
          pax: int | None = None) -> Built:
    """Nights, meal lines and day-service lines for a route travelling on `on`.
    Each day is priced on its own date (day n = on + n-1)."""
    vendors, services = load_route(db, series)
    warnings: list[str] = []
    nights, items = [], []
    meal_runs: dict[tuple, list[int]] = {}  # same restaurant, meal and price → one line counted per day
    unnamed: list[QuoteItemIn] = []          # meals we pay for whose restaurant isn't chosen yet: empty, to fill
    for d in series.days:
        day_on = on + timedelta(days=d.day_number - 1)
        if d.hotel_id and (v := vendors.get(d.hotel_id)):
            prices = _night_prices(v, day_on, pax)
            if "price_dbl" not in prices:
                warnings.append(f"Day {d.day_number} · {v.name}: no room price on {day_on.isoformat()}")
            cur = next(iter(prices.values()))[1] if prices else q.currency
            nights.append(QuoteNightIn(city=d.city, vendor_id=v.id, hotel_name=v.name, currency=cur,
                                       **{k: price for k, (price, c) in prices.items() if c == cur},
                                       **_staff_stay(d, v, vendors, day_on, cur, warnings)))
        if meals:
            for kind, vid, menu_id in (("breakfast", d.breakfast_id, d.breakfast_menu_id), ("lunch", d.lunch_id, d.lunch_menu_id),
                                       ("dinner", d.dinner_id, d.dinner_menu_id)):
                v = vendors.get(vid) if vid else None
                if (getattr(d, f"{kind}_mode", None) or "included") != "included":
                    continue      # tourists pay it themselves: not in our price
                if not v:
                    # Included, but no restaurant yet: the line is there, empty, so the price isn't silently short.
                    if kind != "breakfast":
                        where = f" · {d.city}" if d.city else ""
                        unnamed.append(QuoteItemIn(category="meal", name=f"{kind.capitalize()} · day {d.day_number}{where}"[:200],
                                                   currency=q.currency, unit_price=Decimal(0), basis="per_person", who="everyone",
                                                   day=d.day_number, notes="No restaurant chosen yet: fill the price"))
                    continue
                s = next((x for x in v.services if x.id == menu_id), None) or catalog.service_by_code(v, kind)
                p = priced(s.rates if s else [], day_on, q.pax_min, q.pax_max)
                key = (v.id, kind, s.id if s else None, p.unit_price, p.currency, tuple((t.max_pax, t.unit_price) for t in p.tiers))
                if key not in meal_runs:
                    _warn(p, f"{v.name} · {kind}", day_on, warnings)
                meal_runs.setdefault(key, []).append(d.day_number)
        if extras:
            for slot in d.extras or []:
                s = services.get(slot["service_id"])
                if s is None:
                    warnings.append(f"Day {d.day_number}: a service was removed from the price catalog")
                    continue
                items.append(_item_for_service(s, slot, d.day_number, day_on, q, warnings))
    meal_items = []
    for (vid, kind, sid, price, cur, tiers), days in meal_runs.items():
        v = vendors[vid]
        s = next((x for x in v.services if x.id == sid), None)
        label = (f"{kind.capitalize()}: {v.name}" + (f" · {s.name}" if s and s.code != kind else ""))[:200]
        meal_items.append(QuoteItemIn(
            category="meal", name=label, vendor_id=v.id, service_id=s.id if s else None,
            currency=cur or q.currency, unit_price=price, quantity=str(len(days)), basis="per_person", who="everyone",
            tiers=[QuoteTier(max_pax=m, unit_price=u) for m, u in tiers], day=days[0] if len(days) == 1 else None,
            notes="" if len(days) == 1 else f"days {', '.join(map(str, days))}"))
    staff = staff_items(db, series, q, on, warnings)
    if unnamed:
        warnings.append(f"{len(unnamed)} meals have no restaurant yet: they are in the calculation without a price")
    return Built(nights, sorted(meal_items + unnamed, key=lambda i: i.day or 0) + _merge_days(items) + staff, warnings, staff)


PLAN_PRICED = {"guide": "guide", "tour_leader": "guide", "assistant": "guide"}   # drivers come with the bus line


def staff_items(db: Session, series: Series, q: QuoteIn, on: date, warnings: list[str]) -> list[QuoteItemIn]:
    """The route's guides, each for their days at their own day price: "Guide: Nino · days 1–5"."""
    plan, seen = [], set()
    for x in series.staff_plan or []:
        # Alternatives (the same name on the price list, the same days) work one at a time: price the first.
        alt = ((x.get("label") or "").strip(), x.get("role"), x.get("from_day"), x.get("to_day"))
        if x.get("role") in PLAN_PRICED and not (alt[0] and alt in seen):
            plan.append(x)
            seen.add(alt)
    ids = {x["vendor_id"] for x in plan if x.get("vendor_id")}
    vendors = {v.id: v for v in db.scalars(
        select(Vendor).where(Vendor.id.in_(ids), Vendor.workspace_id == series.workspace_id)
        .options(selectinload(Vendor.services).selectinload(Service.rates)))} if ids else {}
    n = max(1, len(series.days))
    out = []
    for x in plan:
        a, b = x["from_day"], min(x.get("to_day") or n, n)
        if a > b:
            continue
        v = vendors.get(x.get("vendor_id") or "")
        word = (x.get("label") or x["role"].replace("_", " "))
        who = v.name if v else word
        s = catalog.service_by_code(v, "day") if v else None
        p = priced(s.rates if s else [], on + timedelta(days=a - 1), q.pax_min, q.pax_max)
        days = f"day {a}" if a == b else f"days {a}–{b}"
        if not p.unit_price and not p.tiers:
            warnings.append(f"{who} ({days}): no day price - " + ("add one in the catalog" if v else "choose the person or type the price"))
        name = f"{word[:1].upper()}{word[1:]}: {v.name} · {days}" if v else f"{word[:1].upper()}{word[1:]} · {days}"
        out.append(QuoteItemIn(category=PLAN_PRICED[x["role"]], name=name[:200],
                               vendor_id=v.id if v else None, service_id=s.id if s else None, currency=p.currency or q.currency,
                               unit_price=p.unit_price or 0, quantity=str(b - a + 1), basis="group", who="persons",
                               tiers=p.tiers, day=a if a == b else None))
    return out


def _merge_days(items: list[QuoteItemIn]) -> list[QuoteItemIn]:
    """The same service at the same price on several days is one line: "Bus × 9 days", not nine."""
    out: list[QuoteItemIn] = []
    seen: dict[tuple, int] = {}
    for i in items:
        key = (i.service_id, i.unit_price, i.currency, i.basis, i.who, tuple((t.max_pax, t.unit_price) for t in i.tiers), i.notes)
        if i.service_id is None or i.quantity != "1" or key not in seen:
            if i.service_id is not None and i.quantity == "1":
                seen[key] = len(out)
            out.append(i)
            continue
        first = out[seen[key]]
        n = int(first.quantity) + 1
        out[seen[key]] = first.model_copy(update={"quantity": str(n), "day": None,
                                                  "notes": f"days {', '.join(map(str, _days_of(first) + [i.day]))}"})
    return out


def _days_of(item: QuoteItemIn) -> list[int]:
    if item.day is not None:
        return [item.day]
    return [int(x) for x in item.notes.removeprefix("days ").split(", ") if x.strip().isdigit()]


# --- re-pricing an existing calculation for another date ---------------------------------

@dataclass
class PriceChange:
    kind: str            # "night" | "item"
    id: str
    name: str
    currency: str
    before: float | None
    after: float | None


@dataclass
class Repriced:
    doc: QuoteIn
    changes: list[PriceChange]
    warnings: list[str]
    unlinked: int        # lines not from the catalog, left as they are


def reprice(db: Session, workspace_id: str, doc: QuoteIn, on: date) -> Repriced:
    """Take every price that came from the catalog again, for travel starting on `on`.
    Night i is priced on on+i; a line on day n on on+n-1, other lines on `on`."""
    doc = doc.model_copy(deep=True)
    vendor_ids = {n.vendor_id for n in doc.nights if n.vendor_id}
    vendors = {v.id: v for v in db.scalars(
        select(Vendor).where(Vendor.id.in_(vendor_ids), Vendor.workspace_id == workspace_id)
        .options(selectinload(Vendor.services).selectinload(Service.rates)))} if vendor_ids else {}
    service_ids = {i.service_id for i in doc.items if i.service_id}
    services = {s.id: s for s in db.scalars(
        select(Service).join(Vendor).where(Service.id.in_(service_ids), Vendor.workspace_id == workspace_id)
        .options(selectinload(Service.rates)))} if service_ids else {}
    changes: list[PriceChange] = []
    warnings: list[str] = []
    unlinked = 0

    for i, n in enumerate(doc.nights):
        v = vendors.get(n.vendor_id) if n.vendor_id else None
        if not v:
            unlinked += 1
            continue
        night_on = on + timedelta(days=i)
        prices = _night_prices(v, night_on)
        if "price_dbl" not in prices:
            warnings.append(f"Night {i + 1} · {v.name}: no room price on {night_on.isoformat()} (kept)")
            continue
        before = n.price_dbl
        cur = prices["price_dbl"][1]
        n.currency = cur
        for k in ROOM_CODES:
            if k in prices and prices[k][1] == cur:
                setattr(n, k, prices[k][0])
        if before != n.price_dbl:
            changes.append(PriceChange("night", n.id, f"{i + 1}. {n.hotel_name or v.name}", cur,
                                       float(before) if before is not None else None, float(n.price_dbl)))

    for item in doc.items:
        s = services.get(item.service_id) if item.service_id else None
        if not s:
            unlinked += 1
            if item.service_id:
                warnings.append(f"{item.name}: its service was removed from the price catalog (kept)")
            continue
        item_on = on + timedelta(days=item.day - 1) if item.day else on
        p = priced(s.rates, item_on, doc.pax_min, doc.pax_max)
        if p.currency is None:
            warnings.append(f"{item.name}: no price on {item_on.isoformat()} (kept)")
            continue
        _warn(p, item.name, item_on, warnings)
        before, before_tiers = item.unit_price, [(t.max_pax, t.unit_price) for t in item.tiers]
        item.unit_price, item.currency = p.unit_price, p.currency
        # Keep tier quantities/labels the user set; replace the catalog's price bands.
        if p.tiers or any(t.unit_price is not None for t in item.tiers):
            item.tiers = p.tiers
        if before != item.unit_price or before_tiers != [(t.max_pax, t.unit_price) for t in item.tiers]:
            changes.append(PriceChange("item", item.id, item.name, p.currency, float(before), float(item.unit_price)))

    return Repriced(doc, changes, warnings, unlinked)
