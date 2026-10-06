"""Changing the hotel on one tour — an overbooked series hotel, or the client asking.

Preview first: the nights, what they cost at the old and the new hotel (catalog prices for that
date and group), the difference in total and per person. Then, on confirm:
- the nights move to the new hotel (and the change goes to the guide and driver),
- the tour's costs are worked out again (the old hotel's unpaid lines go, the new hotel's come),
- the old booking turns into "cancel" and the new hotel appears "to book" (app/bookings.py),
- who pays the difference is recorded as an incident: we do; the partner does (a draft invoice for
  the supplement); or the overbooked hotel does (a claim against it),
- a message for the partner is written, ready to send.
"""
from datetime import date
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import catalog, changes, finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Incident, Tour, Vendor
from ..scoping import get_owned
from . import incidents
from .tours import _load

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["hotel change"])
can_ope = require_jobs('operations')
CENT = Decimal("0.01")
REASON = {"overbooked": "the hotel is overbooked", "client_request": "at your request", "other": "a change in the programme"}


class HotelChangeIn(BaseModel):
    from_hotel_id: str
    to_hotel_id: str
    days: list[int] | None = Field(default=None, max_length=60)   # the nights to move; None = all at that hotel
    reason: Literal["overbooked", "client_request", "other"] = "overbooked"
    who_pays: Literal["agency", "client", "hotel"] = "agency"
    client_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)   # default: the difference
    note: str = Field(default="", max_length=1000)
    preview: bool = False


class Night(BaseModel):
    day: int
    date: date
    old: float | None       # base currency; None = no price in the catalog
    new: float | None


class HotelChangeOut(BaseModel):
    nights: list[Night]
    currency: str           # the agency's
    old_cost: float | None     # None: a price is missing at that hotel
    new_cost: float | None
    difference: float | None   # new − old, for the whole group; None while a price is missing
    per_person: float | None
    missing_prices: list[str]
    client_currency: str
    client_amount: float    # what the partner would be charged (in the tour's selling currency)
    message: str            # for the partner
    incident_id: str | None = None
    invoice_id: str | None = None
    approval_needed: bool = False
    changes: list[str] = []


def _night_cost(v: Vendor, on: date, rooms: dict, pax: int, rates, missing: list[str]) -> Decimal | None:
    total, priced = Decimal(0), True
    for rtype, n in rooms.items():
        rate = catalog.price_for(v, f"room_{rtype}", on, pax)
        if rate is None:
            missing.append(f"{v.name}: no {rtype} price on {on}")
            priced = False
            continue
        total += rate.price * n * finance.rate_for(rates, rate.currency)
    return total if priced else None


@router.post("/tours/{tour_id}/change-hotel", response_model=HotelChangeOut)
def change_hotel(tour_id: str, body: HotelChangeIn, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    if t.closed_at is not None or t.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is closed or cancelled")
    old, new = get_owned(db, ctx, Vendor, body.from_hotel_id), get_owned(db, ctx, Vendor, body.to_hotel_id)
    if new.type != "hotel" or old.id == new.id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a different hotel")
    last = max((d.day_number for d in t.days), default=0)
    days = [d for d in sorted(t.days, key=lambda d: d.day_number)
            if d.hotel_id == old.id and d.day_number < last and (body.days is None or d.day_number in body.days)]
    if not days:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"No night at {old.name} on the chosen days")
    rates = finance.rates(db, ctx.workspace)
    rooms = finance.room_counts(t)
    if not rooms:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The tour's rooms aren't known: fill in Rooms first")
    pax = finance.group_size(t)
    missing: list[str] = []
    nights, old_total, new_total = [], Decimal(0), Decimal(0)
    old_known = new_known = True
    for d in days:
        a, b = _night_cost(old, d.date, rooms, pax, rates, missing), _night_cost(new, d.date, rooms, pax, rates, missing)
        old_known, new_known = old_known and a is not None, new_known and b is not None
        old_total += a or 0
        new_total += b or 0
        nights.append(Night(day=d.day_number, date=d.date, old=float(a.quantize(CENT)) if a is not None else None,
                            new=float(b.quantize(CENT)) if b is not None else None))
    # A missing price would make the difference up: say it isn't known instead.
    diff = (new_total - old_total).quantize(CENT) if not missing else None
    paying = t.quote_tourists or max(t.pax, 0) or None
    per_person = (diff / paying).quantize(CENT) if paying and diff is not None else None
    cur = t.price_currency or ctx.workspace.base_currency
    cur_rate = finance.rate_for(rates, cur) or Decimal(1)
    default_charge = max(diff or Decimal(0), Decimal(0)) / cur_rate
    charge = (body.client_amount if body.client_amount is not None else default_charge).quantize(CENT)

    dates = ", ".join(d.date.strftime("%d %b") for d in days)
    city = days[0].city or new.city
    price_text = (f"The price goes up by {(charge / paying).quantize(CENT) if paying else charge} {cur} per person "
                  f"({charge} {cur} for the group); we'll send an additional invoice."
                  if body.who_pays == "client" and charge > 0 else "This doesn't change the price.")
    message = (f"{t.code}: because {REASON[body.reason]}, the group stays at {new.name} instead of {old.name}"
               f"{' in ' + city if city else ''} on {dates}. {price_text}")
    out = HotelChangeOut(nights=nights, currency=ctx.workspace.base_currency,
                         old_cost=float(old_total.quantize(CENT)) if old_known else None,
                         new_cost=float(new_total.quantize(CENT)) if new_known else None, difference=float(diff) if diff is not None else None,
                         per_person=float(per_person) if per_person is not None else None, missing_prices=missing,
                         client_currency=cur, client_amount=float(charge), message=message)
    if body.preview:
        return out

    if body.who_pays == "client" and charge > 0 and not t.client_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Set the tour's client first: the supplement is invoiced to them")
    before = changes.snapshot(t)
    for d in days:
        d.hotel_id = new.id
    out.changes = changes.record(db, t, before, ctx.user.id)
    for d in days:
        db.expire(d, ["hotel"])            # the costs read the day's hotel: the new one
    finance.generate(db, ctx.workspace, t)
    i = Incident(workspace_id=ctx.workspace.id, tour_id=t.id, day=days[0].day_number,
                 kind="vendor_failure" if body.reason == "overbooked" else "client_request" if body.reason == "client_request" else "other",
                 title=f"Hotel change: {old.name} → {new.name}"[:200], description=f"{message}\n{body.note}".strip(),
                 carried_by={"agency": "agency", "client": "client", "hotel": "vendor"}[body.who_pays],
                 vendor_id=old.id if body.who_pays == "hotel" else None, reported_by_id=ctx.user.id, costs=[])
    if body.who_pays == "client" and charge > 0:
        i.client_charge, i.client_currency = charge, cur
    if body.who_pays == "hotel" and diff is not None and diff > 0:
        i.vendor_claim, i.claim_currency = diff, ctx.workspace.base_currency
    db.add(i)
    db.commit()
    out.incident_id = i.id
    if i.client_charge or i.vendor_claim:
        try:
            incidents.approve(i.id, incidents.Decision(note="Hotel change"), ctx=ctx, db=db)
            db.refresh(i)
            out.invoice_id = i.invoice_id
        except HTTPException as e:
            if e.status_code != status.HTTP_403_FORBIDDEN:
                raise
            out.approval_needed = True          # above the agency's limit: an admin approves it
    else:
        i.status = "approved"
        db.commit()
    return out
