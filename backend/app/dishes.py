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
        out.append({"name": name, "price": float(price) if price not in (None, "") else None,
                    "per_plate": int(per) if per not in (None, "") and 1 <= int(per) <= 20 else None})
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
