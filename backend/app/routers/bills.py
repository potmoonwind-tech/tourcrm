"""Vendor bills: the invoices vendors send us, matched against what we expected to pay.

Per tour, vendor and currency: billed (all their bills) vs expected (our cost lines,
penalties and claims included). Within the agency's tolerance it matches. Otherwise
the difference is accepted — an adjustment cost line makes our costs equal the bill —
or a bill is disputed, which keeps the tour from closing until it's resolved.
"""
from collections import Counter
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Tour, TourCost, Vendor, VendorBill
from ..schemas import Amount, Payable, VendorRef, _currency
from ..scoping import check_refs

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["bills"])
can_fin_ope = require_jobs('finance', 'operations')
can_fin = require_jobs('finance')
ZERO = Decimal(0)


class BillIn(BaseModel):
    vendor_id: str
    number: str = Field(default="", max_length=80)
    bill_date: date
    due_date: date | None = None
    currency: str
    amount: Amount
    notes: str = Field(default="", max_length=2000)

    _cur = field_validator("currency")(_currency)


class BillPatch(BaseModel):
    number: str | None = Field(default=None, max_length=80)
    bill_date: date | None = None
    due_date: date | None = None
    amount: Amount | None = None
    notes: str | None = Field(default=None, max_length=2000)


class BillOut(BaseModel):
    id: str
    vendor: VendorRef
    number: str
    bill_date: date
    due_date: date | None
    currency: str
    amount: float
    notes: str
    disputed: bool
    dispute_note: str


class TourBills(BaseModel):
    bills: list[BillOut]
    payables: list[Payable]       # per vendor and currency: expected vs billed, with the match state
    tolerance_pct: float


class Note(BaseModel):
    note: str = Field(default="", max_length=500)


class AcceptIn(BaseModel):
    vendor_id: str
    currency: str
    note: str = Field(default="", max_length=500)


def _tour(db: Session, ctx: WorkspaceCtx, tour_id: str) -> Tour:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.costs), selectinload(Tour.payments), selectinload(Tour.series),
                           selectinload(Tour.bills).selectinload(VendorBill.vendor))
                  .execution_options(populate_existing=True))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def _out(db: Session, ctx: WorkspaceCtx, t: Tour) -> TourBills:
    pct = ctx.workspace.bill_tolerance_pct
    return TourBills(
        bills=[BillOut(id=b.id, vendor=VendorRef.model_validate(b.vendor), number=b.number, bill_date=b.bill_date,
                       due_date=b.due_date, currency=b.currency, amount=b.amount, notes=b.notes, disputed=b.disputed,
                       dispute_note=b.dispute_note) for b in t.bills],
        payables=finance.payables(t, finance.vendor_map(db, t), tolerance_pct=pct), tolerance_pct=pct)


def _bill(db: Session, ctx: WorkspaceCtx, bill_id: str) -> VendorBill:
    b = db.scalar(select(VendorBill).join(Tour).where(VendorBill.id == bill_id, Tour.workspace_id == ctx.workspace.id))
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bill not found")
    return b


@router.get("/tours/{tour_id}/bills", response_model=TourBills)
def tour_bills(tour_id: str, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    return _out(db, ctx, _tour(db, ctx, tour_id))


@router.post("/tours/{tour_id}/bills", response_model=TourBills, status_code=status.HTTP_201_CREATED)
def add_bill(tour_id: str, body: BillIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    check_refs(db, ctx, {"vendor_id": (Vendor, body.vendor_id)})
    t.bills.append(VendorBill(tour_id=t.id, **body.model_dump()))
    db.commit()
    return _out(db, ctx, _tour(db, ctx, tour_id))


@router.patch("/bills/{bill_id}", response_model=TourBills)
def update_bill(bill_id: str, body: BillPatch, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    b = _bill(db, ctx, bill_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None or k == "due_date":
            setattr(b, k, v)
    db.commit()
    return _out(db, ctx, _tour(db, ctx, b.tour_id))


@router.delete("/bills/{bill_id}", response_model=TourBills)
def delete_bill(bill_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    b = _bill(db, ctx, bill_id)
    tour_id = b.tour_id
    db.delete(b)
    db.commit()
    return _out(db, ctx, _tour(db, ctx, tour_id))


@router.post("/bills/{bill_id}/dispute", response_model=TourBills)
def dispute(bill_id: str, body: Note, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    b = _bill(db, ctx, bill_id)
    if not body.note.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say what is disputed")
    b.disputed, b.dispute_note = True, body.note.strip()
    db.commit()
    return _out(db, ctx, _tour(db, ctx, b.tour_id))


@router.post("/bills/{bill_id}/resolve", response_model=TourBills)
def resolve(bill_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """The dispute is settled (e.g. the vendor sent a corrected amount, entered on the bill)."""
    b = _bill(db, ctx, bill_id)
    b.disputed, b.dispute_note = False, ""
    db.commit()
    return _out(db, ctx, _tour(db, ctx, b.tour_id))


@router.post("/tours/{tour_id}/bills/accept", response_model=TourBills)
def accept_difference(tour_id: str, body: AcceptIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """Accept what the vendor billed: one adjustment cost line makes our expected cost equal
    the bills, linked to the budget line the vendor's costs belong to (when there is one)."""
    t = _tour(db, ctx, tour_id)
    cur = _currency(body.currency)
    group = next((p for p in _out(db, ctx, t).payables if p.vendor.id == body.vendor_id and p.currency == cur), None)
    if group is None or not group.billed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No bills from this vendor in that currency")
    if group.bill_state == "disputed":
        raise HTTPException(status.HTTP_409_CONFLICT, "A bill is disputed: resolve it first")
    diff = Decimal(str(group.bill_difference)).quantize(Decimal("0.01"))
    if diff == 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Nothing to accept: the bills equal our costs")
    mine = [c for c in t.costs if c.vendor_id == body.vendor_id and c.currency == cur]
    budget_lines = Counter(c.budget_line_id for c in mine if c.budget_line_id)
    category = Counter(c.category for c in mine).most_common(1)[0][0] if mine else "other"
    numbers = ", ".join(b.number for b in t.bills if b.vendor_id == body.vendor_id and b.currency == cur and b.number)
    t.costs.append(TourCost(
        tour_id=t.id, vendor_id=body.vendor_id, category=category,
        description=(f"Vendor invoice {numbers}: difference" if numbers else "Vendor invoice: difference")[:300],
        service_date=max((b.bill_date for b in t.bills if b.vendor_id == body.vendor_id), default=t.end_date),
        quantity=Decimal(1) if diff > 0 else Decimal(-1), unit_price=abs(diff), currency=cur,
        rate_to_base=finance.rate_for(finance.rates(db, ctx.workspace), cur), reason="bill_adjustment",
        notes=body.note, budget_by_hand=True,
        budget_line_id=next(iter(budget_lines)) if len(budget_lines) == 1 else None))
    db.commit()
    return _out(db, ctx, _tour(db, ctx, tour_id))
