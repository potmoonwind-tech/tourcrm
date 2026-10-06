"""Incidents: things that happen beyond the plan (an extra night, a broken bus, a penalty)
and their money on both sides.

Staff (and later guides) report what happened. Managers add the money: cost lines
we pay, a charge to the client, a claim against the vendor at fault. Approving
creates all of it together; above the agency's limit only an admin or the owner
may approve. Staff never see amounts, as everywhere else in the app.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Incident, Invoice, InvoiceLine, Tour, TourCost, Vendor, utcnow
from ..schemas import Amount, VendorRef, _currency
from ..scoping import check_refs
from .invoices import creditable

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["incidents"])
report = require_role("staff")
can_ope_fin = require_jobs('operations', 'finance')
ZERO = Decimal(0)

Kind = Literal["extra_service", "vendor_failure", "client_request", "delay", "damage", "penalty", "cancellation", "other"]
CarriedBy = Literal["client", "agency", "vendor"]
Status = Literal["open", "approved", "rejected", "settled"]
CostCategory = Literal["hotel", "meal", "transport", "guide", "ticket", "visa", "other"]


class IncidentCost(BaseModel):
    vendor_id: str | None = None
    category: CostCategory = "other"
    description: str = Field(min_length=1, max_length=300)
    quantity: Decimal = Field(default=Decimal(1), gt=0, max_digits=10, decimal_places=2)
    unit_price: Amount
    currency: str

    _cur = field_validator("currency")(_currency)


class IncidentIn(BaseModel):
    day: int | None = Field(default=None, ge=1, le=60)
    kind: Kind = "other"
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    carried_by: CarriedBy = "agency"
    vendor_id: str | None = None   # the vendor at fault / to claim from
    # Money: managers only.
    costs: list[IncidentCost] | None = Field(default=None, max_length=50)
    client_charge: Amount | None = None
    client_credit: Amount | None = None   # compensation to the client: a credit note on their invoice
    client_currency: str | None = None
    vendor_claim: Amount | None = None
    claim_currency: str | None = None

    @field_validator("client_currency", "claim_currency")
    @classmethod
    def _curs(cls, v):
        return None if v in (None, "") else _currency(v)

    def has_money(self) -> bool:
        return (bool(self.costs) or self.client_charge is not None or self.client_credit is not None
                or self.vendor_claim is not None)


class IncidentPatch(IncidentIn):
    title: str | None = Field(default=None, min_length=1, max_length=200)  # type: ignore[assignment]


class IncidentCostOut(IncidentCost):
    amount: float


class IncidentOut(BaseModel):
    id: str
    tour_id: str
    tour_code: str
    day: int | None
    date: date | None
    kind: Kind
    title: str
    description: str
    carried_by: CarriedBy
    vendor: VendorRef | None
    status: Status
    reported_by: str | None
    reported_at: datetime
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str
    # Money (None for staff):
    costs: list[IncidentCostOut] | None
    client_charge: float | None
    client_credit: float | None
    client_currency: str
    vendor_claim: float | None
    claim_currency: str
    invoice_id: str | None
    total_base: float | None            # the biggest of costs / charge / claim, in base: what approval is about
    needs: Literal["manager", "admin"]  # who may approve it
    can_decide: bool


class Decision(BaseModel):
    note: str = Field(default="", max_length=500)


# --- helpers ---------------------------------------------------------------------------------

def _rates(db: Session, ctx: WorkspaceCtx):
    return finance.rates(db, ctx.workspace)


def _base(amount: Decimal | None, cur: str, rates) -> Decimal:
    return (amount or ZERO) * finance.rate_for(rates, cur) if amount else ZERO


def money_base(i: Incident, rates) -> Decimal:
    """The size of an incident for approval: its largest money effect in base currency."""
    costs = sum((_base(Decimal(str(c["quantity"])) * Decimal(str(c["unit_price"])), c["currency"], rates)
                 for c in i.costs or []), ZERO)
    return max(costs, _base(i.client_charge, i.client_currency, rates), _base(i.client_credit, i.client_currency, rates),
               _base(i.vendor_claim, i.claim_currency, rates))


def _unrated(i: Incident, rates) -> bool:
    amounts = [(c["currency"]) for c in i.costs or []] + [cur for amt, cur in ((i.client_charge, i.client_currency),
               (i.client_credit, i.client_currency), (i.vendor_claim, i.claim_currency)) if amt]
    return any(not finance.rate_for(rates, cur) for cur in amounts if cur)


def needs(i: Incident, ctx: WorkspaceCtx, rates) -> str:
    limit = ctx.workspace.incident_approval_limit
    if limit is not None and _unrated(i, rates):
        return "admin"             # its size is unknown without a rate: the bigger approval
    return "admin" if limit is not None and money_base(i, rates) > limit else "manager"


def _out(i: Incident, ctx: WorkspaceCtx, rates) -> IncidentOut:
    sees_money = ctx.can("operations", "finance")
    need = needs(i, ctx, rates)
    return IncidentOut(
        id=i.id, tour_id=i.tour_id, tour_code=i.tour.code, day=i.day,
        date=i.tour.start_date + timedelta(days=i.day - 1) if i.day else None, kind=i.kind, title=i.title,
        description=i.description, carried_by=i.carried_by,
        vendor=VendorRef.model_validate(i.vendor) if i.vendor else None, status=i.status,
        reported_by=_who(i.reported_by), reported_at=i.reported_at,
        decided_by=_who(i.decided_by), decided_at=i.decided_at, decision_note=i.decision_note,
        costs=[IncidentCostOut(**c, amount=float(Decimal(str(c["quantity"])) * Decimal(str(c["unit_price"]))))
               for c in i.costs or []] if sees_money else None,
        client_charge=i.client_charge if sees_money else None, client_credit=i.client_credit if sees_money else None,
        client_currency=i.client_currency if sees_money else "",
        vendor_claim=i.vendor_claim if sees_money else None, claim_currency=i.claim_currency if sees_money else "",
        invoice_id=i.invoice_id if sees_money else None,
        total_base=money_base(i, rates) if sees_money else None, needs=need,
        can_decide=i.status == "open" and ctx.allowed(need))


def _who(u) -> str | None:
    return (u.full_name or u.email) if u else None


def _get(db: Session, ctx: WorkspaceCtx, incident_id: str) -> Incident:
    i = db.scalar(select(Incident).where(Incident.id == incident_id, Incident.workspace_id == ctx.workspace.id)
                  .options(selectinload(Incident.tour), selectinload(Incident.vendor)))
    if not i:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Incident not found")
    return i


def _has_money_now(i: Incident) -> bool:
    return bool(i.costs) or any(x is not None for x in (i.client_charge, i.client_credit, i.vendor_claim))


def _apply(db: Session, ctx: WorkspaceCtx, i: Incident, body: IncidentIn, fields: set[str]) -> None:
    money_fields = {"costs", "client_charge", "client_credit", "vendor_claim", "client_currency", "claim_currency"}
    if not ctx.can("operations", "finance"):
        # Not even clearing: sending an empty or null money field is changing it.
        if body.has_money() or (fields & money_fields and i.id is not None and _has_money_now(i)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers set the money of an incident")
        if _has_money_now(i) and fields & {"carried_by", "vendor_id"}:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "A manager has priced this incident; ask them to change who pays")
    vendor_ids = {body.vendor_id} | {c.vendor_id for c in body.costs or []}
    for vid in vendor_ids - {None}:
        check_refs(db, ctx, {"vendor_id": (Vendor, vid)})
    n_days = (i.tour.end_date - i.tour.start_date).days + 1
    if body.day is not None and body.day > n_days:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"The tour has {n_days} days")
    for k in ("day", "kind", "title", "description", "carried_by", "vendor_id"):
        if k in fields and (getattr(body, k) is not None or k in ("day", "vendor_id")):
            setattr(i, k, getattr(body, k))
    if "costs" in fields:
        i.costs = [c.model_dump(mode="json") for c in body.costs or []]
    for amount, cur in (("client_charge", "client_currency"), ("client_credit", "client_currency"),
                        ("vendor_claim", "claim_currency")):
        if amount in fields:
            setattr(i, amount, getattr(body, amount))
        if cur in fields and getattr(body, cur):
            setattr(i, cur, getattr(body, cur))
        if getattr(i, amount) is not None and not getattr(i, cur):
            setattr(i, cur, ctx.workspace.base_currency)


def _check_ready(i: Incident) -> None:
    """What approving needs, said plainly."""
    if i.carried_by == "client" and not i.client_charge:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The client carries it: set the amount to charge them")
    if i.carried_by == "client" and not i.tour.client_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The tour has no client to charge")
    if i.vendor_claim and not i.vendor_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the vendor to claim from")
    if i.client_credit and i.carried_by == "client":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The client carries it, so there's nothing to compensate")
    if i.carried_by == "vendor" and not (i.vendor_id and i.vendor_claim):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The vendor carries it: choose the vendor and the amount to claim")


def _service_date(i: Incident) -> date:
    return i.tour.start_date + timedelta(days=(i.day or 1) - 1)


# --- endpoints ---------------------------------------------------------------------------------

@router.get("/incidents", response_model=list[IncidentOut])
def list_incidents(status_: Status | None = Query(default=None, alias="status"), tour_id: str | None = None,
                   ctx: WorkspaceCtx = Depends(report), db: Session = Depends(get_db)):
    stmt = (select(Incident).where(Incident.workspace_id == ctx.workspace.id)
            .options(selectinload(Incident.tour), selectinload(Incident.vendor),
                     selectinload(Incident.reported_by), selectinload(Incident.decided_by))
            .order_by(Incident.reported_at.desc()))
    if status_:
        stmt = stmt.where(Incident.status == status_)
    if tour_id:
        stmt = stmt.where(Incident.tour_id == tour_id)
    rates = _rates(db, ctx)
    return [_out(i, ctx, rates) for i in db.scalars(stmt)]


@router.post("/tours/{tour_id}/incidents", response_model=IncidentOut, status_code=status.HTTP_201_CREATED)
def report_incident(tour_id: str, body: IncidentIn, ctx: WorkspaceCtx = Depends(report), db: Session = Depends(get_db)):
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    i = Incident(workspace_id=ctx.workspace.id, tour=t, reported_by_id=ctx.user.id, title=body.title, costs=[])
    _apply(db, ctx, i, body, body.model_fields_set | {"title"})
    db.add(i)
    db.commit()
    return _out(_get(db, ctx, i.id), ctx, _rates(db, ctx))


@router.patch("/incidents/{incident_id}", response_model=IncidentOut)
def update_incident(incident_id: str, body: IncidentPatch, ctx: WorkspaceCtx = Depends(report),
                    db: Session = Depends(get_db)):
    i = _get(db, ctx, incident_id)
    if i.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only open incidents can be changed (reopen it first)")
    _apply(db, ctx, i, body, body.model_fields_set)
    db.commit()
    return _out(_get(db, ctx, i.id), ctx, _rates(db, ctx))


@router.post("/incidents/{incident_id}/approve", response_model=IncidentOut)
def approve(incident_id: str, body: Decision, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    """Create the money effects together: cost lines, the client's draft invoice, the vendor claim."""
    i = _get(db, ctx, incident_id)
    rates = _rates(db, ctx)
    if i.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only an open incident can be approved")
    if not ctx.allowed(needs(i, ctx, rates)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Above the approval limit: an admin or the owner approves this")
    _check_ready(i)
    t = i.tour
    when = _service_date(i)
    for c in i.costs or []:
        db.add(TourCost(tour_id=t.id, vendor_id=c.get("vendor_id"), category=c["category"],
                        description=f"{i.title}: {c['description']}"[:300], service_date=when,
                        quantity=Decimal(str(c["quantity"])), unit_price=Decimal(str(c["unit_price"])),
                        currency=c["currency"], rate_to_base=finance.rate_for(rates, c["currency"]),
                        reason="incident", incident_id=i.id, budget_by_hand=True))
    if i.vendor_claim:
        # What the vendor owes back: a negative line on their account for this tour.
        db.add(TourCost(tour_id=t.id, vendor_id=i.vendor_id, category="other",
                        description=f"Claim: {i.title}"[:300], service_date=when, quantity=Decimal(-1),
                        unit_price=i.vendor_claim, currency=i.claim_currency,
                        rate_to_base=finance.rate_for(rates, i.claim_currency), reason="vendor_credit",
                        incident_id=i.id, budget_by_hand=True))
    if i.carried_by == "client" and i.client_charge:
        today = date.today()
        inv = Invoice(workspace_id=ctx.workspace.id, client_id=t.client_id, tour_id=t.id, currency=i.client_currency,
                      rate_to_base=finance.rate_for(rates, i.client_currency), issue_date=today,
                      due_date=today + timedelta(days=7), notes=f"Extra charge: {i.title}")
        inv.lines = [InvoiceLine(position=0, description=f"{i.title}"[:300], quantity=Decimal(1), unit_price=i.client_charge)]
        db.add(inv)
        db.flush()
        i.invoice_id = inv.id
    if i.client_credit and i.carried_by != "client":
        i.invoice_id = _credit_note_for(db, ctx, i).id
    i.status, i.decided_by_id, i.decided_at, i.decision_note = "approved", ctx.user.id, utcnow(), body.note
    db.commit()
    return _out(_get(db, ctx, i.id), ctx, rates)


def _credit_note_for(db: Session, ctx: WorkspaceCtx, i: Incident) -> Invoice:
    """Compensation goes on the tour's latest issued invoice in that currency that still has room."""
    invs = db.scalars(select(Invoice).where(Invoice.tour_id == i.tour_id, Invoice.workspace_id == ctx.workspace.id,
                                            Invoice.kind == "invoice", Invoice.status == "issued",
                                            Invoice.currency == i.client_currency)
                      .options(selectinload(Invoice.lines), selectinload(Invoice.credit_notes).selectinload(Invoice.lines))
                      .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())).all()
    orig = next((inv for inv in invs if creditable(inv) >= i.client_credit), None)
    if not orig:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"Compensation needs an issued {i.client_currency} invoice on this tour with at least "
                            f"{i.client_credit:.2f} left to credit")
    today = date.today()
    cn = Invoice(workspace_id=ctx.workspace.id, kind="credit_note", credits_id=orig.id, client_id=orig.client_id,
                 tour_id=orig.tour_id, currency=orig.currency, rate_to_base=orig.rate_to_base, issue_date=today,
                 due_date=today, notes=f"Compensation: {i.title}")
    cn.lines = [InvoiceLine(position=0, description=f"Compensation: {i.title}"[:300], quantity=Decimal(1),
                            unit_price=i.client_credit)]
    db.add(cn)
    db.flush()
    return cn


@router.post("/incidents/{incident_id}/reject", response_model=IncidentOut)
def reject(incident_id: str, body: Decision, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    i = _get(db, ctx, incident_id)
    if i.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only an open incident can be rejected")
    i.status, i.decided_by_id, i.decided_at, i.decision_note = "rejected", ctx.user.id, utcnow(), body.note
    db.commit()
    return _out(_get(db, ctx, i.id), ctx, _rates(db, ctx))


@router.post("/incidents/{incident_id}/reopen", response_model=IncidentOut)
def reopen(incident_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    """Undo a decision. Its cost lines and draft invoice are removed again, which is only
    possible while nothing was paid or issued on them."""
    i = _get(db, ctx, incident_id)
    if i.kind == "cancellation":
        raise HTTPException(status.HTTP_409_CONFLICT, "A cancellation can't be reopened here — correct its invoices with credit notes")
    if i.status == "open":
        return _out(i, ctx, _rates(db, ctx))
    if i.status == "settled":
        raise HTTPException(status.HTTP_409_CONFLICT, "A settled incident can't be reopened")
    if i.status == "approved":
        inv = db.get(Invoice, i.invoice_id) if i.invoice_id else None
        if inv and inv.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT, "Its invoice is already issued: correct it with a credit note instead")
        costs = db.scalars(select(TourCost).where(TourCost.incident_id == i.id)).all()
        paid_vendors = {p.vendor_id for p in i.tour.payments}
        if any(c.vendor_id in paid_vendors for c in costs):
            raise HTTPException(status.HTTP_409_CONFLICT, "A vendor in it was already paid on this tour; adjust the cost lines instead")
        for c in costs:
            db.delete(c)
        if inv:
            db.delete(inv)
        i.invoice_id = None
    i.status, i.decided_by_id, i.decided_at, i.decision_note = "open", None, None, ""
    db.commit()
    return _out(_get(db, ctx, i.id), ctx, _rates(db, ctx))


@router.post("/incidents/{incident_id}/settle", response_model=IncidentOut)
def settle(incident_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    """Everything about it is done: paid, charged, claimed."""
    i = _get(db, ctx, incident_id)
    if i.status != "approved":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only an approved incident can be settled")
    i.status = "settled"
    db.commit()
    return _out(_get(db, ctx, i.id), ctx, _rates(db, ctx))


@router.delete("/incidents/{incident_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_incident(incident_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    i = _get(db, ctx, incident_id)
    if i.status not in ("open", "rejected"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Approved incidents stay on record (reopen it first)")
    db.delete(i)
    db.commit()
