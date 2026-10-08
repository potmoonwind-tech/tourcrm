"""Email from the CRM: your mailbox, the agency's templates, a booking's email filled in, sending, the log."""
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import bookings as bk, mail, ratelimit
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import MailAccount, MailLog, MailTemplate, Series, Tour, TourBooking, utcnow
from .people import rooming, rooming_filename, rooming_text, rooming_xlsx

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["mail"])
office = require_role("staff")
wording = require_jobs("operations", "finance")


# --- your mailbox ----------------------------------------------------------------------------------

class AccountIn(BaseModel):
    provider: str = Field(pattern="^(gmail|outlook|other)$")
    email: EmailStr
    from_name: str = Field(default="", max_length=120)
    password: str | None = Field(default=None, max_length=200)     # app password; None = keep the saved one
    smtp_host: str | None = Field(default=None, max_length=120)    # "other" only
    smtp_port: int | None = None
    signature: str = Field(default="", max_length=2000)


class AccountOut(BaseModel):
    connected: bool
    provider: str = ""
    email: str = ""
    from_name: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    signature: str = ""
    last_ok_at: datetime | None = None


def _mine(db: Session, ctx: WorkspaceCtx) -> MailAccount | None:
    return db.scalar(select(MailAccount).where(MailAccount.workspace_id == ctx.workspace.id, MailAccount.user_id == ctx.user.id))


def _out(a: MailAccount | None) -> AccountOut:
    if a is None:
        return AccountOut(connected=False)
    return AccountOut(connected=True, provider=a.provider, email=a.email, from_name=a.from_name, smtp_host=a.smtp_host,
                      smtp_port=a.smtp_port, signature=a.signature, last_ok_at=a.last_ok_at)


@router.get("/mail/account", response_model=AccountOut)
def get_account(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    return _out(_mine(db, ctx))


@router.put("/mail/account", response_model=AccountOut)
def save_account(body: AccountIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """Connect (or update) your mailbox. A new password is tried with the server before it's kept."""
    ratelimit.hit("mail-login", ctx.user.id, limit=10, per_seconds=600)
    a = _mine(db, ctx)
    host, port = mail.PROVIDERS.get(body.provider, (body.smtp_host or "", body.smtp_port or 587))
    if body.provider == "other":
        if not host:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "smtp_host: the mail server is needed")
        try:
            mail.safe_host(host, port)
        except mail.MailError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    password = (body.password or "").replace(" ", "") if body.password else None    # Google shows it in 4 groups
    if password is None:
        if a is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "password: the app password is needed")
        password = mail.unseal(a.secret_enc)
        if password is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "password: enter the app password again")
    try:
        mail.check_login(host, port, body.email, password)
    except mail.MailError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    if a is None:
        a = MailAccount(workspace_id=ctx.workspace.id, user_id=ctx.user.id)
        db.add(a)
    a.provider, a.email, a.username, a.from_name = body.provider, body.email, body.email, body.from_name.strip() or ctx.user.full_name
    a.smtp_host, a.smtp_port, a.signature = host, port, body.signature
    a.secret_enc, a.last_ok_at = mail.seal(password), utcnow()
    db.commit()
    return _out(a)


@router.delete("/mail/account", status_code=status.HTTP_204_NO_CONTENT)
def remove_account(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    if (a := _mine(db, ctx)) is not None:
        db.delete(a)
        db.commit()


# --- templates ---------------------------------------------------------------------------------------

class TemplateOut(BaseModel):
    kind: str
    language: str
    subject: str
    body: str
    custom: bool        # the agency's own wording (else the built-in one)


class TemplateIn(BaseModel):
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=8000)


def _templates(db: Session, ws_id: str) -> dict[tuple[str, str], TemplateOut]:
    out = {(k, lang): TemplateOut(kind=k, language=lang, subject=s, body=b, custom=False)
           for k, langs in mail.DEFAULTS.items() for lang, (s, b) in langs.items()}
    for t in db.scalars(select(MailTemplate).where(MailTemplate.workspace_id == ws_id)):
        out[(t.kind, t.language)] = TemplateOut(kind=t.kind, language=t.language, subject=t.subject, body=t.body, custom=True)
    return out


@router.get("/mail/templates", response_model=list[TemplateOut])
def list_templates(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    return list(_templates(db, ctx.workspace.id).values())


def _check_kind(kind: str, language: str) -> None:
    if kind not in mail.KINDS or language not in mail.LANGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such template")


@router.put("/mail/templates/{kind}/{language}", response_model=TemplateOut)
def save_template(kind: str, language: str, body: TemplateIn, ctx: WorkspaceCtx = Depends(wording), db: Session = Depends(get_db)):
    _check_kind(kind, language)
    t = db.scalar(select(MailTemplate).where(MailTemplate.workspace_id == ctx.workspace.id, MailTemplate.kind == kind,
                                             MailTemplate.language == language))
    if t is None:
        t = MailTemplate(workspace_id=ctx.workspace.id, kind=kind, language=language)
        db.add(t)
    t.subject, t.body = body.subject, body.body
    db.commit()
    return TemplateOut(kind=kind, language=language, subject=t.subject, body=t.body, custom=True)


@router.delete("/mail/templates/{kind}/{language}", status_code=status.HTTP_204_NO_CONTENT)
def reset_template(kind: str, language: str, ctx: WorkspaceCtx = Depends(wording), db: Session = Depends(get_db)):
    """Back to the built-in wording."""
    _check_kind(kind, language)
    t = db.scalar(select(MailTemplate).where(MailTemplate.workspace_id == ctx.workspace.id, MailTemplate.kind == kind,
                                             MailTemplate.language == language))
    if t is not None:
        db.delete(t)
        db.commit()


# --- a booking's email -------------------------------------------------------------------------------

class DraftIn(BaseModel):
    kind: str | None = None
    language: str | None = None


class DraftOut(BaseModel):
    kind: str
    language: str
    to: str              # the supplier's email ("" = not in the catalogue)
    subject: str
    body: str
    has_account: bool    # your mailbox is connected
    can_attach_rooming: bool = False   # a hotel, and the tour has its people: the rooming list can go along


def _booking(db: Session, ctx: WorkspaceCtx, tour_id: str, booking_id: str) -> tuple[Tour, TourBooking]:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id))
    b = db.get(TourBooking, booking_id) if t else None
    if t is None or b is None or b.tour_id != t.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found")
    return t, b


@router.post("/tours/{tour_id}/bookings/{booking_id}/email-draft", response_model=DraftOut)
def email_draft(tour_id: str, booking_id: str, body: DraftIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """The booking's email, filled in from the tour in the chosen template and language."""
    t, b = _booking(db, ctx, tour_id, booking_id)
    kind = body.kind or mail.default_kind(b.vendor.type)
    lang = body.language or (ctx.workspace.language if ctx.workspace.language in mail.LANGS else "en")
    _check_kind(kind, lang)
    tpl = _templates(db, ctx.workspace.id)[(kind, lang)]
    acc = _mine(db, ctx)
    u = bk.usage(db, t).get(b.vendor_id)
    values = mail.booking_values(t, b, u, lang, my_name=(acc.from_name if acc else "") or ctx.user.full_name,
                                 agency=ctx.workspace.name, signature=acc.signature if acc else "",
                                 agency_share=ctx.workspace.plate_share or 1)
    return DraftOut(kind=kind, language=lang, to=b.vendor.email or "", subject=mail.fill(tpl.subject, values),
                    body=mail.fill(tpl.body, values), has_account=acc is not None,
                    can_attach_rooming=b.vendor.type == "hotel" and bool(t.participants))


# --- the rooming list to the tour's hotels ------------------------------------------------------------

class RoomingDraft(BaseModel):
    booking_id: str
    vendor_id: str
    name: str
    to: str
    check_in: str
    check_out: str
    subject: str
    body: str


@router.post("/tours/{tour_id}/rooming-drafts", response_model=list[RoomingDraft])
def rooming_drafts(tour_id: str, body: DraftIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """One email per hotel of this tour (its own dates, rooms and reference), with the rooming list room by room."""
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id))
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    lang = body.language or (ctx.workspace.language if ctx.workspace.language in mail.LANGS else "en")
    _check_kind("rooming", lang)
    tpl = _templates(db, ctx.workspace.id)[("rooming", lang)]
    acc = _mine(db, ctx)
    rows, used = bk.sync(db, t)
    db.commit()
    text = rooming_text(t)
    out = []
    for b in sorted(rows, key=lambda b: min(used[b.vendor_id].dates) if b.vendor_id in used and used[b.vendor_id].dates else t.start_date):
        u = used.get(b.vendor_id)
        if b.status == "cancelled" or u is None or b.vendor.type != "hotel" or not u.details(t).get("stays"):
            continue
        values = mail.booking_values(t, b, u, lang, my_name=(acc.from_name if acc else "") or ctx.user.full_name,
                                     agency=ctx.workspace.name, signature=acc.signature if acc else "",
                                     agency_share=ctx.workspace.plate_share or 1)
        values["rooming"] = text
        values["rooms"] = rooming(t).text or values["rooms"]
        out.append(RoomingDraft(booking_id=b.id, vendor_id=b.vendor_id, name=b.vendor.name, to=b.vendor.email or "",
                                check_in=values["check_in"], check_out=values["check_out"],
                                subject=mail.fill(tpl.subject, values), body=mail.fill(tpl.body, values)))
    return out


# --- a series: one supplier, every (or some) departure in one email -----------------------------------

class SeriesDraftIn(BaseModel):
    language: str | None = None
    tour_ids: list[str] | None = None        # None: every upcoming departure


class SeriesDraftTour(BaseModel):
    tour_id: str
    booking_id: str
    code: str
    start_date: date
    status: str
    included: bool                           # in this email


class SeriesDraftOut(BaseModel):
    language: str
    to: str
    subject: str
    body: str
    has_account: bool
    tours: list[SeriesDraftTour]


@router.post("/series/{series_id}/bookings/{vendor_id}/email-draft", response_model=SeriesDraftOut)
def series_email_draft(series_id: str, vendor_id: str, body: SeriesDraftIn, ctx: WorkspaceCtx = Depends(office),
                       db: Session = Depends(get_db)):
    """One booking request to a supplier for a route's departures: each with its tour number, dates and people."""
    from .bookings import _series_tours
    lang = body.language or (ctx.workspace.language if ctx.workspace.language in mail.LANGS else "en")
    _check_kind("series_request", lang)
    s = db.scalar(select(Series).where(Series.id == series_id, Series.workspace_id == ctx.workspace.id))
    tours, rows, vendor = [], [], None
    for t in _series_tours(db, ctx, series_id):
        bookings, used = bk.sync(db, t)
        b = next((x for x in bookings if x.vendor_id == vendor_id and x.status != "cancelled"), None)
        if b is None:
            continue
        vendor = b.vendor
        inside = body.tour_ids is None or t.id in body.tour_ids
        tours.append(SeriesDraftTour(tour_id=t.id, booking_id=b.id, code=t.code, start_date=t.start_date, status=b.status, included=inside))
        if inside:
            rows.append((t, b, used.get(vendor_id)))
    db.commit()
    if s is None or vendor is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No upcoming departure uses this supplier")
    tpl = _templates(db, ctx.workspace.id)[("series_request", lang)]
    acc = _mine(db, ctx)
    values = mail.series_values(s, rows, lang, my_name=(acc.from_name if acc else "") or ctx.user.full_name,
                                agency=ctx.workspace.name, signature=acc.signature if acc else "",
                                agency_share=ctx.workspace.plate_share or 1)
    return SeriesDraftOut(language=lang, to=vendor.email or "", subject=mail.fill(tpl.subject, values),
                          body=mail.fill(tpl.body, values), has_account=acc is not None, tours=tours)


# --- sending -----------------------------------------------------------------------------------------

class SendIn(BaseModel):
    to: list[EmailStr] = Field(min_length=1, max_length=10)
    cc: list[EmailStr] = Field(default_factory=list, max_length=10)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=20000)
    tour_id: str | None = None
    booking_id: str | None = None
    kind: str = Field(default="", max_length=30)
    mark_requested: bool = True      # a booking still "to book" becomes "requested"
    attach_rooming: bool = False     # the tour's rooming list (Excel) goes along
    booking_ids: list[str] = Field(default_factory=list, max_length=60)   # a series email: each departure's booking


class LogOut(BaseModel):
    id: str
    tour_id: str | None
    vendor_id: str | None
    kind: str
    sender: str
    to: str
    subject: str
    body: str
    error: str
    sent_at: datetime


def _log_out(m: MailLog) -> LogOut:
    return LogOut(id=m.id, tour_id=m.tour_id, vendor_id=m.vendor_id, kind=m.kind, sender=m.sender, to=m.to,
                  subject=m.subject, body=m.body, error=m.error, sent_at=m.sent_at)


@router.post("/mail/send", response_model=LogOut)
def send_mail(body: SendIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """Send from your own mailbox. Failures are logged too, and come back as 422 with the reason."""
    ratelimit.hit("mail-send", ctx.user.id, limit=300, per_seconds=86400)
    acc = _mine(db, ctx)
    if acc is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Connect your mailbox first (Settings → Email)")
    t = b = None
    if body.booking_id:
        t, b = _booking(db, ctx, body.tour_id or "", body.booking_id)
    elif body.tour_id:
        t = db.scalar(select(Tour).where(Tour.id == body.tour_id, Tour.workspace_id == ctx.workspace.id))
        if t is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    # A series email: every departure's booking, each checked to be this agency's.
    series = [] if body.booking_id else [
        (x, x.tour) for x in db.scalars(select(TourBooking).join(Tour).where(
            TourBooking.id.in_(body.booking_ids), Tour.workspace_id == ctx.workspace.id))] if body.booking_ids else []
    log = MailLog(workspace_id=ctx.workspace.id, user_id=ctx.user.id, tour_id=t.id if t else (series[0][1].id if series else None),
                  vendor_id=b.vendor_id if b else (series[0][0].vendor_id if series else None), kind=body.kind, sender=acc.email,
                  to=", ".join(body.to), cc=", ".join(body.cc), subject=body.subject, body=body.body)
    password = mail.unseal(acc.secret_enc)
    try:
        if password is None:
            raise mail.MailError("Enter your app password again (Settings → Email)")
        files = []
        if body.attach_rooming and t is not None and t.participants:
            files.append((rooming_filename(t), rooming_xlsx(t), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
        mail.send(acc.smtp_host, acc.smtp_port, acc.username, password, sender=acc.email, from_name=acc.from_name,
                  to=[str(x) for x in body.to], cc=[str(x) for x in body.cc], subject=body.subject, body=body.body,
                  attachments=files)
    except mail.MailError as e:
        log.error = str(e)[:500]
        db.add(log)
        db.commit()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    if b is not None and body.mark_requested and b.status == "to_book":
        b.status = "requested"
    db.add(log)
    # The series email shows on each departure's booking too; each becomes "requested".
    for sb, st in series[1:]:
        db.add(MailLog(workspace_id=ctx.workspace.id, user_id=ctx.user.id, tour_id=st.id, vendor_id=sb.vendor_id, kind=body.kind,
                       sender=acc.email, to=log.to, cc=log.cc, subject=body.subject, body=body.body))
    for sb, _ in series:
        if body.mark_requested and sb.status == "to_book":
            sb.status = "requested"
    db.commit()
    return _log_out(log)


@router.get("/mail/log", response_model=list[LogOut])
def mail_log(tour_id: str | None = None, vendor_id: str | None = None, limit: int = Query(default=50, le=200),
             ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    q = select(MailLog).where(MailLog.workspace_id == ctx.workspace.id)
    if tour_id:
        q = q.where(MailLog.tour_id == tour_id)
    if vendor_id:
        q = q.where(MailLog.vendor_id == vendor_id)
    return [_log_out(m) for m in db.scalars(q.order_by(MailLog.sent_at.desc()).limit(limit))]
