"""A tour's budget (planned, from its calculation) against its costs (actual). Manager and up."""
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..quote_engine import season_on
from .. import budget, finance, travel
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Incident, Invoice, Quote, Tour, TourBudgetLine, TourCost
from ..quote_schemas import QuoteIn
from ..schemas import CostOut, VendorRef
from .invoices import _invoices_by_tour, _tour_money

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["budget"])
can_ope_fin = require_jobs('operations', 'finance')
ZERO = Decimal(0)


class BudgetLineOut(BaseModel):
    id: str
    kind: str
    category: str
    name: str
    vendor: VendorRef | None
    day: int | None
    quantity: float
    unit_price: float
    currency: str
    amount: float
    notes: str
    planned_base: float
    actual_base: float | None      # None: no cost recorded against it yet
    variance_base: float | None    # actual − planned; + is over budget
    costs: int
    status: str                    # no_cost | on_budget | over | under


class IncidentMoney(BaseModel):
    id: str
    title: str
    status: str
    carried_by: str
    cost: float            # cost lines it added (base)
    vendor_credit: float   # claimed back from a vendor (base, ≤ 0)
    client_charge: float   # billed to the client on an issued invoice (base)
    client_charge_draft: float  # on an invoice not issued yet: not revenue yet
    net: float             # effect on profit so far: issued charge − cost − credit


class BudgetTotals(BaseModel):
    planned: float                 # all budget lines
    planned_costed: float          # budget lines that have costs
    actual_budgeted: float         # costs on budget lines
    variance: float                # actual_budgeted − planned_costed
    not_costed: float              # planned on lines with no cost yet (not a saving)
    unbudgeted: float              # costs that are in no budget line (incidents excluded)
    incidents: float               # net cost of approved incidents (costs minus vendor claims)
    actual: float                  # every cost
    revenue_planned: float
    revenue_actual: float          # issued invoices
    profit_planned: float
    profit_actual: float


class BudgetOut(BaseModel):
    has_quote: bool
    quote_id: str | None
    quote_name: str | None
    quote_range: tuple[int, int] | None   # group sizes the calculation covers
    set: bool
    source: str
    set_at: datetime | None
    tourists: int | None
    leaders: int | None
    actual_tourists: int
    currency: str
    lines: list[BudgetLineOut]
    unbudgeted: list[CostOut]
    incidents: list[IncidentMoney]
    totals: BudgetTotals
    missing_rates: bool
    warnings: list[str] = []


def _load(db: Session, ctx: WorkspaceCtx, tour_id: str) -> Tour:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.budget).selectinload(TourBudgetLine.vendor),
                           selectinload(Tour.costs).selectinload(TourCost.vendor), selectinload(Tour.participants))
                  .execution_options(populate_existing=True))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def _quote(db: Session, t: Tour) -> tuple[Quote, QuoteIn] | None:
    q = db.get(Quote, t.quote_id) if t.quote_id else None
    return (q, QuoteIn.model_validate(q.doc)) if q and q.workspace_id == t.workspace_id else None


def actual_tourists(t: Tour) -> int:
    leaders = t.budget_leaders or 0
    return len(t.participants) - leaders if t.participants else max((t.pax or 0) - leaders, 0)


def summary(db: Session, ctx: WorkspaceCtx, t: Tour, warnings: list[str] | None = None) -> BudgetOut:
    by_line: dict[str, list[TourCost]] = {}
    for c in t.costs:
        if c.budget_line_id:
            by_line.setdefault(c.budget_line_id, []).append(c)
    lines, planned_costed, actual_budgeted, not_costed = [], ZERO, ZERO, ZERO
    for b in t.budget:
        costs = by_line.get(b.id, [])
        planned = b.amount_base
        if costs:
            actual = sum((c.amount_base for c in costs), ZERO)
            var = actual - planned
            tolerance = max(Decimal(1), abs(planned) / 100)
            state = "on_budget" if abs(var) <= tolerance else ("over" if var > 0 else "under")
            planned_costed += planned
            actual_budgeted += actual
        else:
            actual = var = None
            state = "no_cost"
            not_costed += planned
        lines.append(BudgetLineOut(
            id=b.id, kind=b.kind, category=b.category, name=b.name,
            vendor=VendorRef.model_validate(b.vendor) if b.vendor else None, day=b.day, quantity=b.quantity,
            unit_price=b.unit_price, currency=b.currency, amount=b.amount, notes=b.notes, planned_base=planned,
            actual_base=actual, variance_base=var, costs=len(costs), status=state))
    unbudgeted = [c for c in t.costs if not c.budget_line_id and not c.incident_id]
    unbudgeted_total = sum((c.amount_base for c in unbudgeted), ZERO)
    incidents = _incident_money(db, t)
    incident_total = sum((c.amount_base for c in t.costs if c.incident_id), ZERO)
    revenue, cost, missing, _ = _tour_money(t, _invoices_by_tour(db, ctx.workspace.id, [t.id]).get(t.id, []))
    planned_total = sum((b.amount_base for b in t.budget), ZERO)
    revenue_planned = ((t.budget_revenue or ZERO) * (t.budget_rate_to_base or ZERO)).quantize(Decimal("0.01"))
    found = _quote(db, t)
    return BudgetOut(
        has_quote=found is not None, quote_id=found[0].id if found else None, quote_name=found[0].name if found else None,
        quote_range=(found[1].pax_min, found[1].pax_max) if found else None,
        set=bool(t.budget_set_at), source=t.budget_source, set_at=t.budget_set_at, tourists=t.budget_tourists,
        leaders=t.budget_leaders, actual_tourists=actual_tourists(t), currency=ctx.workspace.base_currency,
        lines=lines, unbudgeted=[finance.cost_out(c) for c in unbudgeted], incidents=incidents,
        totals=BudgetTotals(
            planned=planned_total, planned_costed=planned_costed, actual_budgeted=actual_budgeted,
            variance=actual_budgeted - planned_costed, not_costed=not_costed, unbudgeted=unbudgeted_total,
            incidents=incident_total, actual=cost,
            revenue_planned=revenue_planned, revenue_actual=revenue, profit_planned=revenue_planned - planned_total,
            profit_actual=revenue - cost),
        missing_rates=missing or any(b.rate_to_base == 0 and b.amount for b in t.budget)
        or bool(t.budget_set_at and not t.budget_rate_to_base),
        warnings=warnings or [])


def _incident_money(db: Session, t: Tour) -> list[IncidentMoney]:
    rows = db.scalars(select(Incident).where(Incident.tour_id == t.id, Incident.status.in_(("approved", "settled")))
                      .order_by(Incident.reported_at)).all()
    out = []
    for i in rows:
        mine = [c for c in t.costs if c.incident_id == i.id]
        cost = sum((c.amount_base for c in mine if c.reason == "incident"), ZERO)
        credit = sum((c.amount_base for c in mine if c.reason == "vendor_credit"), ZERO)
        inv = db.get(Invoice, i.invoice_id) if i.invoice_id else None
        charge = inv.signed_total_base if inv and inv.status == "issued" else ZERO
        draft = inv.signed_total_base if inv and inv.status == "draft" else ZERO
        out.append(IncidentMoney(id=i.id, title=i.title, status=i.status, carried_by=i.carried_by, cost=cost,
                                 vendor_credit=credit, client_charge=charge, client_charge_draft=draft,
                                 net=charge - cost - credit))
    return out


@router.get("/tours/{tour_id}/budget", response_model=BudgetOut)
def get_budget(tour_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    return summary(db, ctx, _load(db, ctx, tour_id))


def take_budget(db: Session, ctx: WorkspaceCtx, t: Tour, q: Quote, doc: QuoteIn, tourists: int) -> list[str]:
    doc = season_on(doc, t.start_date)          # a high-season departure: high-season costs
    snap = budget.apply(t, doc, tourists, finance.rates(db, ctx.workspace),
                        f"{q.name} · {tourists}+{doc.leaders_for(tourists)}" if doc.leaders_for(tourists) else f"{q.name} · {tourists}")
    db.flush()
    budget.link_unlinked(t)
    # Tickets: flights on the tour's days, a task to issue them by the fare's deadline.
    return snap.warnings + travel.to_tour(db, t, doc, ctx.user.id, q.name)


class TakeBudget(BaseModel):
    tourists: int | None = Field(default=None, ge=1, le=500)


@router.post("/tours/{tour_id}/budget", response_model=BudgetOut)
def set_budget(tour_id: str, body: TakeBudget, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    """(Re)take the budget from the tour's calculation, for a group size (default: the
    size it was sold at, else today's group). Costs stay linked to lines that remain."""
    t = _load(db, ctx, tour_id)
    found = _quote(db, t)
    if not found:
        raise HTTPException(status.HTTP_409_CONFLICT, "This tour wasn't created from a calculation")
    q, doc = found
    tourists = body.tourists or t.budget_tourists or t.quote_tourists or actual_tourists(t)
    if not doc.pax_min <= tourists <= doc.pax_max:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"The calculation covers {doc.pax_min}–{doc.pax_max} tourists")
    warnings = take_budget(db, ctx, t, q, doc, tourists)
    db.commit()
    return summary(db, ctx, _load(db, ctx, tour_id), warnings)


class CostsFromBudget(BaseModel):
    line_ids: list[str] | None = Field(default=None, max_length=500)  # None: every line with no cost yet


@router.post("/tours/{tour_id}/budget/costs", response_model=BudgetOut)
def costs_from_budget(tour_id: str, body: CostsFromBudget, ctx: WorkspaceCtx = Depends(can_ope_fin),
                      db: Session = Depends(get_db)):
    """Cost lines with the planned values, for budget lines nothing on the itinerary covers
    (e.g. the guide and bus agreed in the calculation). Edit them to the real invoice later."""
    t = _load(db, ctx, tour_id)
    costed = {c.budget_line_id for c in t.costs if c.budget_line_id}
    ids = set(body.line_ids) if body.line_ids is not None else None
    if ids is not None and ids - {b.id for b in t.budget}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "line_ids: not budget lines of this tour")
    for b in t.budget:
        if (ids is None and b.id not in costed) or (ids is not None and b.id in ids):
            t.costs.append(budget.cost_from(t, b))
    db.commit()
    return summary(db, ctx, _load(db, ctx, tour_id))


class LinkCosts(BaseModel):
    cost_ids: list[str] = Field(min_length=1, max_length=500)
    budget_line_id: str | None   # None: "not in the budget"


@router.post("/tours/{tour_id}/budget/link", response_model=BudgetOut)
def link_costs(tour_id: str, body: LinkCosts, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    """Choose the budget line for several costs at once (e.g. all lunches in Georgia)."""
    t = _load(db, ctx, tour_id)
    if body.budget_line_id and not any(b.id == body.budget_line_id for b in t.budget):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "budget_line_id: not a budget line of this tour")
    costs = {c.id: c for c in t.costs}
    if set(body.cost_ids) - set(costs):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "cost_ids: not cost lines of this tour")
    for cid in body.cost_ids:
        costs[cid].budget_line_id = body.budget_line_id
        costs[cid].budget_by_hand = True
    db.commit()
    return summary(db, ctx, _load(db, ctx, tour_id))
