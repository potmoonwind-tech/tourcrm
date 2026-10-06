"""How far a new agency has got with setting up: drives the "Get started" guide on Home."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import Client, Invite, Membership, Series, Service, ServiceRate, Tour, Vendor

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["setup"])


class SetupProgress(BaseModel):
    vendors: int
    priced_services: int     # services with at least one price
    routes: int
    clients: int
    tours: int
    members: int             # people in the agency, pending invites included


@router.get("/setup", response_model=SetupProgress)
def setup_progress(ctx: WorkspaceCtx = Depends(require_role("staff")), db: Session = Depends(get_db)):
    ws = ctx.workspace.id

    def count(stmt) -> int:
        return db.scalar(stmt) or 0

    return SetupProgress(
        vendors=count(select(func.count()).select_from(Vendor).where(Vendor.workspace_id == ws)),
        priced_services=count(select(func.count(func.distinct(Service.id))).select_from(Service)
                              .join(Vendor, Service.vendor_id == Vendor.id).join(ServiceRate, ServiceRate.service_id == Service.id)
                              .where(Vendor.workspace_id == ws)),
        routes=count(select(func.count()).select_from(Series).where(Series.workspace_id == ws)),
        clients=count(select(func.count()).select_from(Client).where(Client.workspace_id == ws)),
        tours=count(select(func.count()).select_from(Tour).where(Tour.workspace_id == ws)),
        members=count(select(func.count()).select_from(Membership).where(Membership.workspace_id == ws))
        + count(select(func.count()).select_from(Invite).where(Invite.workspace_id == ws, Invite.accepted_at.is_(None))),
    )
