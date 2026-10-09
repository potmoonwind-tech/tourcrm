"""Tenant-scoped lookups. Route code fetches business rows only through these,
so an id from another workspace behaves exactly like an id that doesn't exist."""
from typing import TypeVar

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .deps import WorkspaceCtx
from .models import Client, Series, Service, Tour, Vendor

M = TypeVar("M", Vendor, Client, Series, Tour)


def get_owned(db: Session, ctx: WorkspaceCtx, model: type[M], obj_id: str) -> M:
    obj = db.scalar(select(model).where(model.id == obj_id, model.workspace_id == ctx.workspace.id))
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{model.__name__} not found")
    return obj


def check_refs(db: Session, ctx: WorkspaceCtx, refs: dict[str, tuple[type, str | None]]) -> None:
    """Reject foreign keys that point outside the caller's workspace.

    refs: {field_name: (Model, id or None)}. None means "clear the link" and is allowed.
    """
    for field, (model, obj_id) in refs.items():
        if obj_id is None:
            continue
        found = db.scalar(select(model.id).where(model.id == obj_id, model.workspace_id == ctx.workspace.id))
        if not found:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{field}: unknown {model.__name__.lower()}")


DAY_VENDOR_FIELDS = ("hotel_id", "breakfast_id", "lunch_id", "dinner_id", "staff_hotel_id")


def check_day_refs(db: Session, ctx: WorkspaceCtx, values: dict) -> None:
    check_refs(db, ctx, {f: (Vendor, values.get(f)) for f in DAY_VENDOR_FIELDS if f in values})
    for k, x in (values.get("staff_stays") or {}).items():
        if isinstance(x, dict) and x.get("hotel_id"):
            check_refs(db, ctx, {f"staff_stays.{k}": (Vendor, x["hotel_id"])})
    # A set menu must be a service of the restaurant chosen for that meal.
    for meal in ("breakfast", "lunch", "dinner"):
        menu_id = values.get(f"{meal}_menu_id")
        if not menu_id:
            continue
        menu = db.scalar(select(Service).join(Vendor).where(Service.id == menu_id, Vendor.workspace_id == ctx.workspace.id))
        if not menu:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{meal}_menu_id: unknown menu")
        if f"{meal}_id" in values and values[f"{meal}_id"] and menu.vendor_id != values[f"{meal}_id"]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"The {meal} menu belongs to another restaurant")
    ids = {x["service_id"] for x in values.get("extras") or []}
    if ids:
        found = set(db.scalars(select(Service.id).join(Vendor)
                               .where(Service.id.in_(ids), Vendor.workspace_id == ctx.workspace.id)))
        if ids - found:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "extras: unknown service")
