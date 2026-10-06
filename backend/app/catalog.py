"""Which price applies: a service's rate for a date and a group size.

Rows may overlap only when one is strictly inside the other (a summer season
inside an all-year price, a 13–25 pax price inside "any size"); the narrower one
wins. Partly overlapping rows would be ambiguous and are refused when saved.
"""
from datetime import date

from .models import Service, ServiceRate, Vendor

FAR_PAST, FAR_FUTURE = date.min, date.max
NO_MIN, NO_MAX = 0, 10**6


def _dates(r) -> tuple[date, date]:
    return r.valid_from or FAR_PAST, r.valid_to or FAR_FUTURE


def _pax(r) -> tuple[int, int]:
    return r.min_pax or NO_MIN, r.max_pax or NO_MAX


def _inside(a: tuple, b: tuple) -> bool:
    """Range a lies within range b."""
    return b[0] <= a[0] and a[1] <= b[1]


def _overlap(a: tuple, b: tuple) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def conflicts(rates) -> list[tuple[int, int]]:
    """Index pairs of rows that would make a price ambiguous."""
    out = []
    for i, a in enumerate(rates):
        for j in range(i + 1, len(rates)):
            b = rates[j]
            if not (_overlap(_dates(a), _dates(b)) and _overlap(_pax(a), _pax(b))):
                continue
            a_in_b = _inside(_dates(a), _dates(b)) and _inside(_pax(a), _pax(b))
            b_in_a = _inside(_dates(b), _dates(a)) and _inside(_pax(b), _pax(a))
            if a_in_b == b_in_a:  # neither is narrower (partly overlapping, or identical)
                out.append((i, j))
    return out


def pick(rates, on: date, pax: int | None = None):
    """The narrowest row covering the date and group size. With the size unknown,
    rows without a size limit are preferred over guessing a size band."""
    def covers(r) -> bool:
        lo, hi = _dates(r)
        if not lo <= on <= hi:
            return False
        if pax is None:
            return True
        pmin, pmax = _pax(r)
        return pmin <= pax <= pmax

    if pax is None:
        any_size = [r for r in rates if r.min_pax is None and r.max_pax is None]
        found = pick(any_size, on, NO_MIN) if any_size else None
        if found:
            return found

    def span(r) -> tuple[int, int]:
        lo, hi = _dates(r)
        pmin, pmax = _pax(r)
        return (hi - lo).days, pmax - pmin

    found = sorted((r for r in rates if covers(r)), key=span)
    return found[0] if found else None


def service_by_code(vendor: Vendor, code: str) -> Service | None:
    return next((s for s in vendor.services if s.code == code and s.is_active), None)


def price_for(vendor: Vendor, code: str, on: date, pax: int | None = None) -> ServiceRate | None:
    s = service_by_code(vendor, code)
    return pick(s.rates, on, pax) if s else None
