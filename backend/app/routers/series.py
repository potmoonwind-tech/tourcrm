"""Route templates. A series holds the day-by-day plan (city, hotel, meals,
border) that new tours copy; editing a series never rewrites existing tours."""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import changes
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Series, SeriesDay, Vendor, utcnow
from ..schemas import DayFields, SeriesIn, SeriesOut
from ..scoping import check_day_refs, check_refs, get_owned
from . import staff_change
from .tours import staff_from_plan

router = APIRouter(prefix="/api/workspaces/{workspace_id}/series", tags=["series"])

read = require_role("staff")
can_ope = require_jobs('operations')


def _apply(db: Session, ctx: WorkspaceCtx, s: Series, body: SeriesIn) -> None:
    clash = db.scalar(select(Series.id).where(Series.workspace_id == ctx.workspace.id,
                                              Series.code == body.code, Series.id != s.id))
    if clash:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Series code {body.code} already exists")
    for d in body.days:
        check_day_refs(db, ctx, d.model_dump(mode="json"))
    s.code, s.name, s.color, s.notes = body.code, body.name, body.color, body.notes
    s.bus_return = body.bus_return.model_dump() if body.bus_return else None
    if body.staff_plan is not None:
        n = len(body.days)
        for x in body.staff_plan:
            if x.vendor_id:
                check_refs(db, ctx, {"vendor_id": (Vendor, x.vendor_id)})
            if n and (x.from_day > n or (x.to_day or 0) > n):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"The route has {n} days: the people's days must be within them")
        s.staff_plan = [x.model_dump(mode="json") for x in body.staff_plan]
    new_days = [d.model_dump(mode="json") for d in body.days]
    if s.days and [_day(d) for d in s.days] != new_days:
        s.days_changed_at = utcnow()
    # Days are replaced wholesale: the editor always sends the full list.
    s.days.clear()
    db.flush()
    s.days.extend(SeriesDay(day_number=i + 1, **d.model_dump(mode="json")) for i, d in enumerate(body.days))


def _day(d: SeriesDay) -> dict:
    return DayFields.model_validate(d, from_attributes=True).model_dump(mode="json")


@router.get("", response_model=list[SeriesOut])
def list_series(ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    return db.scalars(select(Series).where(Series.workspace_id == ctx.workspace.id)
                      .options(selectinload(Series.days)).order_by(Series.code)).all()


@router.post("", response_model=SeriesOut, status_code=status.HTTP_201_CREATED)
def create_series(body: SeriesIn, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    s = Series(workspace_id=ctx.workspace.id, code=body.code)
    db.add(s)
    _apply(db, ctx, s, body)
    db.commit()
    return s


@router.get("/{series_id}", response_model=SeriesOut)
def get_series(series_id: str, ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    return get_owned(db, ctx, Series, series_id)


@router.put("/{series_id}", response_model=SeriesOut)
def replace_series(series_id: str, body: SeriesIn, ctx: WorkspaceCtx = Depends(can_ope),
                   db: Session = Depends(get_db)):
    s = get_owned(db, ctx, Series, series_id)
    _apply(db, ctx, s, body)
    db.commit()
    db.refresh(s)
    return s


@router.delete("/{series_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_series(series_id: str, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    db.delete(get_owned(db, ctx, Series, series_id))
    db.commit()


# --- a series: the route changed, the departures follow ----------------------------------------------
# Tours keep their own copy of the days (a sold tour must not change by itself). When the partner
# changes the programme, the operator pushes the route's days to the departures they choose.

class PushIn(BaseModel):
    tour_ids: list[str] = Field(min_length=1, max_length=200)


class PushResult(BaseModel):
    tour_id: str
    code: str
    error: str = ""
    confirmed: int = 0       # bookings that were confirmed: they now say "changed" where it matters


@router.post("/{series_id}/push", response_model=list[PushResult])
def push_days(series_id: str, body: PushIn, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    from ..models import Tour, TourBooking
    s = get_owned(db, ctx, Series, series_id)
    fields = ("city", "hotel_id", "breakfast_id", "breakfast_menu_id", "lunch_id", "dinner_id", "lunch_menu_id", "dinner_menu_id",
              "border_crossing", "notes", "km", "drive_minutes", "drive_km", "stops", "breakfast_mode", "lunch_mode", "dinner_mode",
              "flights", "schedule", "staff_stay", "staff_hotel_id", "staff_twin", "staff_stays")
    out = []
    for tid in body.tour_ids:
        t = db.scalar(select(Tour).where(Tour.id == tid, Tour.workspace_id == ctx.workspace.id, Tour.series_id == s.id))
        if t is None:
            continue
        res = PushResult(tour_id=t.id, code=t.code)
        if t.closed_at is not None or t.status == "cancelled":
            res.error = "Closed or cancelled - left as it is"
        elif len(t.days) != len(s.days):
            res.error = f"The tour has {len(t.days)} days, the route {len(s.days)} - change its dates first"
        else:
            before = changes.snapshot(t)
            for day, src in zip(sorted(t.days, key=lambda d: d.day_number), s.days):
                for k in fields:
                    setattr(day, k, getattr(src, k))
                day.extras = [dict(x) for x in src.extras or []]
            t.route_synced_at = utcnow()
            t.bus_return = dict(s.bus_return) if s.bus_return else None   # the drive back moves with the days
            changes.record(db, t, before, ctx.user.id)
            for text in staff_from_plan(db, t, s)[0]:
                staff_change.record(db, t, text, ctx.user.id)
            res.confirmed = db.scalar(select(func.count()).select_from(TourBooking).where(
                TourBooking.tour_id == t.id, TourBooking.status == "confirmed")) or 0
        out.append(res)
    db.commit()
    return out


class StaffApplyOut(BaseModel):
    tour_id: str
    code: str
    added: list[str]
    busy: list[str] = []        # a person busy on another tour those days: this departure needs someone else


@router.post("/{series_id}/staff-plan/apply", response_model=list[StaffApplyOut])
def apply_staff_plan(series_id: str, body: PushIn, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    """Give departures made before the plan its people, without touching their days. Where someone
    in that role already works those days, they stay."""
    from ..models import Tour
    s = get_owned(db, ctx, Series, series_id)
    out = []
    tours = db.scalars(select(Tour).where(Tour.id.in_(body.tour_ids), Tour.workspace_id == ctx.workspace.id,
                                          Tour.series_id == s.id).order_by(Tour.start_date)).all()
    for t in tours:
        if t.closed_at is not None or t.status == "cancelled":
            continue
        added, busy = staff_from_plan(db, t, s)
        for text in added:
            staff_change.record(db, t, text, ctx.user.id)
        out.append(StaffApplyOut(tour_id=t.id, code=t.code, added=added, busy=busy))
    db.commit()
    return out

