import re
import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Membership, Workspace


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50]
    return slug or "workspace"


def unique_slug(db: Session, name: str) -> str:
    base = slugify(name)
    slug = base
    while db.scalar(select(Workspace.id).where(Workspace.slug == slug)):
        slug = f"{base}-{secrets.token_hex(2)}"
    return slug


def create_workspace(db: Session, owner_id: str, name: str, base_currency: str = "USD", language: str = "en") -> Workspace:
    ws = Workspace(name=name.strip(), slug=unique_slug(db, name), base_currency=base_currency, language=language)
    db.add(ws)
    db.flush()
    db.add(Membership(workspace_id=ws.id, user_id=owner_id, role="owner"))
    return ws


def owner_count(db: Session, workspace_id: str) -> int:
    return db.scalar(
        select(func.count()).select_from(Membership)
        .where(Membership.workspace_id == workspace_id, Membership.role == "owner")
    )
