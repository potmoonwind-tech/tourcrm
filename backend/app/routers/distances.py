"""Suggested road kilometres for a list of day cities (route or tour itinerary)."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import geo, ratelimit
from ..db import get_db
from ..deps import WorkspaceCtx, require_role

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["distances"])
office = require_role("staff")


class DistancesIn(BaseModel):
    cities: list[str] = Field(max_length=60)


class Leg(BaseModel):
    from_city: str | None
    to_city: str
    km: int | None          # None = couldn't find a road — type it in
    minutes: int | None = None   # car driving time (the agency's coach factor is applied when shown)
    skipped: Literal["not_found", "far", "pending"] | None = None   # pending: not asked yet (per-click limit)   # left out of the km: unknown, or only known far away
    where: str = ""         # where the map put a "far" stop


class DistancesOut(BaseModel):
    legs: list[Leg]
    total: int              # of the legs found


@router.post("/distances", response_model=DistancesOut)
def suggest(body: DistancesIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    # Each open day programme asks for its road (mostly answered from what's kept); new places are
    # limited per request (geo.MAX_NEW_LOOKUPS) and paced, so the shared map isn't flooded.
    ratelimit.hit("distances", ctx.workspace.id, limit=200, per_seconds=600)
    cities = [c[:100] for c in body.cities]
    rows = geo.legs(db, cities, countries=ctx.workspace.countries or None, workspace_id=ctx.workspace.id)
    db.commit()     # keep what the map told us
    return DistancesOut(legs=[Leg(from_city=r["from"], to_city=r["to"], km=r["km"], minutes=r.get("minutes"), skipped=r["skipped"], where=r["where"]) for r in rows],
                        total=sum(r["km"] or 0 for r in rows))


# --- real place names while typing ---------------------------------------------------------------

class PlaceSuggestion(BaseModel):
    name: str
    detail: str            # "Mtskheta-Mtianeti, Georgia"
    kind: str              # what the map says it is: city, village, castle, monastery…
    lat: float | None      # None from Google: looked up when picked (/places/details)
    lon: float | None
    street: str = ""       # "Rustaveli Ave 12" when the map has it
    city: str = ""         # the town it is in
    place_id: str | None = None   # Google's id


@router.get("/places", response_model=list[PlaceSuggestion])
def places(q: str = Query(min_length=2, max_length=80), session: str | None = Query(default=None, max_length=64),
           ctx: WorkspaceCtx = Depends(office)):
    ratelimit.hit("places", ctx.workspace.id, limit=300, per_seconds=600)   # typed with a pause; the map is shared
    return geo.suggest(q, ctx.workspace.countries or None, session=session)


class PlaceDetails(BaseModel):
    lat: float
    lon: float
    street: str = ""
    city: str = ""
    detail: str = ""
    place_id: str


@router.get("/places/details", response_model=PlaceDetails)
def place_details(id: str = Query(min_length=1, max_length=300), session: str | None = Query(default=None, max_length=64),
                  ctx: WorkspaceCtx = Depends(office)):
    """Where a picked Google suggestion is (ends the typing session, which Google prices as one lookup)."""
    ratelimit.hit("place-details", ctx.workspace.id, limit=200, per_seconds=600)
    d = geo.place_details(id, session)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Place not found")
    return d


class PinIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    label: str = Field(default="", max_length=300)
    place_id: str | None = Field(default=None, max_length=300)


@router.post("/places/pin", status_code=204)
def pin_place(body: PinIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """The name picked from the suggestions is that spot for km and driving times (this agency only)."""
    geo.pin(db, ctx.workspace.id, body.name, body.lat, body.lon, body.label or body.name, body.place_id)
    db.commit()


# --- maps: where the places are and the roads between them ----------------------------------------

class MapIn(BaseModel):
    places: list[str] = Field(max_length=80)


class MapPoint(BaseModel):
    name: str
    lat: float | None
    lon: float | None
    where: str                                   # what the map calls it
    missing: Literal["not_found", "far", "pending"] | None = None


class MapRoad(BaseModel):
    from_: int = Field(alias="from", serialization_alias="from")   # indexes into points
    to: int
    polyline: str | None                         # encoded (precision 5); None = draw a straight line

    model_config = {"populate_by_name": True}


class MapOut(BaseModel):
    points: list[MapPoint]
    roads: list[MapRoad]


@router.post("/map", response_model=MapOut, response_model_by_alias=True)
def trip_map(body: MapIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """The places of a trip or a day on the map, with the roads between them (shapes kept once asked)."""
    ratelimit.hit("map", ctx.workspace.id, limit=60, per_seconds=600)
    out = geo.path_map(db, [p[:300] for p in body.places], ctx.workspace.countries or None, ctx.workspace.id)
    db.commit()
    return out
