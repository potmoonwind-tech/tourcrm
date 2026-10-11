"""The agency's place names in one place (Settings → Place names): every town, stop and visit its tours and
routes use, so mixed spellings ("Tbilisi", "თბილისი", "T'bilisi") can be made one - renamed everywhere at
once, or to the map's name in the agency's place language - and the name each has for clients in English,
Georgian and Chinese (what programme files print; kept with the AI's translations, and editable)."""
import hashlib
import re
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import geo, ratelimit
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import DayTemplate, GeoPlace, Series, SeriesDay, TextTranslation, Tour, TourDay

router = APIRouter(prefix="/api/workspaces/{workspace_id}/place-names", tags=["place-names"])
office = require_role("staff")
CLIENT_LANGS = ("en", "ka", "zh")      # the programme files' languages


def _days(db: Session, ws_id: str) -> list:
    """Every day of the agency's tours and routes."""
    tours = db.scalars(select(TourDay).join(Tour, TourDay.tour_id == Tour.id).where(Tour.workspace_id == ws_id)).all()
    routes = db.scalars(select(SeriesDay).join(Series, SeriesDay.series_id == Series.id).where(Series.workspace_id == ws_id)).all()
    return [*tours, *routes]


def _names_of(d) -> list[str]:
    """The place names a day uses: where it sleeps, its stops, its visits typed by hand, its TBD meal towns."""
    out = [d.city, *(d.stops or [])]
    for x in d.schedule or []:
        if x.get("kind") == "visit" and not x.get("ref") and x.get("title"):
            out.append(x["title"])
        if x.get("place"):
            out.append(x["place"])
    out += [v for v in (d.meal_tbd or {}).values() if isinstance(v, str)]
    return [n.strip() for n in out if isinstance(n, str) and n.strip() and re.search(r"[^\W\d_]", n)]


def _hash(t: str) -> str:
    return hashlib.sha1(t.encode()).hexdigest()


class NameRow(BaseModel):
    name: str
    uses: int                          # how many times tours and routes use it
    on_map: bool                       # picked from the map (its spot is known)
    client: dict[str, str]             # the name for clients: {"en": "...", "ka": "...", "zh": "..."}


@router.get("", response_model=list[NameRow])
def list_names(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)) -> list[NameRow]:
    count = Counter(n for d in _days(db, ctx.workspace.id) for n in _names_of(d))
    names = sorted(count, key=lambda n: n.lower())
    pins = {g.key for g in db.scalars(select(GeoPlace).where(GeoPlace.key.in_([geo.pin_key(ctx.workspace.id, n[:100]) for n in names])))}
    kept: dict[tuple[str, str], str] = {}
    hashes = [_hash(n) for n in names]
    for r in db.scalars(select(TextTranslation).where(TextTranslation.workspace_id == ctx.workspace.id,
                                                      TextTranslation.source_hash.in_(hashes))):
        kept[(r.source_hash, r.lang)] = r.result
    return [NameRow(name=n, uses=count[n], on_map=geo.pin_key(ctx.workspace.id, n[:100]) in pins,
                    client={lang: kept.get((_hash(n), lang), "") for lang in CLIENT_LANGS}) for n in names]


class RenameIn(BaseModel):
    old: str = Field(min_length=1, max_length=200)
    new: str = Field(min_length=1, max_length=100)


@router.post("/rename")
def rename(body: RenameIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)) -> dict:
    """One name becomes another in every tour and route (and saved day); its map spot goes with it."""
    old, new = body.old.strip(), body.new.strip()
    if not old or not new or old == new:
        return {"changed": 0}
    sub = lambda v: new if isinstance(v, str) and v.strip() == old else v
    changed = 0
    for d in _days(db, ctx.workspace.id):
        before = (d.city, list(d.stops or []), [dict(x) for x in d.schedule or []], dict(d.meal_tbd or {}))
        d.city = sub(d.city)
        d.stops = [sub(s) for s in d.stops or []]
        d.schedule = [{**x, **({"title": new} if x.get("kind") == "visit" and not x.get("ref") and (x.get("title") or "").strip() == old else {}),
                       **({"place": new} if (x.get("place") or "").strip() == old else {})} for x in d.schedule or []]
        d.meal_tbd = {k: sub(v) for k, v in (d.meal_tbd or {}).items()}
        if (d.city, d.stops, d.schedule, d.meal_tbd) != before:
            changed += 1
    for tpl in db.scalars(select(DayTemplate).where(DayTemplate.workspace_id == ctx.workspace.id)):
        if tpl.city.strip() == old:
            tpl.city = new
        if isinstance(tpl.data, dict) and (tpl.data.get("city") or "").strip() == old:
            tpl.data = {**tpl.data, "city": new}
    # The spot on the map, and the names for clients, follow the name.
    pin = db.get(GeoPlace, geo.pin_key(ctx.workspace.id, old[:100]))
    if pin is not None and db.get(GeoPlace, geo.pin_key(ctx.workspace.id, new[:100])) is None:
        geo.pin(db, ctx.workspace.id, new[:100], pin.lat, pin.lon, pin.name, pin.place_id, pin.hours)
    for r in db.scalars(select(TextTranslation).where(TextTranslation.workspace_id == ctx.workspace.id,
                                                      TextTranslation.source_hash == _hash(old))):
        if db.scalars(select(TextTranslation).where(TextTranslation.workspace_id == ctx.workspace.id, TextTranslation.lang == r.lang,
                                                    TextTranslation.source_hash == _hash(new))).first() is None:
            db.add(TextTranslation(workspace_id=ctx.workspace.id, lang=r.lang, source_hash=_hash(new), source=new, result=r.result))
    db.commit()
    return {"changed": changed}


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.post("/map-name")
def map_name(body: NameIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)) -> dict:
    """The map's name for a place in the agency's place language: its picked spot when there is one, else the
    map's best match for the name. 404 when the map has nothing."""
    if not geo.google():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The map service isn't set up here")
    ratelimit.hit("place-details", ctx.workspace.id, limit=200, per_seconds=600)
    lang = ctx.workspace.place_lang or ctx.workspace.language or "en"
    pin = db.get(GeoPlace, geo.pin_key(ctx.workspace.id, body.name.strip()[:100]))
    if pin is not None and pin.place_id:
        d = geo.place_details(pin.place_id, lang=lang)
        if d and d.get("name"):
            return {"name": d["name"]}
    hits = [x for x in geo.suggest(body.name.strip(), ctx.workspace.countries or None, lang=lang) if x.get("name")]
    if not hits:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The map has no name for this place")
    return {"name": hits[0]["name"]}


class ClientNameIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lang: str = Field(pattern=r"^(en|ka|zh)$")
    text: str = Field(default="", max_length=200)


@router.put("/client-name", status_code=204)
def client_name(body: ClientNameIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)) -> None:
    """The name a place has for clients in a language (what programme files print). Empty = let the AI
    translate it again next time."""
    h = _hash(body.name.strip())
    row = db.scalars(select(TextTranslation).where(TextTranslation.workspace_id == ctx.workspace.id,
                                                   TextTranslation.lang == body.lang, TextTranslation.source_hash == h)).first()
    text = body.text.strip()
    if not text:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(TextTranslation(workspace_id=ctx.workspace.id, lang=body.lang, source_hash=h, source=body.name.strip(), result=text))
    else:
        row.result = text
    db.commit()
