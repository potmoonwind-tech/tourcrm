"""Vendors (hotels, restaurants, transport, guides...) and clients (partner
agencies / direct customers). Everyone from staff up reads; managers edit."""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Client, Invoice, Series, SeriesDay, Tour, TourCost, TourDay, Vendor, VendorBill, VendorPayment
from ..schemas import ClientCreate, ClientOut, ClientUpdate, VendorCreate, VendorOut, VendorType, VendorUpdate
from ..scoping import get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["catalog"])

read = require_role("staff")
can_ope = require_jobs('operations')
can_fin_sal = require_jobs('finance', 'sales')


# --- vendors -------------------------------------------------------------------

@router.get("/vendors", response_model=list[VendorOut])
def list_vendors(type: VendorType | None = None, q: str | None = None, include_inactive: bool = False,
                 ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    stmt = select(Vendor).where(Vendor.workspace_id == ctx.workspace.id)
    if type:
        stmt = stmt.where(Vendor.type == type)
    if not include_inactive:
        stmt = stmt.where(Vendor.is_active.is_(True))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Vendor.name.ilike(like), Vendor.city.ilike(like), Vendor.contact_person.ilike(like)))
    return db.scalars(stmt.order_by(Vendor.type, Vendor.name)).all()


@router.post("/vendors", response_model=VendorOut, status_code=status.HTTP_201_CREATED)
def create_vendor(body: VendorCreate, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    _check_company(db, ctx, body.company_id, None)
    v = Vendor(workspace_id=ctx.workspace.id, **body.model_dump(mode="json", exclude_none=True))
    db.add(v)
    db.commit()
    return v


def _check_company(db: Session, ctx: WorkspaceCtx, company_id: str | None, self_id: str | None) -> None:
    """A driver's company is one of this agency's transport (or other) suppliers, never the driver itself."""
    if not company_id:
        return
    c = db.get(Vendor, company_id)
    if c is None or c.workspace_id != ctx.workspace.id or c.id == self_id or c.type not in ("transport", "other"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "company_id: not a transport company of this agency")


class StopSuggestion(BaseModel):
    name: str
    uses: int              # route and tour days that pass it
    routes: list[str]      # route codes
    similar: str | None = None   # a supplier that is probably the same place ("Garni" → "Garni temple")


def same_place(a: str, b: str) -> bool:
    """'Garni' and 'Garni temple', 'Zvartnots' and 'Zvartnots Cathedral': one name starts the other."""
    a, b = a.casefold().strip(), b.casefold().strip()
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 4 and (long_ == short or long_.startswith(short + " ") or long_.startswith(short + ","))


@router.get("/vendors/stop-suggestions", response_model=list[StopSuggestion])
def stop_suggestions(ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    """Places the routes and tours visit ("via" stops, visits in day programmes) that are not a supplier
    yet — free sights like Bodbe or Jvari — to add as activities with no price."""
    vendors = db.execute(select(Vendor.name, Vendor.type).where(Vendor.workspace_id == ctx.workspace.id)).all()
    known = {n.casefold() for n, _ in vendors}
    # Only a sight or activity can be the same place as a stop ("Sighnaghi" isn't "Sighnaghi local restaurant").
    names = [n for n, ty in vendors if ty in ("activity", "other")]
    found: dict[str, dict] = {}

    def add(name: str, route: str | None):
        name = " ".join((name or "").split())
        if len(name) < 2 or name.casefold() in known:
            return
        f = found.setdefault(name.casefold(), {"name": name, "uses": 0, "routes": set()})
        f["uses"] += 1
        if route:
            f["routes"].add(route)

    def scan(stops, schedule, route):
        for s in stops or []:
            add(s, route)
        for x in schedule or []:
            if isinstance(x, dict) and x.get("kind") == "visit" and not x.get("ref"):
                add(x.get("title") or "", route)

    for code, stops, sched in db.execute(select(Series.code, SeriesDay.stops, SeriesDay.schedule)
                                         .join(SeriesDay, SeriesDay.series_id == Series.id)
                                         .where(Series.workspace_id == ctx.workspace.id)):
        scan(stops, sched, code)
    for stops, sched in db.execute(select(TourDay.stops, TourDay.schedule).join(Tour, Tour.id == TourDay.tour_id)
                                   .where(Tour.workspace_id == ctx.workspace.id, Tour.status != "cancelled")):
        scan(stops, sched, None)
    out = [StopSuggestion(name=f["name"], uses=f["uses"], routes=sorted(f["routes"]),
                          similar=next((n for n in names if same_place(n, f["name"])), None)) for f in found.values()]
    return sorted(out, key=lambda x: (-x.uses, x.name.casefold()))


@router.get("/vendors/{vendor_id}", response_model=VendorOut)
def get_vendor(vendor_id: str, ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    return get_owned(db, ctx, Vendor, vendor_id)


@router.patch("/vendors/{vendor_id}", response_model=VendorOut)
def update_vendor(vendor_id: str, body: VendorUpdate, ctx: WorkspaceCtx = Depends(can_ope),
                  db: Session = Depends(get_db)):
    v = get_owned(db, ctx, Vendor, vendor_id)
    if "company_id" in body.model_fields_set:
        _check_company(db, ctx, body.company_id, v.id)
    for k, val in body.model_dump(mode="json", exclude_unset=True).items():
        if val is not None or k in ("visit_minutes", "company_id"):     # these can be cleared
            setattr(v, k, val)
    db.commit()
    return v


@router.delete("/vendors/{vendor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vendor(vendor_id: str, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    # Itinerary links to this vendor are cleared (ON DELETE SET NULL). A supplier with money
    # history (costs, payments, invoices received) is archived instead: deleting would erase it.
    v = get_owned(db, ctx, Vendor, vendor_id)
    used = any(db.scalar(select(func.count()).select_from(m).where(m.vendor_id == v.id))
               for m in (TourCost, VendorPayment, VendorBill))
    if used:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This supplier has costs or payments on tours — mark it inactive instead of deleting")
    db.delete(v)
    db.commit()


# --- clients -------------------------------------------------------------------

@router.get("/clients", response_model=list[ClientOut])
def list_clients(q: str | None = None, ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    stmt = select(Client).where(Client.workspace_id == ctx.workspace.id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Client.name.ilike(like), Client.country.ilike(like), Client.contact_person.ilike(like)))
    return db.scalars(stmt.order_by(Client.name)).all()


@router.post("/clients", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
def create_client(body: ClientCreate, ctx: WorkspaceCtx = Depends(can_fin_sal), db: Session = Depends(get_db)):
    c = Client(workspace_id=ctx.workspace.id, **body.model_dump(mode="json", exclude_none=True))
    db.add(c)
    db.commit()
    return c


@router.get("/clients/{client_id}", response_model=ClientOut)
def get_client(client_id: str, ctx: WorkspaceCtx = Depends(read), db: Session = Depends(get_db)):
    return get_owned(db, ctx, Client, client_id)


@router.patch("/clients/{client_id}", response_model=ClientOut)
def update_client(client_id: str, body: ClientUpdate, ctx: WorkspaceCtx = Depends(can_fin_sal),
                  db: Session = Depends(get_db)):
    c = get_owned(db, ctx, Client, client_id)
    for k, val in body.model_dump(mode="json", exclude_unset=True).items():
        if val is not None or k in ("cancellation_scale", "payment_terms"):  # null = back to the agency's
            setattr(c, k, val)
    db.commit()
    return c


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_client(client_id: str, ctx: WorkspaceCtx = Depends(can_fin_sal), db: Session = Depends(get_db)):
    c = get_owned(db, ctx, Client, client_id)
    if db.scalar(select(Invoice.id).where(Invoice.client_id == c.id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "This client has invoices and can't be deleted")
    db.delete(c)
    db.commit()
