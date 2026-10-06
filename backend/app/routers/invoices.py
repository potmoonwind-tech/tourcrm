"""Client invoices, credit notes, money received, client debts and profit. Manager and up.

Lifecycle: draft (freely editable, not counted) → issued (counted as revenue;
only due date / notes change) → void (cancelled; kept for the number trail).
An invoice with payments or issued credit notes can't be voided.

Issued invoices never change. A correction (refund, smaller group, compensation)
is a credit note: its own numbered document against one issued invoice, never
more than is left to credit. It lowers revenue and that invoice's balance; if the
client had already paid, the invoice shows a refund due, recorded as a refund.
"""
from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .. import finance, schedule
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Client, ClientPayment, Invoice, InvoiceLine, Tour, TourCost
from ..schemas import (
    ClientDebt, ClientPaymentIn, ClientPaymentOut, CreditNoteIn, DocRef, InvoiceIn, InvoiceLineOut, InvoiceOut,
    InvoicePatch, InvoiceSummary, PaymentTerms, ProfitReport, ProfitRow, Ref, RefundIn, TourRef, _currency,
)
from ..scoping import check_refs

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["invoices"])
can_fin_sal = require_jobs('finance', 'sales')
can_fin = require_jobs('finance')
ZERO = Decimal(0)

_opts = (selectinload(Invoice.lines), selectinload(Invoice.payments), selectinload(Invoice.client),
         selectinload(Invoice.tour).selectinload(Tour.series),
         selectinload(Invoice.credit_notes).selectinload(Invoice.lines),
         selectinload(Invoice.credits).selectinload(Invoice.lines))


# --- helpers -----------------------------------------------------------------------------

def display_status(inv: Invoice, today: date | None = None) -> str:
    if inv.status in ("draft", "void"):
        return inv.status
    if inv.is_credit_note:
        return "credit_note"
    if inv.balance < 0:
        return "refund_due"
    if inv.balance == 0:
        return "paid"
    return finance.status_of(inv.total - inv.credited, inv.paid, inv.due_date, today or date.today())


def _ref(inv: Invoice) -> DocRef:
    return DocRef(id=inv.id, number=inv.number, status=inv.status, total=inv.total)


def creditable(inv: Invoice, excluding: str | None = None) -> Decimal:
    """What can still be credited on an issued invoice (other issued credit notes taken off)."""
    done = sum((cn.total for cn in inv.credit_notes if cn.status == "issued" and cn.id != excluding), ZERO)
    return inv.total - done


def summary(inv: Invoice) -> InvoiceSummary:
    t = inv.tour
    return InvoiceSummary(
        id=inv.id, number=inv.number, kind=inv.kind, credits=_ref(inv.credits) if inv.credits else None,
        status=inv.status, display_status=display_status(inv),
        client=Ref(id=inv.client.id, name=inv.client.name),
        tour=TourRef(id=t.id, code=t.code, color=t.series.color if t.series else "slate") if t else None,
        issue_date=inv.issue_date, due_date=inv.due_date, currency=inv.currency, rate_to_base=inv.rate_to_base,
        total=inv.total, paid=inv.paid, credited=inv.credited, balance=ZERO if inv.is_credit_note else inv.balance,
        total_base=inv.total_base,
    )


def full(inv: Invoice) -> InvoiceOut:
    return InvoiceOut(
        **summary(inv).model_dump(), notes=inv.notes,
        lines=[InvoiceLineOut(description=ln.description, quantity=ln.quantity, unit_price=ln.unit_price,
                              amount=ln.amount) for ln in inv.lines],
        payments=[ClientPaymentOut.model_validate(p) for p in inv.payments],
        credit_notes=[_ref(cn) for cn in inv.credit_notes if cn.status != "void"],
        creditable=creditable(inv) if inv.status == "issued" and not inv.is_credit_note else ZERO,
    )


def _get(db: Session, ctx: WorkspaceCtx, invoice_id: str) -> Invoice:
    inv = db.scalar(select(Invoice).where(Invoice.id == invoice_id, Invoice.workspace_id == ctx.workspace.id)
                    .options(*_opts).execution_options(populate_existing=True))
    if not inv:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
    return inv


def next_number(db: Session, ws_id: str, year: int, credit_note: bool = False) -> str:
    prefix = f"CN-{year}-" if credit_note else f"{year}-"
    taken = db.scalars(select(Invoice.number).where(Invoice.workspace_id == ws_id, Invoice.number.like(f"{prefix}%")))
    n = max((int(x[len(prefix):]) for x in taken if x and x[len(prefix):].isdigit()), default=0) + 1
    return f"{prefix}{n:04d}"


def _apply(db: Session, ctx: WorkspaceCtx, inv: Invoice, body: InvoiceIn) -> None:
    if inv.is_credit_note:
        # A credit note belongs to its invoice: same client, tour and currency, and
        # never more than is left to credit.
        orig = inv.credits
        body = body.model_copy(update={"client_id": orig.client_id, "tour_id": orig.tour_id, "currency": orig.currency,
                                       "rate_to_base": orig.rate_to_base})
        _check_credit(orig, sum((ln.quantity * ln.unit_price for ln in body.lines), ZERO), inv.id)
    check_refs(db, ctx, {"client_id": (Client, body.client_id), "tour_id": (Tour, body.tour_id)})
    if body.due_date < body.issue_date:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Due date is before the issue date")
    rate = body.rate_to_base
    if rate is None:
        rate = finance.rate_for(finance.rates(db, ctx.workspace), body.currency)
    inv.client_id, inv.tour_id = body.client_id, body.tour_id
    inv.issue_date, inv.due_date, inv.currency, inv.rate_to_base, inv.notes = (
        body.issue_date, body.due_date, body.currency, rate, body.notes)
    inv.lines.clear()
    db.flush()
    inv.lines.extend(InvoiceLine(position=i, **ln.model_dump()) for i, ln in enumerate(body.lines))


def _check_credit(orig: Invoice, amount: Decimal, excluding: str | None) -> None:
    left = creditable(orig, excluding)
    if amount > left:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"Only {left:.2f} {orig.currency} is left to credit on invoice {orig.number}")


# --- invoices -------------------------------------------------------------------------------

@router.get("/invoices", response_model=list[InvoiceSummary])
def list_invoices(client_id: str | None = None, tour_id: str | None = None,
                  status_: Literal["all", "open", "overdue", "draft", "paid", "void"] = Query(default="all", alias="status"),
                  ctx: WorkspaceCtx = Depends(can_fin_sal), db: Session = Depends(get_db)):
    stmt = select(Invoice).where(Invoice.workspace_id == ctx.workspace.id).options(*_opts)
    if client_id:
        stmt = stmt.where(Invoice.client_id == client_id)
    if tour_id:
        stmt = stmt.where(Invoice.tour_id == tour_id)
    rows = [summary(i) for i in db.scalars(stmt.order_by(Invoice.issue_date.desc(), Invoice.created_at.desc()))]
    want = {
        "all": lambda s: True,
        "open": lambda s: s in ("unpaid", "partial", "overdue", "refund_due"),
        "overdue": lambda s: s == "overdue",
        "draft": lambda s: s == "draft",
        "paid": lambda s: s == "paid",
        "void": lambda s: s == "void",
    }[status_]
    return [r for r in rows if want(r.display_status)]


@router.post("/invoices", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
def create_invoice(body: InvoiceIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = Invoice(workspace_id=ctx.workspace.id)
    db.add(inv)
    _apply(db, ctx, inv, body)
    db.commit()
    return full(_get(db, ctx, inv.id))


@router.get("/invoices/{invoice_id}", response_model=InvoiceOut)
def get_invoice(invoice_id: str, ctx: WorkspaceCtx = Depends(can_fin_sal), db: Session = Depends(get_db)):
    return full(_get(db, ctx, invoice_id))


@router.put("/invoices/{invoice_id}", response_model=InvoiceOut)
def replace_invoice(invoice_id: str, body: InvoiceIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    if inv.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft invoices can be edited")
    _apply(db, ctx, inv, body)
    db.commit()
    return full(_get(db, ctx, inv.id))


@router.patch("/invoices/{invoice_id}", response_model=InvoiceOut)
def patch_invoice(invoice_id: str, body: InvoicePatch, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    if inv.status == "void":
        raise HTTPException(status.HTTP_409_CONFLICT, "The invoice is void")
    if body.due_date and body.due_date < inv.issue_date:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Due date is before the issue date")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(inv, k, v)
    db.commit()
    return full(_get(db, ctx, inv.id))


@router.post("/invoices/{invoice_id}/issue", response_model=InvoiceOut)
def issue_invoice(invoice_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    if inv.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a draft can be issued")
    if not inv.lines or inv.total <= 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Add at least one line with an amount")
    if inv.is_credit_note:
        if inv.credits.status != "issued":
            raise HTTPException(status.HTTP_409_CONFLICT, "The invoice it credits is no longer issued")
        _check_credit(inv.credits, inv.total, inv.id)
    for _ in range(3):  # two people issuing at once may race for the same number
        inv.number = next_number(db, ctx.workspace.id, inv.issue_date.year, inv.is_credit_note)
        inv.status = "issued"
        try:
            db.commit()
            return full(_get(db, ctx, inv.id))
        except IntegrityError:
            db.rollback()
            inv = _get(db, ctx, invoice_id)
    raise HTTPException(status.HTTP_409_CONFLICT, "Could not allocate an invoice number, try again")


@router.post("/invoices/{invoice_id}/void", response_model=InvoiceOut)
def void_invoice(invoice_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    if inv.status != "issued":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only an issued invoice can be voided (delete drafts instead)")
    if inv.payments:
        raise HTTPException(status.HTTP_409_CONFLICT, "Remove the payments before voiding")
    if any(cn.status == "issued" for cn in inv.credit_notes):
        raise HTTPException(status.HTTP_409_CONFLICT, "Void its credit notes first")
    if inv.is_credit_note and any(p.amount < 0 for p in inv.credits.payments):
        raise HTTPException(status.HTTP_409_CONFLICT, "A refund was paid on its invoice; remove the refund first")
    inv.status = "void"
    db.commit()
    return full(_get(db, ctx, inv.id))


@router.delete("/invoices/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_invoice(invoice_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    if inv.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Issued invoices are voided, not deleted")
    db.delete(inv)
    db.commit()


# --- money received ------------------------------------------------------------------------

@router.post("/invoices/{invoice_id}/payments", response_model=ClientPaymentOut, status_code=status.HTTP_201_CREATED)
def receive_payment(invoice_id: str, body: ClientPaymentIn, ctx: WorkspaceCtx = Depends(can_fin),
                    db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    if inv.status != "issued":
        raise HTTPException(status.HTTP_409_CONFLICT, "Payments can only be recorded on issued invoices")
    if inv.is_credit_note:
        raise HTTPException(status.HTTP_409_CONFLICT, "Record payments and refunds on the invoice, not on its credit note")
    p = ClientPayment(invoice_id=inv.id, created_by_id=ctx.user.id, **body.model_dump())
    db.add(p)
    db.commit()
    return p


@router.post("/invoices/{invoice_id}/credit-note", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
def create_credit_note(invoice_id: str, body: CreditNoteIn, ctx: WorkspaceCtx = Depends(can_fin),
                       db: Session = Depends(get_db)):
    """A draft credit note against an issued invoice: the lines given, or a copy of the
    invoice's lines (as much as is left to credit) to edit down."""
    orig = _get(db, ctx, invoice_id)
    if orig.is_credit_note or orig.status != "issued":
        raise HTTPException(status.HTTP_409_CONFLICT, "Credit notes correct issued invoices")
    lines = body.lines
    if lines is None:
        left = creditable(orig)
        if left <= 0:
            raise HTTPException(status.HTTP_409_CONFLICT, "This invoice is fully credited")
        lines = [ln for ln in orig.lines] if left == orig.total else []
        lines = [{"description": ln.description, "quantity": ln.quantity, "unit_price": ln.unit_price} for ln in lines] \
            or [{"description": f"Credit on invoice {orig.number}", "quantity": 1, "unit_price": left}]
    else:
        lines = [ln.model_dump() for ln in lines]
    _check_credit(orig, sum((Decimal(str(ln["quantity"])) * Decimal(str(ln["unit_price"])) for ln in lines), ZERO), None)
    today = date.today()
    cn = Invoice(workspace_id=ctx.workspace.id, kind="credit_note", credits_id=orig.id, client_id=orig.client_id,
                 tour_id=orig.tour_id, currency=orig.currency, rate_to_base=orig.rate_to_base, issue_date=today,
                 due_date=today, notes=body.notes or f"Corrects invoice {orig.number}")
    cn.lines = [InvoiceLine(position=i, description=ln["description"], quantity=ln["quantity"], unit_price=ln["unit_price"])
                for i, ln in enumerate(lines)]
    db.add(cn)
    db.commit()
    return full(_get(db, ctx, cn.id))


@router.post("/invoices/{invoice_id}/refunds", response_model=ClientPaymentOut, status_code=status.HTTP_201_CREATED)
def refund(invoice_id: str, body: RefundIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """Money paid back to the client after a credit note: a negative payment, at most the refund due."""
    inv = _get(db, ctx, invoice_id)
    due = -inv.balance
    if inv.is_credit_note or inv.status != "issued" or due <= 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Nothing to refund on this invoice")
    if body.amount > due:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"The refund due is {due:.2f} {inv.currency}")
    p = ClientPayment(invoice_id=inv.id, created_by_id=ctx.user.id, amount=-body.amount, received_on=body.paid_on,
                      method=body.method, reference=body.reference, notes="Refund")
    db.add(p)
    db.commit()
    return p


@router.delete("/invoices/{invoice_id}/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_received(invoice_id: str, payment_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    inv = _get(db, ctx, invoice_id)
    p = next((p for p in inv.payments if p.id == payment_id), None)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found")
    inv.payments.remove(p)
    db.commit()


# --- debts ------------------------------------------------------------------------------------

@router.get("/debts", response_model=list[ClientDebt])
def client_debts(ctx: WorkspaceCtx = Depends(can_fin_sal), db: Session = Depends(get_db)):
    """What each client still owes on issued invoices, biggest first."""
    today = date.today()
    open_: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    overdue: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    count: dict[str, int] = defaultdict(int)
    oldest: dict[str, date] = {}
    clients: dict[str, Client] = {}
    refunds: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    invs = db.scalars(select(Invoice).where(Invoice.workspace_id == ctx.workspace.id, Invoice.status == "issued",
                                            Invoice.kind == "invoice").options(*_opts))
    for inv in invs:
        bal = inv.balance
        if bal < 0:
            clients[inv.client_id] = inv.client
            refunds[inv.client_id][inv.currency] += -bal
            continue
        if bal == 0:
            continue
        cid = inv.client_id
        clients[cid] = inv.client
        open_[cid][inv.currency] += bal
        count[cid] += 1
        oldest[cid] = min(oldest.get(cid, inv.due_date), inv.due_date)
        if inv.due_date < today:
            overdue[cid][inv.currency] += bal
    rows = [ClientDebt(client=Ref(id=c, name=clients[c].name), open={k: float(v) for k, v in open_[c].items()},
                       overdue={k: float(v) for k, v in overdue[c].items()}, open_invoices=count[c],
                       oldest_due=oldest.get(c), refund_due={k: float(v) for k, v in refunds[c].items()})
            for c in set(open_) | set(refunds)]
    return sorted(rows, key=lambda r: (-sum(r.overdue.values()), -sum(r.open.values())))


# --- profit -------------------------------------------------------------------------------------

def _tour_money(t: Tour, invoices: list[Invoice]) -> tuple[Decimal, Decimal, set[str], bool]:
    """(revenue, cost, currencies without a rate, invoiced) for one tour, in the base currency.
    Revenue = issued invoices only; drafts are not sales yet."""
    cost = sum((c.amount_base for c in t.costs), ZERO)
    missing = {c.currency for c in t.costs if c.rate_to_base == 0 and c.amount}
    issued = [i for i in invoices if i.status == "issued"]
    revenue = sum((i.signed_total_base for i in issued), ZERO)   # credit notes count negative
    missing |= {i.currency for i in issued if i.rate_to_base == 0 and i.total}
    return revenue, cost, missing, any(not i.is_credit_note for i in issued)


def _row(key: str, label: str, members: list[tuple[Tour, tuple]], vat_rate: Decimal | None = None, **extra) -> ProfitRow:
    revenue = sum((m[1][0] for m in members), ZERO)
    cost = sum((m[1][1] for m in members), ZERO)
    profit = revenue - cost
    # VAT inside the costs comes back from the tax office: profit after VAT = profit + it.
    vat = None if vat_rate is None else sum((finance.vat_base(t.costs, vat_rate) for t, _ in members), ZERO)
    return ProfitRow(
        vat=vat, profit_after_vat=None if vat is None else profit + vat,
        key=key, label=label, tours=len(members), pax=sum(t.pax for t, _ in members),
        revenue=revenue, cost=cost, profit=profit,
        margin=float((profit / revenue * 100).quantize(Decimal("0.1"))) if revenue else None,
        uninvoiced=sum(1 for _, m in members if not m[3] and m[1] > 0),
        missing_rates=any(m[2] for _, m in members),
        missing_currencies=sorted(set().union(*(m[2] for _, m in members))), **extra,
    )


def _invoices_by_tour(db: Session, ws_id: str, tour_ids: list[str]) -> dict[str, list[Invoice]]:
    out: dict[str, list[Invoice]] = defaultdict(list)
    if tour_ids:
        for inv in db.scalars(select(Invoice).where(Invoice.workspace_id == ws_id, Invoice.tour_id.in_(tour_ids))
                              .options(selectinload(Invoice.lines))):
            out[inv.tour_id].append(inv)
    return out


@router.get("/reports/profit", response_model=ProfitReport)
def profit_report(date_from: date | None = None, date_to: date | None = None,
                  group: Literal["tour", "month", "route"] = "tour",
                  ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """Profit of tours starting in [date_from, date_to] (default: this calendar year)."""
    today = date.today()
    date_from = date_from or date(today.year, 1, 1)
    date_to = date_to or date(today.year, 12, 31)
    ws = ctx.workspace
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.start_date >= date_from,
                                          Tour.start_date <= date_to)
                       .options(selectinload(Tour.costs).selectinload(TourCost.vendor), selectinload(Tour.series))
                       .order_by(Tour.start_date, Tour.code)).all()
    invoices = _invoices_by_tour(db, ws.id, [t.id for t in tours])
    members = [(t, _tour_money(t, invoices.get(t.id, []))) for t in tours]
    # A cancelled tour only matters if money moved (cancellation fees, deposits).
    members = [(t, m) for t, m in members if t.status != "cancelled" or m[0] or m[1]]

    groups: dict[str, list] = defaultdict(list)
    for t, m in members:
        key = {"tour": t.id, "month": f"{t.start_date:%Y-%m}", "route": t.series.code if t.series else "—"}[group]
        groups[key].append((t, m))
    rows = []
    for key, ms in groups.items():
        t0 = ms[0][0]
        if group == "tour":
            rows.append(_row(key, t0.code, ms, color=t0.series.color if t0.series else "slate", start_date=t0.start_date, vat_rate=ws.vat_rate))
        elif group == "route":
            rows.append(_row(key, f"{key} · {t0.series.name}" if t0.series else key, ms,
                             color=t0.series.color if t0.series else "slate", vat_rate=ws.vat_rate))
        else:
            rows.append(_row(key, key, ms, vat_rate=ws.vat_rate))
    if group == "route":
        rows.sort(key=lambda r: -r.profit)
    return ProfitReport(base_currency=ws.base_currency, group=group, rows=rows, totals=_row("total", "Total", members, vat_rate=ws.vat_rate))


@router.get("/tours/{tour_id}/profit", response_model=ProfitRow)
def tour_profit(tour_id: str, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.costs).selectinload(TourCost.vendor), selectinload(Tour.series)))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    invoices = _invoices_by_tour(db, ctx.workspace.id, [t.id])
    money_ = _tour_money(t, invoices.get(t.id, []))
    ws = ctx.workspace
    row = _row(t.id, t.code, [(t, money_)], color=t.series.color if t.series else "slate", start_date=t.start_date, vat_rate=ws.vat_rate)
    # Not invoiced yet: what the agreed price per person would bring.
    if (t.price_pp is not None or t.budget_revenue is not None) and t.pax and not money_[3]:
        # Sold from a calculation: its revenue for that size (leaders free, singles included).
        if t.budget_revenue is not None:
            cur, amount = t.budget_currency or ctx.workspace.base_currency, t.budget_revenue
        else:
            cur, amount = t.price_currency or ctx.workspace.base_currency, t.price_pp * (t.quote_tourists or t.pax)
        rate = finance.rate_for(finance.rates(db, ctx.workspace), cur)
        if rate:
            expected = (amount * rate).quantize(Decimal("0.01"))
            row.expected_revenue = float(expected)
            row.expected_paying = t.quote_tourists or t.pax
            row.expected_profit = float(expected - money_[1])
        else:
            row.missing_currencies = sorted({*row.missing_currencies, cur})
            row.missing_rates = True
    return row


# --- payment schedule: deposit and balance invoices from the client's terms ---------------------

class ScheduleIn(BaseModel):
    total: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)  # default: the price sold at
    currency: str | None = None
    description: str | None = Field(default=None, max_length=300)


class SchedulePart(BaseModel):
    kind: Literal["deposit", "balance", "full"]
    percent: float
    amount: float
    due_date: date


class ScheduleOut(BaseModel):
    terms: PaymentTerms
    source: Literal["client", "agency"]
    client: Ref | None
    total: float | None
    currency: str
    description: str
    parts: list[SchedulePart]
    existing: list[DocRef]      # invoices already on the tour (not void)
    created: list[str] = []     # ids, after creating


def _schedule(db: Session, ctx: WorkspaceCtx, tour_id: str, body: ScheduleIn) -> tuple[Tour, ScheduleOut, dict]:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.client)))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    terms, source = schedule.terms_for(ctx.workspace, t.client)
    # Default total: the calculation's revenue for the size sold (singles included), else pax × price per person.
    sold = (t.price_pp * t.pax).quantize(Decimal("0.01")) if t.price_pp is not None and t.pax else None
    use_budget = t.budget_revenue is not None
    total = body.total if body.total is not None else (t.budget_revenue if use_budget else sold)
    currency = _currency(body.currency) if body.currency else (
        (t.budget_currency if use_budget else t.price_currency) or ctx.workspace.base_currency)
    description = body.description or f"Tour {t.code} · {t.start_date:%d.%m}–{t.end_date:%d.%m.%Y}"
    parts = schedule.plan(terms, total, t.start_date) if total else []
    existing = db.scalars(select(Invoice).where(Invoice.tour_id == t.id, Invoice.status != "void")
                          .options(selectinload(Invoice.lines))).all()
    out = ScheduleOut(terms=PaymentTerms(**terms), source=source,
                      client=Ref(id=t.client.id, name=t.client.name) if t.client else None, total=total, currency=currency,
                      description=description, existing=[_ref(i) for i in existing],
                      parts=[SchedulePart(kind=p.kind, percent=p.percent, amount=p.amount, due_date=p.due_date) for p in parts])
    return t, out, terms


@router.post("/tours/{tour_id}/invoice-schedule/preview", response_model=ScheduleOut)
def schedule_preview(tour_id: str, body: ScheduleIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    return _schedule(db, ctx, tour_id, body)[1]


@router.post("/tours/{tour_id}/invoice-schedule", response_model=ScheduleOut, status_code=status.HTTP_201_CREATED)
def schedule_create(tour_id: str, body: ScheduleIn, ctx: WorkspaceCtx = Depends(can_fin), db: Session = Depends(get_db)):
    """Draft invoices for the tour by the client's payment terms (deposit + balance, or one)."""
    t, out, terms = _schedule(db, ctx, tour_id, body)
    if not t.client_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Set the tour's client first")
    if not out.total:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter the total to invoice")
    invs = schedule.make_invoices(ctx.workspace, t, t.client_id, out.currency,
                                  finance.rate_for(finance.rates(db, ctx.workspace), out.currency),
                                  [(out.description, Decimal(1), Decimal(str(out.total)))], terms)
    for inv in invs:
        db.add(inv)
    db.commit()
    out.created = [i.id for i in invs]
    return out
