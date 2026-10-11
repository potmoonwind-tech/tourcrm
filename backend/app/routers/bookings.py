"""A tour's bookings: every supplier, whether it is booked, by whom, and how it is paid."""
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from typing import Literal
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import bookings as bk
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import LIVE_STATUSES, Membership, TourBooking, User, utcnow
from .tours import _load

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["bookings"])
office = require_role("staff")

Status = Literal["to_book", "requested", "confirmed", "problem", "cancelled"]


class BookingVendor(BaseModel):
    id: str
    name: str
    type: str
    phone: str
    email: str
    contact_person: str


class BookingOut(BaseModel):
    id: str
    vendor: BookingVendor
    kind: str                      # hotel | meal | transport | guide | activity | other
    first_date: date | None
    last_date: date | None
    details: dict                  # nights, rooms, lunches, dinners, people, services, staff
    in_itinerary: bool
    status: Status
    state: str                     # ok | to_book | waiting | changed | cancel | problem | cancelled
    reference: str
    note: str
    assignee_id: str | None        # chosen for this booking
    default_assignee_id: str | None  # Settings → Who does what
    book_by: date
    book_by_custom: bool
    pay_when: str
    pay_method: str
    paid_by: str
    confirmed_at: datetime | None


class BookingsOut(BaseModel):
    bookings: list[BookingOut]
    confirmed: int                 # in the itinerary and confirmed (and unchanged)
    total: int                     # in the itinerary


class BookingUpdate(BaseModel):
    status: Status | None = None
    reference: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=1000)
    assignee_id: str | None = None
    book_by: date | None = None
    pay_when: Literal["", "asap", "before", "after", "on_site"] | None = None
    pay_method: Literal["transfer", "cash", "card"] | None = None
    paid_by: Literal["office", "guide"] | None = None


def out(t, b: TourBooking, used: dict, owners: dict) -> BookingOut:
    u = used.get(b.vendor_id)
    v = b.vendor
    kind = bk.kind_of(v)
    return BookingOut(
        id=b.id, kind=kind, in_itinerary=u is not None,
        vendor=BookingVendor(id=v.id, name=v.name, type=v.type, phone=v.phone, email=v.email, contact_person=v.contact_person),
        first_date=min(u.dates) if u and u.dates else None, last_date=max(u.dates) if u and u.dates else None,
        details=u.details(t) if u else {}, status=b.status, state=bk.state(b, t, u),
        reference=b.reference, note=b.note, assignee_id=b.assignee_id, default_assignee_id=bk.owner_of(owners, kind),
        book_by=bk.book_by(t, b, u), book_by_custom=b.book_by is not None,
        pay_when=b.pay_when, pay_method=b.pay_method, paid_by=b.paid_by, confirmed_at=b.confirmed_at,
    )


ORDER = {"hotel": 0, "meal": 1, "transport": 2, "guide": 3, "activity": 4, "other": 5}


def _listing(db: Session, ctx: WorkspaceCtx, tour_id: str) -> BookingsOut:
    t = _load(db, ctx, tour_id)
    rows, used = bk.sync(db, t)
    db.commit()
    items = [out(t, b, used, ctx.workspace.task_owners) for b in rows]
    items.sort(key=lambda x: (not x.in_itinerary, x.first_date or date.max, ORDER[x.kind], x.vendor.name.lower()))
    live = [x for x in items if x.in_itinerary and x.status != "cancelled"]
    return BookingsOut(bookings=items, confirmed=sum(1 for x in live if x.state == "ok"), total=len(live))


@router.get("/tours/{tour_id}/bookings", response_model=BookingsOut)
def list_bookings(tour_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    return _listing(db, ctx, tour_id)


@router.patch("/tours/{tour_id}/bookings/{booking_id}", response_model=BookingsOut)
def update_booking(tour_id: str, booking_id: str, body: BookingUpdate, ctx: WorkspaceCtx = Depends(office),
                   db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    b = db.scalar(select(TourBooking).where(TourBooking.id == booking_id, TourBooking.tour_id == t.id))
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found")
    values = body.model_dump(exclude_unset=True)
    _check_assignee(db, ctx, values)
    _apply(db, t, b, values)
    db.commit()
    return _listing(db, ctx, tour_id)


def _check_assignee(db: Session, ctx: WorkspaceCtx, values: dict) -> None:
    if values.get("assignee_id"):
        member = db.scalar(select(Membership).where(Membership.workspace_id == ctx.workspace.id,
                                                    Membership.user_id == values["assignee_id"]))
        if not member or not db.get(User, values["assignee_id"]):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Not a member of this agency")


def _apply(db: Session, t, b: TourBooking, values: dict) -> None:
    for k, v in values.items():
        if v is None and k not in ("assignee_id", "book_by"):
            continue
        setattr(b, k, v)
    if values.get("status") == "confirmed":
        # Remember what was confirmed, so a later change of the tour shows "confirm again".
        u = bk.usage(db, t).get(b.vendor_id)
        b.confirmed_at = utcnow()
        b.confirmed_what = bk.fingerprint(t, u) if u else ""
    elif "status" in values:
        b.confirmed_at, b.confirmed_what = None, ""


# --- a series: one supplier, all its departures ------------------------------------------------------
# A series hotel is contracted once (an allotment for the season), not 21 times: confirm it, give it
# to one person, set its payment terms — for every departure at once.

class SeriesTourBooking(BaseModel):
    tour_id: str
    code: str
    start_date: date
    booking_id: str
    status: str
    state: str
    reference: str
    details: dict
    assignee_id: str | None
    book_by: date


class SeriesSupplier(BaseModel):
    vendor: BookingVendor
    kind: str
    tours: list[SeriesTourBooking]
    confirmed: int
    total: int


def _series_tours(db: Session, ctx: WorkspaceCtx, series_id: str):
    from ..models import Series, Tour
    s = db.scalar(select(Series).where(Series.id == series_id, Series.workspace_id == ctx.workspace.id))
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Route not found")
    return [_load(db, ctx, tid) for tid in db.scalars(
        select(Tour.id).where(Tour.series_id == s.id, Tour.status.in_(LIVE_STATUSES), Tour.closed_at.is_(None),
                              Tour.end_date >= date.today()).order_by(Tour.start_date))]


def _series_listing(db: Session, ctx: WorkspaceCtx, series_id: str) -> list[SeriesSupplier]:
    groups: dict[str, SeriesSupplier] = {}
    for t in _series_tours(db, ctx, series_id):
        rows, used = bk.sync(db, t)
        for b in rows:
            u = used.get(b.vendor_id)
            if u is None:
                continue
            o = out(t, b, used, ctx.workspace.task_owners)
            g = groups.setdefault(b.vendor_id, SeriesSupplier(vendor=o.vendor, kind=o.kind, tours=[], confirmed=0, total=0))
            g.tours.append(SeriesTourBooking(tour_id=t.id, code=t.code, start_date=t.start_date, booking_id=b.id, status=b.status,
                                             state=o.state, reference=b.reference, details=o.details,
                                             assignee_id=b.assignee_id or o.default_assignee_id, book_by=o.book_by))
            g.total += b.status != "cancelled"
            g.confirmed += o.state == "ok"
    db.commit()
    return sorted(groups.values(), key=lambda g: (ORDER[g.kind], g.vendor.name.lower()))


@router.get("/series/{series_id}/bookings", response_model=list[SeriesSupplier])
def series_bookings(series_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """Every supplier of a route's upcoming departures, with each departure's booking."""
    return _series_listing(db, ctx, series_id)


class SeriesUpdate(BookingUpdate):
    vendor_id: str
    tour_ids: list[str] | None = None        # None: every upcoming departure


@router.post("/series/{series_id}/bookings", response_model=list[SeriesSupplier])
def update_series_bookings(series_id: str, body: SeriesUpdate, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    values = body.model_dump(exclude_unset=True, exclude={"vendor_id", "tour_ids"})
    _check_assignee(db, ctx, values)
    for t in _series_tours(db, ctx, series_id):
        if body.tour_ids is not None and t.id not in body.tour_ids:
            continue
        rows, _ = bk.sync(db, t)
        for b in rows:
            if b.vendor_id == body.vendor_id:
                _apply(db, t, b, values)
    db.commit()
    return _series_listing(db, ctx, series_id)
