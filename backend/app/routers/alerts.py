"""Alerts: conflicts and things that need attention, per tour and across the agency.

Each alert is a code with parameters (the screen words it in the user's language),
a severity, the tour and day it concerns, and the tab where it gets fixed.
Operations alerts are for everyone in the office; money alerts only for managers.

  error    something is wrong now (a guide booked on two tours at once, an overdue client)
  warning  will go wrong if nobody acts (no hotel for a night, passports expiring)
  info     worth knowing (open incidents, a finished tour not closed yet)
"""
from collections import defaultdict
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import bookings, finance, geo
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import FieldExpense, Incident, Invoice, Service, StaffAssignment, Tour, TourDay, Vendor
from ..dishes import names as dish_names
from .people import rooming

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["alerts"])
office = require_role("staff")

Severity = Literal["error", "warning", "info"]
RANK = {"error": 0, "warning": 1, "info": 2}
# Only people can't be in two places at once; a transport company has a fleet.
BOOKED_ROLES = ("guide", "driver", "assistant")
PERSON_TYPES = ("guide", "driver")


class Alert(BaseModel):
    code: str
    severity: Severity
    tour_id: str
    tour_code: str
    start_date: date
    day: int | None = None
    link: str = ""                  # tour tab: itinerary | participants | staff | costs | incidents
    params: dict[str, str | int | float] = {}


LONG_DRIVE = 9 * 60      # minutes of driving a day (coach time) above which the day is flagged


def _span(a: StaffAssignment, t: Tour) -> tuple[date, date]:
    last = (t.end_date - t.start_date).days + 1
    return (t.start_date + timedelta(days=a.start_day - 1), t.start_date + timedelta(days=(a.end_day or last) - 1))


def _load(db: Session, ws_id: str, tour_ids: list[str] | None = None) -> list[Tour]:
    today = date.today()
    stmt = (select(Tour).where(Tour.workspace_id == ws_id, Tour.closed_at.is_(None))
            .options(selectinload(Tour.days).selectinload(TourDay.hotel), selectinload(Tour.staff).selectinload(StaffAssignment.vendor),
                     selectinload(Tour.participants), selectinload(Tour.costs), selectinload(Tour.payments),
                     selectinload(Tour.bills), selectinload(Tour.series), selectinload(Tour.client)))
    if tour_ids is not None:
        stmt = stmt.where(Tour.id.in_(tour_ids))
    else:  # what is still alive: upcoming, running, or ended in the last 90 days
        stmt = stmt.where(Tour.end_date >= today - timedelta(days=90))
    return list(db.scalars(stmt))


def _double_bookings(db: Session, ws_id: str, tours: list[Tour]) -> dict[str, list[Alert]]:
    """Guides, drivers and vehicles assigned to two tours on the same days."""
    rows = db.execute(select(StaffAssignment, Tour).join(Tour)
                      .join(Vendor, Vendor.id == StaffAssignment.vendor_id)
                      .where(Tour.workspace_id == ws_id, Tour.status != "cancelled", StaffAssignment.role.in_(BOOKED_ROLES),
                             Vendor.type.in_(PERSON_TYPES), Vendor.placeholder.is_(False))
                      .options(selectinload(StaffAssignment.vendor))).all()
    by_vendor: dict[str, list[tuple[StaffAssignment, Tour, date, date]]] = defaultdict(list)
    for a, t in rows:
        lo, hi = _span(a, t)
        by_vendor[a.vendor_id].append((a, t, lo, hi))
    wanted = {t.id for t in tours}
    out: dict[str, list[Alert]] = defaultdict(list)
    for items in by_vendor.values():
        for i, (a, t, lo, hi) in enumerate(items):
            for b, u, lo2, hi2 in items[i + 1:]:
                if t.id == u.id or lo > hi2 or lo2 > hi:
                    continue
                start, end = max(lo, lo2), min(hi, hi2)
                for me, other in ((t, u), (u, t)):
                    if me.id in wanted:
                        out[me.id].append(Alert(
                            code="staff_double_booked", severity="error", tour_id=me.id, tour_code=me.code,
                            start_date=me.start_date, day=(start - me.start_date).days + 1, link="staff",
                            params={"vendor": a.vendor.name, "other": other.code, "from": start.isoformat(), "to": end.isoformat()}))
    return out


def _food_alerts(t: Tour, menus: dict, add) -> None:
    """The same dish twice in a day, on two days running, or on many days of the tour."""
    by_day: dict[int, dict[str, str]] = {}      # day → {normalized dish: as written}
    for d in sorted(t.days, key=lambda x: x.day_number):
        seen: dict[str, str] = {}
        twice: list[str] = []
        for menu_id in (d.breakfast_menu_id, d.lunch_menu_id, d.dinner_menu_id):
            menu = menus.get(menu_id) if menu_id else None
            for dish in dish_names(menu.dishes) if menu else []:
                k = dish.strip().lower()
                if k in seen and seen[k] not in twice:
                    twice.append(seen[k])
                seen.setdefault(k, dish)
        if twice:
            add("dish_same_day", "warning", "meals", d.day_number, dishes=", ".join(twice))
        prev = by_day.get(d.day_number - 1, {})
        again = [v for k, v in seen.items() if k in prev]
        if again:
            add("dish_next_day", "warning", "meals", d.day_number, dishes=", ".join(again))
        by_day[d.day_number] = seen
    days_of: dict[str, set[int]] = defaultdict(set)
    names: dict[str, str] = {}
    for n, dishes in by_day.items():
        for k, v in dishes.items():
            days_of[k].add(n)
            names.setdefault(k, v)
    often = sorted(((len(ds), names[k]) for k, ds in days_of.items() if len(ds) >= 3), key=lambda x: (-x[0], x[1]))
    if often:  # one line, the most repeated first
        add("dish_often", "info", "meals", dishes=", ".join(f"{name} ({n})" for n, name in often[:6]), n=len(often))


def tour_alerts(db: Session, ctx: WorkspaceCtx, tours: list[Tour]) -> list[Alert]:
    today = date.today()
    money = ctx.can("finance")
    booked = _double_bookings(db, ctx.workspace.id, tours)
    service_ids = {x["service_id"] for t in tours for d in t.days for x in d.extras or []}
    menu_ids = {m for t in tours for d in t.days for m in (d.breakfast_menu_id, d.lunch_menu_id, d.dinner_menu_id) if m}
    menus = {s.id: s for s in db.scalars(select(Service).join(Vendor).where(
        Service.id.in_(menu_ids), Vendor.workspace_id == ctx.workspace.id))} if menu_ids else {}
    service_vendor = dict(db.execute(select(Service.id, Service.vendor_id).join(Vendor).where(
        Service.id.in_(service_ids), Vendor.workspace_id == ctx.workspace.id)).all()) if service_ids else {}
    known = set(service_vendor)
    service_cat = dict(db.execute(select(Service.id, Service.category).where(Service.id.in_(service_ids))).all()) if service_ids else {}
    ids = [t.id for t in tours]
    open_incidents: dict[str, int] = defaultdict(int)
    for tid in db.scalars(select(Incident.tour_id).where(Incident.tour_id.in_(ids), Incident.status == "open")):
        open_incidents[tid] += 1
    invoices: dict[str, list[Invoice]] = defaultdict(list)
    waiting_reports: dict[str, int] = defaultdict(int)       # guide expenses the office hasn't decided
    if money and ids:
        for tid in db.scalars(select(FieldExpense.tour_id).where(FieldExpense.tour_id.in_(ids), FieldExpense.status == "pending")):
            waiting_reports[tid] += 1
        for inv in db.scalars(select(Invoice).where(Invoice.tour_id.in_(ids), Invoice.status == "issued", Invoice.kind == "invoice")
                              .options(selectinload(Invoice.lines), selectinload(Invoice.payments),
                                       selectinload(Invoice.credit_notes).selectinload(Invoice.lines))):
            invoices[inv.tour_id].append(inv)

    all_vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ctx.workspace.id))}
    out: list[Alert] = []
    for t in tours:
        def add(code: str, severity: Severity, link: str = "", day: int | None = None, **params):
            out.append(Alert(code=code, severity=severity, tour_id=t.id, tour_code=t.code, start_date=t.start_date,
                             day=day, link=link, params=params))

        out.extend(booked.get(t.id, []))
        if waiting_reports.get(t.id):
            add("guide_reports", "warning", "costs", n=waiting_reports[t.id])
        live = t.status != "cancelled"
        upcoming = live and t.end_date >= today
        days_to_start = (t.start_date - today).days
        if upcoming:
            _food_alerts(t, menus, add)
            for a in t.staff:
                lo, hi = _span(a, t)
                for away in a.vendor.unavailable or []:
                    s, e = date.fromisoformat(away["start"]), date.fromisoformat(away["end"])
                    if s <= hi and lo <= e:
                        first = max(s, lo)
                        add("staff_unavailable", "error", "staff", (first - t.start_date).days + 1, vendor=a.vendor.name,
                            **{"from": first.isoformat(), "to": min(e, hi).isoformat()}, note=away.get("note") or "")
            last = len(t.days)
            nights = [d for d in t.days if d.day_number < last]
            # Group size still a guess (or unknown) three weeks before: rooms, meals and costs depend on it.
            if days_to_start <= 21 and (t.pax == 0 or t.pax_estimated):
                add("pax_unconfirmed", "warning", "", n=t.pax)
            for d in t.days:
                for f in d.flights or []:
                    # A ride: a bus/driver on Staff that day, or a transport service in the day's plan.
                    rides = [a for a in t.staff if a.covers(d.day_number) and a.role in ("transport", "driver")] or                         [x for x in d.extras or [] if service_cat.get(x["service_id"]) == "transport"]
                    if not rides:
                        add("flight_no_transport", "warning", "staff", d.day_number, flight=f.get("number", ""),
                            direction=f.get("direction", ""))
                    # Evening flights, and the ones just after midnight (ZV: CZ8164 at 00:45 — the night after
                    # the last day): the group checks out in the morning and waits all day.
                    late = (f.get("time") or "") >= "18:00" or "00:00" <= (f.get("time") or "99") < "05:00"
                    # A day room / late checkout (a hotel service that day) answers it.
                    day_room = any(service_cat.get(x["service_id"]) == "hotel" for x in d.extras or [])
                    if f.get("direction") == "departure" and late and d.day_number == len(t.days) and not day_room:
                        add("flight_late_checkout", "info", "itinerary", d.day_number, flight=f.get("number", ""), time=f["time"])
            # A long day on the road for the coach driver (car time from the map × the agency's coach factor).
            factor = float(ctx.workspace.drive_factor or 1.25)
            for d in t.days:
                drive = round(sum(d.drive_minutes or []) * factor)
                if drive > LONG_DRIVE:
                    add("long_drive", "warning", "itinerary", d.day_number, n=d.day_number, hours=f"{drive // 60}:{drive % 60:02d}")
            missing = [d.day_number for d in nights if not d.hotel_id]
            if missing:
                add("no_hotel", "warning", "itinerary", missing[0], days=", ".join(map(str, missing)), n=len(missing))
            # Hotel nights but nobody knows how many rooms: the hotel can't be costed or booked.
            if any(d.hotel_id for d in nights) and not finance.room_counts(t):
                add("rooms_unknown", "warning", "")
            # Six weeks out and whole parts of the trip not planned: a route made from the partner's list of
            # hotels has no meals, no transport, no guide — say so before the bookings are due.
            if 0 <= days_to_start <= 45 and t.days:
                extras_cat = {service_cat.get(x["service_id"]) for d in t.days for x in d.extras or []}
                gaps = []
                if not any(d.lunch_id or d.dinner_id or (d.lunch_mode or "included") != "included"
                           or (d.dinner_mode or "included") != "included" for d in t.days):
                    gaps.append("meals")
                if "transport" not in extras_cat and not any(a.role in ("transport", "driver") for a in t.staff):
                    gaps.append("transport")
                if "guide" not in extras_cat and not any(a.role in ("guide", "tour_leader") for a in t.staff):
                    gaps.append("guide")
                if gaps:
                    add("plan_incomplete", "warning", "itinerary", what=",".join(gaps), days=days_to_start)
            for d in t.days:
                # The same town in another alphabet ("Tbilisi" / "თბილისი") is the same town.
                if d.hotel and d.hotel.city and d.city and geo.town_key(d.hotel.city) != geo.town_key(d.city):
                    add("hotel_city", "warning", "itinerary", d.day_number, hotel=d.hotel.name, city=d.city, hotel_city=d.hotel.city)
                removed = [x for x in d.extras or [] if x["service_id"] not in known]
                if removed:
                    add("service_removed", "warning", "itinerary", d.day_number, n=len(removed))
            # The same supplier on Staff and as a day service the same day: it would be paid twice.
            twice: dict[str, list[int]] = defaultdict(list)
            for a in t.staff:
                first, last = _span(a, t)
                for d in t.days:
                    if first <= d.date <= last and any(service_vendor.get(x["service_id"]) == a.vendor_id for x in d.extras or []):
                        twice[a.vendor.name].append(d.day_number)
            for name, days_ in twice.items():
                add("counted_twice", "warning", "staff", days_[0], name=name, days=", ".join(map(str, sorted(set(days_)))))
            # Bookings past their "book by" date and not confirmed (or changed, or to cancel).
            if t.closed_at is None and days_to_start <= 45:
                rows, used = bookings.sync(db, t, all_vendors)
                late = [b for b in rows if bookings.state(b, t, used.get(b.vendor_id)) in bookings.LATE_STATES
                        and bookings.book_by(t, b, used.get(b.vendor_id)) <= today
                        and bookings.first_date(t, used.get(b.vendor_id)) > today]
                if late:
                    add("bookings_late", "error" if days_to_start <= 3 else "warning", "bookings", n=len(late),
                        names=", ".join(sorted(b.vendor.name for b in late)[:4]))
            if t.status == "confirmed" and not t.client_id:
                add("no_client", "warning", "")
            guides = [a for a in t.staff if a.role == "guide"]
            if t.status == "confirmed" and 0 <= days_to_start <= 7 and not guides:
                add("no_guide", "warning", "staff", days=days_to_start)
            if t.participants:
                r = rooming(t)
                if r.unassigned:
                    add("rooms_unassigned", "warning", "participants", n=r.unassigned)
                if r.passport_warnings:
                    add("passports", "warning", "participants", n=r.passport_warnings)
                if t.pax and abs(len(t.participants) - (t.pax + (t.leaders or 0))) > 0:
                    add("pax_mismatch", "info", "participants", pax=t.pax + (t.leaders or 0), listed=len(t.participants))
            elif t.status == "confirmed" and 0 <= days_to_start <= 14:
                add("no_participants", "warning", "participants", days=days_to_start)
        if open_incidents.get(t.id):
            add("incidents_open", "info", "incidents", n=open_incidents[t.id])
        if live and t.end_date < today - timedelta(days=14):
            add("not_closed", "info", "", days=(today - t.end_date).days)
        if money:
            overdue = [i for i in invoices.get(t.id, []) if i.balance > 0 and i.due_date < today]
            if overdue:
                add("client_overdue", "error", "costs", n=len(overdue),
                    amount=" + ".join(f"{i.balance:,.2f} {i.currency}" for i in overdue))
            vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.id.in_(
                {c.vendor_id for c in t.costs if c.vendor_id} | {p.vendor_id for p in t.payments} | {b.vendor_id for b in t.bills})))}
            payables = finance.payables(t, vendors, today, ctx.workspace.bill_tolerance_pct)
            late = [p for p in payables if p.status == "overdue"]
            if late:
                add("vendor_overdue", "warning", "costs", n=len(late))
            if any(p.bill_state == "disputed" for p in payables):
                add("bill_disputed", "warning", "costs")
            no_rate = sorted({c.currency for c in t.costs if c.rate_to_base == 0 and c.amount}
                             | {i.currency for i in invoices.get(t.id, []) if i.rate_to_base == 0 and i.total})
            if no_rate:
                add("rate_missing", "error", "costs", currencies=", ".join(no_rate), base=ctx.workspace.base_currency)
            zero = [c for c in t.costs if c.vendor_id and c.amount == 0 and not c.incident_id]
            if upcoming and zero:
                add("zero_costs", "warning", "costs", n=len(zero))
    out.sort(key=lambda a: (RANK[a.severity], a.start_date, a.tour_code, a.day or 0))
    return out


@router.get("/tours/{tour_id}/alerts", response_model=list[Alert])
def alerts_for_tour(tour_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    tours = _load(db, ctx.workspace.id, [tour_id])
    if not tours:
        exists = db.scalar(select(Tour.id).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id))
        if not exists:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
        return []      # closed tours raise no alerts
    out = tour_alerts(db, ctx, tours)
    db.commit()       # bookings may have been brought up to date
    return out


@router.get("/alerts", response_model=list[Alert])
def all_alerts(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    out = tour_alerts(db, ctx, _load(db, ctx.workspace.id))[:300]
    db.commit()
    return out

