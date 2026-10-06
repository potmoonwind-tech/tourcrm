from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..models import User
from ..schemas import LoginIn, MeOut, MyWorkspaceOut, SignupIn, UserOut, WorkspaceOut
from .. import ratelimit
from ..security import COOKIE_NAME, burn_time, create_session_token, hash_password, verify_password
from ..services import create_workspace

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_session(response: Response, user: User) -> None:
    response.set_cookie(
        COOKIE_NAME,
        create_session_token(user.id, user.session_version or 0),
        max_age=settings.session_days * 86400,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


MONEY_SETTINGS = ("incident_approval_limit", "bill_tolerance_pct", "payment_terms", "cancellation_scale")


def workspace_view(ws, role: str, jobs: list | None = None) -> dict:
    """The agency as this person may see it: money settings only for the finance job (and owners)."""
    from ..deps import jobs_of
    out = WorkspaceOut.model_validate(ws).model_dump()
    mine = jobs_of(role, jobs)
    if "finance" not in mine:
        for k in MONEY_SETTINGS:
            out.pop(k, None)
    out["jobs"] = sorted(mine)
    return out


def me_payload(user: User) -> MeOut:
    workspaces = [
        MyWorkspaceOut(**workspace_view(m.workspace, m.role, m.jobs), role=m.role)
        for m in sorted(user.memberships, key=lambda m: m.created_at)
    ]
    return MeOut(user=UserOut.model_validate(user), workspaces=workspaces)


@router.post("/signup", response_model=MeOut, status_code=status.HTTP_201_CREATED)
def signup(body: SignupIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ratelimit.hit("signup", ratelimit.client_ip(request), limit=20, per_seconds=3600)
    email = body.email.lower().strip()
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    user = User(email=email, full_name=body.full_name.strip(), password_hash=hash_password(body.password))
    db.add(user)
    db.flush()
    if body.workspace_name and body.workspace_name.strip():
        create_workspace(db, user.id, body.workspace_name, body.base_currency, body.language)
    db.commit()
    db.refresh(user)
    _set_session(response, user)
    return me_payload(user)


@router.post("/login", response_model=MeOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower().strip()
    ip = ratelimit.client_ip(request)
    # Wrong guesses are counted per address and per account; a right password always works below the limit.
    ratelimit.hit("login-ip", ip, limit=30, per_seconds=900, count=False)
    ratelimit.hit("login-email", email, limit=10, per_seconds=900, count=False)
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        burn_time(body.password)
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        ratelimit.add("login-ip", ip)
        ratelimit.add("login-email", email)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password")
    _set_session(response, user)
    return me_payload(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    # Ends this person's sessions on every device: a copied cookie stops working too.
    try:
        user = get_current_user(request, db)
        user.session_version = (user.session_version or 0) + 1
        db.commit()
    except HTTPException:
        pass
    response.delete_cookie(COOKIE_NAME)


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)):
    return me_payload(user)
