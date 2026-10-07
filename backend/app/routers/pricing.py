"""The price catalog: services each vendor sells, with prices by season and group size.
Manager and up (prices), like the rest of money."""
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from .. import catalog, dishes
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import RATE_KINDS, SERVICE_UNITS, Service, ServiceRate, Vendor
from ..schemas import Amount, RateKind as Code, VendorRef, VendorType, _currency
from ..scoping import get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["catalog"])
can_ope_fin_sal = require_jobs('operations', 'finance', 'sales')
can_ope = require_jobs('operations')

Unit = Literal["room_night", "person", "vehicle_day", "day", "group", "item", "km", "litre"]
Category = Literal["hotel", "meal", "transport", "guide", "ticket", "activity", "tips", "border", "other"]
assert set(Code.__args__) == set(RATE_KINDS) and set(Unit.__args__) == set(SERVICE_UNITS)


class RateIn(BaseModel):
    id: str | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    min_pax: int | None = Field(default=None, ge=1, le=1000)
    max_pax: int | None = Field(default=None, ge=1, le=1000)
    price: Amount
    currency: str
    notes: str = Field(default="", max_length=300)

    _cur = field_validator("currency")(_currency)

    @model_validator(mode="after")
    def _ranges(self):
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("season ends before it starts")
        if self.min_pax and self.max_pax and self.max_pax < self.min_pax:
            raise ValueError("group size: 'to' is below 'from'")
        return self


class Dish(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: float | None = Field(default=None, ge=0, le=100000)   # one plate (one portion), in the menu's currency
    per_plate: int | None = Field(default=None, ge=1, le=20)      # people sharing one plate (None = the tour's / agency's)


class ServiceIn(BaseModel):
    id: str | None = None
    code: Code | None = None
    name: str = Field(min_length=1, max_length=200)
    category: Category = "other"
    unit: Unit = "person"
    notes: str = Field(default="", max_length=2000)
    dishes: list[Dish | str] = Field(default_factory=list, max_length=40)   # plain names still accepted
    is_active: bool = True
    minutes: int | None = Field(default=None, ge=5, le=720)     # how long it takes (activities)
    rates: list[RateIn] = Field(default_factory=list, max_length=100)

    @field_validator("dishes")
    @classmethod
    def _dishes(cls, v):
        return dishes.normalize([d if isinstance(d, str) else d.model_dump() for d in v])


class RateOut(BaseModel):
    id: str
    valid_from: date | None
    valid_to: date | None
    min_pax: int | None
    max_pax: int | None
    price: float
    currency: str
    notes: str


class ServiceOut(BaseModel):
    id: str
    vendor_id: str
    code: Code | None
    name: str
    category: Category
    unit: Unit
    notes: str
    dishes: list[Dish] = []
    is_active: bool
    minutes: int | None = None
    rates: list[RateOut]


class ServiceBrief(BaseModel):
    """A service without its prices: what staff need to plan an itinerary."""
    id: str
    code: Code | None
    name: str
    category: Category
    unit: Unit
    vendor: VendorRef
    notes: str = ""
    dishes: list[Dish] = []   # a set menu's dishes (prices hidden for staff)
    minutes: int | None = None   # how long it takes (activities)


class CatalogRow(BaseModel):
    service: ServiceOut
    vendor: VendorRef
    price: float | None       # the price that applies on the date / group size asked for
    currency: str | None
    rate_id: str | None       # which row it came from (for highlighting)


def service_out(s: Service) -> ServiceOut:
    return ServiceOut(id=s.id, vendor_id=s.vendor_id, code=s.code, name=s.name, category=s.category, unit=s.unit,
                      notes=s.notes, dishes=dishes.normalize(s.dishes), is_active=s.is_active, minutes=s.minutes,
                      rates=[RateOut(id=r.id, valid_from=r.valid_from, valid_to=r.valid_to, min_pax=r.min_pax,
                                     max_pax=r.max_pax, price=r.price, currency=r.currency, notes=r.notes) for r in s.rates])


def _vendor(db: Session, ctx: WorkspaceCtx, vendor_id: str) -> Vendor:
    v = get_owned(db, ctx, Vendor, vendor_id)
    db.refresh(v, ["services"])
    return v


@router.get("/vendors/{vendor_id}/services", response_model=list[ServiceOut])
def list_services(vendor_id: str, ctx: WorkspaceCtx = Depends(can_ope_fin_sal), db: Session = Depends(get_db)):
    return [service_out(s) for s in _vendor(db, ctx, vendor_id).services]


@router.put("/vendors/{vendor_id}/services", response_model=list[ServiceOut])
def save_services(vendor_id: str, body: list[ServiceIn], ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    """Replace the vendor's services and prices with what the editor shows.
    Rows keep their ids, so prices used elsewhere stay linked."""
    v = _vendor(db, ctx, vendor_id)
    codes = [s.code for s in body if s.code]
    if len(codes) != len(set(codes)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Each system code (e.g. DBL room) can be used once per vendor")
    for s in body:
        bad = catalog.conflicts(s.rates)
        if bad:
            i, j = bad[0]
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                f"'{s.name}': price rows {i + 1} and {j + 1} overlap, so the price would be ambiguous. "
                                "Make one season/size range fit inside the other, or stop them overlapping.")
    existing = {s.id: s for s in v.services}
    by_code = {s.code: s for s in v.services if s.code}
    # A row without an id but with a known system code is that same service.
    matched = [existing.get(s.id) if s.id else None for s in body]
    matched = [m or (by_code.get(s.code) if s.code else None) for m, s in zip(matched, body)]
    gone = [s for s in v.services if s not in matched]
    if gone:  # remove first, so a code can move to a new row without a unique clash
        for s in gone:
            v.services.remove(s)
        db.flush()
    keep: list[Service] = []
    for s, svc in zip(body, matched):
        if svc is None:
            svc = Service(vendor_id=v.id)
        svc.code, svc.name, svc.category, svc.unit, svc.notes, svc.dishes, svc.is_active, svc.minutes = (
            s.code, s.name, s.category, s.unit, s.notes, s.dishes, s.is_active, s.minutes)
        old_rates = {r.id: r for r in svc.rates}
        new_rates = []
        for r in s.rates:
            row = old_rates.get(r.id) if r.id else None
            if row is None:
                row = ServiceRate()
            for k in ("valid_from", "valid_to", "min_pax", "max_pax", "price", "currency", "notes"):
                setattr(row, k, getattr(r, k))
            new_rates.append(row)
        svc.rates = new_rates
        keep.append(svc)
    v.services = keep
    db.commit()
    db.refresh(v, ["services"])
    return [service_out(s) for s in v.services]


@router.get("/services", response_model=list[ServiceBrief])
def list_all_services(ctx: WorkspaceCtx = Depends(require_role("staff")), db: Session = Depends(get_db)):
    stmt = (select(Service).join(Vendor).where(Vendor.workspace_id == ctx.workspace.id, Service.is_active.is_(True))
            .options(selectinload(Service.vendor)).order_by(Vendor.name, Service.category, Service.name))
    return [ServiceBrief(id=s.id, code=s.code, name=s.name, category=s.category, unit=s.unit, notes=s.notes, minutes=s.minutes,
                         dishes=[{**d, "price": None} for d in dishes.normalize(s.dishes)],
                         vendor=VendorRef.model_validate(s.vendor)) for s in db.scalars(stmt)]


@router.get("/catalog", response_model=list[CatalogRow])
def price_catalog(on: date | None = None, pax: int | None = None, type: VendorType | None = None, q: str | None = None,
                  missing: bool = False, ctx: WorkspaceCtx = Depends(can_ope_fin_sal), db: Session = Depends(get_db)):
    """Every service with the price that applies on a date (default today) for a group size."""
    on = on or date.today()
    stmt = (select(Service).join(Vendor).where(Vendor.workspace_id == ctx.workspace.id, Service.is_active.is_(True))
            .options(selectinload(Service.rates), selectinload(Service.vendor))
            .order_by(Vendor.type, Vendor.name, Service.category, Service.name))
    if type:
        stmt = stmt.where(Vendor.type == type)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Service.name.ilike(like), Vendor.name.ilike(like), Vendor.city.ilike(like)))
    rows = []
    for s in db.scalars(stmt):
        r = catalog.pick(s.rates, on, pax)
        if missing and r is not None:
            continue
        rows.append(CatalogRow(service=service_out(s), vendor=VendorRef.model_validate(s.vendor),
                               price=r.price if r else None, currency=r.currency if r else None, rate_id=r.id if r else None))
    return rows

