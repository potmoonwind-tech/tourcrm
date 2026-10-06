"""A closed tour is final: its money and plan can't change until an admin reopens it.

Enforced once, on every database flush, rather than in each endpoint: any insert,
update or delete touching a closed tour (its days, people, costs, payments, budget,
incidents, invoices, client payments) raises TourLocked, which the API turns into a
409. Closing and reopening only change the tour's close fields, which stay allowed.
"""
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from .models import (
    ClientPayment, Incident, TourBooking, Invoice, InvoiceLine, Participant, StaffAssignment, Tour, TourBudgetLine, TourCost,
    TourDay, VendorBill, VendorPayment,
)

CLOSE_FIELDS = {"closed_at", "closed_by_id", "close_note", "final_revenue", "final_cost"}
_BY_TOUR = (TourDay, StaffAssignment, Participant, TourCost, VendorPayment, VendorBill, TourBudgetLine, Incident, TourBooking)


class TourLocked(Exception):
    def __init__(self, code: str):
        super().__init__(f"Tour {code} is closed: reopen it to make changes")


def _was_closed(t: Tour) -> bool:
    """Closed before this flush (a reopen in this flush still counts as closed before)."""
    hist = inspect(t).attrs.closed_at.history
    before = hist.deleted[0] if hist.deleted else t.closed_at
    return before is not None


def _tour_of(session: Session, obj) -> Tour | None:
    # A new row may point at its tour through the relationship only (tour_id is set at flush).
    linked = obj.__dict__.get("tour")
    if isinstance(linked, Tour):
        return linked
    if isinstance(obj, (*_BY_TOUR, Invoice)):
        tid = obj.tour_id
    elif isinstance(obj, (InvoiceLine, ClientPayment)):
        inv = session.get(Invoice, obj.invoice_id) if obj.invoice_id else None
        tid = inv.tour_id if inv else None
    else:
        return None
    return session.get(Tour, tid) if tid else None


def _old_tour_ids(obj) -> list[str]:
    """An invoice moved off a closed tour counts against that tour too."""
    if isinstance(obj, Invoice):
        hist = inspect(obj).attrs.tour_id.history
        return [x for x in hist.deleted if x]
    return []


@event.listens_for(Session, "before_flush")
def _guard(session: Session, flush_context, instances) -> None:
    with session.no_autoflush:
        for obj in list(session.dirty) + list(session.new) + list(session.deleted):
            if isinstance(obj, Tour):
                if obj in session.new or not _was_closed(obj):
                    continue
                if obj in session.deleted:
                    raise TourLocked(obj.code)
                changed = {a.key for a in inspect(obj).attrs if a.history.has_changes()}
                if changed - CLOSE_FIELDS:
                    raise TourLocked(obj.code)
                continue
            if obj in session.dirty and not session.is_modified(obj):
                continue  # only touched (e.g. a relationship loaded), nothing to write
            tours = [_tour_of(session, obj)] + [session.get(Tour, tid) for tid in _old_tour_ids(obj)]
            for t in tours:
                if t is not None and _was_closed(t) and not (t in session.dirty and t.closed_at is None):
                    raise TourLocked(t.code)
