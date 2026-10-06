from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user
from ..models import Invite, Membership, User, utcnow
from ..schemas import InvitePublic, MyWorkspaceOut, WorkspaceOut

router = APIRouter(prefix="/api/invites", tags=["invites"])


def _status(inv: Invite) -> str:
    if inv.accepted_at:
        return "accepted"
    expires = inv.expires_at
    if expires.tzinfo is None:  # SQLite drops tzinfo
        expires = expires.replace(tzinfo=timezone.utc)
    return "expired" if expires < utcnow() else "pending"


def _by_token(db: Session, token: str) -> Invite:
    inv = db.scalar(select(Invite).where(Invite.token == token))
    if not inv:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite not found")
    return inv


@router.get("/{token}", response_model=InvitePublic)
def view(token: str, db: Session = Depends(get_db)):
    """Public: lets the invite page show which agency invited you before you log in."""
    inv = _by_token(db, token)
    return InvitePublic(workspace_name=inv.workspace.name, email=inv.email, role=inv.role, status=_status(inv))


@router.post("/{token}/accept", response_model=MyWorkspaceOut)
def accept(token: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    inv = _by_token(db, token)
    st = _status(inv)
    if st != "pending":
        raise HTTPException(status.HTTP_410_GONE, f"Invite is {st}")
    # The link alone is not enough: it must be used by the account it was sent to.
    if user.email != inv.email:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"This invite is for {inv.email}")
    m = db.scalar(select(Membership).where(Membership.workspace_id == inv.workspace_id,
                                           Membership.user_id == user.id))
    if not m:
        m = Membership(workspace_id=inv.workspace_id, user_id=user.id, role=inv.role, jobs=inv.jobs)
        db.add(m)
    inv.accepted_at = utcnow()
    db.commit()
    from .auth import workspace_view
    return MyWorkspaceOut(**workspace_view(inv.workspace, m.role, m.jobs), role=m.role)
