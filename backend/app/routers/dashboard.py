"""Home: each person's own widget layout, plus data two widgets need that no other page has
(who of our guides and drivers works where this week; money in vs out over the next 30 days).
"""
import re
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Invoice, StaffAssignment, Tour
from ..schemas import VendorRef
from .alerts import BOOKED_ROLES, PERSON_TYPES, _span
from .finance import schedule

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["dashboard"])
member = require_role("guide")
office = require_role("staff")
can_fin = require_jobs('finance')


# --- layout --------------------------------------------------------------------------------------

class Widget(BaseModel):
    id: str = Field(max_length=40)
    size: Literal["half", "full"] = "half"

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not re.fullmatch(r"[a-z0-9_]+", v):
            raise ValueError("bad widget id")
        return v


class Layout(BaseModel):
    widgets: list[Widget] | None      # None = the role's default (decided by the app)


@router.get("/dashboard/layout", response_model=Layout)
def get_layout(ctx: WorkspaceCtx = Depends(member)):
    return Layout(widgets=ctx.membership.dashboard)


@router.put("/dashboard/layout", response_model=Layout)
def put_layout(body: Layout, ctx: WorkspaceCtx = Depends(member), db: Session = Depends(get_db)):
    seen: set[str] = set()
    widgets = [w for w in body.widgets or [] if not (w.id in seen or seen.add(w.id))][:40]
    ctx.membership.dashboard = [w.model_dump() for w in widgets] if body.widgets is not None else None
    db.commit()
    return Layout(widgets=ctx.membership.dashboard)


@router.delete("/dashboard/layout", status_code=status.HTTP_204_NO_CONTENT)
def reset_layout(ctx: WorkspaceCtx = Depends(member), db: Session = Depends(get_db)):
    ctx.membership.dashboard = None
    db.commit()


# --- staff week ----------------------------------------------------------------------------------

class StaffDay(BaseModel):
    date: date
    tour_id: str | None
    tour_code: str | None
    tour_color: str | None
    also: list[str] = []     # other tours the same day: a double booking


class StaffWeek(BaseModel):
    vendor: VendorRef
    role: str
    days: list[StaffDay]     # 7 days from today; empty slots have no tour
    busy: int


@router.get("/dashboard/staff-week", response_model=list[StaffWeek])
def staff_week(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """Guides, drivers and assistants on tours in the next 7 days, day by day."""
    today = date.today()
    days = [today + timedelta(days=i) for i in range(7)]
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ctx.workspace.id, Tour.status != "cancelled",
                                          Tour.start_date <= days[-1], Tour.end_date >= today)
                       .options(selectinload(Tour.staff).selectinload(StaffAssignment.vendor), selectinload(Tour.series))).all()
    by_person: dict[str, dict] = {}
    for t in tours:
        for a in t.staff:
            # People only (as the double-booking check): a coach company runs several buses at once.
            if a.role not in BOOKED_ROLES or a.vendor.type not in PERSON_TYPES:
                continue
            first, last = _span(a, t)
            row = by_person.setdefault(a.vendor_id, {"vendor": a.vendor, "role": a.role, "days": defaultdict(list)})
            for d in days:
                if first <= d <= last and t not in row["days"][d]:
                    row["days"][d].append(t)
    out = []
    for row in by_person.values():
        slots = []
        for d in days:
            ts = sorted(row["days"].get(d, []), key=lambda x: x.start_date)
            t = ts[0] if ts else None
            slots.append(StaffDay(date=d, tour_id=t.id if t else None, tour_code=t.code if t else None,
                                  tour_color=(t.series.color if t and t.series else None), also=[x.code for x in ts[1:]]))
        out.append(StaffWeek(vendor=VendorRef.model_validate(row["vendor"]), role=row["role"], days=slots,
                             busy=sum(1 for s in slots if s.tour_id)))
    return sorted(out, key=lambda r: (r.role, r.vendor.name.lower()))


# --- cash forecast -------------------------------------------------------------------------------

class CashWeek(BaseModel):
    label: Literal["overdue", "week1", "week2", "week3", "week4"]
    money_in: float          # clients' issued invoices due, in base currency
    money_out: float         # owed to suppliers, in base currency


class CashForecast(BaseModel):
    base_currency: str
    weeks: list[CashWeek]
    total_in: float
    total_out: float
    missing_rates: list[str]


@router.get("/dashboard/cash", response_model=CashForecast)
def cash_forecast(ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """Money coming in (client invoices) and going out (suppliers) over the next 30 days,
    overdue first, by week, in the agency's currency."""
    ws = ctx.workspace
    today = date.today()
    table = finance.rates(db, ws)
    missing: set[str] = set()
    labels = ["overdue", "week1", "week2", "week3", "week4"]
    money_in: dict[str, Decimal] = defaultdict(Decimal)
    money_out: dict[str, Decimal] = defaultdict(Decimal)

    def bucket(due: date) -> str | None:
        if due < today:
            return "overdue"
        days = (due - today).days
        return labels[min(days // 7, 3) + 1] if days <= 30 else None

    def to_base(amount: Decimal, currency: str) -> Decimal:
        r = finance.rate_for(table, currency)
        if not r:
            missing.add(currency)
        return amount * r

    invs = db.scalars(select(Invoice).where(Invoice.workspace_id == ws.id, Invoice.status == "issued", Invoice.kind == "invoice")
                      .options(selectinload(Invoice.lines), selectinload(Invoice.payments),
                               selectinload(Invoice.credit_notes).selectinload(Invoice.lines)))
    for inv in invs:
        b = bucket(inv.due_date)
        if b and inv.balance > 0:
            money_in[b] += to_base(inv.balance, inv.currency)
    for p in schedule(status_="open", due_to=today + timedelta(days=30), vendor_id=None, ctx=ctx, db=db).items:
        b = bucket(p.due_date) if p.due_date else None
        if b:
            amount = to_base(Decimal(str(p.balance)), p.currency)
            if amount >= 0:
                money_out[b] += amount
            else:
                money_in[b] -= amount            # a supplier paying us back
    q = lambda d: float(d.quantize(Decimal("0.01")))  # noqa: E731
    weeks = [CashWeek(label=lb, money_in=q(money_in[lb]), money_out=q(money_out[lb])) for lb in labels]
    return CashForecast(base_currency=ws.base_currency, weeks=weeks, total_in=sum(w.money_in for w in weeks),
                        total_out=sum(w.money_out for w in weeks), missing_rates=sorted(missing))
