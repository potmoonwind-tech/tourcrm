"""Download a tour's or route's programme - from what is on screen, saved or not."""
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from .. import programme, programme_files
from ..db import get_db
from ..deps import WorkspaceCtx, require_role

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["programme"])
office = require_role("staff")


@router.post("/programme", response_model=programme.ProgrammeOut)
def build(body: programme.ProgrammeIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """The programme as data (the print page shows it, and prints it to PDF)."""
    return programme.build(db, ctx.workspace, body)


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
