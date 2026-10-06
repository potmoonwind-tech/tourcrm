"""Search everywhere (Ctrl+K): tours, clients, suppliers, tourists, routes — and for managers
invoices and calculations. A few hits per kind, best matches first; each hit says where to go."""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..dishes import names as dish_names
from ..models import Client, Invoice, Participant, Quote, Series, Service, Tour, Vendor

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["search"])
office = require_role("staff")
PER_KIND = 6


class Hit(BaseModel):
    kind: str           # tour | client | vendor | participant | route | invoice | quote
    id: str
    title: str
    subtitle: str = ""
    link: str           # path inside the workspace, e.g. "tours/<id>?tab=participants"


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _rank(text: str, q: str) -> int:
    t = text.lower()
    return 0 if t == q else 1 if t.startswith(q) else 2


@router.get("/search", response_model=list[Hit])
def search(q: str = Query(min_length=1, max_length=100), ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    ws = ctx.workspace.id
    q = " ".join(q.split())
    if not q:
        return []
    like, ql = _like(q), q.lower()
    hits: list[Hit] = []

    def take(rows, make, key):
        rows = sorted(rows, key=lambda r: _rank(key(r), ql))[:PER_KIND]
        hits.extend(make(r) for r in rows)

    take(db.scalars(select(Tour).where(Tour.workspace_id == ws, or_(Tour.code.ilike(like, escape="\\"), Tour.name.ilike(like, escape="\\"),
                                                                   Tour.client.has(Client.name.ilike(like, escape="\\"))))
                    .options(selectinload(Tour.client)).order_by(Tour.start_date.desc()).limit(30)),
         lambda t: Hit(kind="tour", id=t.id, title=t.code, link=f"tours/{t.id}",
                       subtitle=" · ".join(x for x in (t.client.name if t.client else "", f"{t.start_date:%d.%m.%Y}", t.name) if x)),
         lambda t: t.code)
    take(db.scalars(select(Participant).join(Tour).where(Tour.workspace_id == ws, or_(
        Participant.full_name.ilike(like, escape="\\"), Participant.passport_number.ilike(like, escape="\\"))).options(
        selectinload(Participant.tour)).limit(30)),
         lambda p: Hit(kind="participant", id=p.id, title=p.full_name, link=f"tours/{p.tour_id}?tab=participants&p={p.id}",
                       subtitle=" · ".join(x for x in (p.tour.code, p.passport_number, p.nationality) if x)),
         lambda p: p.full_name)
    take(db.scalars(select(Client).where(Client.workspace_id == ws, or_(Client.name.ilike(like, escape="\\"),
                                                                       Client.contact_person.ilike(like, escape="\\"),
                                                                       Client.email.ilike(like, escape="\\"))).limit(30)),
         lambda c: Hit(kind="client", id=c.id, title=c.name, link=f"clients?open={c.id}",
                       subtitle=" · ".join(x for x in (c.country, c.contact_person) if x)),
         lambda c: c.name)
    take(db.scalars(select(Vendor).where(Vendor.workspace_id == ws, or_(Vendor.name.ilike(like, escape="\\"),
                                                                       Vendor.city.ilike(like, escape="\\"),
                                                                       Vendor.contact_person.ilike(like, escape="\\"))).limit(30)),
         lambda v: Hit(kind="vendor", id=v.id, title=v.name, link=f"vendors?open={v.id}",
                       subtitle=" · ".join(x for x in (v.city, v.phone) if x)),
         lambda v: v.name)
    # Services and set menus by name, and menus by a dish on them ("khinkali" → every menu with khinkali).
    found: dict[str, tuple[Service, str]] = {}
    services = db.scalars(select(Service).join(Vendor).where(Vendor.workspace_id == ws, Service.is_active.is_(True))
                          .options(selectinload(Service.vendor)))
    for sv in services:
        if ql in sv.name.lower():
            found[sv.id] = (sv, "")
        else:
            dish = next((d for d in dish_names(sv.dishes) if ql in d.lower()), None)
            if dish:
                found[sv.id] = (sv, dish)
    take(list(found.values()),
         lambda x: Hit(kind="menu" if x[0].category == "meal" and not x[0].code else "service", id=x[0].id, title=x[0].name,
                       link=f"vendors?open={x[0].vendor_id}",
                       subtitle=" · ".join(v for v in (x[0].vendor.name, f"✓ {x[1]}" if x[1] else "") if v)),
         lambda x: x[1] or x[0].name)
    take(db.scalars(select(Series).where(Series.workspace_id == ws, or_(Series.code.ilike(like, escape="\\"),
                                                                       Series.name.ilike(like, escape="\\"))).limit(30)),
         lambda s: Hit(kind="route", id=s.id, title=f"{s.code} — {s.name}" if s.name else s.code, link=f"routes?open={s.id}"),
         lambda s: s.code)
    if ctx.can("finance", "sales"):
        take(db.scalars(select(Invoice).where(Invoice.workspace_id == ws, or_(Invoice.number.ilike(like, escape="\\"),
                                                                             Invoice.client.has(Client.name.ilike(like, escape="\\"))))
                        .options(selectinload(Invoice.client), selectinload(Invoice.lines), selectinload(Invoice.payments),
                                 selectinload(Invoice.credit_notes).selectinload(Invoice.lines))
                        .order_by(Invoice.issue_date.desc()).limit(30)),
             lambda i: Hit(kind="invoice", id=i.id, title=i.number or "draft", link=f"finance?tab=invoices&open={i.id}",
                           subtitle=f"{i.client.name} · {i.total:,.2f} {i.currency}"),
             lambda i: i.number or "")
        take(db.scalars(select(Quote).where(Quote.workspace_id == ws, Quote.name.ilike(like, escape="\\")).limit(30)),
             lambda x: Hit(kind="quote", id=x.id, title=x.name, link=f"calculations/{x.id}", subtitle=x.status),
             lambda x: x.name)
    return hits
