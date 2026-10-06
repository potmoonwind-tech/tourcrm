"""Closing a tour: a checklist of what is still open, then a final, locked result.

A tour is ready to close when it has ended (or was cancelled), every issued invoice
is settled (nothing owed either way), no drafts are left, every vendor is settled,
no incident is still open and every amount has an exchange rate. Closing freezes
revenue and cost and locks the tour (app/locks.py). An admin or the owner can
close despite open items (writing them off, with a note) and can reopen.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Incident, Invoice, Tour, TourCost, User, utcnow
from .invoices import _tour_money

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["lifecycle"])
can_fin_ope = require_jobs('finance', 'operations')
can_fin = require_jobs('finance')
ZERO = Decimal(0)

Phase = Literal["inquiry", "confirmed", "operating", "settling", "closed", "cancelled"]


def phase(t: Tour, today: date | None = None) -> str:
    """Where the tour is in its life, one word: what the office should be doing with it."""
    today = today or date.today()
    if t.closed_at:
        return "closed"
    if t.status == "cancelled":
        return "cancelled"
    if t.status == "inquiry":
        return "inquiry"
    if today < t.start_date:
        return "confirmed"
    return "operating" if today <= t.end_date else "settling"


class CheckItem(BaseModel):
    key: str            # ended | invoiced | no_drafts | client_settled | vendors_settled | incidents | rates | costed
    ok: bool
    blocking: bool      # False: worth a look, doesn't stop closing
    detail: str = ""    # language-free: amounts still owed ("1,200.00 USD"); "↩ …" = owed back to/from us
    count: int = 0      # how many (drafts, incidents, payables, budget lines)
    link: str = ""      # tour tab to fix it: costs | incidents | invoices


class CloseCheck(BaseModel):
    phase: Phase
    closed_at: datetime | None
    closed_by: str | None
    close_note: str
    final_revenue: float | None
    final_cost: float | None
    items: list[CheckItem]
    ready: bool
    can_force: bool      # admin/owner may close anyway, with a note
    revenue: float       # now, base currency
    cost: float
    profit: float


def _load(db: Session, ctx: WorkspaceCtx, tour_id: str) -> Tour:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.costs).selectinload(TourCost.vendor), selectinload(Tour.payments),
                           selectinload(Tour.budget), selectinload(Tour.series))
                  .execution_options(populate_existing=True))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def _money(amounts: dict[str, Decimal]) -> str:
    return " + ".join(f"{v:,.2f} {k}" for k, v in sorted(amounts.items()) if v)


def check(db: Session, ctx: WorkspaceCtx, t: Tour) -> CloseCheck:
    today = date.today()
    invoices = db.scalars(select(Invoice).where(Invoice.tour_id == t.id, Invoice.workspace_id == ctx.workspace.id)
                          .options(selectinload(Invoice.lines), selectinload(Invoice.payments),
                                   selectinload(Invoice.credit_notes).selectinload(Invoice.lines))).all()
    issued = [i for i in invoices if i.status == "issued" and i.kind == "invoice"]
    drafts = [i for i in invoices if i.status == "draft"]
    owed: dict[str, Decimal] = {}
    refunds: dict[str, Decimal] = {}
    for i in issued:
        if i.balance > 0:
            owed[i.currency] = owed.get(i.currency, ZERO) + i.balance
        elif i.balance < 0:
            refunds[i.currency] = refunds.get(i.currency, ZERO) - i.balance
    payables = finance.payables(t, finance.vendor_map(db, t), today, ctx.workspace.bill_tolerance_pct)
    disputed = [p for p in payables if p.bill_state == "disputed"]
    unbilled = [p for p in payables if p.bill_state in ("no_bill", "difference")]
    unpaid = [p for p in payables if p.balance > 0]
    owes_us = [p for p in payables if p.balance < 0]
    open_incidents = db.scalars(select(Incident.id).where(Incident.tour_id == t.id, Incident.status == "open")).all()
    revenue, cost, missing, _ = _tour_money(t, invoices)
    uncosted = [b for b in t.budget if not any(c.budget_line_id == b.id for c in t.costs)] if t.budget_set_at else []
    cancelled = t.status == "cancelled"

    def unpaid_text() -> str:
        parts = []
        if unpaid:
            parts.append(_money({p.currency: p.balance for p in unpaid}))
        if owes_us:
            parts.append("↩ " + _money({p.currency: -p.balance for p in owes_us}))
        return " · ".join(parts)

    items = [
        CheckItem(key="ended", ok=cancelled or t.end_date < today, blocking=True,
                  detail="" if cancelled or t.end_date < today else t.end_date.isoformat()),
        CheckItem(key="invoiced", ok=bool(issued) or cancelled, blocking=not cancelled, link="costs"),
        CheckItem(key="no_drafts", ok=not drafts, blocking=True, count=len(drafts), link="costs"),
        CheckItem(key="client_settled", ok=not owed and not refunds, blocking=True, link="costs",
                  detail=" · ".join(x for x in (_money(owed), "↩ " + _money(refunds) if refunds else "") if x)),
        CheckItem(key="vendors_settled", ok=not unpaid and not owes_us, blocking=True, detail=unpaid_text(),
                  count=len(unpaid) + len(owes_us), link="costs"),
        CheckItem(key="bills_disputed", ok=not disputed, blocking=True, count=len(disputed), link="costs"),
        CheckItem(key="bills_matched", ok=not unbilled, blocking=False, count=len(unbilled), link="costs"),
        CheckItem(key="incidents", ok=not open_incidents, blocking=True, count=len(open_incidents), link="incidents"),
        CheckItem(key="rates", ok=not missing, blocking=True, link="costs"),
        CheckItem(key="costed", ok=bool(t.costs) and not uncosted, blocking=False, link="costs", count=len(uncosted)),
    ]
    closer = db.get(User, t.closed_by_id) if t.closed_by_id else None
    return CloseCheck(
        phase=phase(t, today), closed_at=t.closed_at, closed_by=(closer.full_name or closer.email) if closer else None,
        close_note=t.close_note, final_revenue=t.final_revenue, final_cost=t.final_cost, items=items,
        ready=all(i.ok for i in items if i.blocking), can_force=ctx.has_role("admin"),
        revenue=revenue, cost=cost, profit=revenue - cost)


@router.get("/tours/{tour_id}/close-check", response_model=CloseCheck)
def close_check(tour_id: str, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    return check(db, ctx, _load(db, ctx, tour_id))


class CloseIn(BaseModel):
    note: str = Field(default="", max_length=500)
    force: bool = False   # admin/owner: close with open items (written off), a note is required


@router.post("/tours/{tour_id}/close", response_model=CloseCheck)
def close(tour_id: str, body: CloseIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    if t.closed_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is already closed")
    c = check(db, ctx, t)
    if not c.ready:
        open_items = [i.key for i in c.items if i.blocking and not i.ok]
        if not body.force:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Not ready to close: {', '.join(open_items)}")
        if not ctx.has_role("admin"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin or the owner can close with open items")
        if not body.note.strip():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say why it's closed with open items")
        if "ended" in open_items:
            raise HTTPException(status.HTTP_409_CONFLICT, "A tour can't be closed before it ends")
    t.closed_at, t.closed_by_id, t.close_note = utcnow(), ctx.user.id, body.note
    t.final_revenue, t.final_cost = Decimal(str(c.revenue)), Decimal(str(c.cost))
    db.commit()
    return check(db, ctx, _load(db, ctx, tour_id))


class ReopenIn(BaseModel):
    note: str = Field(min_length=1, max_length=500)


@router.post("/tours/{tour_id}/reopen", response_model=CloseCheck)
def reopen(tour_id: str, body: ReopenIn, ctx: WorkspaceCtx = Depends(require_role("admin")), db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    if not t.closed_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour isn't closed")
    t.closed_at = t.closed_by_id = t.final_revenue = t.final_cost = None
    t.close_note = f"Reopened: {body.note}"[:500]
    db.commit()
    return check(db, ctx, _load(db, ctx, tour_id))


class ToClose(BaseModel):
    id: str
    code: str
    color: str
    end_date: date
    status: str
    open_items: list[str]


@router.get("/tours-to-close", response_model=list[ToClose])
def tours_to_close(ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    """Ended (or cancelled) tours not closed yet, oldest first, with what still blocks each."""
    today = date.today()
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ctx.workspace.id, Tour.closed_at.is_(None),
                                          (Tour.end_date < today) | (Tour.status == "cancelled"))
                       .options(selectinload(Tour.costs), selectinload(Tour.payments), selectinload(Tour.budget),
                                selectinload(Tour.series))
                       .order_by(Tour.end_date)).all()
    out = []
    for t in tours:
        c = check(db, ctx, t)
        out.append(ToClose(id=t.id, code=t.code, color=t.series.color if t.series else "slate", end_date=t.end_date,
                           status=t.status, open_items=[i.key for i in c.items if i.blocking and not i.ok]))
    return out

