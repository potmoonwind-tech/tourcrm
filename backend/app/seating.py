"""Who eats where at a tour's meals: the group's table and, when some sit apart, the staff table.

The tour's free tour leaders (part of its group size) and each day's guides, drivers and assistants each
eat with the group, at the staff table, or not with us (e.g. a driver who eats on his own). The tour says
where each usually eats (not chosen: its old "staff table" switch decides); one meal can differ - a day's
`seating` keeps, per meal, only who sits elsewhere than usual: {"dinner": {"leader": "staff", "<staff id>": "group"}}.

Costs, the meals page, the restaurant's booking email and the programme all count people - and so the
plates of each dish, table by table - from here.
"""
from collections import Counter
from dataclasses import dataclass, field

MEAL_STAFF = frozenset({"guide", "driver", "assistant"})      # staff roles that eat at the meals
# A bus company's driver can eat too - but only when chosen (by default not with us, as costs always had it).
SEATED = MEAL_STAFF | {"transport"}
SEATS = ("group", "staff", "none")


# The usual: two tables - the group, and the staff's (tour leaders, guide, driver). A bus company's driver
# eats with us only when seated. A meal can seat anyone elsewhere (the day's `seating`).
def leader_seat(t) -> str:
    return t.leader_seat or "staff"


def seat_of(a, t) -> str:
    if a.role == "transport":
        return a.meal_seat or "none"
    return a.meal_seat or "staff"


def _role(a) -> str:
    return "driver" if a.role == "transport" else a.role


@dataclass
class Seating:
    group: int = 0                   # at the group's table: tourists, and whoever eats with them
    staff: int = 0                   # at the staff table
    group_roles: Counter = field(default_factory=Counter)      # "leader" / "guide" / "driver" / "assistant" -> people
    staff_roles: Counter = field(default_factory=Counter)

    @property
    def tables(self) -> list[int]:
        """People at each table: [18, 3] with a staff table, [21] without."""
        return [self.group, self.staff] if self.staff else [self.group]


def changed(t, day: int, meal: str | None) -> dict:
    """Who sits elsewhere than usual at this meal (and its extra guests, under "_extra")."""
    d = next((x for x in t.days if x.day_number == day), None) if meal else None
    return dict(((d.seating or {}).get(meal) or {})) if d is not None else {}


def extras(o: dict) -> list[dict]:
    """A meal's extra guests: [{"name": "Photographer", "seat": "staff"}]."""
    return [x for x in (o.get("_extra") or []) if isinstance(x, dict) and x.get("seat") in ("group", "staff")]


def people(t, day: int, meal: str | None, pax: int) -> list[dict]:
    """Everyone who could eat at this meal, with where they sit and where they usually sit (the grid)."""
    pax = int(pax or 0)
    o = changed(t, day, meal)
    leaders = min(t.leaders or 0, pax)
    out = [{"key": "leader", "role": "leader", "name": "", "count": leaders,
            "seat": o.get("leader") or leader_seat(t), "usual": leader_seat(t)}] if leaders else []
    for a in t.staff:
        if a.role in SEATED and a.covers(day):
            out.append({"key": a.id, "role": a.role, "name": a.vendor.name if a.vendor else "", "count": 1,
                        "seat": o.get(a.id) or seat_of(a, t), "usual": seat_of(a, t)})
    for i, x in enumerate(extras(o)):
        out.append({"key": f"_extra:{i}", "role": "guest", "name": str(x.get("name") or ""), "count": 1, "seat": x["seat"], "usual": x["seat"]})
    return out


def tables(t, day: int, pax: int, meal: str | None = None) -> Seating:
    """The tables of one day's meal, for a group of `pax` (tour leaders included)."""
    pax = int(pax or 0)
    leaders = min(t.leaders or 0, pax)
    s = Seating(group=pax - leaders)
    o = changed(t, day, meal)

    def put(where: str, role: str, n: int) -> None:
        if n <= 0 or where == "none":
            return
        if where == "staff":
            s.staff += n
            s.staff_roles[role] += n
        else:
            s.group += n
            s.group_roles[role] += n

    put(o.get("leader") or leader_seat(t), "leader", leaders)
    for a in t.staff:
        if a.role in SEATED and a.covers(day):
            put(o.get(a.id) or seat_of(a, t), _role(a), 1)
    for x in extras(o):
        put(x["seat"], "guest", 1)
    return s
