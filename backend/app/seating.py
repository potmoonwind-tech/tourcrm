"""Who eats where at a tour's meals: the group's table and, when some sit apart, the staff table.

The tour's free tour leaders (part of its group size) and each day's guides, drivers and assistants each
eat with the group, at the staff table, or not with us (e.g. a driver who eats on his own). Not chosen:
the tour's old "staff table" switch decides (on: the staff table, off: with the group).

Costs, the meals page, the restaurant's booking email and the programme all count people - and so the
plates of each dish, table by table - from here.
"""
from collections import Counter
from dataclasses import dataclass, field

MEAL_STAFF = frozenset({"guide", "driver", "assistant"})      # staff roles that eat at the meals
SEATS = ("group", "staff", "none")


def leader_seat(t) -> str:
    return t.leader_seat or ("staff" if t.staff_table else "group")


def seat_of(a, t) -> str:
    return a.meal_seat or ("staff" if t.staff_table else "group")


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


def tables(t, day: int, pax: int) -> Seating:
    """The tables of one day's meals, for a group of `pax` (tour leaders included)."""
    pax = int(pax or 0)
    leaders = min(t.leaders or 0, pax)
    s = Seating(group=pax - leaders)

    def put(where: str, role: str, n: int) -> None:
        if n <= 0 or where == "none":
            return
        if where == "staff":
            s.staff += n
            s.staff_roles[role] += n
        else:
            s.group += n
            s.group_roles[role] += n

    put(leader_seat(t), "leader", leaders)
    for a in t.staff:
        if a.role in MEAL_STAFF and a.covers(day):
            put(seat_of(a, t), a.role, 1)
    return s
