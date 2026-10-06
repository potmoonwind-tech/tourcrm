"""The setup assistant's API: conversations, uploads, and confirming what it proposed.

Managers and up (it proposes prices and suppliers, which only they can save). The assistant runs
in the background after each message; the screen polls the session to show its progress.
"""
import logging
from datetime import timedelta

import anthropic

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import ratelimit
from ..ai import agent, apply as applying, keys, sheets
from ..config import settings
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import AiSession, utcnow
from ..storage import image_kind

router = APIRouter(prefix="/api/workspaces/{workspace_id}/ai", tags=["assistant"])
log = logging.getLogger(__name__)
can_ope = require_jobs('operations')
SHEET_EXT = (".xlsx", ".xlsm", ".csv", ".tsv")
IMAGE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
MAX_FILES = 10
FILE_DAYS = 7          # uploads to the AI service delete themselves after this


class SessionBrief(BaseModel):
    id: str
    title: str
    status: str
    proposed: int
    applied: int
    updated_at: object


class SessionOut(BaseModel):
    id: str
    title: str
    status: str
    error: str
    chat: list[dict]
    plan: list[dict]
    files: list[dict]


class ApplyIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=2000)


def _out(s: AiSession) -> SessionOut:
    if s.status == "running" and s.updated_at and utcnow() - s.updated_at.replace(tzinfo=utcnow().tzinfo) > timedelta(minutes=15):
        s.status, s.error = "error", "The assistant was interrupted — send your message again"
    return SessionOut(id=s.id, title=s.title, status=s.status, error=s.error, chat=s.chat,
                      plan=[p for p in s.plan if p["status"] != "removed"],
                      files=[{"name": f["name"], "kind": f["kind"]} for f in s.files])


def _get(db: Session, ctx: WorkspaceCtx, session_id: str) -> AiSession:
    s = db.scalar(select(AiSession).where(AiSession.id == session_id, AiSession.workspace_id == ctx.workspace.id))
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    return s


@router.get("/status")
def ai_status(ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    return {"available": agent.available(ctx.workspace), "own_key": bool(ctx.workspace.ai_key_enc), "spent_usd": round(agent.spent_usd(db, ctx.workspace.id), 2),
            "limit_usd": settings.ai_monthly_usd}


@router.get("/sessions", response_model=list[SessionBrief])
def list_sessions(ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    rows = db.scalars(select(AiSession).where(AiSession.workspace_id == ctx.workspace.id).order_by(AiSession.updated_at.desc()).limit(50))
    return [SessionBrief(id=s.id, title=s.title, status=s.status, updated_at=s.updated_at,
                         proposed=sum(1 for p in s.plan if p["status"] in ("proposed", "failed")),
                         applied=sum(1 for p in s.plan if p["status"] == "applied")) for s in rows]


@router.post("/sessions", response_model=SessionOut, status_code=status.HTTP_201_CREATED)
def new_session(ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    s = AiSession(workspace_id=ctx.workspace.id, user_id=ctx.user.id, history=[], chat=[], plan=[], files=[])
    db.add(s)
    db.commit()
    return _out(s)


@router.get("/sessions/{session_id}", response_model=SessionOut)
def get_session(session_id: str, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    return _out(_get(db, ctx, session_id))


def _unique(name: str, taken: set[str]) -> str:
    base, n, out = name, 2, name
    while out in taken:
        stem, dot, ext = base.rpartition(".")
        out = f"{stem} ({n}).{ext}" if dot else f"{base} ({n})"
        n += 1
    return out


@router.post("/sessions/{session_id}/messages", response_model=SessionOut)
async def send(session_id: str, request: Request, background: BackgroundTasks, text: str = Form("", max_length=20000),
               files: list[UploadFile] = File(default_factory=list),
               ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    if not agent.available(ctx.workspace):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The AI assistant isn't set up — add an API key in Settings")
    ratelimit.hit("ai", ctx.workspace.id, limit=30, per_seconds=600)
    s = _get(db, ctx, session_id)
    if s.status == "running":
        raise HTTPException(status.HTTP_409_CONFLICT, "The assistant is still working on your last message")
    if agent.spent_usd(db, ctx.workspace.id) >= settings.ai_monthly_usd:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "This month's AI allowance is used up")
    if not text.strip() and not files:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Write something or add a file")
    if len(files) + len(s.files) > MAX_FILES * 3 or len(files) > MAX_FILES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"At most {MAX_FILES} files at a time")

    blocks, stored, names = [], list(s.files), []
    taken = {f["name"] for f in s.files}
    client = None
    for f in files:
        data = await f.read()
        name = _unique((f.filename or "file").split("/")[-1].split("\\")[-1][:120], taken)
        taken.add(name)
        names.append(name)
        if name.lower().endswith(SHEET_EXT):
            try:
                parsed = sheets.read(name, data)
            except ValueError as e:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{name}: {e}") from e
            stored.append({"name": name, "kind": "sheet", "sheets": parsed})
            blocks.append({"type": "text", "text": sheets.preview(name, parsed)})
            continue
        kind = "pdf" if data[:5] == b"%PDF-" else image_kind(data)
        if kind not in ("pdf", *IMAGE_TYPES):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{name}: send Excel, CSV, PDF or a photo (JPEG, PNG, WebP)")
        client = client or agent.make_client(ctx.workspace)
        mime = "application/pdf" if kind == "pdf" else IMAGE_TYPES[kind]
        try:
            up = client.files.upload(file=(name, data, mime), expires_in_seconds=FILE_DAYS * 86400)
        except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"{name}: couldn't send it to the AI service — try again") from e
        stored.append({"name": name, "kind": "pdf" if kind == "pdf" else "image", "file_id": up.id})
        blocks.append({"type": "text", "text": f"File {name!r}:"})
        blocks.append({"type": "document", "source": {"type": "file", "file_id": up.id}, "title": name} if kind == "pdf"
                      else {"type": "image", "source": {"type": "file", "file_id": up.id}})

    s.files = stored
    agent.user_turn(s, ctx.workspace, text.strip(), blocks)
    agent._say(s, "user", text.strip(), files=names)
    if not s.title:
        s.title = (text.strip().split("\n")[0][:80] or ", ".join(names))[:200]
    s.status, s.error, s.updated_at = "running", "", utcnow()
    db.commit()
    background.add_task(_work, request.app.dependency_overrides.get(get_db, get_db), s.id)
    return _out(s)


def _work(session_factory, session_id: str) -> None:
    gen = session_factory()
    db = next(gen)
    try:
        agent.run(db, session_id)
    finally:
        gen.close()


@router.post("/sessions/{session_id}/apply", response_model=SessionOut)
def confirm(session_id: str, body: ApplyIn, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    s = _get(db, ctx, session_id)
    if s.status == "running":
        raise HTTPException(status.HTTP_409_CONFLICT, "Wait until the assistant has finished")
    applying.apply(db, ctx, s, body.ids)
    done = [p for p in s.plan if p["id"] in set(body.ids)]
    ok = sum(1 for p in done if p["status"] == "applied")
    # Tell the assistant what was saved, so a follow-up ("now add the tour") refers to real records.
    s.history = [*s.history, {"role": "user", "content": [{"type": "text", "text": "[Saved by the person: " + ", ".join(
        f"{p['id']} → {p['kind']} id {p['result_id']}" for p in done if p["status"] == "applied") + "]"}]}] if ok else s.history
    agent._say(s, "notice", "applied", ok=ok, failed=len(done) - ok)
    s.updated_at = utcnow()
    db.commit()
    return _out(s)


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: str, ctx: WorkspaceCtx = Depends(can_ope), db: Session = Depends(get_db)):
    s = _get(db, ctx, session_id)
    if s.status == "running":
        raise HTTPException(status.HTTP_409_CONFLICT, "Wait until the assistant has finished")
    ids = [f["file_id"] for f in s.files if f.get("file_id")]
    if ids and agent.available(ctx.workspace):
        client = agent.make_client(ctx.workspace)
        for fid in ids:
            try:
                client.files.delete(fid)
            except Exception:      # already expired or gone: nothing to clean up
                pass
    db.delete(s)
    db.commit()


# --- the agency's own API key (Settings) -------------------------------------------------------------

admin = require_role("admin")


class KeyIn(BaseModel):
    key: str = Field(min_length=20, max_length=300)
    workspace_id: str = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9_-]*$")


NEEDS_WORKSPACE = "anthropic-workspace-id"


def _check_key(key: str, workspace_id: str = "") -> None:
    """A free request (list one model) to see that Anthropic accepts the key."""
    try:
        anthropic.Anthropic(api_key=key, max_retries=1, timeout=15,
                            default_headers={"anthropic-workspace-id": workspace_id} if workspace_id else None).models.list(limit=1)
    except anthropic.AuthenticationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Anthropic didn't accept this key — check it and paste it again") from e
    except anthropic.PermissionDeniedError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "This key isn't allowed to use the API") from e
    except anthropic.APITimeoutError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Anthropic didn't answer in time — try again") from e
    except anthropic.APIConnectionError as e:
        log.warning("AI key check: can't connect: %r", e.__cause__ or e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Couldn't connect to Anthropic from the server — check its internet access") from e
    except anthropic.APIStatusError as e:
        # Say what Anthropic said (no credit, rate limit, overloaded...) instead of a generic error.
        detail = e.body.get("error", {}).get("message") if isinstance(e.body, dict) else None
        if NEEDS_WORKSPACE in (detail or ""):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                "This key belongs to the whole organization: add the Workspace ID (Console → Settings → Workspaces), "
                                "or create a key inside a workspace") from e
        log.warning("AI key check: Anthropic answered %s: %s", e.status_code, detail or e.message)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Anthropic answered {e.status_code}: {detail or e.message}") from e


@router.put("/key")
def save_key(body: KeyIn, ctx: WorkspaceCtx = Depends(admin), db: Session = Depends(get_db)):
    ratelimit.hit("ai-key", ctx.workspace.id, limit=10, per_seconds=600)
    key = body.key.strip()
    if not key.startswith("sk-ant-") or any(c.isspace() for c in key):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "An Anthropic API key starts with sk-ant-")
    _check_key(key, body.workspace_id)
    ctx.workspace.ai_key_enc, ctx.workspace.ai_key_hint = keys.seal(key), key[-4:]
    ctx.workspace.ai_workspace_id = body.workspace_id
    db.commit()
    return {"hint": ctx.workspace.ai_key_hint}


@router.post("/key/test")
def test_key(ctx: WorkspaceCtx = Depends(admin), db: Session = Depends(get_db)):
    ratelimit.hit("ai-key", ctx.workspace.id, limit=10, per_seconds=600)
    key = keys.agency_key(ctx.workspace)
    if not key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No key saved — or it can't be read any more; paste it again")
    _check_key(key, ctx.workspace.ai_workspace_id)
    return {"ok": True}


@router.delete("/key", status_code=status.HTTP_204_NO_CONTENT)
def remove_key(ctx: WorkspaceCtx = Depends(admin), db: Session = Depends(get_db)):
    ctx.workspace.ai_key_enc, ctx.workspace.ai_key_hint, ctx.workspace.ai_workspace_id = None, "", ""
    db.commit()

