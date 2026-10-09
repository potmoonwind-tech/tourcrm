"""What changed on a tour's days, in plain words — for the people working on it.

Before a change, take a snapshot of the days; after it, `record` writes one line per difference
("Day 3: hotel Kutaisi Inn → Rioni Palace", "Day 2: lunch 13:00 → 13:30"). Guides and drivers see
the lines on their phone page until they tap "Got it"; the office sees who has.
"""
from sqlalchemy.orm import Session

from .models import Service, Tour, TourChange, Vendor


def _name(db: Session, model, id_: str | None) -> str:
    if not id_:
        return "—"
    x = db.get(model, id_)
    return x.name if x is not None else "—"


def snapshot(t: Tour) -> dict[int, dict]:
    return {d.day_number: {
        "date": d.date, "city": d.city, "stops": list(d.stops or []), "hotel_id": d.hotel_id,
        "breakfast_id": d.breakfast_id, "breakfast_menu_id": d.breakfast_menu_id, "breakfast_mode": d.breakfast_mode or "hotel",
        "lunch_id": d.lunch_id, "dinner_id": d.dinner_id, "lunch_menu_id": d.lunch_menu_id, "dinner_menu_id": d.dinner_menu_id,
        "lunch_mode": d.lunch_mode or "included", "dinner_mode": d.dinner_mode or "included",
        "flights": [dict(f) for f in d.flights or []], "schedule": [dict(x) for x in d.schedule or []],
        "extras": sorted(x["service_id"] for x in d.extras or []), "notes": d.notes, "border": d.border_crossing,
        "staff_stay": d.staff_stay or "none", "staff_hotel_id": d.staff_hotel_id, "staff_twin": bool(d.staff_twin),
        "staff_stays": d.staff_stays or {},
    } for d in t.days}


def _step(x: dict) -> str:
    return x.get("title") or x.get("ref") or x.get("kind", "")


def lines(db: Session, before: dict[int, dict], after: dict[int, dict]) -> list[tuple[int | None, str, str]]:
    """(day, kind, text) for every difference."""
    out: list[tuple[int | None, str, str]] = []
    mode_word = {"included": "", "tourists": " (tourists pay)", "own": "on their own", "hotel": "at the hotel"}
    for n in sorted(set(before) | set(after)):
        a, b = before.get(n), after.get(n)
        if a is None or b is None:
            out.append((n, "other", f"Day {n} {'added' if a is None else 'removed'}"))
            continue
        day = f"Day {n}"
        if a["date"] != b["date"]:
            out.append((n, "other", f"{day}: date {a['date']} → {b['date']}"))
        if (a["city"], a["stops"]) != (b["city"], b["stops"]):
            route = lambda d: " → ".join([*d["stops"], d["city"]]) or "—"      # noqa: E731
            out.append((n, "route", f"{day}: {route(a)} → {route(b)}"))
        if a["hotel_id"] != b["hotel_id"]:
            out.append((n, "hotel", f"{day}: hotel {_name(db, Vendor, a['hotel_id'])} → {_name(db, Vendor, b['hotel_id'])}"))
        for meal in ("breakfast", "lunch", "dinner"):
            ka, kb = (a[f"{meal}_id"], a[f"{meal}_mode"]), (b[f"{meal}_id"], b[f"{meal}_mode"])
            if ka != kb:
                word = lambda k: mode_word[k[1]] if k[1] in ("own", "hotel") else _name(db, Vendor, k[0]) + mode_word[k[1]]  # noqa: E731
                out.append((n, "meal", f"{day}: {meal} {word(ka)} → {word(kb)}"))
            elif a[f"{meal}_menu_id"] != b[f"{meal}_menu_id"]:
                out.append((n, "meal", f"{day}: {meal} menu {_name(db, Service, a[f'{meal}_menu_id'])} → {_name(db, Service, b[f'{meal}_menu_id'])}"))
        fa = {(f.get("number"), f.get("direction")): f.get("time", "") for f in a["flights"]}
        fb = {(f.get("number"), f.get("direction")): f.get("time", "") for f in b["flights"]}
        for k in sorted(set(fa) | set(fb), key=str):
            if k not in fb:
                out.append((n, "flight", f"{day}: flight {k[0]} removed"))
            elif k not in fa:
                out.append((n, "flight", f"{day}: flight {k[0]} {fb[k]} added"))
            elif fa[k] != fb[k]:
                out.append((n, "flight", f"{day}: flight {k[0]} {fa[k] or '?'} → {fb[k] or '?'}"))
        # The programme: times of the same steps, then order, then steps added / removed.
        sa = {x["id"]: x for x in a["schedule"]}
        sb = {x["id"]: x for x in b["schedule"]}
        for i, x in sb.items():
            if i in sa and (sa[i].get("time"), sa[i].get("end")) != (x.get("time"), x.get("end")):
                out.append((n, "time", f"{day}: {_step(x)} {sa[i].get('time') or '?'} → {x.get('time') or '?'}"))
        common_a = [i for i in sa if i in sb]
        common_b = [i for i in sb if i in sa]
        if common_a != common_b:
            out.append((n, "programme", f"{day}: order of the programme changed"))
        for i, x in sb.items():
            if i not in sa and a["schedule"]:
                out.append((n, "programme", f"{day}: added {_step(x)}{' at ' + x['time'] if x.get('time') else ''}"))
        for i, x in sa.items():
            if i not in sb and b["schedule"]:
                out.append((n, "programme", f"{day}: removed {_step(x)}"))
        if a["extras"] != b["extras"]:
            out.append((n, "other", f"{day}: services changed"))
        if a["border"] != b["border"]:
            out.append((n, "route", f"{day}: border {a['border'] or '—'} → {b['border'] or '—'}"))
        if a["notes"] != b["notes"]:
            out.append((n, "other", f"{day}: notes changed"))
    return out


def record(db: Session, t: Tour, before: dict[int, dict], user_id: str | None) -> list[str]:
    """Write what changed since `before`; returns the lines."""
    db.flush()
    db.refresh(t, ["days"])
    found = lines(db, before, snapshot(t))
    for day, kind, text in found:
        db.add(TourChange(tour_id=t.id, day=day, kind=kind, text=text[:300], by_id=user_id))
    return [x[2] for x in found]
