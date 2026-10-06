from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import ROLE_RANK, Membership, User, Workspace
from .security import COOKIE_NAME, decode_session_token


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    auth = request.headers.get("authorization", "")
    if not token and auth.lower().startswith("bearer "):
        token = auth[7:]
    session = decode_session_token(token) if token else None
    user = db.get(User, session[0]) if session else None
    if not user or not user.is_active or session[1] != (user.session_version or 0):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user


@dataclass
class WorkspaceCtx:
    """The request's tenant scope. Every workspace route depends on this, so
    business queries always have the caller's verified workspace_id to filter by."""
    user: User
    workspace: Workspace
    membership: Membership

    @property
    def role(self) -> str:
        return self.membership.role

    def has_role(self, minimum: str) -> bool:
        return ROLE_RANK[self.role] >= ROLE_RANK[minimum]

    @property
    def jobs(self) -> set[str]:
        return jobs_of(self.role, self.membership.jobs)

    def can(self, *jobs: str) -> bool:
        """Does this person do any of these jobs here (owners and admins do all)?"""
        return bool(self.jobs & set(jobs))

    def allowed(self, level: str) -> bool:
        """An approval level ("manager" | "admin", e.g. incidents): "manager" means the operations
        or finance job now; "admin" stays a role."""
        return self.can("operations", "finance") if level == "manager" else self.has_role(level)


def get_ctx(workspace_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> WorkspaceCtx:
    m = db.scalar(
        select(Membership).where(Membership.workspace_id == workspace_id, Membership.user_id == user.id)
    )
    # 404 rather than 403: don't reveal that someone else's workspace exists.
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return WorkspaceCtx(user=user, workspace=m.workspace, membership=m)


JOBS = ("operations", "finance", "sales")


def jobs_of(role: str, jobs: list | None) -> set[str]:
    """What someone may do: owners and admins everything; guides only their phone page; otherwise the
    jobs given — or, for members from before jobs existed, a manager all three and staff none."""
    if role in ("owner", "admin"):
        return set(JOBS)
    if role == "guide":
        return set()
    if jobs is not None:
        return set(jobs) & set(JOBS)
    return set(JOBS) if role == "manager" else set()


def require_jobs(*jobs: str):
    """An office member doing one of these jobs (owners and admins always)."""
    def dep(ctx: WorkspaceCtx = Depends(get_ctx)) -> WorkspaceCtx:
        if not ctx.has_role("staff") or not ctx.can(*jobs):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"This is for: {', '.join(jobs)}")
        return ctx
    return dep


def require_role(minimum: str):
    def dep(ctx: WorkspaceCtx = Depends(get_ctx)) -> WorkspaceCtx:
        if not ctx.has_role(minimum):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {minimum} role or higher")
        return ctx
    return dep
