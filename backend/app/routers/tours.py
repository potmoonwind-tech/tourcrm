from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .. import changes
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import Client, Participant, Series, SeriesDay, StaffAssignment, Tour, TourDay, Vendor
from ..schemas import (
    BusReturn, DayFields, DayViewRow, StaffOut, TourCreate, TourDayOut, TourDayUpdate, TourOut, TourStatus, TourSummary, TourUpdate, VendorRef,
)
from ..scoping import check_day_refs, check_refs, get_owned
from .lifecycle import phase

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["tours"])

read = require_role("staff")
write = require_role("staff")      # staff run day-to-day itineraries
admin_write = require_role("manager")  # deleting a tour is a manager decision

MAX_TOUR_DAYS = 60
_summary_opts = (
    selectinload(Tour.series), selectinload(Tour.client),
    selectinload(Tour.staff).selectinload(StaffAssignment.vendor),
)
_day_opts = selectinload(Tour.days).options(
    selectinload(TourDay.hotel), selectinload(TourDay.lunch), selectinload(TourDay.dinner))


def summary(t: Tour, participant_count: int | None = None) -> TourSummary:
    return TourSummary(
        id=t.id, code=t.code, name=t.name,
        series_id=t.series_id, series_code=t.series.code if t.series else None,
        color=t.series.color if t.series else "slate",
        client_id=t.client_id, client_name=t.client.name if t.client else None,
        start_date=t.start_date, end_date=t.end_date, status=t.status, pax=t.pax, pax_estimated=t.pax_estimated, rooms=t.rooms, quote_id=t.quote_id,
        staff=[StaffOut.model_validate(a) for a in t.staff],
        participant_count=len(t.participants) if participant_count is None else participant_count,
        phase=phase(t), closed_at=t.closed_at,
    )


def participant_counts(db: Session, tour_ids: list[str]) -> dict[str, int]:
    if not tour_ids:
        return {}
    rows = db.execute(select(Participant.tour_id, func.count()).where(Participant.tour_id.in_(tour_ids))
                      .group_by(Participant.tour_id))
    return dict(rows.all())


def full(t: Tour, money: bool = False) -> TourOut:
    return TourOut(**summary(t).model_dump(), notes=t.notes, plate_share=t.plate_share, leaders=t.leaders or 0,
                   staff_table=bool(t.staff_table), bus_return=t.bus_return,
                   days=[TourDayOut.model_validate(d) for d in t.days],
                   price_pp=t.price_pp if money else None, price_currency=t.price_currency if money else None,
                   route_changed=_route_changed(t))


def _route_changed(t: Tour) -> bool:
    changed = t.series.days_changed_at if t.series else None
    if not changed or not t.created_at:
        return False
    since = max(x.replace(tzinfo=None) for x in (t.created_at, t.route_synced_at) if x)   # SQLite drops the zone
    return changed.replace(tzinfo=None) > since


def _price_allowed(ctx: WorkspaceCtx, values: dict) -> None:
    if ("price_pp" in values or "price_currency" in values) and not ctx.can("operations", "finance", "sales"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers set prices")


def _load(db: Session, ctx: WorkspaceCtx, tour_id: str) -> Tour:
    # populate_existing: after an update, re-read links (guide, hotel...) from the
    # database instead of returning the objects cached before the change.
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(*_summary_opts, _day_opts).execution_options(populate_existing=True))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def _check_dates(start: date, end: date) -> None:
    if end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "End date is before start date")
    if (end - start).days + 1 > MAX_TOUR_DAYS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"A tour can be at most {MAX_TOUR_DAYS} days")


def busy_elsewhere(db: Session, t: Tour, vendor_id: str, start: date, end: date) -> str | None:
    """The tour this person already works on in these dates (a weekly 9-day series overlaps by 2 days)."""
    rows = db.execute(select(StaffAssignment, Tour).join(Tour, StaffAssignment.tour_id == Tour.id).where(
        StaffAssignment.vendor_id == vendor_id, Tour.workspace_id == t.workspace_id, Tour.status != "cancelled",
        Tour.id != t.id, Tour.start_date <= end, Tour.end_date >= start)).all()
    for s, o in rows:
        n = (o.end_date - o.start_date).days + 1
        s_from = o.start_date + timedelta(days=s.start_day - 1)
        s_to = o.start_date + timedelta(days=(s.end_day or n) - 1)
        if s_from <= end and s_to >= start:
            return o.code
    return None


def staff_from_plan(db: Session, t: Tour, series: Series) -> tuple[list[str], list[str]]:
    """Add the route's named people to a tour. A plan line is already there when someone in that role
    on those days is the same person, or was added for the same line (its label) — so a guide changed
    on this departure stays, and a second guide (an Armenian one joining for days 7–8) is still added.
    Lines with the same label are alternatives ("Chinese-speaking guide": A or B): the first one who
    isn't busy on another tour those days is given. Returns (what was added, who was busy) in words."""
    n = len(t.days) or (t.end_date - t.start_date).days + 1
    added: list[str] = []
    busy: list[tuple[str, str]] = []
    for x in series.staff_plan or []:
        if not x.get("vendor_id") or x["from_day"] > n:
            continue
        a, b = x["from_day"], min(x.get("to_day") or n, n)
        label = (x.get("label") or "").strip()
        if any(s.role == x["role"] and s.start_day <= b and (s.end_day or n) >= a
               and (s.vendor_id == x["vendor_id"] or (label and (s.notes or "").strip() == label)) for s in t.staff):
            continue
        other = busy_elsewhere(db, t, x["vendor_id"], t.start_date + timedelta(days=a - 1), t.start_date + timedelta(days=b - 1))
        days = f"Day {a}" if a == b else f"Days {a}–{b}"
        if other:
            v = db.get(Vendor, x["vendor_id"])
            busy.append((f"{days}: {v.name if v else x['role']} is busy on {other}", label))
            continue
        t.staff.append(StaffAssignment(vendor_id=x["vendor_id"], role=x["role"], start_day=a,
                                       end_day=None if b == n else b, notes=x.get("label", "")))
        db.flush()      # the next departure sees this one
        added.append(f"{days}: {x['role'].replace('_', ' ')} from the route added")
    # A busy person whose alternative (same label) was given is no news.
    have = {(s.notes or "").strip() for s in t.staff}
    return added, [m for m, label in busy if not (label and label in have)]


def sync_days(t: Tour, template: list[SeriesDay] | None = None) -> None:
    """Make t.days match t.start_date..t.end_date.

    Days keep their content by day number: moving the start date shifts the
    whole itinerary, shortening drops days from the end, lengthening appends
    days (pre-filled from the template when there is one).
    """
    n = (t.end_date - t.start_date).days + 1
    days = sorted(t.days, key=lambda d: d.day_number)
    for d in days[n:]:
        t.days.remove(d)
    for i, d in enumerate(days[:n]):
        d.date = t.start_date + timedelta(days=i)
    for i in range(len(days), n):
        fields = {}
        if template and i < len(template):
            src = template[i]
            fields = {k: getattr(src, k) for k in
                      ("city", "hotel_id", "breakfast_id", "breakfast_menu_id", "lunch_id", "dinner_id", "lunch_menu_id", "dinner_menu_id",
                       "border_crossing", "notes", "km")}
            fields["extras"] = [dict(x) for x in src.extras or []]
            fields["stops"] = list(src.stops or [])
            fields["lunch_mode"], fields["dinner_mode"] = src.lunch_mode or "included", src.dinner_mode or "included"
            fields["breakfast_mode"] = src.breakfast_mode or "hotel"
            fields["flights"] = [dict(f) for f in src.flights or []]
            fields["schedule"] = [dict(x) for x in src.schedule or []]
            fields["drive_minutes"] = list(src.drive_minutes or [])
            fields["drive_km"] = list(src.drive_km or [])
            fields["staff_stay"], fields["staff_hotel_id"] = src.staff_stay or "none", src.staff_hotel_id
            fields["staff_twin"] = bool(src.staff_twin)
        t.days.append(TourDay(day_number=i + 1, date=t.start_date + timedelta(days=i), **fields))
    # Staff ranges are day numbers: drop the ones that now start after the
    # last day, and let ranges running past the end run "until the end".
    for a in list(t.staff):
        if a.start_day > n:
            t.staff.remove(a)
        elif a.end_day is not None and a.end_day > n:
            a.end_day = None


def _code_taken(db: Session, ctx: WorkspaceCtx, code: str, exclude_id: str | None = None) -> bool:
    stmt = select(Tour.id).where(Tour.workspace_id == ctx.workspace.id, Tour.code == code)
    if exclude_id:
        stmt = stmt.where(Tour.id != exclude_id)
    return db.scalar(stmt) is not None


def _generate_code(db: Session, ctx: WorkspaceCtx, series: Series | None, start: date) -> str:
    # Same convention as the agencies' spreadsheets: SERIES-MMDD (e.g. HM-0906),
    # with a letter suffix when two groups of one series start the same day.
    base = f"{series.code}-{start:%m%d}" if series else f"T-{start:%y%m%d}"
    code, suffix = base, ord("B")
    while _code_taken(db, ctx, code):
        code, suffix = f"{base}{chr(suffix)}", suffix + 1
    return code


# --- tours -----------------------------------------------------------------------

@router.get("/tours", response_model=list[TourSummary])
def list_tours(date_from: date | None = None, date_to: date | None = None,
               status_: TourStatus | None = Query(default=None, alias="status"),
               q: str | None = None, ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    """Tours overlapping [date_from, date_to] (either bound optional)."""
    stmt = select(Tour).where(Tour.workspace_id == ctx.workspace.id).options(*_summary_opts)
    if date_from:
        stmt = stmt.where(Tour.end_date >= date_from)
    if date_to:
        stmt = stmt.where(Tour.start_date <= date_to)
    if status_:
        stmt = stmt.where(Tour.status == status_)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.outerjoin(Client, Tour.client_id == Client.id).where(
            or_(Tour.code.ilike(like), Tour.name.ilike(like), Client.name.ilike(like)))
    tours = db.scalars(stmt.order_by(Tour.start_date, Tour.code)).all()
    counts = participant_counts(db, [t.id for t in tours])
    return [summary(t, counts.get(t.id, 0)) for t in tours]


class Departure(BaseModel):
    code: str | None = Field(default=None, max_length=40)      # the group's code, e.g. ZK-1025
    start_date: date                                           # when our part starts


class DeparturesIn(BaseModel):
    """Many tours of one route at once (a series: every Sunday from October to March)."""
    series_id: str
    departures: list[Departure] = Field(min_length=1, max_length=60)
    client_id: str | None = None
    pax: int = Field(default=0, ge=0, le=10000)
    pax_estimated: bool = False
    rooms: str = Field(default="", max_length=200)
    status: TourStatus = "inquiry"
    price_pp: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    price_currency: str | None = None


class DepartureResult(BaseModel):
    code: str | None
    start_date: date
    tour_id: str | None = None
    error: str = ""


@router.post("/tours/departures", response_model=list[DepartureResult])
def create_departures(body: DeparturesIn, ctx: WorkspaceCtx = Depends(write), db: Session = Depends(get_db)):
    """Each departure is made like a single new tour, so every rule applies; one that fails (a
    code already taken) is reported and the others are still made."""
    _price_allowed(ctx, body.model_dump(exclude_none=True))
    get_owned(db, ctx, Series, body.series_id)
    codes = [d.code.strip().upper() for d in body.departures if d.code]
    if len(codes) != len(set(codes)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The same code is used twice in the list")
    out = []
    for d in body.departures:
        try:
            t = create_tour(TourCreate(series_id=body.series_id, code=d.code or None, start_date=d.start_date,
                                       client_id=body.client_id, pax=body.pax, pax_estimated=body.pax_estimated,
                                       rooms=body.rooms or None, status=body.status, price_pp=body.price_pp,
                                       price_currency=body.price_currency), ctx=ctx, db=db)
            out.append(DepartureResult(code=t.code, start_date=d.start_date, tour_id=t.id))
        except HTTPException as e:
            db.rollback()
            out.append(DepartureResult(code=d.code, start_date=d.start_date, error=str(e.detail)))
    return out


@router.post("/tours", response_model=TourOut, status_code=status.HTTP_201_CREATED)
def create_tour(body: TourCreate, ctx: WorkspaceCtx = Depends(write), db: Session = Depends(get_db)):
    series = get_owned(db, ctx, Series, body.series_id) if body.series_id else None
    check_refs(db, ctx, {"client_id": (Client, body.client_id)})
    end = body.end_date
    if end is None:
        if not series or not series.days:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "End date is required")
        end = body.start_date + timedelta(days=len(series.days) - 1)
    _check_dates(body.start_date, end)

    code = body.code or _generate_code(db, ctx, series, body.start_date)
    if _code_taken(db, ctx, code):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Tour code {code} already exists")

    fields = body.model_dump(exclude_none=True, exclude={"code", "series_id", "end_date"})
    _price_allowed(ctx, fields)
    if fields.get("price_pp") is not None and not fields.get("price_currency"):
        fields["price_currency"] = ctx.workspace.base_currency
    t = Tour(workspace_id=ctx.workspace.id, code=code, series_id=series.id if series else None,
             end_date=end, **fields)
    db.add(t)
    sync_days(t, series.days if series else None)
    if series:
        t.bus_return = dict(series.bus_return) if series.bus_return else None
    if series:
        db.flush()
        staff_from_plan(db, t, series)
    db.commit()
    return full(_load(db, ctx, t.id), ctx.can("operations", "finance", "sales"))


@router.get("/tours/{tour_id}", response_model=TourOut)
def get_tour(tour_id: str, ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    return full(_load(db, ctx, tour_id), ctx.can("operations", "finance", "sales"))


@router.patch("/tours/{tour_id}", response_model=TourOut)
def update_tour(tour_id: str, body: TourUpdate, ctx: WorkspaceCtx = Depends(write), db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    values = body.model_dump(exclude_unset=True)
    before = changes.snapshot(t)
    _price_allowed(ctx, values)
    # Cancelling (or bringing back) a tour changes money: penalties, invoices. Managers only.
    if "status" in values and values["status"] != t.status and "cancelled" in (values["status"], t.status) \
            and not ctx.can("operations", "finance", "sales"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers cancel a tour or bring it back")
    if values.get("price_pp") is not None and not (values.get("price_currency") or t.price_currency):
        values["price_currency"] = ctx.workspace.base_currency
    if "client_id" in values:
        check_refs(db, ctx, {"client_id": (Client, values["client_id"])})
    if values.get("code") and _code_taken(db, ctx, values["code"], exclude_id=t.id):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Tour code {values['code']} already exists")
    start = values.get("start_date") or t.start_date
    end = values.get("end_date") or t.end_date
    # Moving only the start keeps the tour's length (the whole group shifts).
    if "start_date" in values and "end_date" not in values:
        end = start + (t.end_date - t.start_date)
    _check_dates(start, end)

    if values.get("plate_share") == 0:
        values["plate_share"] = None          # back to the agency's usual
    for k, v in values.items():
        if k in ("start_date", "end_date"):
            continue
        if v is None and k not in ("client_id", "price_pp", "plate_share"):
            continue  # null only clears links, never required text fields
        setattr(t, k, v)
    if (start, end) != (t.start_date, t.end_date):
        t.start_date, t.end_date = start, end
        sync_days(t, t.series.days if t.series else None)
        changes.record(db, t, before, ctx.user.id)
    db.commit()
    return full(_load(db, ctx, t.id), ctx.can("operations", "finance", "sales"))


@router.delete("/tours/{tour_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tour(tour_id: str, ctx: WorkspaceCtx = Depends(admin_write), db: Session = Depends(get_db)):
    db.delete(get_owned(db, ctx, Tour, tour_id))
    db.commit()


class ItineraryIn(BaseModel):
    """Every day's content, in order (the builder saves the whole plan at once, e.g. after
    days were dragged into a new order). Dates stay; content moves between them."""
    days: list[DayFields] = Field(max_length=60)
    bus_return: BusReturn | None = None


@router.put("/tours/{tour_id}/itinerary", response_model=TourOut)
def save_itinerary(tour_id: str, body: ItineraryIn, ctx: WorkspaceCtx = Depends(write), db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    if len(body.days) != len(t.days):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"The tour has {len(t.days)} days; change its dates to add or remove days")
    for d in body.days:
        check_day_refs(db, ctx, d.model_dump(mode="json"))
    before = changes.snapshot(t)
    for day, new in zip(sorted(t.days, key=lambda x: x.day_number), body.days):
        for k, v in new.model_dump(mode="json").items():
            setattr(day, k, v)
    t.bus_return = body.bus_return.model_dump() if body.bus_return else None
    changes.record(db, t, before, ctx.user.id)
    db.commit()
    return full(_load(db, ctx, tour_id), ctx.can("operations", "finance", "sales"))


@router.patch("/tours/{tour_id}/days/{day_id}", response_model=TourDayOut)
def update_day(tour_id: str, day_id: str, body: TourDayUpdate, ctx: WorkspaceCtx = Depends(write),
               db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    day = next((d for d in t.days if d.id == day_id), None)
    if not day:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Day not found")
    values = body.model_dump(exclude_unset=True, mode="json")
    before = changes.snapshot(t)
    if body.extras is not None:  # exclude_unset would also drop the generated slot ids inside
        values["extras"] = [x.model_dump(mode="json") for x in body.extras]
    meals = ("breakfast", "lunch", "dinner")
    current = {f"{m}_id": getattr(day, f"{m}_id") for m in meals}
    check_day_refs(db, ctx, {**current, **values} if any(f"{m}_menu_id" in values for m in meals) else values)
    for k, v in values.items():
        if v is None and k not in ("hotel_id", "breakfast_id", "lunch_id", "dinner_id", "breakfast_menu_id", "lunch_menu_id",
                                   "dinner_menu_id", "km", "staff_hotel_id"):
            continue
        setattr(day, k, v)
    for meal in meals:
        # Only a different restaurant drops the menu chosen at the old one.
        if f"{meal}_id" in values and values[f"{meal}_id"] != current[f"{meal}_id"] and f"{meal}_menu_id" not in values:
            setattr(day, f"{meal}_menu_id", None)
    changes.record(db, t, before, ctx.user.id)
    db.commit()
    db.refresh(day)
    return day


# --- day view ----------------------------------------------------------------------

@router.get("/day/{day}", response_model=list[DayViewRow])
def day_view(day: date, include_cancelled: bool = False, ctx: WorkspaceCtx = Depends(read),
             db: Session = Depends(get_db)):
    """Every group on the road on a given date: where they sleep, eat, cross."""
    stmt = (select(TourDay).join(Tour)
            .where(Tour.workspace_id == ctx.workspace.id, TourDay.date == day)
            .options(selectinload(TourDay.tour).options(*_summary_opts),
                     selectinload(TourDay.hotel), selectinload(TourDay.lunch), selectinload(TourDay.dinner))
            .order_by(Tour.code))
    if not include_cancelled:
        stmt = stmt.where(Tour.status != "cancelled")
    days = db.scalars(stmt).all()
    counts = participant_counts(db, [d.tour_id for d in days])
    # Last night's hotel of each group (breakfast "at the hotel" is there, and the day starts from it).
    nights = {n.tour_id: n.hotel for n in db.scalars(
        select(TourDay).where(TourDay.tour_id.in_([d.tour_id for d in days]), TourDay.date == day - timedelta(days=1))
        .options(selectinload(TourDay.hotel)))} if days else {}
    return [
        DayViewRow(tour=summary(d.tour, counts.get(d.tour_id, 0)), day=TourDayOut.model_validate(d),
                   staff_today=[StaffOut.model_validate(a) for a in d.tour.staff if a.covers(d.day_number)],
                   is_first_day=d.date == d.tour.start_date, is_last_day=d.date == d.tour.end_date,
                   prev_hotel=VendorRef.model_validate(nights[d.tour_id]) if nights.get(d.tour_id) else None)
        for d in days
    ]
