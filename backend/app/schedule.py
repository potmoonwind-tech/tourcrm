"""Client payment schedule: deposit and balance invoices from the client's payment terms.

Terms come from the client (their contract) or the agency. The balance is due
balance_days_before arrival; the deposit deposit_days after booking. When there is
no deposit, or no time left for one (it would fall due on or after the balance),
it is a single invoice. The balance invoice lists the full price and deducts the
deposit ("Less deposit"), as clients expect to see it.
"""
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from .models import DEFAULT_PAYMENT_TERMS, Client, Invoice, InvoiceLine, Tour, Workspace

CENT = Decimal("0.01")


def terms_for(ws: Workspace, client: Client | None) -> tuple[dict, str]:
    if client is not None and client.payment_terms is not None:
        return {**DEFAULT_PAYMENT_TERMS, **client.payment_terms}, "client"
    return {**DEFAULT_PAYMENT_TERMS, **(ws.payment_terms or {})}, "agency"


@dataclass
class Part:
    kind: str           # deposit | balance | full
    percent: float
    amount: Decimal
    due_date: date


def plan(terms: dict, total: Decimal, start: date, today: date | None = None) -> list[Part]:
    today = today or date.today()
    balance_due = max(today, start - timedelta(days=int(terms["balance_days_before"])))
    pct = Decimal(str(terms["deposit_percent"]))
    deposit_due = today + timedelta(days=int(terms["deposit_days"]))
    if pct <= 0 or pct >= 100 or deposit_due >= balance_due:
        return [Part("full", 100, total, balance_due if pct < 100 else min(deposit_due, balance_due))]
    deposit = (total * pct / 100).quantize(CENT, ROUND_HALF_UP)
    return [Part("deposit", float(pct), deposit, deposit_due), Part("balance", float(100 - pct), total - deposit, balance_due)]


def make_invoices(ws: Workspace, t: Tour, client_id: str, currency: str, rate_to_base: Decimal,
                  lines: list[tuple[str, Decimal, Decimal]], terms: dict, today: date | None = None) -> list[Invoice]:
    """Draft invoices for the schedule. lines: (description, quantity, unit price) of the full price."""
    today = today or date.today()
    total = sum((q * p for _, q, p in lines), Decimal(0)).quantize(CENT, ROUND_HALF_UP)
    parts = plan(terms, total, t.start_date, today)
    title = lines[0][0] if len(lines) == 1 else f"Tour {t.code}"

    def invoice(due: date, notes: str) -> Invoice:
        return Invoice(workspace_id=ws.id, client_id=client_id, tour_id=t.id, currency=currency, rate_to_base=rate_to_base,
                       issue_date=today, due_date=due, notes=notes)

    def full_lines() -> list[InvoiceLine]:
        return [InvoiceLine(position=i, description=d[:300], quantity=q, unit_price=p) for i, (d, q, p) in enumerate(lines)]

    if parts[0].kind == "full":
        inv = invoice(parts[0].due_date, "")
        inv.lines = full_lines()
        return [inv]
    dep, bal = parts
    deposit = invoice(dep.due_date, f"Deposit {dep.percent:g}%. Balance {bal.amount:.2f} {currency} due {bal.due_date.isoformat()}.")
    deposit.lines = [InvoiceLine(position=0, description=f"Deposit {dep.percent:g}% · {title}"[:300],
                                 quantity=Decimal(1), unit_price=dep.amount)]
    balance = invoice(bal.due_date, f"Balance {bal.percent:g}% after the deposit.")
    balance.lines = full_lines() + [InvoiceLine(position=len(lines), description=f"Less deposit {dep.percent:g}%",
                                                quantity=Decimal(1), unit_price=-dep.amount)]
    return [deposit, balance]
