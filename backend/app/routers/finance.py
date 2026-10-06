"""Money: exchange rates, tour costs, vendor payments, payment schedule.

Manager and up only. Staff run itineraries but never see prices (as in ki.360,
where LIZI/BUS logins had no financial tabs).
"""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session, selectinload

from .. import finance, nbg
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import ExchangeRate, Invoice, Membership, Tour, TourCost, Vendor, VendorPayment
from ..schemas import (
    CostIn, CostOut, CostUpdate, ExchangeRateIn, ExchangeRateOut, GenerateResult, PaymentIn, PaymentOut,
    ScheduleOut, TourCostsOut,
)
from ..scoping import check_refs, get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["finance"])
can_ope_fin_sal = require_jobs('operations', 'finance', 'sales')
can_ope_fin = require_jobs('operations', 'finance')
can_fin = require_jobs('finance')


# --- exchange rates ------------------------------------------------------------------------

@router.get("/exchange-rates", response_model=list[ExchangeRateOut])
def list_rates(ctx: WorkspaceCtx = Depends(can_ope_fin_sal), db: Session = Depends(get_db)):
    return db.scalars(select(ExchangeRate).where(ExchangeRate.workspace_id == ctx.workspace.id)
                      .order_by(ExchangeRate.currency)).all()


class RateSuggestion(BaseModel):
    source: str = "nbg"            # National Bank of Georgia
    on: date
    base: str
    rates: dict[str, float]        # 1 unit of the currency = this much of the base currency


@router.get("/exchange-rates/suggest", response_model=RateSuggestion)
def suggest_rates(currencies: str = Query(..., max_length=200), ctx: WorkspaceCtx = Depends(can_ope_fin_sal)):
    """Today's National Bank of Georgia rates for these currencies, in the agency's currency —
    a starting point the agency can accept or change. Never saved by itself."""
    wanted = [c.strip().upper() for c in currencies.split(",") if c.strip()][:20]
    if not all(len(c) == 3 and c.isalpha() for c in wanted):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Currencies must be 3-letter codes")
    base = ctx.workspace.base_currency
    try:
        found = nbg.rates_to(base, wanted)
    except nbg.Unavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The National Bank rates can't be reached right now")
    return RateSuggestion(on=date.today(), base=base, rates={k: float(v) for k, v in found.items()})


@router.put("/exchange-rates", response_model=list[ExchangeRateOut])
def set_rates(body: list[ExchangeRateIn], ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    """Replace the rate table. Cost lines that were valued without a rate (0)
    pick up the new one; lines already valued keep their historical rate."""
    ws = ctx.workspace
    wanted = {r.currency: r.rate for r in body if r.currency != ws.base_currency}
    current = {r.currency: r for r in db.scalars(select(ExchangeRate).where(ExchangeRate.workspace_id == ws.id))}
    for cur, row in current.items():
        if cur not in wanted:
            db.delete(row)
    for cur, rate in wanted.items():
        if cur in current:
            current[cur].rate = rate
        else:
            db.add(ExchangeRate(workspace_id=ws.id, currency=cur, rate=rate))
        tour_ids = select(Tour.id).where(Tour.workspace_id == ws.id, Tour.closed_at.is_(None))   # closed = final
        db.execute(update(TourCost).where(TourCost.tour_id.in_(tour_ids), TourCost.currency == cur,
                                          TourCost.rate_to_base == 0).values(rate_to_base=rate))
        db.execute(update(Invoice).where(Invoice.workspace_id == ws.id, Invoice.currency == cur, Invoice.rate_to_base == 0,
                                         (Invoice.tour_id.is_(None)) | Invoice.tour_id.in_(tour_ids)).values(rate_to_base=rate))
    db.commit()
    return list_rates(ctx, db)


# --- tour costs -----------------------------------------------------------------------------

def _tour(db: Session, ctx: WorkspaceCtx, tour_id: str) -> Tour:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.costs).selectinload(TourCost.vendor), selectinload(Tour.payments),
                           selectinload(Tour.budget),
                           selectinload(Tour.series))
                  .execution_options(populate_existing=True))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def _costs_out(db: Session, ctx: WorkspaceCtx, t: Tour) -> TourCostsOut:
    vendors = finance.vendor_map(db, t)
    return TourCostsOut(
        lines=[finance.cost_out(c, ctx.workspace.vat_rate) for c in t.costs],
        payables=finance.payables(t, vendors, tolerance_pct=ctx.workspace.bill_tolerance_pct),
        payments=[finance.payment_out(p, vendors[p.vendor_id]) for p in t.payments],
        totals=finance.totals(t, ctx.workspace),
    )


@router.get("/tours/{tour_id}/costs", response_model=TourCostsOut)
def tour_costs(tour_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    return _costs_out(db, ctx, _tour(db, ctx, tour_id))


@router.post("/tours/{tour_id}/costs/generate", response_model=GenerateResult)
def generate_costs(tour_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    if t.closed_at:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Tour {t.code} is closed: reopen it to make changes")
    if t.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is cancelled")
    result = finance.generate(db, ctx.workspace, t)
    db.commit()
    return result


@router.post("/tours/{tour_id}/costs", response_model=CostOut, status_code=status.HTTP_201_CREATED)
def add_cost(tour_id: str, body: CostIn, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    check_refs(db, ctx, {"vendor_id": (Vendor, body.vendor_id)})
    _check_budget_line(t, body.budget_line_id)
    values = body.model_dump(exclude_none=True)
    if body.rate_to_base is None:
        values["rate_to_base"] = finance.rate_for(finance.rates(db, ctx.workspace), body.currency)
    c = TourCost(tour_id=t.id, **values)
    db.add(c)
    db.commit()
    db.refresh(c)
    return finance.cost_out(c, ctx.workspace.vat_rate)


def _check_budget_line(t: Tour, line_id: str | None) -> None:
    if line_id and not any(b.id == line_id for b in t.budget):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "budget_line_id: not a budget line of this tour")


def _line(t: Tour, cost_id: str) -> TourCost:
    c = next((c for c in t.costs if c.id == cost_id), None)
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cost line not found")
    return c


@router.patch("/tours/{tour_id}/costs/{cost_id}", response_model=CostOut)
def update_cost(tour_id: str, cost_id: str, body: CostUpdate, ctx: WorkspaceCtx = Depends(can_ope_fin),
                db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    c = _line(t, cost_id)
    values = body.model_dump(exclude_unset=True)
    if values.get("vendor_id"):
        check_refs(db, ctx, {"vendor_id": (Vendor, values["vendor_id"])})
    _check_budget_line(t, values.get("budget_line_id"))
    for k, v in values.items():
        if v is not None or k in ("vendor_id", "service_end", "budget_line_id", "vat_rate"):
            setattr(c, k, v)
    if "currency" in values and "rate_to_base" not in values:
        c.rate_to_base = finance.rate_for(finance.rates(db, ctx.workspace), c.currency)
    if "budget_line_id" in values:
        c.budget_by_hand = True
    if c.auto_key and set(values) - {"budget_line_id"}:
        c.locked = True  # a hand edit wins over the next regeneration (re-linking alone doesn't)
    db.commit()
    db.refresh(c)
    return finance.cost_out(c, ctx.workspace.vat_rate)


@router.delete("/tours/{tour_id}/costs/{cost_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cost(tour_id: str, cost_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    t.costs.remove(_line(t, cost_id))
    db.commit()


# --- payments --------------------------------------------------------------------------------

@router.post("/tours/{tour_id}/payments", response_model=PaymentOut, status_code=status.HTTP_201_CREATED)
def add_payment(tour_id: str, body: PaymentIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    check_refs(db, ctx, {"vendor_id": (Vendor, body.vendor_id), "paid_by_vendor_id": (Vendor, body.paid_by_vendor_id)})
    if body.paid_by_user_id and not db.scalar(select(Membership.id).where(
            Membership.workspace_id == ctx.workspace.id, Membership.user_id == body.paid_by_user_id)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "paid_by_user_id: not a member of this agency")
    if body.paid_by_user_id and body.paid_by_vendor_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Paid by one person: a team member or a guide/driver")
    v = db.get(Vendor, body.vendor_id)
    p = VendorPayment(tour_id=t.id, created_by_id=ctx.user.id, **body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return finance.payment_out(p, v)


@router.delete("/tours/{tour_id}/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment(tour_id: str, payment_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    t = _tour(db, ctx, tour_id)
    p = next((p for p in t.payments if p.id == payment_id), None)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found")
    t.payments.remove(p)
    db.commit()


# --- schedule ------------------------------------------------------------------------------------

@router.get("/payments/schedule", response_model=ScheduleOut)
def schedule(status_: Literal["open", "overdue", "paid", "all", "bills"] = Query(default="open", alias="status"),
             due_to: date | None = None,
             vendor_id: str | None = None, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """Everything owed to vendors across all tours, ordered by due date."""
    ws_id = ctx.workspace.id
    has_money = or_(Tour.costs.any(TourCost.vendor_id.is_not(None)), Tour.payments.any())
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ws_id, has_money)
                       .options(selectinload(Tour.costs), selectinload(Tour.payments), selectinload(Tour.series),
                                selectinload(Tour.bills))).all()
    vendor_ids = ({c.vendor_id for t in tours for c in t.costs if c.vendor_id} | {p.vendor_id for t in tours for p in t.payments}
                  | {b.vendor_id for t in tours for b in t.bills})
    vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.id.in_(vendor_ids)))} if vendor_ids else {}

    today = date.today()
    items = [p for t in tours for p in finance.payables(t, vendors, today, ctx.workspace.bill_tolerance_pct)]
    overdue: dict[str, Decimal] = defaultdict(Decimal)
    due_7: dict[str, Decimal] = defaultdict(Decimal)
    due_30: dict[str, Decimal] = defaultdict(Decimal)
    for p in items:
        if p.status in ("paid", "owed_to_us") or not p.due_date or p.balance <= 0:
            continue
        bal = Decimal(str(p.balance))
        if p.status == "overdue":
            overdue[p.currency] += bal
        elif p.due_date <= today + timedelta(days=7):
            due_7[p.currency] += bal
        elif p.due_date <= today + timedelta(days=30):
            due_30[p.currency] += bal

    def keep(p) -> bool:
        if vendor_id and p.vendor.id != vendor_id:
            return False
        if due_to and (p.due_date is None or p.due_date > due_to):
            return False
        return {"open": p.status != "paid", "overdue": p.status == "overdue",
                "paid": p.status == "paid", "all": True,
                "bills": p.bill_state in ("difference", "disputed")}[status_]   # bills to look at

    items = sorted(filter(keep, items), key=lambda p: (p.due_date or date.max, p.tour_code, p.vendor.name))
    as_float = lambda d: {k: float(v) for k, v in sorted(d.items())}  # noqa: E731
    return ScheduleOut(items=items, overdue=as_float(overdue), due_7=as_float(due_7), due_30=as_float(due_30))
