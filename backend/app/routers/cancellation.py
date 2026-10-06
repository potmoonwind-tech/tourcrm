"""Cancelling a tour: what the client pays, what each vendor charges, in one step.

Client side: the client's own scale (their contract) or the agency's, by days before
arrival. That percent of each issued invoice is kept; the rest is credited (a draft
credit note), and money already paid above the penalty becomes a refund due. With
no issued invoice yet, a draft penalty invoice is made instead.

Vendor side: each vendor's release terms, by days before that vendor's first service
on the tour, as a percent of what was booked with them. The booked cost lines are
replaced by one penalty line; payments stay, so a vendor paid more than the penalty
shows as owing us back.

The wizard previews all of it; every percent can be changed before applying. It is
recorded as an approved "cancellation" incident, under the same approval limit.
"""
from collections import defaultdict
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Incident, Invoice, InvoiceLine, Tour, TourCost, utcnow
from ..schemas import ScaleRow, VendorRef

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["cancellation"])
can_ope_fin = require_jobs('operations', 'finance')
ZERO = Decimal(0)
CENT = Decimal("0.01")


def percent_for(scale: list[dict], days_left: int) -> tuple[Decimal, dict | None]:
    """The narrowest 'within N days' row that applies; none applies → 0 (free)."""
    rows = sorted((r for r in scale or [] if days_left <= r["within_days"]), key=lambda r: r["within_days"])
    return (Decimal(str(rows[0]["percent"])), rows[0]) if rows else (ZERO, None)


def _pct(amount: Decimal, percent: Decimal) -> Decimal:
    return (amount * percent / 100).quantize(CENT, ROUND_HALF_UP)


class CancelIn(BaseModel):
    on_date: date
    client_percent: Decimal | None = Field(default=None, ge=0, le=100, max_digits=5, decimal_places=2)
    vendor_percents: dict[str, Decimal] = Field(default_factory=dict)   # vendor_id → percent
    note: str = Field(default="", max_length=500)


class ClientPart(BaseModel):
    invoice_id: str | None
    number: str | None
    currency: str
    base: float          # what the percent is taken of (invoice net of credits, or the planned price)
    paid: float
    keep: float          # the penalty
    credit: float        # credited back (draft credit note)
    refund: float        # paid above the penalty: to give back
    new_invoice: bool    # no issued invoice: a draft penalty invoice is made


class VendorPart(BaseModel):
    vendor: VendorRef
    currency: str
    booked: float
    first_service: date
    days_left: int
    percent: float
    rule: ScaleRow | None
    penalty: float
    paid: float
    owes_back: float     # paid above the penalty


class CancelPreview(BaseModel):
    days_left: int
    scale_source: str            # client | agency
    scale: list[ScaleRow]
    rule: ScaleRow | None
    percent: float               # applied to the client (after any override)
    client: list[ClientPart]
    drafts_removed: list[str]    # draft invoices that won't be issued now
    vendors: list[VendorPart]
    free_lines: int              # cost lines without a vendor that are simply dropped
    client_penalty_base: float   # in base currency, for the approval limit
    vendor_penalty_base: float
    needs: str                   # manager | admin
    can_apply: bool
    warnings: list[str]


def _load(db: Session, ctx: WorkspaceCtx, tour_id: str) -> Tour:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.costs).selectinload(TourCost.vendor), selectinload(Tour.payments),
                           selectinload(Tour.client)).execution_options(populate_existing=True))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def plan(db: Session, ctx: WorkspaceCtx, t: Tour, body: CancelIn) -> tuple[CancelPreview, dict]:
    if t.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is already cancelled")
    if body.on_date > t.end_date:
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is already over")
    rates = finance.rates(db, ctx.workspace)
    warnings: list[str] = []
    days_left = max((t.start_date - body.on_date).days, 0)
    own = t.client.cancellation_scale if t.client and t.client.cancellation_scale is not None else None
    scale = own if own is not None else (ctx.workspace.cancellation_scale or [])
    percent, rule = percent_for(scale, days_left)
    if body.client_percent is not None:
        percent = body.client_percent

    invoices = db.scalars(select(Invoice).where(Invoice.tour_id == t.id, Invoice.workspace_id == ctx.workspace.id)
                          .options(selectinload(Invoice.lines), selectinload(Invoice.payments),
                                   selectinload(Invoice.credit_notes).selectinload(Invoice.lines))).all()
    issued = [i for i in invoices if i.kind == "invoice" and i.status == "issued"]
    drafts = [i for i in invoices if i.kind == "invoice" and i.status == "draft"]
    client_parts: list[ClientPart] = []
    for inv in issued:
        net = inv.total - inv.credited
        keep = _pct(net, percent)
        client_parts.append(ClientPart(invoice_id=inv.id, number=inv.number, currency=inv.currency, base=net,
                                       paid=inv.paid, keep=keep, credit=net - keep, refund=max(inv.paid - keep, ZERO),
                                       new_invoice=False))
    if not issued:
        # Nothing issued yet: the penalty is taken of the planned price.
        if drafts:
            by_cur: dict[str, Decimal] = defaultdict(Decimal)
            for d in drafts:
                by_cur[d.currency] += d.total
            bases = list(by_cur.items())
        elif t.budget_revenue:
            bases = [(t.budget_currency, t.budget_revenue)]
        else:
            bases = []
            if percent:
                warnings.append("No invoice and no price from a calculation: there is nothing to take the penalty of")
        for cur, base in bases:
            keep = _pct(base, percent)
            if keep > 0:
                client_parts.append(ClientPart(invoice_id=None, number=None, currency=cur, base=base, paid=0, keep=keep,
                                               credit=0, refund=0, new_invoice=True))
        if any(p.new_invoice for p in client_parts) and not t.client_id:
            warnings.append("The tour has no client: the penalty invoice can't be made (set the client first)")

    # Vendors: what was booked per vendor and currency (incident lines are real costs and stay).
    booked: dict[tuple[str, str], list[TourCost]] = defaultdict(list)
    free_lines = 0
    for c in t.costs:
        if c.incident_id:
            continue
        if c.vendor_id:
            booked[(c.vendor_id, c.currency)].append(c)
        else:
            free_lines += 1
    paid: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    for p in t.payments:
        paid[(p.vendor_id, p.currency)] += p.amount
    vendor_parts: list[VendorPart] = []
    for (vid, cur), lines in sorted(booked.items(), key=lambda kv: (kv[1][0].vendor.name, kv[0][1])):
        v = lines[0].vendor
        first = min(c.service_date for c in lines)
        v_days = max((first - body.on_date).days, 0)
        v_pct, v_rule = percent_for(v.cancel_terms or [], v_days)
        if vid in body.vendor_percents:
            v_pct = Decimal(str(body.vendor_percents[vid]))
            if not ZERO <= v_pct <= 100:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Percents are between 0 and 100")
        total = sum((c.amount for c in lines), ZERO)
        penalty = _pct(total, v_pct)
        vendor_parts.append(VendorPart(
            vendor=VendorRef.model_validate(v), currency=cur, booked=total, first_service=first, days_left=v_days,
            percent=v_pct, rule=ScaleRow(**v_rule) if v_rule else None, penalty=penalty, paid=paid[(vid, cur)],
            owes_back=max(paid[(vid, cur)] - penalty, ZERO)))
    if set(body.vendor_percents) - {p.vendor.id for p in vendor_parts}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "vendor_percents: vendors not booked on this tour")

    client_base = sum((Decimal(str(p.keep)) * finance.rate_for(rates, p.currency) for p in client_parts), ZERO)
    vendor_base = sum((Decimal(str(p.penalty)) * finance.rate_for(rates, p.currency) for p in vendor_parts), ZERO)
    limit = ctx.workspace.incident_approval_limit
    unrated = any(not finance.rate_for(rates, p.currency) for p in [*client_parts, *vendor_parts])
    need = "admin" if limit is not None and (unrated or max(client_base, vendor_base) > limit) else "manager"
    preview = CancelPreview(
        days_left=days_left, scale_source="client" if own is not None else "agency",
        scale=[ScaleRow(**r) for r in scale], rule=ScaleRow(**rule) if rule and body.client_percent is None else None,
        percent=percent, client=client_parts, drafts_removed=[f"{d.total:.2f} {d.currency}" for d in drafts],
        vendors=vendor_parts, free_lines=free_lines, client_penalty_base=client_base, vendor_penalty_base=vendor_base,
        needs=need, can_apply=ctx.allowed(need), warnings=warnings)
    return preview, {"issued": issued, "drafts": drafts, "booked": booked}


@router.post("/tours/{tour_id}/cancellation/preview", response_model=CancelPreview)
def preview(tour_id: str, body: CancelIn, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    return plan(db, ctx, _load(db, ctx, tour_id), body)[0]


class CancelOut(BaseModel):
    incident_id: str
    documents: list[str]   # ids of the draft credit notes / penalty invoice made


@router.post("/tours/{tour_id}/cancel", response_model=CancelOut)
def cancel(tour_id: str, body: CancelIn, ctx: WorkspaceCtx = Depends(can_ope_fin), db: Session = Depends(get_db)):
    t = _load(db, ctx, tour_id)
    p, src = plan(db, ctx, t, body)
    if not p.can_apply:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Above the approval limit: an admin or the owner cancels this")
    if any(c.new_invoice for c in p.client) and not t.client_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Set the tour's client first: the penalty invoice needs one")
    rates = finance.rates(db, ctx.workspace)
    title = f"Tour cancelled {p.days_left} days before arrival"
    inc = Incident(workspace_id=ctx.workspace.id, tour_id=t.id, kind="cancellation", title=title,
                   description=body.note or f"Client penalty {p.percent}% ({'client contract' if p.scale_source == 'client' else 'agency scale'}).",
                   carried_by="client", status="approved", costs=[], reported_by_id=ctx.user.id,
                   decided_by_id=ctx.user.id, decided_at=utcnow(), decision_note=body.note)
    db.add(inc)
    db.flush()
    docs: list[str] = []
    today = date.today()

    # Client: credit what isn't kept; or a penalty invoice when nothing was issued.
    issued = {i.id: i for i in src["issued"]}
    for part in p.client:
        if part.new_invoice:
            inv = Invoice(workspace_id=ctx.workspace.id, client_id=t.client_id, tour_id=t.id, currency=part.currency,
                          rate_to_base=finance.rate_for(rates, part.currency), issue_date=today, due_date=today,
                          notes=f"Cancellation of tour {t.code}")
            inv.lines = [InvoiceLine(position=0, description=f"Cancellation fee {p.percent}% · tour {t.code}"[:300],
                                     quantity=Decimal(1), unit_price=Decimal(str(part.keep)))]
        elif part.credit > 0:
            orig = issued[part.invoice_id]
            inv = Invoice(workspace_id=ctx.workspace.id, kind="credit_note", credits_id=orig.id, client_id=orig.client_id,
                          tour_id=t.id, currency=orig.currency, rate_to_base=orig.rate_to_base, issue_date=today,
                          due_date=today, notes=f"Cancellation of tour {t.code}: {p.percent}% kept")
            inv.lines = [InvoiceLine(position=0, description=f"Tour {t.code} cancelled: {100 - p.percent}% credited"[:300],
                                     quantity=Decimal(1), unit_price=Decimal(str(part.credit)))]
        else:
            continue
        db.add(inv)
        db.flush()
        docs.append(inv.id)
    for d in src["drafts"]:
        db.delete(d)
    inc.invoice_id = next((d for d in docs if db.get(Invoice, d).kind == "invoice"), None)

    # Vendors: booked lines become one penalty line each; lines without a vendor are dropped.
    for c in [c for c in t.costs if not c.incident_id]:
        t.costs.remove(c)
    for part in p.vendors:
        if part.penalty > 0:
            first = src["booked"][(part.vendor.id, part.currency)][0]
            t.costs.append(TourCost(
                tour_id=t.id, vendor_id=part.vendor.id, category=first.category,
                description=f"Cancellation penalty {part.percent}% of {part.booked:.2f}"[:300],
                service_date=body.on_date, quantity=Decimal(1), unit_price=Decimal(str(part.penalty)),
                currency=part.currency, rate_to_base=finance.rate_for(rates, part.currency), reason="incident",
                incident_id=inc.id, budget_by_hand=True))
    t.status, t.cancelled_on = "cancelled", body.on_date
    db.commit()
    return CancelOut(incident_id=inc.id, documents=docs)
