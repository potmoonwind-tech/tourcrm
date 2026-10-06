"""Handing part of a tour to another guide / driver: "Nino guides days 1–3, Aram days 4–5 in Armenia".

Preview first: the days that move, what they cost with the current person and the new one (each
one's own day rate in the catalog), the difference. On confirm the assignment splits (the current
person keeps the days before and after), the tour's costs are worked out again, and the change is
written for the team (app/changes.py), so both people see it on their phone page.
"""
from datetime import timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import catalog
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import StaffAssignment, Tour, TourChange, Vendor
from ..scoping import get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["staff change"])
office = require_role("staff")
CENT = Decimal("0.01")


class HandOverIn(BaseModel):
    vendor_id: str
    from_day: int = Field(ge=1, le=60)
    to_day: int | None = Field(default=None, ge=1, le=60)    # None = until the current person's last day
    note: str = Field(default="", max_length=300)
    preview: bool = False


class HandOverOut(BaseModel):
    from_day: int
    to_day: int
    days: int
    currency: str
    old_cost: float | None      # None: no day rate in the catalog
    new_cost: float | None
    difference: float | None
    missing_prices: list[str]
    changes: list[str] = []


def days_text(a: int, b: int) -> str:
    return f"Day {a}" if a == b else f"Days {a}–{b}"


def _cost(v: Vendor, t: Tour, a: int, b: int, rates, missing: list[str]) -> Decimal | None:
    from .. import finance     # finance imports the people router, which imports this module
    total = Decimal(0)
    for n in range(a, b + 1):
        on = t.start_date + timedelta(days=n - 1)
        rate = catalog.price_for(v, "day", on, finance.group_size(t))
        if rate is None:
            missing.append(f"{v.name}: no day price on {on}")
            return None
        total += rate.price * finance.rate_for(rates, rate.currency)
    return total.quantize(CENT)


def record(db: Session, t: Tour, text: str, user_id: str | None) -> str:
    """A staff change concerns everyone on the tour (the one leaving and the one coming): no day."""
    db.add(TourChange(tour_id=t.id, day=None, kind="staff", text=text[:300], by_id=user_id))
    return text


@router.post("/tours/{tour_id}/staff/{staff_id}/hand-over", response_model=HandOverOut)
def hand_over(tour_id: str, staff_id: str, body: HandOverIn, ctx: WorkspaceCtx = Depends(office),
              db: Session = Depends(get_db)):
    from .. import finance
    t = get_owned(db, ctx, Tour, tour_id)
    a = next((x for x in t.staff if x.id == staff_id), None)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Assignment not found")
    new = get_owned(db, ctx, Vendor, body.vendor_id)
    if new.id == a.vendor_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose someone else")
    n_days = (t.end_date - t.start_date).days + 1
    start, end = a.start_day, a.end_day or n_days
    to_day = body.to_day or end
    if not (start <= body.from_day <= to_day <= end):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"{a.vendor.name} works {days_text(start, end).lower()}: choose days within them")
    rates = finance.rates(db, ctx.workspace)
    missing: list[str] = []
    old_cost = _cost(a.vendor, t, body.from_day, to_day, rates, missing)
    new_cost = _cost(new, t, body.from_day, to_day, rates, missing)
    out = HandOverOut(from_day=body.from_day, to_day=to_day, days=to_day - body.from_day + 1,
                      currency=ctx.workspace.base_currency,
                      old_cost=float(old_cost) if old_cost is not None else None,
                      new_cost=float(new_cost) if new_cost is not None else None,
                      difference=float(new_cost - old_cost) if old_cost is not None and new_cost is not None else None,
                      missing_prices=missing)
    if body.preview:
        return out

    old_name = a.vendor.name
    if body.from_day == start and to_day == end:
        a.vendor_id = new.id
    else:
        if to_day < end:     # the current person comes back after
            db.add(StaffAssignment(tour_id=t.id, vendor_id=a.vendor_id, role=a.role, start_day=to_day + 1,
                                   end_day=a.end_day, notes=a.notes))
        db.add(StaffAssignment(tour_id=t.id, vendor_id=new.id, role=a.role, start_day=body.from_day,
                               end_day=None if to_day == n_days else to_day, notes=body.note))
        if body.from_day == start:
            db.delete(a)
        else:
            a.end_day = body.from_day - 1
    text = f"{days_text(body.from_day, to_day)}: {a.role.replace('_', ' ')} {old_name} → {new.name}"
    out.changes = [record(db, t, text + (f" ({body.note})" if body.note else ""), ctx.user.id)]
    db.flush()
    db.expire(t, ["staff"])
    finance.generate(db, ctx.workspace, t)
    db.commit()
    return out
