"""Dishes of a set menu: {"name": "Khinkali", "price": 25, "per_plate": 4}.

`price` is one plate (one portion), in the menu's currency, optional. How many people share a plate
— family style, e.g. one plate for 4 — comes from the dish (`per_plate`), else the tour, else the
agency (Settings), else 1 (everyone their own portion, so the price is per person as before).
Older menus stored plain names; both read the same way."""
import math
from decimal import Decimal


def normalize(raw) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for d in raw or []:
        name, price, per = (d, None, None) if isinstance(d, str) else (d.get("name", ""), d.get("price"), d.get("per_plate"))
        name = " ".join(str(name).split())[:80]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        row = {"name": name, "price": float(price) if price not in (None, "") else None,
               "per_plate": int(per) if per not in (None, "") and 1 <= int(per) <= 20 else None}
        if isinstance(d, dict) and d.get("dish_id"):
            row["dish_id"] = str(d["dish_id"])[:36]       # from the restaurant's dish list: its price follows it
        out.append(row)
    return out


def names(raw) -> list[str]:
    return [d["name"] for d in normalize(raw)]


def total(raw) -> Decimal | None:
    """Sum of the dish prices (one plate each), when every dish has one."""
    ds = normalize(raw)
    if not ds or any(d["price"] is None for d in ds):
        return None
    return sum((Decimal(str(d["price"])) for d in ds), Decimal(0))


def share_of(dish: dict, tour_share: int | None, agency_share: int | None) -> int:
    """How many people share one plate of this dish."""
    return dish.get("per_plate") or tour_share or agency_share or 1


def plates(people: int, share: int) -> int:
    """12 people, a plate for 4 → 3 plates; 13 → 4."""
    return math.ceil(people / max(share, 1)) if people > 0 else 0


def sharing(raw, tour_share: int | None, agency_share: int | None) -> bool:
    """Is any dish of this menu shared (more than one person per plate)?"""
    return any(share_of(d, tour_share, agency_share) > 1 for d in normalize(raw))


def plate_total(raw, people: int, tour_share: int | None, agency_share: int | None) -> Decimal | None:
    """What the menu costs for this many people, plate by plate; None when a dish has no price."""
    ds = normalize(raw)
    if not ds or any(d["price"] is None for d in ds):
        return None
    return sum((Decimal(str(d["price"])) * plates(people, share_of(d, tour_share, agency_share)) for d in ds), Decimal(0))


def served(day, meal: str, menu) -> list:
    """What this meal serves: the tour's own dishes for it (changed in the tour), else its menu's."""
    own = (getattr(day, "meal_dishes", None) or {}).get(meal)
    if own is not None:
        return [x.model_dump() if hasattr(x, "model_dump") else x for x in own]
    return list(menu.dishes or []) if menu is not None else []


def meal_cost(price_pp, staff_price, group: int, staff: int, tables: list[int], raw, tour_share, agency_share):
    """What a meal costs, and so per person - (total, per_person, by_plates).

    - Shared dishes (family style) with every dish priced: the plates, counted TABLE BY TABLE (19 guests and
      3 staff, 1 plate for 2: 10 + 2 = 12 plates - both tables eat); dishes for one cost a portion a person.
    - Otherwise a set price per person (the menu's, else the restaurant's usual): price × the group, and the
      staff at the restaurant's staff price when it has one. Plates then only tell the kitchen what to bring.
    - No price per person but every dish priced: the dishes, a portion a person.
    - Nothing priced: unknown (None). Per person is always total ÷ the people eating.
    """
    people = group + staff
    ds = normalize(raw)
    priced = bool(ds) and all(d["price"] is not None for d in ds) and people > 0
    shared = priced and any(share_of(d, tour_share, agency_share) > 1 for d in ds)
    if shared or (priced and price_pp is None):
        total = Decimal(0)
        for d in ds:
            share = share_of(d, tour_share, agency_share)
            count = sum(plates(n, share) for n in (tables or [people])) if share > 1 else people
            total += Decimal(str(d["price"])) * count
        total = total.quantize(Decimal("0.01"))
        return total, (total / people).quantize(Decimal("0.01")), shared
    if price_pp is not None:
        p = Decimal(str(price_pp))
        sp = Decimal(str(staff_price)) if staff_price is not None else p
        return (p * group + sp * staff).quantize(Decimal("0.01")), p, False
    return None, None, False
