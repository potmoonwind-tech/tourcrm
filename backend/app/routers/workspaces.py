import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import WorkspaceCtx, get_ctx, get_current_user, require_role
from ..models import Invite, Membership, Tour, User, utcnow
from ..schemas import (
    InviteCreate, InviteOut, MemberOut, MyWorkspaceOut, RoleUpdate,
    WorkspaceCreate, WorkspaceOut, WorkspaceUpdate,
)
from ..services import create_workspace, owner_count

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


# --- workspace itself ------------------------------------------------------------

@router.post("", response_model=MyWorkspaceOut, status_code=status.HTTP_201_CREATED)
def create(body: WorkspaceCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ws = create_workspace(db, user.id, body.name, body.base_currency, body.language)
    db.commit()
    return MyWorkspaceOut(**WorkspaceOut.model_validate(ws).model_dump(), role="owner")


@router.get("/{workspace_id}", response_model=MyWorkspaceOut)
def get(ctx: WorkspaceCtx = Depends(get_ctx)):
    from .auth import workspace_view
    return MyWorkspaceOut(**workspace_view(ctx.workspace, ctx.role, ctx.membership.jobs), role=ctx.role)


@router.patch("/{workspace_id}", response_model=WorkspaceOut)
def update(body: WorkspaceUpdate, ctx: WorkspaceCtx = Depends(require_role("admin")), db: Session = Depends(get_db)):
    ws = ctx.workspace
    if body.base_currency and body.base_currency != ws.base_currency:
        from ..models import ExchangeRate, Invoice, TourCost
        if any(db.scalar(select(m.id).where(m.workspace_id == ws.id).limit(1)) for m in (ExchangeRate, Invoice)) or \
                db.scalar(select(TourCost.id).join(Tour).where(Tour.workspace_id == ws.id).limit(1)):
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "The agency's currency can't change once rates, costs or invoices exist — they are all counted in it")
    if body.task_owners:
        members = set(db.scalars(select(Membership.user_id).where(Membership.workspace_id == ws.id)))
        if any(uid and uid not in members for uid in body.task_owners.values()):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Tasks can only go to members of this agency")
        body.task_owners = {k: v for k, v in body.task_owners.items() if v}
    for field, value in body.model_dump(mode="json", exclude_unset=True).items():
        if value is not None or field in ("incident_approval_limit", "vat_rate"):  # these can be cleared
            setattr(ws, field, value)
    db.commit()
    return ws


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(ctx: WorkspaceCtx = Depends(require_role("owner")), db: Session = Depends(get_db)):
    db.delete(ctx.workspace)
    db.commit()


# --- members ---------------------------------------------------------------------

def _member_out(m: Membership) -> MemberOut:
    from ..deps import jobs_of
    return MemberOut(id=m.id, user_id=m.user_id, email=m.user.email, full_name=m.user.full_name,
                     role=m.role, created_at=m.created_at, jobs=sorted(jobs_of(m.role, m.jobs)), jobs_set=m.jobs is not None)


def _get_member(db: Session, ctx: WorkspaceCtx, member_id: str) -> Membership:
    m = db.scalar(select(Membership).where(Membership.id == member_id,
                                           Membership.workspace_id == ctx.workspace.id))
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    return m


@router.get("/{workspace_id}/members", response_model=list[MemberOut])
def list_members(ctx: WorkspaceCtx = Depends(require_role("staff")), db: Session = Depends(get_db)):
    rows = db.scalars(select(Membership).where(Membership.workspace_id == ctx.workspace.id)
                      .order_by(Membership.created_at))
    return [_member_out(m) for m in rows]


@router.patch("/{workspace_id}/members/{member_id}", response_model=MemberOut)
def change_role(member_id: str, body: RoleUpdate, ctx: WorkspaceCtx = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    m = _get_member(db, ctx, member_id)
    if body.role is not None:
        # Only an owner can create another owner or touch an existing one.
        if (m.role == "owner" or body.role == "owner") and ctx.role != "owner":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner can change owner roles")
        if m.role == "owner" and body.role != "owner" and owner_count(db, ctx.workspace.id) == 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A workspace must keep at least one owner")
        m.role = body.role
    if body.jobs is not None:
        m.jobs = sorted(set(body.jobs))     # what they do here: operations / finance / sales
    db.commit()
    return _member_out(m)


@router.delete("/{workspace_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(member_id: str, ctx: WorkspaceCtx = Depends(get_ctx), db: Session = Depends(get_db)):
    m = _get_member(db, ctx, member_id)
    leaving_self = m.user_id == ctx.user.id
    if not leaving_self and not ctx.has_role("admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires admin role or higher")
    if m.role == "owner":
        if not leaving_self and ctx.role != "owner":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner can remove an owner")
        if owner_count(db, ctx.workspace.id) == 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A workspace must keep at least one owner")
    db.delete(m)
    db.commit()


# --- invites ---------------------------------------------------------------------

def _invite_out(inv: Invite) -> InviteOut:
    return InviteOut(id=inv.id, email=inv.email, role=inv.role, created_at=inv.created_at,
                     expires_at=inv.expires_at, link=f"{settings.app_url}/invite/{inv.token}")


@router.get("/{workspace_id}/invites", response_model=list[InviteOut])
def list_invites(ctx: WorkspaceCtx = Depends(require_role("admin")), db: Session = Depends(get_db)):
    rows = db.scalars(select(Invite).where(Invite.workspace_id == ctx.workspace.id,
                                           Invite.accepted_at.is_(None))
                      .order_by(Invite.created_at.desc()))
    return [_invite_out(i) for i in rows]


@router.post("/{workspace_id}/invites", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
def create_invite(body: InviteCreate, ctx: WorkspaceCtx = Depends(require_role("admin")),
                  db: Session = Depends(get_db)):
    if body.role == "owner" and ctx.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner can invite another owner")
    email = body.email.lower().strip()
    already = db.scalar(select(Membership.id).join(User)
                        .where(Membership.workspace_id == ctx.workspace.id, User.email == email))
    if already:
        raise HTTPException(status.HTTP_409_CONFLICT, "This person is already a member")
    inv = Invite(workspace_id=ctx.workspace.id, email=email, role=body.role, jobs=sorted(set(body.jobs)) if body.jobs is not None else None,
                 token=secrets.token_urlsafe(32), invited_by_id=ctx.user.id,
                 expires_at=utcnow() + timedelta(days=settings.invite_days))
    db.add(inv)
    db.commit()
    return _invite_out(inv)


@router.delete("/{workspace_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invite(invite_id: str, ctx: WorkspaceCtx = Depends(require_role("admin")),
                  db: Session = Depends(get_db)):
    inv = db.scalar(select(Invite).where(Invite.id == invite_id, Invite.workspace_id == ctx.workspace.id))
    if not inv:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite not found")
    db.delete(inv)
    db.commit()
