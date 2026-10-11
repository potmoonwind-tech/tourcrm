"""Photos of places (uploaded, or free ones from Wikimedia Commons), and a tour's presentation for the client:
made from the tour as it is now, shown by link (/present/<token>) and printed to PDF from the browser."""
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import geo, presentation, programme, ratelimit, storage
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import Photo, ProgrammeShare, Tour, Vendor, Workspace, utcnow
from ..schemas import DayFields
from ..scoping import get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["photos"])
public = APIRouter(tags=["photos"])
office = require_role("staff")


class PhotoOut(BaseModel):
    id: str
    vendor_id: str | None
    place: str
    source: str
    url: str
    thumb: str
    credit: str
    link: str
    auto: bool
    position: int


def _out(ws_id: str, p: Photo) -> PhotoOut:
    url = p.url or f"/api/workspaces/{ws_id}/photos/{p.id}/file"
    return PhotoOut(id=p.id, vendor_id=p.vendor_id, place=p.place, source=p.source, url=url, thumb=p.thumb or url,
                    credit=p.credit, link=p.link, auto=p.auto, position=p.position)


def _target(db: Session, ctx: WorkspaceCtx, vendor_id: str | None, place: str | None) -> tuple[str | None, str]:
    """A photo is of a catalogue place (vendor) or of a town or sight by its name."""
    if vendor_id:
        get_owned(db, ctx, Vendor, vendor_id)
        return vendor_id, ""
    k = geo.key(place or "")
    if not k:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say whose photo it is")
    return None, k[:200]


def _first(db: Session, ws_id: str, vendor_id: str | None, place: str) -> int:
    """A position before every photo of the same place (the new one becomes the main one)."""
    q = select(func.min(Photo.position)).where(Photo.workspace_id == ws_id)
    q = q.where(Photo.vendor_id == vendor_id) if vendor_id else q.where(Photo.place == place, Photo.vendor_id.is_(None))
    return (db.scalar(q) or 0) - 1


@router.get("/photos", response_model=list[PhotoOut])
def list_photos(vendor_id: str | None = None, place: str | None = None, ctx: WorkspaceCtx = Depends(office),
                db: Session = Depends(get_db)):
    vid, k = _target(db, ctx, vendor_id, place)
    q = select(Photo).where(Photo.workspace_id == ctx.workspace.id, (Photo.url != "") | Photo.storage_key.is_not(None))
    q = q.where(Photo.vendor_id == vid) if vid else q.where(Photo.place == k)
    return [_out(ctx.workspace.id, p) for p in db.scalars(q.order_by(Photo.position, Photo.created_at))]


@router.post("/photos", response_model=PhotoOut, status_code=status.HTTP_201_CREATED)
async def upload_photo(file: UploadFile = File(...), vendor_id: str | None = Form(None), place: str | None = Form(None),
                       ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    vid, k = _target(db, ctx, vendor_id, place)
    data = await file.read(storage.MAX_IMAGE + 1)
    try:
        key = storage.save_image(ctx.workspace.id, data)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e))
    p = Photo(workspace_id=ctx.workspace.id, vendor_id=vid, place=k, source="upload", storage_key=key,
              position=_first(db, ctx.workspace.id, vid, k))
    db.add(p)
    db.commit()
    return _out(ctx.workspace.id, p)


class WikiIn(BaseModel):
    vendor_id: str | None = None
    place: str | None = None
    url: str = Field(min_length=10, max_length=1000, pattern=r"^https://upload\.wikimedia\.org/")
    thumb: str = Field(default="", max_length=1000, pattern=r"^(|https://upload\.wikimedia\.org/.*)$")
    credit: str = Field(default="", max_length=300)
    link: str = Field(default="", max_length=1000, pattern=r"^(|https://commons\.wikimedia\.org/.*)$")


@router.post("/photos/wikimedia", response_model=PhotoOut, status_code=status.HTTP_201_CREATED)
def add_wikimedia(body: WikiIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """A free photo picked from Wikimedia Commons: it becomes the place's main photo."""
    vid, k = _target(db, ctx, body.vendor_id, body.place)
    p = Photo(workspace_id=ctx.workspace.id, vendor_id=vid, place=k, source="wikimedia", url=body.url, thumb=body.thumb,
              credit=body.credit, link=body.link, position=_first(db, ctx.workspace.id, vid, k))
    db.add(p)
    db.commit()
    return _out(ctx.workspace.id, p)


class Found(BaseModel):
    url: str
    thumb: str
    credit: str
    link: str
    title: str


@router.get("/photos/search", response_model=list[Found])
def search_photos(q: str = Query(min_length=2, max_length=120), ctx: WorkspaceCtx = Depends(office)):
    """Free photos on Wikimedia Commons for these words, to pick one."""
    return [Found(**x) for x in presentation.search(q)]


def _own(db: Session, ctx: WorkspaceCtx, photo_id: str) -> Photo:
    p = db.scalar(select(Photo).where(Photo.id == photo_id, Photo.workspace_id == ctx.workspace.id))
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo not found")
    return p


@router.post("/photos/{photo_id}/main", response_model=PhotoOut)
def make_main(photo_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    p = _own(db, ctx, photo_id)
    p.position = _first(db, ctx.workspace.id, p.vendor_id, p.place)
    p.auto = False
    db.commit()
    return _out(ctx.workspace.id, p)


@router.delete("/photos/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_photo(photo_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    p = _own(db, ctx, photo_id)
    if p.auto and p.vendor_id is None:
        # The app's own pick, taken away: remembered as "none", so it isn't searched for again.
        p.url = p.thumb = p.credit = p.link = ""
    else:
        storage.delete(p.storage_key)
        db.delete(p)
    db.commit()


def _file(p: Photo) -> FileResponse:
    found = storage.open_image(p.storage_key or "")
    if not found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo not found")
    path, media = found
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=86400"})


@router.get("/photos/{photo_id}/file")
def photo_file(photo_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    return _file(_own(db, ctx, photo_id))


# --- a tour's presentation ------------------------------------------------------------------------------

def _tour(db: Session, ws_id: str, tour_id: str) -> Tour:
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ws_id)
                  .options(selectinload(Tour.days), selectinload(Tour.staff), selectinload(Tour.client)))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    return t


def _programme_of(t: Tour, lang: str) -> programme.ProgrammeIn:
    """The tour's programme for the client: no phones of the places, the tour's own title."""
    return programme.ProgrammeIn(title=t.name or t.code, start_date=t.start_date, lang=lang, tour_id=t.id, people=t.pax or None,
                                 include=programme.Include(phones=False),
                                 days=[DayFields.model_validate(d, from_attributes=True) for d in sorted(t.days, key=lambda d: d.day_number)])


@router.get("/tours/{tour_id}/presentation/places", response_model=list[list[presentation.PSubject]])
def presentation_places(tour_id: str, fill: bool = True, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """Each day's town, sights and hotel with the photo the presentation will show (the missing towns and
    sights looked up on Wikimedia first)."""
    t = _tour(db, ctx.workspace.id, tour_id)
    body = _programme_of(t, "en")
    subjects = presentation._subjects(db, ctx.workspace, body)
    if fill:
        presentation.fill_missing(db, ctx.workspace, subjects)
    photos = presentation._photos(db, ctx.workspace.id, subjects)

    def shown(p: Photo | None) -> presentation.PPhoto | None:
        if p is None:
            return None
        o = _out(ctx.workspace.id, p)
        return presentation.PPhoto(id=o.id, url=o.url, thumb=o.thumb, credit=o.credit, link=o.link, source=o.source)
    return [[s.model_copy(update={"photo": shown(presentation.photo_of(s, photos))}) for s in day] for day in subjects]


class PresentIn(BaseModel):
    lang: str = Field(default="en", pattern=r"^(en|ka|zh)$")
    price: bool = False


class PresentLink(BaseModel):
    id: str
    token: str
    lang: str
    price: bool
    created_at: datetime
    views: int = 0
    last_seen_at: datetime | None = None


def _link(x: ProgrammeShare) -> PresentLink:
    return PresentLink(id=x.id, token=x.token, lang=x.body.get("lang", "en"), price=bool(x.body.get("price")),
                       created_at=x.created_at, views=x.views or 0, last_seen_at=x.last_seen_at)


@router.post("/tours/{tour_id}/presentation", response_model=PresentLink, status_code=status.HTTP_201_CREATED)
def make_presentation(tour_id: str, body: PresentIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """A link to the tour's presentation: always the tour as it is now; with the price per person if asked."""
    t = _tour(db, ctx.workspace.id, tour_id)
    if body.price and not ctx.can("operations", "finance", "sales"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers show prices")
    presentation.fill_missing(db, ctx.workspace, presentation._subjects(db, ctx.workspace, _programme_of(t, "en")))
    x = ProgrammeShare(workspace_id=ctx.workspace.id, token=secrets.token_urlsafe(18), title=(t.name or t.code)[:200],
                       body={"kind": "presentation", "tour_id": t.id, "lang": body.lang, "price": body.price},
                       created_by_id=ctx.user.id)
    db.add(x)
    db.commit()
    return _link(x)


@router.get("/tours/{tour_id}/presentation", response_model=list[PresentLink])
def presentation_links(tour_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    t = _tour(db, ctx.workspace.id, tour_id)
    rows = db.scalars(select(ProgrammeShare).where(ProgrammeShare.workspace_id == ctx.workspace.id, ProgrammeShare.revoked_at.is_(None))
                      .order_by(ProgrammeShare.created_at.desc())).all()
    return [_link(x) for x in rows if x.body.get("kind") == "presentation" and x.body.get("tour_id") == t.id]


def _shared(db: Session, token: str, request: Request) -> tuple[ProgrammeShare, Tour]:
    ratelimit.hit("presentation", ratelimit.client_ip(request), limit=120, per_seconds=600)
    x = db.scalar(select(ProgrammeShare).where(ProgrammeShare.token == token[:64]))
    if not x or x.revoked_at or x.body.get("kind") != "presentation":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This link doesn't work any more")
    t = db.scalar(select(Tour).where(Tour.id == x.body.get("tour_id"), Tour.workspace_id == x.workspace_id)
                  .options(selectinload(Tour.days), selectinload(Tour.staff), selectinload(Tour.client)))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This link doesn't work any more")
    return x, t


@public.get("/api/shared/presentation/{token}", response_model=presentation.PresentationOut)
def shared_presentation(token: str, request: Request, db: Session = Depends(get_db)):
    x, t = _shared(db, token, request)
    x.views, x.last_seen_at = (x.views or 0) + 1, utcnow()
    db.commit()
    ws = db.get(Workspace, x.workspace_id)
    return presentation.build(db, ws, _programme_of(t, x.body.get("lang", "en")), t, bool(x.body.get("price")),
                              lambda p: f"/api/shared/presentation/{x.token}/photos/{p.id}")


@public.get("/api/shared/presentation/{token}/photos/{photo_id}")
def shared_photo(token: str, photo_id: str, request: Request, db: Session = Depends(get_db)):
    x, _ = _shared(db, token, request)
    p = db.scalar(select(Photo).where(Photo.id == photo_id, Photo.workspace_id == x.workspace_id))
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo not found")
    return _file(p)
