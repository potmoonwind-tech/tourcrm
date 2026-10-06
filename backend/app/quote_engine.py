"""The tour price calculation. Pure functions over QuoteIn: no database, so the
editor can preview unsaved changes and tests can pin it to the agencies' sheets.

Every agency describes its own trip in three parts:

  people   types of person: who pays (adults, children…), who travels free (the 19+1
           leader), who works (driver, guide). One paying type is "the group": its number
           is the group size the price list runs over.
  costs    lines (per person, per group, per vehicle) and hotel nights. A per-person line
           says how each type uses it (full, half, its own price, not at all).
  recipe   steps from cost to selling price: profit, markup, commission, VAT, rounding…

For each paying type:

  own cost       = its per-person lines + its hotel bed
  shared cost    = (group lines + vehicles + everything the free people and staff cost)
                   × its weight / Σ(paying people × weight)
  price          = the recipe applied to own + shared

Older calculations have no people or recipe: they are read as tourists + free leaders +
staff, and "best of group profit / minimum per person / margin floor, then rounding" -
exactly the agencies' spreadsheets, which the tests pin.

All arithmetic is Decimal; floats appear only in the returned display models.
"""
import math
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal

from .formula import names as formula_names, FormulaError, evaluate
from .quote_schemas import (
    Breakdown, ExtraPrice, FormulaCheck, OtherCurrency, SeasonResult, Vehicle, FormulaName, FormulaValue, ItemCalc, PersonCost, PriceStep, PriceSteps, QuoteIn,
    QuoteItemIn, QuoteResult, QuoteTier, RecipeLine, TierRow, TypePrice,
)

ZERO = Decimal(0)
ONE = Decimal(1)
CENT = Decimal("0.01")
# Which roles a line's `who` counts.
WHO_ROLES = {"tourists": {"pay"}, "persons": {"pay", "free"}, "everyone": {"pay", "free", "staff"},
             "staff": {"staff"}, "crew": {"free", "staff"}}


# --- people ---------------------------------------------------------------------------------

@dataclass
class Person:
    """One type of person, resolved for a group size."""
    id: str
    name: str
    role: str
    count: int
    room: str
    weight: Decimal = ONE
    group: bool = False      # the type whose number is the group size


def people_for(q: QuoteIn, n: int) -> list[Person]:
    if q.people:
        out = []
        for p in q.people:
            count = n if p.count is None else p.count
            if p.per:
                count = max(count, n // p.per)
            out.append(Person(p.id, p.name, p.role, count, p.room, p.weight, p.count is None))
        return out
    leader_room = {"single": "sgl", "shared": "dbl", "free": "free"}[q.leader_kind()]
    return [Person("tourists", "Tourists", "pay", n, "dbl", ONE, True),
            Person("leaders", "Tour leader", "free", q.leaders_for(n), leader_room),
            Person("staff", "Staff", "staff", q.staff, "staff")]


def _count(people: list[Person], roles: set[str]) -> int:
    return sum(p.count for p in people if p.role in roles)


def variables(q: QuoteIn, tourists: int) -> dict[str, Decimal]:
    ps = people_for(q, tourists)
    pay, free, staff = _count(ps, {"pay"}), _count(ps, {"free"}), _count(ps, {"staff"})
    return {
        **q.variables,
        "days": Decimal(q.days), "nights": Decimal(sum(1 for n in q.nights if n.price_dbl is not None)),
        "tourists": Decimal(pay), "leaders": Decimal(free), "staff": Decimal(staff),
        "persons": Decimal(pay + free), "everyone": Decimal(pay + free + staff), "crew": Decimal(free + staff),
        "group": Decimal(tourists),
    }


def to_quote_currency(q: QuoteIn, amount: Decimal, currency: str) -> Decimal | None:
    if currency == q.currency:
        return amount
    rate = q.fx.get(currency)
    return None if rate is None else amount / rate


def tier_for(item: QuoteItemIn, tourists: int) -> QuoteTier | None:
    """The first tier whose max_pax covers the group; the largest tier beyond that."""
    tiers = sorted(item.tiers, key=lambda t: t.max_pax)
    return next((t for t in tiers if tourists <= t.max_pax), tiers[-1] if tiers else None)


# --- lines ----------------------------------------------------------------------------------

@dataclass
class Line:
    quantity: Decimal | None
    unit_price: Decimal
    multiplier: Decimal | None
    amount: Decimal          # whole group, quote currency; 0 when excluded or broken
    error: str | None
    # Per-person lines: the amount each type of person takes (quote currency). Group and
    # vehicle lines are shared by the payers instead.
    split: dict[str, Decimal] = field(default_factory=dict)
    # Lines left out of the price: what they would cost (optional extras are priced from it).
    would: Decimal = ZERO
    would_split: dict[str, Decimal] = field(default_factory=dict)


def line(q: QuoteIn, item: QuoteItemIn, tourists: int, v: dict[str, Decimal]) -> Line:
    tier = tier_for(item, tourists)
    price = tier.unit_price if tier and tier.unit_price is not None else item.unit_price
    try:
        if item.price_formula.strip() and not (tier and tier.unit_price is not None):
            price = evaluate(item.price_formula, v)
        qty = evaluate(tier.quantity if tier and tier.quantity else item.quantity, v)
    except FormulaError as e:
        return Line(None, price, None, ZERO, str(e))
    rate = to_quote_currency(q, ONE, item.currency)
    if rate is None:
        return Line(qty, price, None, ZERO, f"no exchange rate for {item.currency}")
    # Tickets: taxes and fees on top of every fare (a child's fare too), not halved with it.
    tax = item.travel.taxes if item.travel else ZERO
    split: dict[str, Decimal] = {}
    if item.basis == "per_person":
        roles = WHO_ROLES[item.who]
        mult = ZERO
        for p in people_for(q, tourists):
            use = item.uses.get(p.id)
            if use is None:
                each, people = (price + tax, p.count) if p.role in roles else (ZERO, 0)
            elif use.mode == "none":
                each, people = ZERO, 0
            else:
                each = tax + {"full": price, "half": price / 2, "own": use.price if use.price is not None else price}[use.mode]
                people = p.count
            if people:
                split[p.id] = each * qty * people * rate
                mult += people
        amount = sum(split.values(), ZERO)
    else:
        if item.basis == "group":
            mult = ONE
        else:  # per_vehicle: enough vehicles for everyone counted plus extra seats (e.g. the guide)
            mult = Decimal(math.ceil((v[item.who] + item.extra) / item.capacity))
        amount = (price + tax) * qty * mult * rate
    if not item.included:
        return Line(qty, price + tax, mult, ZERO, None, {}, amount, split)
    return Line(qty, price + tax, mult, amount, None, split)


# --- hotels ---------------------------------------------------------------------------------

def staff_rooms(q: QuoteIn, night, count: int | None = None) -> int:
    count = q.staff if count is None else count
    return math.ceil(count / 2) if night.staff_twin else count


def staff_night(q: QuoteIn, night, dbl: Decimal, sgl: Decimal, count: int | None = None) -> tuple[Decimal, str | None]:
    """Driver/guide rooms of one night, for the group, in the quote currency."""
    rooms = staff_rooms(q, night, count)
    if night.staff_stay in ("none", "free") or not rooms:
        return ZERO, None
    if night.staff_stay == "allowance":   # per person, not per room: they find their own hotel
        if night.staff_price is None:
            return ZERO, "staff allowance missing"
        each = to_quote_currency(q, night.staff_price, night.staff_currency or night.currency)
        return (each or ZERO) * (q.staff if count is None else count), None
    if night.staff_stay == "same":
        return (dbl if night.staff_twin else sgl) * rooms, None
    if night.staff_price is None:
        return ZERO, "staff hotel price missing"
    each = to_quote_currency(q, night.staff_price, night.staff_currency or night.currency)
    return (each or ZERO) * rooms, None


@dataclass
class Hotels:
    dbl_pp: Decimal          # Σ DBL room / 2: the group's bed
    sgl: Decimal             # Σ SGL room
    trp_pp: Decimal | None   # Σ TRP room / 3, only if every priced night has one
    rows: list[dict]
    errors: list[str]
    staff: Decimal = ZERO    # Σ staff-type rooms, for the group
    by_type: dict[str, Decimal] = field(default_factory=dict)   # other types' beds, total per type
    quad_pp: Decimal | None = None   # Σ QUAD room / 4, only if every priced night has one


def hotels(q: QuoteIn, n: int | None = None) -> Hotels:
    people = people_for(q, q.pax_min if n is None else n)
    dbl = sgl = trp = staff = ZERO
    by_type: dict[str, Decimal] = {}
    all_trp, rows, errors = True, [], []
    for i, night in enumerate(q.nights, 1):
        if night.price_dbl is None:
            continue  # unpriced night: not counted (as in the agencies' sheets)
        d = to_quote_currency(q, night.price_dbl, night.currency)
        if d is None:
            errors.append(f"night {i}: no exchange rate for {night.currency}")
            continue
        s = to_quote_currency(q, night.price_sgl if night.price_sgl is not None else night.price_dbl, night.currency)
        t3 = to_quote_currency(q, night.price_trp, night.currency) / 3 if night.price_trp is not None else None
        dbl += d / 2
        sgl += s
        if t3 is None:
            all_trp = False
        else:
            trp += t3
        night_staff = ZERO
        for p in people:
            if p.group or not p.count:
                continue
            if p.room == "staff":
                cost, err = staff_night(q, night, d, s, p.count)
                if err:
                    errors.append(f"night {i}: {err}")
                staff += cost
                night_staff += cost
            else:
                bed = {"dbl": d / 2, "sgl": s, "trp": t3 if t3 is not None else d / 2, "free": ZERO, "none": ZERO}[p.room]
                by_type[p.id] = by_type.get(p.id, ZERO) + bed * p.count
        rows.append({"night": i, "city": night.city, "hotel": night.hotel_name, "dbl_pp": float(d / 2), "sgl": float(s),
                     "staff": float(night_staff), "staff_stay": night.staff_stay})
    quads = [to_quote_currency(q, n.price_quad, n.currency) if n.price_quad is not None else None
             for n in q.nights if n.price_dbl is not None]
    quad = sum(quads, ZERO) / 4 if rows and all(x is not None for x in quads) else None
    return Hotels(dbl, sgl, trp if all_trp and rows else None, rows, errors, staff, by_type, quad)


# --- recipe ---------------------------------------------------------------------------------

def legacy_recipe(q: QuoteIn) -> list[PriceStep]:
    """Older calculations: the best of three profits, then rounding."""
    return [PriceStep(id="profit", kind="profit", group=q.profit_group, min_pp=q.profit_min_pp, value=q.margin_floor_pct),
            PriceStep(id="round", kind="round", value=q.rounding_step, mode=q.rounding_mode)]


def recipe_of(q: QuoteIn) -> list[PriceStep]:
    return q.recipe or legacy_recipe(q)


def _round_to(x: Decimal, step: Decimal, mode: str) -> Decimal:
    if not step:
        return x.quantize(CENT, ROUND_HALF_UP)
    m = {"floor": ROUND_FLOOR, "ceil": ROUND_CEILING, "nearest": ROUND_HALF_UP}[mode]
    return (x / step).quantize(Decimal(1), m) * step


STEP_LABEL = {"profit": "Profit", "markup": "Markup", "add_pp": "Per person", "add_group": "Per group",
              "commission": "Commission", "vat_margin": "VAT on margin", "vat": "VAT", "discount": "Discount",
              "relative": "Share of another price", "round": "Rounding", "formula": "Formula"}


@dataclass
class Priced:
    price: Decimal
    lines: list[RecipeLine]
    profit_parts: dict[str, Decimal] | None = None   # the first profit step: group / minimum / floor
    profit_rule: str = "group"
    added: Decimal = ZERO    # what the steps other than rounding added


def apply_recipe(q: QuoteIn, steps: list[PriceStep], cost: Decimal, base: Decimal, who: str, n: int, payers: int,
                 prices: dict[str, Decimal], v: dict[str, Decimal], only_rounding: bool = False,
                 cats: dict[str, Decimal] | None = None) -> Priced:
    """Run the recipe for one type of person. `base` is the cost a profit floor is a share of
    (the group's DBL cost for its room variants). `prices`: types already priced (for "relative")."""
    x = cost
    added = ZERO
    out: list[RecipeLine] = []
    parts, rule = None, "group"
    for s in steps:
        if not s.on or (s.only and who not in s.only):
            continue
        if (s.min_pax and n < s.min_pax) or (s.max_pax and n > s.max_pax):
            continue
        if only_rounding and s.kind != "round":
            continue
        before = x
        if s.kind == "profit":
            p = {"group": s.group / payers if payers else ZERO, "minimum": s.min_pp, "floor": base * s.value / 100}
            r = max(p, key=p.get)
            if parts is None:
                parts, rule = p, r
            x = x + p[r]
        elif s.kind == "markup":
            if s.cats:   # 10% on hotels, 25% on excursions…: on those costs only
                x = x + sum(((cats or {}).get(c, ZERO) for c in s.cats), ZERO) * s.value / 100
            else:
                x = x * (1 + s.value / 100)
        elif s.kind == "add_pp":
            x = x + s.value
        elif s.kind == "add_group":
            x = x + (s.value / payers if payers else ZERO)
        elif s.kind == "commission":
            x = x / (1 - s.value / 100) if s.value < 100 else x
        elif s.kind == "vat_margin":
            x = x + max(x - cost, ZERO) * s.value / 100
        elif s.kind == "vat":
            x = x * (1 + s.value / 100)
        elif s.kind == "discount":
            x = x * (1 - s.value / 100)
        elif s.kind == "relative":
            if s.ref in prices and s.ref != who:   # never a share of their own price (their room variants)
                x = prices[s.ref] * s.value / 100
        elif s.kind == "round":
            x = _round_to(x, s.value, s.mode)
        elif s.kind == "formula" and s.formula:
            x = evaluate(s.formula, {**v, "cost": cost, "price": x, "profit": x - cost})
        if s.kind != "round":
            added += x - before
        out.append(RecipeLine(label=s.label or STEP_LABEL[s.kind], kind=s.kind, amount=x - before, price=x))
    return Priced(x.quantize(CENT, ROUND_HALF_UP), out, parts, rule, added)


# --- one group size -------------------------------------------------------------------------

@dataclass
class Tier:
    row: TierRow
    steps: PriceSteps
    people: list[PersonCost]


def _tier(q: QuoteIn, n: int, h: Hotels, lines: list[Line]) -> Tier:
    people = people_for(q, n)
    v = variables(q, n)
    main = next(p for p in people if p.group)
    payers = [p for p in people if p.role == "pay" and p.count]
    paying = sum(p.count for p in payers)
    weights = sum((p.weight * p.count for p in payers), ZERO) or ONE

    # Shared: group/vehicle lines, and everything free people and staff take. Kept by kind of cost
    # (hotel, meal, transport…), so a recipe can mark some kinds up more than others.
    lines_total = sum((ln.amount for ln in lines), ZERO)
    own: dict[str, dict[str, Decimal]] = {p.id: {} for p in people}
    pot: dict[str, Decimal] = {}

    def put(d: dict[str, Decimal], cat: str, amt: Decimal):
        d[cat] = d.get(cat, ZERO) + amt

    for item, ln in zip(q.items, lines):
        if ln.split:
            for pid, amt in ln.split.items():
                put(own.setdefault(pid, {}), item.kind or item.category, amt)
        else:
            put(pot, item.kind or item.category, ln.amount)
    for p in people:
        if p.role != "pay":
            for cat, amt in own.get(p.id, {}).items():
                put(pot, cat, amt)
    free_rooms = sum((h.by_type.get(p.id, ZERO) for p in people if p.role == "free"), ZERO)
    put(pot, "hotel", free_rooms + h.staff)
    pay_rooms = {p.id: h.by_type.get(p.id, ZERO) for p in payers if not p.group}

    def cats_of(p: Person, bed: Decimal) -> dict[str, Decimal]:
        """One person's cost by kind: their own, their share of the shared, and their bed."""
        out = {cat: amt / p.count for cat, amt in own.get(p.id, {}).items()} if p.count else {}
        for cat, amt in pot.items():
            out[cat] = out.get(cat, ZERO) + amt * p.weight / weights
        out["hotel"] = out.get("hotel", ZERO) + bed
        return out

    def shared_pp(p: Person) -> Decimal:
        return sum(pot.values(), ZERO) * p.weight / weights

    main_own = sum(own.get(main.id, {}).values(), ZERO) / main.count if main.count else ZERO
    shared_main = shared_pp(main)
    cats_dbl, cats_sgl = cats_of(main, h.dbl_pp), cats_of(main, h.sgl)
    cats_trp = cats_of(main, h.trp_pp) if h.trp_pp is not None else None
    cats_quad = cats_of(main, h.quad_pp) if h.quad_pp is not None else None
    cost_dbl = sum(cats_dbl.values(), ZERO)
    cost_sgl = sum(cats_sgl.values(), ZERO)
    cost_trp = sum(cats_trp.values(), ZERO) if cats_trp is not None else None

    steps = recipe_of(q)
    priced: dict[str, Decimal] = {}
    dbl = apply_recipe(q, steps, cost_dbl, cost_dbl, main.id, n, paying, priced, v, cats=cats_dbl)
    priced[main.id] = dbl.price
    added = dbl.price - cost_dbl
    profit = dbl.profit_parts[dbl.profit_rule] if dbl.profit_parts else added
    if q.recipe:
        sgl = apply_recipe(q, steps, cost_sgl, cost_dbl, main.id, n, paying, priced, v, only_rounding=not q.single_profit, cats=cats_sgl).price
        trp = apply_recipe(q, steps, cost_trp, cost_dbl, main.id, n, paying, priced, v, cats=cats_trp).price if cost_trp is not None else None
        quad = apply_recipe(q, steps, sum(cats_quad.values(), ZERO), cost_dbl, main.id, n, paying, priced, v, cats=cats_quad).price if cats_quad else None
        unrounded_dbl = cost_dbl + dbl.added
        unrounded_sgl = cost_sgl + (unrounded_dbl - cost_dbl if q.single_profit else ZERO)
    else:
        # The spreadsheets: the room variants carry the DBL profit, then the same rounding.
        rnd = lambda x: _round_to(x, q.rounding_step, q.rounding_mode)  # noqa: E731
        unrounded_dbl = cost_dbl + profit
        unrounded_sgl = cost_sgl + (profit if q.single_profit else ZERO)
        sgl = rnd(unrounded_sgl)
        trp = rnd(cost_trp + profit) if cost_trp is not None else None
        quad = rnd(sum(cats_quad.values(), ZERO) + profit) if cats_quad else None

    types = [TypePrice(id=main.id, name=main.name, count=main.count, cost=cost_dbl, price=dbl.price)]
    person_costs = [PersonCost(id=main.id, name=main.name, role="pay", count=main.count,
                               own=main_own + h.dbl_pp, shared=shared_main, for_others=0)]
    revenue = dbl.price * main.count
    # Optional extras: what one person of the group would pay, priced with the recipe's markups.
    extra_steps = [PriceStep(kind="markup", value=q.extra_markup)] if q.extra_markup else []
    extra_steps += [s for s in steps if s.kind in ("markup", "commission", "vat_margin", "vat", "discount", "round")]
    extras = []
    for item, ln in zip(q.items, lines):
        if item.optional and not item.included and ln.error is None:
            each = (ln.would_split.get(main.id, ZERO) / main.count if ln.would_split else ln.would / paying) if main.count and paying else ZERO
            pr = apply_recipe(q, extra_steps, each, each, main.id, n, paying, {}, v, cats={item.kind or item.category: each})
            extras.append(ExtraPrice(id=item.id, name=item.name, cost=each, price=pr.price))
    for p in payers:
        if p.group:
            continue
        p_cats = cats_of(p, pay_rooms.get(p.id, ZERO) / p.count)
        cost = sum(p_cats.values(), ZERO)
        p_own = cost - shared_pp(p)
        pr = apply_recipe(q, steps, cost, cost, p.id, n, paying, priced, v, cats=p_cats)
        priced[p.id] = pr.price
        revenue += pr.price * p.count
        types.append(TypePrice(id=p.id, name=p.name, count=p.count, cost=cost, price=pr.price))
        person_costs.append(PersonCost(id=p.id, name=p.name, role="pay", count=p.count, own=p_own, shared=shared_pp(p), for_others=0))
    for p in people:
        if p.role != "pay" and p.count:
            took = sum(own.get(p.id, {}).values(), ZERO) + h.by_type.get(p.id, ZERO) + (h.staff if p.room == "staff" else ZERO)
            person_costs.append(PersonCost(id=p.id, name=p.name, role=p.role, count=p.count, own=0, shared=0, for_others=took))

    leaders = _count(people, {"free"})
    parts = dbl.profit_parts or {"group": ZERO, "minimum": ZERO, "floor": ZERO}
    row = TierRow(
        tourists=n, leaders=leaders, label=f"{n}+{leaders}" if leaders else str(n),
        cost_dbl=cost_dbl, cost_sgl=cost_sgl, cost_trp=cost_trp, profit_pp=unrounded_dbl - cost_dbl,
        price_dbl=dbl.price, price_sgl=sgl, price_trp=trp, single_supplement=sgl - dbl.price,
        group_cost=lines_total + free_rooms + h.staff + h.dbl_pp * main.count + sum(pay_rooms.values(), ZERO),
        group_revenue=revenue, vehicle=_vehicle(q, n), types=types, extras=extras, price_quad=quad,
    )
    steps_out = PriceSteps(
        lines_total=lines_total, leader_room=free_rooms, staff_room=h.staff, shared_pp=cost_dbl - h.dbl_pp,
        hotel_dbl_pp=h.dbl_pp, hotel_sgl_pp=h.sgl,
        profit_group_pp=parts["group"], profit_min_pp=parts["minimum"], profit_floor_pp=parts["floor"], profit_rule=dbl.profit_rule,
        unrounded_dbl=unrounded_dbl, unrounded_sgl=unrounded_sgl,
        rounding_mode=q.rounding_mode, rounding_step=q.rounding_step, single_profit=q.single_profit, recipe=dbl.lines,
    )
    return Tier(row, steps_out, person_costs)


def _vehicle(q: QuoteIn, tourists: int) -> str:
    # The transport plan's choice names the vehicles when there is one; else the line marked as the vehicle.
    lines = sorted(q.items, key=lambda i: not i.id.startswith("transport:"))
    for item in lines:
        if item.vehicle and item.included:
            t = tier_for(item, tourists)
            return t.label if t and t.label else item.name
    return ""


def _check(q: QuoteIn) -> list[str]:
    errors = list(hotels(q).errors)
    # Check every line once; a broken line stops the price table rather than silently pricing without it.
    v0 = variables(q, q.pax_min)
    for item, ln in zip(q.items, lines_for(following(q), q.pax_min, v0)):
        if ln.error:
            errors.append(f"{item.name}: {ln.error}")
    for s in q.recipe:
        if s.on and s.kind == "formula":
            try:
                evaluate(s.formula, {**v0, "cost": ONE, "price": ONE, "profit": ZERO})
            except FormulaError as e:
                errors.append(f"{s.label or 'Formula'}: {e}")
        if s.on and s.kind == "relative" and s.ref not in {p.id for p in people_for(q, q.pax_min)}:
            errors.append(f"{s.label or STEP_LABEL['relative']}: choose whose price it is a share of")
    return errors


def tier_at(q: QuoteIn, n: int) -> Tier:
    q = following(q)
    return _tier(q, n, hotels(q, n), lines_for(q, n))


# --- lines that depend on others ------------------------------------------------------------------
# "Comes with": a line follows another (the dance show with the KTW dinner) - in the price only when
# that one is. Cost totals: a formula may use what the other lines and the hotels cost the group
# (cost_total, cost_hotel, cost_meal, cost_<own kind>…): those lines are priced after the others.

def following(q: QuoteIn) -> QuoteIn:
    """The calculation with every line that follows a line left out of the price left out too."""
    by_id = {i.id: i for i in q.items}

    def on(item, depth=0) -> bool:
        if not item.included:
            return False
        lead = by_id.get(item.with_line) if item.with_line and item.with_line != item.id else None
        return lead is None or depth > 8 or on(lead, depth + 1)

    off = {i.id for i in q.items if i.included and i.with_line and not on(i)}
    if not off:
        return q
    return q.model_copy(update={"items": [i.model_copy(update={"included": False}) if i.id in off else i for i in q.items]})


def _uses_costs(item: QuoteItemIn) -> bool:
    exprs = [item.quantity, item.price_formula, *(t.quantity for t in item.tiers if t.quantity)]
    return any(n.startswith("cost_") for e in exprs if e for n in formula_names(e))


def cost_vars(q: QuoteIn, n: int, lines: list["Line | None"], h: "Hotels | None" = None) -> dict[str, Decimal]:
    """What the group's costs are so far, by kind and in all, in the quote currency."""
    h = h or hotels(q, n)
    main = next(p for p in people_for(q, n) if p.group)
    bed = {"sgl": h.sgl, "trp": h.trp_pp or h.dbl_pp}.get(main.room, h.dbl_pp if main.room in ("dbl", "staff") else ZERO)
    out: dict[str, Decimal] = {"cost_hotel": bed * main.count + sum(h.by_type.values(), ZERO) + h.staff}
    for item, ln in zip(q.items, lines):
        if ln is not None:
            k = f"cost_{item.kind or item.category}"
            out[k] = out.get(k, ZERO) + ln.amount
    for k in ("meal", "transport", "guide", "ticket", "activity", "tips", "border", "other"):
        out.setdefault(f"cost_{k}", ZERO)
    out["cost_total"] = sum(out.values(), ZERO)
    return out


def lines_for(q: QuoteIn, n: int, v: dict[str, Decimal] | None = None) -> list[Line]:
    """Every line at group size n: the others first, then the ones that use cost totals."""
    v = v if v is not None else variables(q, n)
    out: list[Line | None] = [None if _uses_costs(it) else line(q, it, n, v) for it in q.items]
    later = [i for i, ln in enumerate(out) if ln is None]
    if later:
        vc = {**v, **cost_vars(q, n, out)}
        for i in later:
            out[i] = line(q, q.items[i], n, vc)
    return out  # type: ignore[return-value]


# --- transport: vehicles, rent per day and fuel by distance -----------------------------------------

def vehicles_for(q: QuoteIn, n: int) -> list[tuple["Vehicle", int]]:
    """Which vehicles a group of n takes: the fixed choice, or automatically the first vehicle meant for
    this group size (max_pax), else the smallest one with enough seats, else enough of the biggest."""
    tp = q.transport
    by_id = {v.id: v for v in tp.vehicles}
    if tp.mode == "fixed":
        return [(by_id[c.vehicle_id], c.count) for c in tp.fixed if c.vehicle_id in by_id]
    if not tp.vehicles:
        return []
    need = int(variables(q, n)["persons"]) + tp.extra_seats
    ranged = sorted((v for v in tp.vehicles if v.max_pax), key=lambda v: v.max_pax)
    pick = next((v for v in ranged if n <= v.max_pax), None)
    if pick:
        return [(pick, max(1, math.ceil(need / pick.seats)))]
    fits = sorted((v for v in tp.vehicles if v.seats >= need), key=lambda v: (v.seats, v.day_price))
    if fits:
        return [(fits[0], 1)]
    big = max(tp.vehicles, key=lambda v: v.seats)
    return [(big, math.ceil(need / big.seats))]


def _choice_text(choice) -> str:
    return " + ".join(f"{c} × {v.name}" if c > 1 else v.name for v, c in choice)


def with_transport(q: QuoteIn) -> QuoteIn:
    """The transport plan as ordinary lines (rent per vehicle, fuel per vehicle), priced per group
    size, so everything downstream - prices, budgets, scenarios - treats them like any line."""
    tp = q.transport
    if tp is None or (not tp.vehicles and not tp.fixed):
        return q
    days = (tp.days if tp.days is not None else Decimal(q.days)) + tp.extra_days
    km = (tp.km + tp.extra_km) / 100
    sizes = range(q.pax_min, q.pax_max + 1)
    choices = {n: vehicles_for(q, n) for n in sizes}
    out = q.model_copy(deep=True)
    out.transport = None
    # One rent line and one fuel line per vehicle kind; group sizes that don't use it count 0.
    kinds: dict[str, "Vehicle"] = {}
    for ch in choices.values():
        for v, _ in ch:
            kinds.setdefault(v.id, v)
    for v in kinds.values():
        def count(n, vid=v.id):
            return next((c for x, c in choices[n] if x.id == vid), 0)
        rent_tiers, fuel_tiers = [], []
        for n in sizes:   # a tier per run of sizes with the same count (and the same vehicles, for the label)
            label = _choice_text(choices[n])
            c = count(n)
            if rent_tiers and rent_tiers[-1]["_key"] == (c, label):
                rent_tiers[-1]["max_pax"] = n
                fuel_tiers[-1]["max_pax"] = n
                continue
            rent_tiers.append({"_key": (c, label), "max_pax": n, "quantity": str(c * days), "label": label})
            litres = c * km * (v.fuel_l_100km or 0)
            fuel_tiers.append({"_key": (c, label), "max_pax": n, "quantity": str(litres), "label": label})
        for t in rent_tiers + fuel_tiers:
            t.pop("_key")
        out.items.append(QuoteItemIn(
            id=f"transport:{v.id}", category="transport", name=f"{v.name} · {days.normalize():f} days", vendor_id=v.vendor_id,
            currency=v.currency, unit_price=v.day_price, quantity="0", basis="group", tiers=rent_tiers, vehicle=True,
            notes="transport"))
        if v.fuel_l_100km and tp.fuel_price is not None and (tp.km or tp.extra_km):
            out.items.append(QuoteItemIn(
                id=f"fuel:{v.id}", category="transport", name=f"Fuel · {v.name} · {(tp.km + tp.extra_km).normalize():f} km",
                currency=tp.fuel_currency or q.currency, unit_price=tp.fuel_price, quantity="0", basis="group",
                tiers=fuel_tiers, notes=f"fuel {v.fuel_l_100km.normalize():f} L/100 km" + (f" · price of {tp.fuel_date.isoformat()}" if tp.fuel_date else "")))
    return out


def in_season(q: QuoteIn, season_id: str) -> QuoteIn:
    """The calculation with one season's prices: the night and line prices it overrides."""
    s = q.model_copy(deep=True)
    s.seasons = []
    for night in s.nights:
        over = night.season_prices.get(season_id)
        if over:
            for k in ("price_dbl", "price_sgl", "price_trp", "price_quad"):
                if getattr(over, k) is not None:
                    setattr(night, k, getattr(over, k))
    for item in s.items:
        if season_id in item.season_prices:
            item.unit_price = item.season_prices[season_id]
            for tier in item.tiers:   # one season price for every group size
                tier.unit_price = None
    return s


def season_on(q: QuoteIn, on) -> QuoteIn:
    """The calculation as priced for a departure on `on`: its season's prices when a season's
    dates contain that day, else the base prices."""
    for s in q.seasons:
        if (s.from_date is None or s.from_date <= on) and (s.to_date is None or on <= s.to_date) and (s.from_date or s.to_date):
            return in_season(q, s.id)
    return q


def _in_currencies(q: QuoteIn, row: TierRow) -> list[OtherCurrency]:
    out = []
    for c in q.sell_in:
        rate = c.rate or q.fx.get(c.currency)
        if not rate or c.currency == q.currency:
            continue
        conv = lambda x: _round_to(Decimal(str(x)) * rate, c.step, c.mode) if x is not None else None  # noqa: E731
        out.append(OtherCurrency(currency=c.currency, price_dbl=conv(row.price_dbl), price_sgl=conv(row.price_sgl),
                                 price_trp=conv(row.price_trp), price_quad=conv(row.price_quad)))
    return out


def _tiers(q: QuoteIn) -> list[TierRow]:
    rows = [tier_at(q, n).row for n in range(q.pax_min, q.pax_max + 1)]
    if q.sell_in:
        for r in rows:
            r.other = _in_currencies(q, r)
    return rows


def price_range(q: QuoteIn) -> tuple[Decimal, Decimal] | None:
    """The DBL price for the biggest and the smallest group - for lists (two sizes, not the table)."""
    q = with_transport(q)
    if _check(q):
        return None
    return tier_at(q, q.pax_max).row.price_dbl, tier_at(q, q.pax_min).row.price_dbl


def compute(q: QuoteIn) -> QuoteResult:
    q = with_transport(q)
    errors = _check(q)
    for c in q.sell_in:
        if c.currency != q.currency and not (c.rate or q.fx.get(c.currency)):
            errors.append(f"selling in {c.currency}: no exchange rate")
    tiers = _tiers(q) if not errors else []
    seasons = [SeasonResult(id=s.id, name=s.name, from_date=s.from_date, to_date=s.to_date, tiers=_tiers(in_season(q, s.id)))
               for s in q.seasons] if not errors else []
    h = hotels(q)
    return QuoteResult(currency=q.currency, tiers=tiers, errors=errors, seasons=seasons,
                       nights_priced=len(h.rows), hotel_dbl_pp=h.dbl_pp, hotel_sgl_pp=h.sgl)


def breakdown(q: QuoteIn, tourists: int) -> Breakdown:
    """Line-by-line view of one group size, like one '19+1' sheet."""
    q = following(with_transport(q))
    h = hotels(q, tourists)
    lines = lines_for(q, tourists)
    t = _tier(q, tourists, h, lines)
    items = [ItemCalc(index=i, name=it.name, category=it.category, kind=it.kind, included=it.included, currency=it.currency,
                      quantity=ln.quantity, unit_price=ln.unit_price, multiplier=ln.multiplier,
                      amount=ln.amount, error=ln.error)
             for i, (it, ln) in enumerate(zip(q.items, lines))]
    return Breakdown(tier=t.row, items=items, leader_room=t.steps.leader_room, hotel_nights=h.rows, steps=t.steps, people=t.people)


COST_NOTE = {"cost_total": "what everything costs the group (lines + hotels)", "cost_hotel": "hotel rooms for the group"}
BUILTIN_NOTES = {
    "days": "tour days", "nights": "priced hotel nights", "tourists": "people who pay",
    "leaders": "people travelling free (tour leaders)", "staff": "driver, guide… travelling with the group",
    "persons": "who pays + who travels free", "everyone": "everyone, staff too", "crew": "free + staff (staff table)",
    "group": "the group size the price list runs over",
}


def check_formula(q: QuoteIn, expr: str, tourists: int) -> FormulaCheck:
    """A quantity formula's value for the smallest, chosen and largest group, or why it fails."""
    sizes = sorted({q.pax_min, min(max(tourists, q.pax_min), q.pax_max), q.pax_max})
    q = following(with_transport(q))

    def env(n: int) -> dict[str, Decimal]:
        v = variables(q, n)
        # Cost totals from the lines that don't use them themselves.
        return {**v, **cost_vars(q, n, [None if _uses_costs(it) else line(q, it, n, v) for it in q.items])}

    v = env(sizes[len(sizes) // 2])
    names = [FormulaName(name=k, value=v[k], note=BUILTIN_NOTES[k], builtin=True) for k in BUILTIN_NOTES] + [
        FormulaName(name=k, value=v[k], note=COST_NOTE.get(k, "what these lines cost the group"), builtin=True)
        for k in sorted(v) if k.startswith("cost_") and (v[k] or k in COST_NOTE)] + [
        FormulaName(name=k, value=val, note=q.variable_notes.get(k, ""), builtin=False) for k, val in q.variables.items()]
    try:
        values = [FormulaValue(tourists=n, value=evaluate(expr, env(n))) for n in sizes]
    except FormulaError as e:
        return FormulaCheck(ok=False, values=[], error_code=e.code, error=str(e), error_params=e.params, names=names)
    return FormulaCheck(ok=True, values=values, names=names)
