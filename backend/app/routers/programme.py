"""Download a tour's or route's programme - from what is on screen, saved or not."""
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import programme, programme_files, ratelimit
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import ProgrammeShare, Tour, Workspace, utcnow
from ..schemas import DayFields

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["programme"])
public = APIRouter(tags=["programme"])
office = require_role("staff")


class ShareOut(BaseModel):
    id: str
    token: str
    created_at: datetime


@router.post("/programme/share", response_model=ShareOut)
def share(body: programme.ProgrammeIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """A link anyone can open (/p/<token>): the programme as made here, on any phone or computer."""
    x = ProgrammeShare(workspace_id=ctx.workspace.id, token=secrets.token_urlsafe(18), title=body.title[:200],
                       body=body.model_dump(mode="json"), created_by_id=ctx.user.id)
    db.add(x)
    db.commit()
    return ShareOut(id=x.id, token=x.token, created_at=x.created_at)


@router.delete("/programme/share/{share_id}", status_code=204)
def unshare(share_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    x = db.scalar(select(ProgrammeShare).where(ProgrammeShare.id == share_id, ProgrammeShare.workspace_id == ctx.workspace.id))
    if not x:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    x.revoked_at = utcnow()
    db.commit()


@public.get("/api/shared/programme/{token}", response_model=programme.ProgrammeOut)
def shared(token: str, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("programme-share", ratelimit.client_ip(request), limit=120, per_seconds=600)
    x = db.scalar(select(ProgrammeShare).where(ProgrammeShare.token == token[:64]))
    if not x or x.revoked_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This link doesn't work any more")
    x.views, x.last_seen_at = (x.views or 0) + 1, utcnow()
    db.commit()
    body = programme.ProgrammeIn.model_validate(x.body)
    # A tour's link shows the tour as it is now (a menu chosen later, a changed hotel), with the options it
    # was made with; a day without its own programme gets the suggested one, as in the dialog.
    t = db.scalar(select(Tour).where(Tour.id == body.tour_id, Tour.workspace_id == x.workspace_id)
                  .options(selectinload(Tour.days))) if body.tour_id else None
    if t and t.days:
        body = body.model_copy(update={"start_date": t.start_date, "days": [
            DayFields.model_validate(d, from_attributes=True) for d in sorted(t.days, key=lambda d: d.day_number)]})
    return programme.build(db, db.get(Workspace, x.workspace_id), body, fill=True)


@router.post("/programme", response_model=programme.ProgrammeOut)
def build(body: programme.ProgrammeIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """The programme as data (the print page shows it, and prints it to PDF)."""
    return programme.build(db, ctx.workspace, body, fill=True)     # as the share link shows it


def _name(p: programme.ProgrammeOut, ext: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in " -_" else "_" for ch in p.title).strip() or "programme"
    return f"{safe[:60]}-{p.lang}.{ext}"


@router.post("/programme.docx")
def as_word(body: programme.ProgrammeIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    p = programme.build(db, ctx.workspace, body)
    return Response(programme_files.docx_bytes(p),
                    media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(_name(p, 'docx'))}",
                             "X-Programme-Warnings": ",".join(p.warnings)})


@router.post("/programme.xlsx")
def as_excel(body: programme.ProgrammeIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    p = programme.build(db, ctx.workspace, body)
    return Response(programme_files.xlsx_bytes(p),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(_name(p, 'xlsx'))}",
                             "X-Programme-Warnings": ",".join(p.warnings)})


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)
