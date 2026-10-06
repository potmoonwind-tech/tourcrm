"""Phone pages for guides and drivers: a private link per person per tour, no login.

The office makes a link for one staff assignment (a guide or driver on a tour) and sends it by
WhatsApp/SMS. The link shows only that person's days: where to go, hotel and restaurant
addresses, km and notes; guides also get the group list (names, rooms, phones, notes — never
passports) and the set menus. Anyone holding the link can see this, so:
  - only a hash of the token is stored; the office sees the link once and can make a new one,
  - a new link replaces the old one, and the office can switch it off,
  - it stops working a few days after the tour ends, and requests are rate limited.
"""
import hashlib
import secrets
from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import finance, ratelimit, storage
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import (COST_CATEGORIES, FieldExpense, FieldLink, Service, StaffAssignment, Tour, TourChange, TourCost, TourDay,
                      Vendor, VendorPayment, Workspace, utcnow)
from ..schemas import _currency
from ..scoping import get_owned

router = APIRouter(tags=["field"])
office = require_role("staff")
GRACE_DAYS = 3          # the link keeps working this long after the tour's last day
SEES_GROUP = ("guide", "tour_leader", "assistant")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# --- office side ---------------------------------------------------------------------------------

class FieldLinkOut(BaseModel):
    id: str
    staff_id: str
    created_at: datetime
    expires_on: date
    last_seen_at: datetime | None
    token: str | None = None        # only right after it's made


def _staff(db: Session, ctx: WorkspaceCtx, tour_id: str, staff_id: str) -> StaffAssignment:
    t = get_owned(db, ctx, Tour, tour_id)
    s = db.scalar(select(StaffAssignment).where(StaffAssignment.id == staff_id, StaffAssignment.tour_id == t.id))
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not on this tour")
    return s


@router.get("/api/workspaces/{workspace_id}/tours/{tour_id}/field-links", response_model=list[FieldLinkOut])
def list_links(tour_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    t = get_owned(db, ctx, Tour, tour_id)
    rows = db.scalars(select(FieldLink).where(FieldLink.tour_id == t.id, FieldLink.revoked_at.is_(None)))
    return [FieldLinkOut(id=x.id, staff_id=x.staff_id, created_at=x.created_at, expires_on=x.expires_on,
                         last_seen_at=x.last_seen_at) for x in rows]


@router.post("/api/workspaces/{workspace_id}/tours/{tour_id}/staff/{staff_id}/field-link",
             response_model=FieldLinkOut, status_code=status.HTTP_201_CREATED)
def make_link(tour_id: str, staff_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    s = _staff(db, ctx, tour_id, staff_id)
    if s.tour.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is cancelled")
    now = utcnow()
    for old in db.scalars(select(FieldLink).where(FieldLink.staff_id == s.id, FieldLink.revoked_at.is_(None))):
        old.revoked_at = now                                  # one live link per person
    token = secrets.token_urlsafe(24)
    x = FieldLink(workspace_id=ctx.workspace.id, tour_id=s.tour_id, staff_id=s.id, token_hash=_hash(token),
                  expires_on=s.tour.end_date + timedelta(days=GRACE_DAYS), created_by_id=ctx.user.id)
    db.add(x)
    db.commit()
    return FieldLinkOut(id=x.id, staff_id=s.id, created_at=x.created_at, expires_on=x.expires_on,
                        last_seen_at=None, token=token)


@router.delete("/api/workspaces/{workspace_id}/tours/{tour_id}/field-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke(tour_id: str, link_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    t = get_owned(db, ctx, Tour, tour_id)
    x = db.scalar(select(FieldLink).where(FieldLink.id == link_id, FieldLink.tour_id == t.id))
    if not x:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found")
    x.revoked_at = x.revoked_at or utcnow()
    db.commit()


# --- the phone page ------------------------------------------------------------------------------

class Place(BaseModel):
    name: str
    address: str
    city: str
    phone: str
    menu: str | None = None
    dishes: list[str] = []


class FieldDay(BaseModel):
    number: int
    date: date
    city: str
    stops: list[str] = []
    breakfast_mode: str = "hotel"
    lunch_mode: str = "included"
    dinner_mode: str = "included"
    flights: list[dict] = []
    schedule: list[dict] = []
    km: int | None
    border: str
    notes: str
    hotel: Place | None
    breakfast: Place | None = None
    lunch: Place | None
    dinner: Place | None
    extras: list[str]


class GroupMember(BaseModel):
    name: str
    room: str
    phone: str
    notes: str


class Colleague(BaseModel):
    role: str
    name: str
    phone: str
    days: str            # "1–3", or "2" — when they work together


class FieldView(BaseModel):
    agency: str
    office_phone: str
    team: list[Colleague]               # the other guides / drivers / bus on the same days
    tour_code: str
    start_date: date
    end_date: date
    role: str
    person: str
    days: list[FieldDay]
    pax: int | None = None              # guides only
    group: list[GroupMember] | None = None
    changes: list[dict] = []            # since their last "Got it"


def _place(v: Vendor | None, menu: Service | None = None) -> Place | None:
    if v is None:
        return None
    dishes = [d if isinstance(d, str) else str(d.get("name", "")) for d in (menu.dishes or [])] if menu else []
    return Place(name=v.name, address=v.address, city=v.city, phone=v.phone,
                 menu=menu.name if menu else None, dishes=[d for d in dishes if d])


def _extras(slots, services: dict) -> list[str]:
    """One line per place, its activities after it: "KTW · Wine tasting, Bread baking, Churchkhela (optional)"."""
    places: dict[str, tuple[str, list[str]]] = {}
    for e in slots or []:
        sv = services.get(e.get("service_id")) if isinstance(e, dict) else None
        if sv is None:
            continue
        name = sv.name + (" (optional)" if e.get("optional") else "")
        places.setdefault(sv.vendor_id, (sv.vendor.name, []))[1].append(name)
    out = []
    for vendor, names in places.values():
        own = [n for n in names if vendor.lower() not in n.lower()]
        out.append(f"{vendor} · {', '.join(own)}" if len(own) == len(names) else ", ".join(names))
    return out


DEAD = "This link doesn't work any more — ask the office for a new one"


def _open(db: Session, token: str, request: Request, writes: bool = False) -> tuple[FieldLink, StaffAssignment]:
    """The live link and whose it is; 404 for anything else (made up, replaced, switched off, old)."""
    ip = ratelimit.client_ip(request)
    ratelimit.hit("field", ip, limit=120, per_seconds=600)
    if writes:
        ratelimit.hit("field-write", ip, limit=40, per_seconds=600)
    x = db.scalar(select(FieldLink).where(FieldLink.token_hash == _hash(token[:100])))
    if not x or x.revoked_at or date.today() > x.expires_on:
        raise HTTPException(status.HTTP_404_NOT_FOUND, DEAD)
    s = db.get(StaffAssignment, x.staff_id)
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, DEAD)
    return x, s


@router.get("/api/field/{token}", response_model=FieldView)
def field_page(token: str, request: Request, db: Session = Depends(get_db)):
    x, s = _open(db, token, request)
    t = db.scalar(select(Tour).where(Tour.id == x.tour_id).options(
        selectinload(Tour.days).options(selectinload(TourDay.hotel), selectinload(TourDay.lunch), selectinload(TourDay.dinner)),
        selectinload(Tour.participants), selectinload(Tour.staff).selectinload(StaffAssignment.vendor)))
    if not t or t.status == "cancelled":
        raise HTTPException(status.HTTP_404_NOT_FOUND, DEAD)
    now = utcnow()
    if not x.last_seen_at or (now - x.last_seen_at.replace(tzinfo=now.tzinfo)) > timedelta(minutes=10):
        x.last_seen_at = now
        db.commit()

    days = [d for d in t.days if s.covers(d.day_number)]
    menu_ids = {m for d in days for m in (d.breakfast_menu_id, d.lunch_menu_id, d.dinner_menu_id) if m}
    extra_ids = {e.get("service_id") for d in days for e in (d.extras or []) if isinstance(e, dict)}
    services = {sv.id: sv for sv in db.scalars(select(Service).where(Service.id.in_(menu_ids | extra_ids)))} if menu_ids | extra_ids else {}
    out_days = [FieldDay(
        number=d.day_number, date=d.date, city=d.city, stops=d.stops or [], km=d.km,
        lunch_mode=d.lunch_mode or "included", dinner_mode=d.dinner_mode or "included", flights=d.flights or [], schedule=d.schedule or [], border=d.border_crossing, notes=d.notes,
        breakfast_mode=d.breakfast_mode or "hotel",
        breakfast=_place(d.breakfast, services.get(d.breakfast_menu_id)) if (d.breakfast_mode or "hotel") not in ("hotel", "own") else None,
        hotel=_place(d.hotel), lunch=_place(d.lunch, services.get(d.lunch_menu_id)),
        dinner=_place(d.dinner, services.get(d.dinner_menu_id)),
        extras=_extras(d.extras, services)) for d in days]
    guide = s.role in SEES_GROUP
    mine = {d.day_number for d in days}
    team = []
    for o in sorted(t.staff, key=lambda o: (o.start_day, o.role)):
        shared = sorted(n for n in mine if o.covers(n))
        if o.id == s.id or not shared:
            continue
        span = str(shared[0]) if len(shared) == 1 else f"{shared[0]}–{shared[-1]}"
        team.append(Colleague(role=o.role, name=o.vendor.name, phone=o.vendor.phone or o.vendor.phone2, days=span))
    group = [GroupMember(name=p.full_name, room=" ".join(x for x in (p.room_type, p.room_group) if x), phone=p.phone, notes=p.notes)
             for p in sorted(t.participants, key=lambda p: (p.position, p.full_name))] if guide else None
    ws = db.get(Workspace, t.workspace_id)
    return FieldView(agency=ws.name, office_phone=ws.phone, team=team, tour_code=t.code, start_date=t.start_date, end_date=t.end_date,
                     role=s.role, person=s.vendor.name, days=out_days,
                     pax=(len(t.participants) or t.pax) if guide else None, group=group,
                     changes=[c.model_dump(mode="json") for c in _unseen(db, x, s)])


# --- guide money: cash advance, expenses with receipts, extra pay -----------------------------------
#
# Advance = a cash payment from the office to the guide (a VendorPayment). What the guide reports
# waits for the office; approved, it becomes a locked cost line for the guide. So the guide's usual
# balance in Costs (costs - payments) says who owes whom at the end.

REPORTS = ("guide", "tour_leader", "assistant")
EXPENSE_CATEGORIES = ("meal", "ticket", "transport", "visa", "other")


class FieldEntry(BaseModel):
    id: str
    kind: str
    category: str
    day: int | None
    description: str
    amount: Decimal
    currency: str
    status: str
    office_note: str
    has_receipt: bool
    created_at: datetime


class CashLine(BaseModel):
    currency: str
    given: Decimal          # advances received
    spent: Decimal          # approved expenses
    waiting: Decimal        # expenses not decided yet
    in_hand: Decimal        # given - spent - waiting: what should still be in the pocket
    extra_pay: Decimal      # approved extra pay (owed to the guide on top of the fee)


class Advance(BaseModel):
    paid_on: date
    amount: Decimal
    currency: str


class FieldMoney(BaseModel):
    can_report: bool
    currency: str                       # the agency's, preselected in the form
    advances: list[Advance]
    entries: list[FieldEntry]
    cash: list[CashLine]


def _entry(e: FieldExpense) -> FieldEntry:
    return FieldEntry(id=e.id, kind=e.kind, category=e.category, day=e.day_number, description=e.description,
                      amount=e.amount, currency=e.currency, status=e.status, office_note=e.office_note,
                      has_receipt=bool(e.receipt_key), created_at=e.created_at)


def _money_view(db: Session, s: StaffAssignment, t: Tour) -> FieldMoney:
    pays = db.scalars(select(VendorPayment).where(VendorPayment.tour_id == t.id, VendorPayment.vendor_id == s.vendor_id)
                      .order_by(VendorPayment.paid_on)).all()
    entries = db.scalars(select(FieldExpense).where(FieldExpense.staff_id == s.id)
                         .order_by(FieldExpense.created_at.desc())).all()
    # Suppliers the office recorded as paid by this person, from the cash they hold.
    paid_for_us = db.scalars(select(VendorPayment).where(VendorPayment.tour_id == t.id, VendorPayment.paid_by_vendor_id == s.vendor_id,
                                                         VendorPayment.vendor_id != s.vendor_id)).all()
    cash = []
    for c in sorted({p.currency for p in pays} | {e.currency for e in entries} | {p.currency for p in paid_for_us}):
        mine = [e for e in entries if e.currency == c]

        def total(kind: str, st: str) -> Decimal:
            return sum((e.amount for e in mine if e.kind == kind and e.status == st), Decimal(0))
        given = sum((p.amount for p in pays if p.currency == c), Decimal(0))
        spent, waiting = total("expense", "approved"), total("expense", "pending")
        spent += sum((p.amount for p in paid_for_us if p.currency == c), Decimal(0))
        cash.append(CashLine(currency=c, given=given, spent=spent, waiting=waiting, in_hand=given - spent - waiting,
                             extra_pay=total("extra", "approved")))
    ws = db.get(Workspace, t.workspace_id)
    return FieldMoney(can_report=s.role in REPORTS and t.closed_at is None and t.status != "cancelled",
                      currency=ws.base_currency,
                      advances=[Advance(paid_on=p.paid_on, amount=p.amount, currency=p.currency) for p in pays],
                      entries=[_entry(e) for e in entries], cash=cash)


@router.get("/api/field/{token}/money", response_model=FieldMoney)
def field_money(token: str, request: Request, db: Session = Depends(get_db)):
    _, s = _open(db, token, request)
    return _money_view(db, s, s.tour)


@router.post("/api/field/{token}/expenses", response_model=FieldMoney, status_code=status.HTTP_201_CREATED)
async def field_report(token: str, request: Request, kind: str = Form(...), description: str = Form(..., max_length=300),
                       amount: Decimal = Form(..., gt=0, max_digits=12, decimal_places=2), currency: str = Form(...),
                       category: str = Form("other"), day: int | None = Form(None, ge=1, le=60),
                       photo: UploadFile | None = File(None), db: Session = Depends(get_db)):
    _, s = _open(db, token, request, writes=True)
    t = s.tour
    if s.role not in REPORTS:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only guides report money here")
    if t.closed_at is not None or t.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "The tour is closed: tell the office")
    if kind not in ("expense", "extra") or (kind == "expense" and category not in EXPENSE_CATEGORIES) or not description.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "What was it, and how much?")
    try:
        currency = _currency(currency)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    key = None
    if photo is not None and photo.filename:
        data = await photo.read(storage.MAX_IMAGE + 1)
        try:
            key = storage.save_image(t.workspace_id, data)
        except ValueError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.add(FieldExpense(workspace_id=t.workspace_id, tour_id=t.id, staff_id=s.id, kind=kind,
                        category="guide" if kind == "extra" else category, day_number=day,
                        description=description.strip(), amount=amount, currency=currency, receipt_key=key))
    db.commit()
    return _money_view(db, s, t)


def _own_entry(db: Session, s: StaffAssignment, entry_id: str) -> FieldExpense:
    e = db.scalar(select(FieldExpense).where(FieldExpense.id == entry_id, FieldExpense.staff_id == s.id))
    if not e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return e


@router.delete("/api/field/{token}/expenses/{entry_id}", response_model=FieldMoney)
def field_unreport(token: str, entry_id: str, request: Request, db: Session = Depends(get_db)):
    _, s = _open(db, token, request, writes=True)
    e = _own_entry(db, s, entry_id)
    if e.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "The office already decided: ask them to change it")
    storage.delete(e.receipt_key)
    db.delete(e)
    db.commit()
    return _money_view(db, s, s.tour)


def _receipt(e: FieldExpense) -> FileResponse:
    found = storage.open_image(e.receipt_key or "")
    if not found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No photo")
    path, media = found
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/field/{token}/expenses/{entry_id}/receipt")
def field_receipt(token: str, entry_id: str, request: Request, db: Session = Depends(get_db)):
    _, s = _open(db, token, request)
    return _receipt(_own_entry(db, s, entry_id))


# --- office: advances and approvals (money: managers) -----------------------------------------------

can_fin_ope = require_jobs('finance', 'operations')


class OfficeEntry(FieldEntry):
    staff_id: str
    person: str
    role: str


class AdvanceIn(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    currency: str
    paid_on: date | None = None

    _cur = field_validator("currency")(_currency)


class DecideIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=300)


def _tour_open(t: Tour) -> None:
    if t.closed_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Tour {t.code} is closed: reopen it to make changes")


@router.get("/api/workspaces/{workspace_id}/tours/{tour_id}/field-expenses", response_model=list[OfficeEntry])
def office_entries(tour_id: str, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    t = get_owned(db, ctx, Tour, tour_id)
    rows = db.scalars(select(FieldExpense).where(FieldExpense.tour_id == t.id).order_by(FieldExpense.created_at.desc())).all()
    staff = {a.id: a for a in t.staff}
    return [OfficeEntry(**_entry(e).model_dump(), staff_id=e.staff_id, person=staff[e.staff_id].vendor.name,
                        role=staff[e.staff_id].role) for e in rows if e.staff_id in staff]


def _office_entry(db: Session, ctx: WorkspaceCtx, tour_id: str, entry_id: str) -> tuple[Tour, FieldExpense]:
    t = get_owned(db, ctx, Tour, tour_id)
    e = db.scalar(select(FieldExpense).where(FieldExpense.id == entry_id, FieldExpense.tour_id == t.id))
    if not e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return t, e


@router.post("/api/workspaces/{workspace_id}/tours/{tour_id}/field-expenses/{entry_id}/decide", response_model=FieldEntry)
def decide(tour_id: str, entry_id: str, body: DecideIn, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    t, e = _office_entry(db, ctx, tour_id, entry_id)
    _tour_open(t)
    if e.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Already decided: reopen it first")
    s = db.get(StaffAssignment, e.staff_id)
    e.status, e.office_note = ("approved" if body.approve else "rejected"), body.note.strip()
    e.decided_by_id, e.decided_at = ctx.user.id, utcnow()
    if body.approve:
        day = e.day_number if e.day_number and e.day_number <= len(t.days) else 1
        what = "Extra pay" if e.kind == "extra" else "Paid by guide"
        cost = TourCost(tour_id=t.id, vendor_id=s.vendor_id, category=e.category if e.category in COST_CATEGORIES else "other",
                        description=f"{what}: {e.description}"[:300], service_date=t.start_date + timedelta(days=day - 1),
                        quantity=Decimal(1), unit_price=e.amount, currency=e.currency, locked=True,
                        rate_to_base=finance.rate_for(finance.rates(db, ctx.workspace), e.currency))
        db.add(cost)
        db.flush()
        e.cost_id = cost.id
    db.commit()
    return _entry(e)


@router.post("/api/workspaces/{workspace_id}/tours/{tour_id}/field-expenses/{entry_id}/reopen", response_model=FieldEntry)
def reopen(tour_id: str, entry_id: str, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    t, e = _office_entry(db, ctx, tour_id, entry_id)
    _tour_open(t)
    if e.cost_id and (c := db.get(TourCost, e.cost_id)):
        db.delete(c)
    e.status, e.cost_id, e.decided_at, e.decided_by_id = "pending", None, None, None
    db.commit()
    return _entry(e)


@router.get("/api/workspaces/{workspace_id}/tours/{tour_id}/field-expenses/{entry_id}/receipt")
def office_receipt(tour_id: str, entry_id: str, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    return _receipt(_office_entry(db, ctx, tour_id, entry_id)[1])


@router.post("/api/workspaces/{workspace_id}/tours/{tour_id}/staff/{staff_id}/advance", status_code=status.HTTP_201_CREATED)
def give_advance(tour_id: str, staff_id: str, body: AdvanceIn, ctx: WorkspaceCtx = Depends(can_fin_ope), db: Session = Depends(get_db)):
    s = _staff(db, ctx, tour_id, staff_id)
    _tour_open(s.tour)
    db.add(VendorPayment(tour_id=s.tour_id, vendor_id=s.vendor_id, currency=body.currency, amount=body.amount,
                         paid_on=body.paid_on or date.today(), method="cash", reference="Cash advance", created_by_id=ctx.user.id))
    db.commit()
    return {"ok": True}


# --- changes: shown to the team until they acknowledge -------------------------------------------------------

class ChangeOut(BaseModel):
    id: str
    day: int | None
    kind: str
    text: str
    at: datetime


class TeamSeen(BaseModel):
    staff_id: str
    person: str
    role: str
    phone: str
    has_link: bool
    acked_at: datetime | None
    unseen: int                 # changes after their last "Got it"
    unseen_texts: list[str] = []   # those changes, oldest first (for the message)


class ChangesOut(BaseModel):
    changes: list[ChangeOut]
    team: list[TeamSeen]


@router.get("/api/workspaces/{workspace_id}/tours/{tour_id}/changes", response_model=ChangesOut)
def tour_changes(tour_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    t = get_owned(db, ctx, Tour, tour_id)
    rows = db.scalars(select(TourChange).where(TourChange.tour_id == t.id).order_by(TourChange.at.desc()).limit(200)).all()
    links = {x.staff_id: x for x in db.scalars(select(FieldLink).where(FieldLink.tour_id == t.id, FieldLink.revoked_at.is_(None)))}
    team = []
    for a in t.staff:
        link = links.get(a.id)
        since = _since(link)
        new = [c for c in reversed(rows) if _covers(a, c) and (since is None or _naive(c.at) > since)]
        team.append(TeamSeen(staff_id=a.id, person=a.vendor.name, role=a.role, phone=a.vendor.phone or a.vendor.phone2,
                             has_link=link is not None, acked_at=link.acked_at if link else None,
                             unseen=len(new), unseen_texts=[c.text for c in new]))
    return ChangesOut(changes=[ChangeOut(id=c.id, day=c.day, kind=c.kind, text=c.text, at=c.at) for c in rows], team=team)


def _naive(d: datetime) -> datetime:
    return d.replace(tzinfo=None)


def _since(link: "FieldLink | None"):
    """Changes after this are new for them: after their "Got it", else after the link was made."""
    if link is None:
        return None
    return _naive(link.acked_at or link.created_at)


def _covers(s: StaffAssignment, c: TourChange) -> bool:
    return c.day is None or s.covers(c.day)


def _unseen(db: Session, x: FieldLink, s: StaffAssignment) -> list[ChangeOut]:
    since = _since(x)
    rows = db.scalars(select(TourChange).where(TourChange.tour_id == s.tour_id).order_by(TourChange.at)).all()
    return [ChangeOut(id=c.id, day=c.day, kind=c.kind, text=c.text, at=c.at)
            for c in rows if _covers(s, c) and _naive(c.at) > since]


@router.post("/api/field/{token}/ack")
def field_ack(token: str, request: Request, db: Session = Depends(get_db)):
    """The guide tapped "Got it": the changes so far are seen."""
    x, _ = _open(db, token, request, writes=True)
    x.acked_at = utcnow()
    db.commit()
    return {"ok": True}
