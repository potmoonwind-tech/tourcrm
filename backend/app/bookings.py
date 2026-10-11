"""Bookings: one per supplier on a tour, following the itinerary and the staff.

What a supplier is booked for (nights and rooms, lunches and dinners for how many people, day
services, a guide's days) is worked out from the tour every time, so it is always current. The
booking row only keeps what people decide: status, confirmation number, who books it and by when,
and how it is paid. When the tour changes after a confirmation, the booking says so ("changed —
confirm again"); when a supplier leaves the itinerary after being booked, it says "cancel with
the supplier".
"""
import json
from dataclasses import dataclass, field
from datetime import date, timedelta

import uuid

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from . import finance
from .models import LIVE_STATUSES, Tour, TourBooking, Vendor, utcnow

# Kind of work, from the supplier's type (who books it — Settings → Who does what).
KIND = {"hotel": "hotel", "restaurant": "meal", "transport": "transport", "driver": "transport",
        "guide": "guide", "activity": "activity", "airline": "transport", "rail": "transport", "other": "other"}
KINDS = ("hotel", "meal", "transport", "guide", "activity", "other")
# Book this many days before the supplier's first service, unless the booking says otherwise.
BOOK_AHEAD = {"hotel": 30, "meal": 7, "transport": 14, "guide": 14, "activity": 7, "other": 7}
OPEN = ("to_book", "requested", "problem")
LATE_STATES = ("to_book", "waiting", "changed", "cancel", "problem")


@dataclass
class Usage:
    """What one supplier does on one tour."""
    vendor: Vendor
    dates: set[date] = field(default_factory=set)
    nights: int = 0
    night_dates: set[date] = field(default_factory=set)        # the nights at this hotel
    breakfasts: int = 0
    lunches: int = 0
    dinners: int = 0
    tourists_pay: int = 0                                       # of those meals, paid by the tourists on the spot
    services: dict[str, int] = field(default_factory=dict)     # service name → days
    staff: list[dict] = field(default_factory=list)            # [{"role": "guide", "from": 1, "to": 3}]
    staff_night_dates: set[date] = field(default_factory=set)  # nights the driver/guide sleep here
    staff_rooms: dict[str, int] = field(default_factory=dict)  # {"SGL": 2} most rooms they need on a night

    def details(self, t: Tour) -> dict:
        d: dict = {}
        # Only the driver and guide sleep here (another hotel): the stays are theirs.
        staff_only = bool(self.staff_night_dates) and not self.nights
        nights, night_dates = (len(self.staff_night_dates), self.staff_night_dates) if staff_only else (self.nights, self.night_dates)
        if nights:
            d["nights"] = nights
            # Separate stays, as a hotel reads them: check-in / check-out. Two nights a week apart
            # are two stays, not one long one.
            stays, run = [], []
            for n in sorted(night_dates):
                if run and (n - run[-1]).days != 1:
                    stays.append(run)
                    run = []
                run.append(n)
            if run:
                stays.append(run)
            d["stays"] = [{"check_in": s[0].isoformat(), "check_out": (s[-1] + timedelta(days=1)).isoformat(), "nights": len(s)}
                          for s in stays]
            rooms = {} if staff_only else finance.room_counts(t)
            if rooms:
                d["rooms"] = rooms
        if self.staff_rooms:
            d["staff_rooms"] = {"rooms": self.staff_rooms, "nights": len(self.staff_night_dates)}
        if self.breakfasts:
            d["breakfasts"] = self.breakfasts
        if self.lunches:
            d["lunches"] = self.lunches
        if self.dinners:
            d["dinners"] = self.dinners
        if self.breakfasts or self.lunches or self.dinners:
            d["people"] = finance.everyone(t)      # the same count the meal costs use (guests + tour leaders)
        if self.tourists_pay:
            d["tourists_pay"] = self.tourists_pay           # reserve, but the tourists pay the restaurant
        if self.services:
            d["services"] = self.services
        if self.staff:
            d["staff"] = self.staff
        return d


def usage(db: Session, t: Tour, vendors: dict[str, Vendor] | None = None) -> dict[str, Usage]:
    """Every supplier the tour uses, from its days (hotel, meals, day services) and staff."""
    out: dict[str, Usage] = {}
    if vendors is None:
        vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == t.workspace_id))}

    def of(vendor_id: str) -> Usage | None:
        v = vendors.get(vendor_id)
        if v is None or v.placeholder:          # a person not named yet: nothing to book
            return None
        return out.setdefault(vendor_id, Usage(v))

    last = max((d.day_number for d in t.days), default=0)
    services = finance.day_services(db, t)
    for d in t.days:
        if d.hotel_id and d.day_number < last and (u := of(d.hotel_id)):
            u.nights += 1
            u.night_dates.add(d.date)
            u.dates.add(d.date)
        if d.breakfast_id and (d.breakfast_mode or "hotel") in ("included", "tourists") and (u := of(d.breakfast_id)):
            u.breakfasts += 1
            u.tourists_pay += d.breakfast_mode == "tourists"
            u.dates.add(d.date)
        if d.lunch_id and (d.lunch_mode or "included") != "own" and (u := of(d.lunch_id)):
            u.lunches += 1
            u.tourists_pay += d.lunch_mode == "tourists"
            u.dates.add(d.date)
        if d.dinner_id and (d.dinner_mode or "included") != "own" and (u := of(d.dinner_id)):
            u.dinners += 1
            u.tourists_pay += d.dinner_mode == "tourists"
            u.dates.add(d.date)
        # Each hotel the staff sleep in that night (the guide with the group, the driver elsewhere...).
        for where, who in finance.staff_nights(t, d, last).items():
            if (u := of(where)):
                kind = "TWN" if d.staff_twin else "SGL"
                n = -(-len(who) // 2) if d.staff_twin else len(who)
                u.staff_rooms[kind] = max(u.staff_rooms.get(kind, 0), n)
                u.staff_night_dates.add(d.date)
                u.dates.add(d.date)
        for x in d.extras or []:
            s = services.get(x["service_id"])
            if s and (u := of(s.vendor_id)):
                name = f"{s.name} (optional)" if x.get("optional") else s.name
                u.services[name] = u.services.get(name, 0) + 1
                u.dates.add(d.date)
    for a in t.staff:
        if not (u := of(a.vendor_id)):
            continue
        first = a.start_day
        end = a.end_day or last
        u.staff.append({"role": a.role, "from": first, "to": end})
        for d in t.days:
            if first <= d.day_number <= end:
                u.dates.add(d.date)
    return {k: u for k, u in out.items() if u.dates or u.staff}


def fingerprint(t: Tour, u: Usage) -> str:
    """What a confirmation covers: dates and details. If it changes, the booking needs a new confirmation."""
    d = u.details(t)
    d.pop("stays", None)        # derived from the dates, which are already in
    if d.get("staff"):
        d["staff"] = sorted(d["staff"], key=lambda s: (s["from"], s["to"], s["role"]))
    return json.dumps({"dates": sorted(x.isoformat() for x in u.dates), **d}, sort_keys=True)


def sync(db: Session, t: Tour, vendors: dict[str, Vendor] | None = None) -> tuple[list[TourBooking], dict[str, Usage]]:
    """Make the booking rows match the tour: a row for every supplier used; an untouched row of a
    supplier no longer used goes away (a booked one stays, to be cancelled with the supplier)."""
    used = usage(db, t, vendors)
    rows = {b.vendor_id: b for b in db.scalars(select(TourBooking).where(TourBooking.tour_id == t.id))}
    if t.closed_at is None and t.status in LIVE_STATUSES:        # a draft books nothing yet
        missing = [vid for vid in used if vid not in rows]
        stale = [b.id for vid, b in rows.items() if vid not in used and b.status == "to_book" and not b.reference and not b.note]
        if missing or stale:
            # Plain SQL that tolerates another request doing the same at the same moment:
            # inserts skip rows that already exist, deletes only touch still-untouched rows.
            if missing:
                ins = _insert(db)(TourBooking).values([{"id": str(uuid.uuid4()), "tour_id": t.id, "vendor_id": vid,
                                                         "status": "to_book", "reference": "", "note": "", "pay_when": "",
                                                         "pay_method": "transfer", "paid_by": "office", "confirmed_what": "",
                                                         "updated_at": utcnow()} for vid in missing])
                db.execute(ins.on_conflict_do_nothing(index_elements=["tour_id", "vendor_id"]))
            if stale:
                db.execute(delete(TourBooking).where(TourBooking.id.in_(stale), TourBooking.status == "to_book",
                                                     TourBooking.reference == "", TourBooking.note == ""))
            rows = {b.vendor_id: b for b in db.scalars(select(TourBooking).where(TourBooking.tour_id == t.id)
                                                        .execution_options(populate_existing=True))}
    return list(rows.values()), used


def _insert(db: Session):
    return pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert


def first_date(t: Tour, u: Usage | None) -> date:
    return min(u.dates) if u and u.dates else t.start_date


def kind_of(v: Vendor) -> str:
    return KIND.get(v.type, "other")


def book_by(t: Tour, b: TourBooking, u: Usage | None) -> date:
    if b.book_by:
        return b.book_by
    first = min(u.dates) if u and u.dates else t.start_date
    return first - timedelta(days=BOOK_AHEAD[kind_of(b.vendor)])


def state(b: TourBooking, t: Tour, u: Usage | None) -> str:
    """What needs doing: ok | to_book | waiting | changed | cancel | problem | cancelled."""
    if u is None:
        return "cancel" if b.status in ("requested", "confirmed") else "cancelled"
    if b.status == "confirmed":
        return "changed" if b.confirmed_what and b.confirmed_what != fingerprint(t, u) else "ok"
    return {"to_book": "to_book", "requested": "waiting", "problem": "problem", "cancelled": "cancelled"}[b.status]


def owner_of(ws_owners: dict, kind: str) -> str | None:
    return (ws_owners or {}).get(kind) or None
