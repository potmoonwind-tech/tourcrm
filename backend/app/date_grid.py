"""The partner's departure plan as they send it: a grid, not a table.

    ZK   10twin
    ZK-1025              ZK-1101              …
    25.10.2026  marriott baku   01.11.2026  marriott baku
    26.10.2026  marxal          02.11.2026  marxal
    …           Flight          …           Flight

A row of codes starts a block; under each code, one row per night: the date, and in the next
column where the group sleeps. A line above the codes ("ZK  10twin") names the series.

We read every departure (code, its nights, the place of each night) and point out what looks
wrong instead of guessing: nights that aren't consecutive, a first date that doesn't match the
code (ZK-1025 → 25 Oct), and a date in the wrong year (ZS-0106 dated 2026-01-06 between
December 2026 and February 2027 departures).
"""
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date

from .importer import as_date

CODE = re.compile(r"^\s*([A-Z]{1,6})[-\s]?(\d{3,4})\s*$")


@dataclass
class GridDeparture:
    code: str
    dates: list[date]
    places: list[str]
    warnings: list[str] = field(default_factory=list)
    suggested_start: date | None = None      # when the year looks wrong

    @property
    def start(self) -> date:
        return self.dates[0]


@dataclass
class GridSeries:
    prefix: str
    note: str                                   # what the line above says ("10twin")
    departures: list[GridDeparture]
    places: list[str]                           # the usual night-by-night places
    warnings: list[str] = field(default_factory=list)


def _date(v) -> date | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    if isinstance(v, (int, float)) and not 30000 < v < 80000:   # a count, not an Excel day
        return None
    try:
        return as_date(v)
    except (ValueError, TypeError):
        return None


def _text(v) -> str:
    return "" if v is None else str(v).strip()


def read_grid(table: list[tuple[int, list]], today: date | None = None) -> list[GridSeries]:
    today = today or date.today()
    rows = [r for _, r in table]
    found: dict[str, list[GridDeparture]] = {}
    notes: dict[str, str] = {}
    prev_text: list[str] = []
    i = 0
    while i < len(rows):
        row = rows[i]
        codes = [(c, m.group(1), m.group(2)) for c, v in enumerate(row) if isinstance(v, str) and (m := CODE.match(v))]
        if not codes:
            prev_text = [_text(v) for v in row if _text(v)]
            i += 1
            continue
        # The line above the codes names the series ("ZK", "10twin").
        if prev_text and prev_text[0].upper() == codes[0][1]:
            notes.setdefault(codes[0][1], " ".join(prev_text[1:]))
        block: dict[int, GridDeparture] = {c: GridDeparture(code=f"{p}-{n}", dates=[], places=[]) for c, p, n in codes}
        j = i + 1
        while j < len(rows):
            r = rows[j]
            got = False
            for c in block:
                d = _date(r[c]) if c < len(r) else None
                if d:
                    got = True
                    block[c].dates.append(d)
                    block[c].places.append(_text(r[c + 1]) if c + 1 < len(r) and not _date(r[c + 1]) else "")
            if not got:
                break
            j += 1
        for c, p, _ in codes:
            if block[c].dates:
                found.setdefault(p, []).append(block[c])
        prev_text = []
        i = j
    return [_series(p, notes.get(p, ""), deps, today) for p, deps in found.items()]


def _series(prefix: str, note: str, deps: list[GridDeparture], today: date) -> GridSeries:
    usual = Counter(tuple(x.places) for x in deps).most_common(1)[0][0]
    for k, x in enumerate(deps):
        for a, b in zip(x.dates, x.dates[1:]):
            if (b - a).days != 1:
                x.warnings.append(f"Nights aren't one after another: {a:%d.%m.%Y} then {b:%d.%m.%Y}")
                break
        digits = x.code.split("-")[1]
        if len(digits) == 4 and f"{x.start:%m%d}" != digits:
            x.warnings.append(f"The code says {digits[2:]}.{digits[:2]}, the first night is {x.start:%d.%m.%Y}")
        # A date out of the series' order, or in the past, is usually the wrong year.
        before = next((y.start for y in reversed(deps[:k]) if not y.suggested_start), None)
        if (before and x.start < before) or x.start < today:
            for years in (1, 2):
                try:
                    guess = x.start.replace(year=x.start.year + years)
                except ValueError:       # 29 February
                    continue
                if guess >= today and (before is None or guess >= before):
                    x.suggested_start = guess
                    break
            x.warnings.append(f"{x.start:%d.%m.%Y} is " + ("before the departure above it" if before and x.start < before else "in the past")
                              + (f": probably {x.suggested_start:%d.%m.%Y}" if x.suggested_start else ""))
        if tuple(x.places) != usual:
            x.warnings.append("Different nights from the others in this series")
    wrong_year = [x.code for x in deps if x.suggested_start]
    warnings = [f"{len(wrong_year)} departures look like the wrong year: {', '.join(wrong_year)}"] if wrong_year else []
    return GridSeries(prefix=prefix, note=note, departures=deps, places=list(usual), warnings=warnings)

