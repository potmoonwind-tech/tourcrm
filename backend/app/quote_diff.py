"""Differences between two states of a calculation (history), and scenarios as
patches applied on top of one."""
from decimal import Decimal

from .quote_engine import compute
from .quote_schemas import Change, PriceImpact, QuoteIn, QuoteNightIn, ScenarioPatch

SETTINGS = ("name", "status", "series_id", "client_id", "currency", "valid_from", "valid_to", "days", "pax_min",
            "pax_max", "leaders", "leader_room", "leaders_per", "staff", "profit_group", "profit_min_pp", "margin_floor_pct",
            "single_profit", "rounding_mode", "rounding_step", "languages", "notes", "people", "recipe",
            "extra_markup", "seasons", "sell_in", "per_room", "transport")
ITEM_FIELDS = ("name", "category", "included", "unit_price", "currency", "quantity", "basis", "who", "capacity",
               "extra", "tiers", "vehicle", "vendor_id", "day", "notes", "uses", "optional", "season_prices",
               "price_formula", "standard", "kind", "travel")
NIGHT_FIELDS = ("city", "hotel_name", "vendor_id", "currency", "price_dbl", "price_sgl", "price_trp",
                "staff_stay", "staff_hotel", "staff_price", "staff_currency", "staff_twin", "price_quad", "season_prices")


def show(v) -> str | None:
    """A value as a person would write it: 550 not 550.000000, yes/no for booleans."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, Decimal):
        return format(v.normalize(), "f")
    if hasattr(v, "legs") and hasattr(v, "ticket_by"):              # a ticket's journey
        return " · ".join(f"{x.from_place} → {x.to_place}" for x in v.legs) or v.mode
    if isinstance(v, list):
        return ", ".join(_one(x) for x in v)
    if isinstance(v, dict):
        return ", ".join(f"{k}: {getattr(x, 'mode', x)}" for k, x in v.items())
    return str(v)


def _one(x) -> str:
    if hasattr(x, "max_pax") and hasattr(x, "unit_price"):          # a group-size tier
        return f"≤{x.max_pax}"
    if hasattr(x, "role"):                                          # a type of person
        return f"{x.name} × {'group' if x.count is None else x.count}"
    if hasattr(x, "kind") and hasattr(x, "on"):                     # a price step
        return f"{x.label or x.kind} {show(x.value)}" + ("" if x.on else " (off)")
    return str(show(x))


def _dump(v):
    if isinstance(v, list):
        return [x.model_dump() if hasattr(x, "model_dump") else x for x in v]
    return v


def _night_label(i: int, n: QuoteNightIn) -> str:
    return f"{i}. {n.city}" + (f" · {n.hotel_name}" if n.hotel_name else "")


def _rows(area, old_rows, new_rows, fields, label) -> list[Change]:
    out = []
    old = {r.id: (i, r) for i, r in enumerate(old_rows, 1)}
    new = {r.id: (i, r) for i, r in enumerate(new_rows, 1)}
    for rid, (i, r) in new.items():
        if rid not in old:
            out.append(Change(area=area, action="added", key=rid, label=label(i, r)))
            continue
        o = old[rid][1]
        for f in fields:
            if _dump(getattr(o, f)) != _dump(getattr(r, f)):
                out.append(Change(area=area, action="changed", key=rid, label=label(i, r), field=f,
                                  before=show(getattr(o, f)), after=show(getattr(r, f))))
    for rid, (i, o) in old.items():
        if rid not in new:
            out.append(Change(area=area, action="removed", key=rid, label=label(i, o)))
    return out


def diff_docs(old: QuoteIn, new: QuoteIn) -> list[Change]:
    out: list[Change] = []
    for f in SETTINGS:
        a, b = getattr(old, f), getattr(new, f)
        if _dump(a) != _dump(b):
            long_text = f == "notes"
            out.append(Change(area="settings", action="changed", key=f, label=f, field=f,
                              before=None if long_text else show(a), after=None if long_text else show(b)))
    for area in ("variables", "fx"):
        a, b = getattr(old, area), getattr(new, area)
        for k in sorted(set(a) | set(b)):
            if k not in b:
                out.append(Change(area=area, action="removed", key=k, label=k, before=show(a[k])))
            elif k not in a:
                out.append(Change(area=area, action="added", key=k, label=k, after=show(b[k])))
            elif a[k] != b[k]:
                out.append(Change(area=area, action="changed", key=k, label=k, before=show(a[k]), after=show(b[k])))
    out += _rows("items", old.items, new.items, ITEM_FIELDS, lambda i, x: x.name)
    out += _rows("nights", old.nights, new.nights, NIGHT_FIELDS, _night_label)
    for lang in sorted(set(old.texts) | set(new.texts)):
        if old.texts.get(lang) != new.texts.get(lang):
            out.append(Change(area="texts", action="changed", key=lang, label=lang))
    return out


def price_impact(old: QuoteIn, new: QuoteIn) -> list[PriceImpact]:
    a = {t.tourists: t for t in compute(old).tiers}
    b = {t.tourists: t for t in compute(new).tiers}
    return [PriceImpact(tourists=n, label=(b.get(n) or a[n]).label,
                        before=a[n].price_dbl if n in a else None, after=b[n].price_dbl if n in b else None)
            for n in sorted(set(a) | set(b))]


def apply_patch(doc: QuoteIn, patch: ScenarioPatch) -> tuple[QuoteIn, list[str]]:
    """The calculation with the scenario's changes, plus anything the patch points
    at that the calculation no longer has (a deleted line, a renamed variable)."""
    d = doc.model_dump()
    stale: list[str] = []
    d.update(patch.settings.model_dump(exclude_none=True))
    for k, v in patch.variables.items():
        if k in d["variables"]:
            d["variables"][k] = v
        else:
            stale.append(f"variable:{k}")
    d["fx"].update(patch.fx)
    for area, rows in (("items", patch.items), ("nights", patch.nights)):
        by_id = {r["id"]: r for r in d[area]}
        for rid, p in rows.items():
            if rid in by_id:
                change = p.model_dump(exclude_none=True)
                by_id[rid].update(change)
                if area == "items" and "unit_price" in change:
                    for tier in by_id[rid].get("tiers") or []:
                        tier["unit_price"] = None
            else:
                stale.append(f"{area[:-1]}:{rid}")
    return QuoteIn.model_validate(d), stale
