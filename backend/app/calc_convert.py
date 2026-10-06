"""Older calculations into the one way of pricing.

Older calculations kept who travels (tourists, free leaders, staff) and the profit (per group, minimum per
person, margin floor, rounding) as plain fields; newer ones write both out as "Who travels" (people) and
"How we price" (recipe). Two systems for the same thing confused people, so older calculations are written
out the new way - but only when every price stays exactly the same (all group sizes, every season, every
type of person, optional extras). One that would change is left as it is.
"""
from .quote_engine import compute
from .quote_schemas import PersonType, PriceStep, QuoteIn

NAMES = {
    "en": ("Paying tourists", "Tour leader", "Driver and guide"),
    "ka": ("გადამხდელი ტურისტები", "ტურლიდერი", "მძღოლი და გიდი"),
}


def is_legacy(q: QuoteIn) -> bool:
    return not q.people or not q.recipe


def explicit(q: QuoteIn, lang: str = "en") -> QuoteIn:
    """The same calculation with people and recipe written out (as the editor does on the first edit)."""
    tourists, leaders, staff = NAMES.get(lang, NAMES["en"])
    people = q.people or [
        PersonType(id="tourists", name=tourists, role="pay", count=None, room="dbl"),
        PersonType(id="leaders", name=leaders, role="free", count=q.leaders, per=q.leaders_per,
                   room={"single": "sgl", "shared": "dbl", "free": "free"}[q.leader_kind()]),
        PersonType(id="staff", name=staff, role="staff", count=q.staff, room="staff"),
    ]
    recipe = q.recipe or [
        PriceStep(id="profit", kind="profit", value=q.margin_floor_pct, group=q.profit_group, min_pp=q.profit_min_pp),
        PriceStep(id="round", kind="round", value=q.rounding_step, mode=q.rounding_mode),
    ]
    return q.model_copy(update={"people": people, "recipe": recipe})


def _prices(q: QuoteIn) -> list:
    """Everything a client or a tour can be charged, for every size and season."""
    r = compute(q)
    def tiers(ts):
        return [(t.tourists, t.leaders, t.label, t.price_dbl, t.price_sgl, t.price_trp, t.price_quad,
                 tuple((x.id, x.price) for x in t.types), tuple((x.id, x.price) for x in t.extras),
                 tuple((o.currency, o.price_dbl, o.price_sgl, o.price_trp, o.price_quad) for o in t.other))
                for t in ts]
    return [tuple(r.errors), tiers(r.tiers), [(s.id, tiers(s.tiers)) for s in r.seasons]]


def convert(q: QuoteIn, lang: str = "en") -> QuoteIn | None:
    """The calculation written the new way, or None when it isn't older or a price would change."""
    if not is_legacy(q):
        return None
    new = explicit(q, lang)
    try:
        if _prices(new) != _prices(q):
            return None
    except (ArithmeticError, ValueError):
        return None
    return new


def same_prices(a: QuoteIn, b: QuoteIn) -> bool:
    return _prices(a) == _prices(b)

