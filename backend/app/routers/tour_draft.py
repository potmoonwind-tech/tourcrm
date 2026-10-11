"""A new tour from a few words: "Chinese group of 20 + 1 leader, from 3 October, Tbilisi 2 nights, Kazbegi,
Kutaisi, Batumi 2". The AI reads the text into a draft (dates, people, client, towns and nights); the days are
laid out and each night gets a hotel from the agency's catalogue in that town. Nothing is saved: the person
sees the draft and creates the tour (the usual endpoints), then fills what's left."""
import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import geo
from ..ai import keys
from ..config import settings
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..models import Client, Vendor, Workspace

router = APIRouter(prefix="/api/workspaces/{workspace_id}/tours", tags=["tours"])
write = require_role("staff")


def make_client(ws: Workspace):
    """Tests replace this."""
    from ..ai.agent import make_client as ai_client
    return ai_client(ws)


TOOL = {
    "name": "tour_draft",
    "description": "The tour described in the message, as fields. Leave out what the message doesn't say.",
    "input_schema": {
        "type": "object",
        "properties": {
            "start_date": {"type": "string", "description": "First day, YYYY-MM-DD (the nearest future date when no year is given)"},
            "towns": {"type": "array", "description": "Where the group sleeps, in order, with the number of nights in each",
                      "items": {"type": "object", "properties": {"town": {"type": "string"}, "nights": {"type": "integer", "minimum": 1}},
                                "required": ["town", "nights"]}},
            "end_town": {"type": "string", "description": "Where the last day ends (departure town), if said; else the last town"},
            "days": {"type": "integer", "description": "Total number of days, if said"},
            "pax": {"type": "integer", "description": "Number of tourists (without tour leaders)"},
            "leaders": {"type": "integer", "description": "Number of tour leaders travelling free, if said"},
            "client": {"type": "string", "description": "The client (agency or person) the tour is for, if said"},
            "notes": {"type": "string", "description": "Anything else useful from the message, short"},
        },
    },
}


class DraftIn(BaseModel):
    text: str = Field(min_length=3, max_length=4000)


class DraftDay(BaseModel):
    city: str
    hotel_id: str | None = None
    hotel: str = ""                    # the hotel's name, to show


class DraftOut(BaseModel):
    start_date: date | None = None
    days: list[DraftDay] = []
    pax: int | None = None
    leaders: int | None = None
    client_id: str | None = None       # an existing client it matched
    client_name: str = ""              # the client as written (a new one when not matched)
    notes: str = ""


@router.post("/draft", response_model=DraftOut)
def draft(body: DraftIn, ctx: WorkspaceCtx = Depends(write), db: Session = Depends(get_db)) -> DraftOut:
    ws = ctx.workspace
    if not keys.key_for(ws):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The assistant isn't set up (no AI key)")
    hotels = db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id, Vendor.type == "hotel", Vendor.is_active.is_(True))).all()
    towns = sorted({h.city.strip() for h in hotels if h.city and h.city.strip()})
    prompt = (f"Today is {date.today().isoformat()}. A travel agency ({ws.name}) describes a group tour. "
              f"Their towns are usually spelled: {', '.join(towns[:80]) or '-'}. Use those spellings when the same town is meant. "
              "Fill the tour_draft tool from the message.\n\nMessage:\n" + body.text)
    try:
        msg = make_client(ws).messages.create(model=settings.ai_translate_model, max_tokens=1500, tools=[TOOL],
                                              tool_choice={"type": "tool", "name": "tour_draft"},
                                              messages=[{"role": "user", "content": prompt}])
        got = next(b.input for b in msg.content if getattr(b, "type", "") == "tool_use")
        if isinstance(got, str):
            got = json.loads(got)
    except Exception:          # noqa: BLE001 - said plainly; the form still works
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "The assistant couldn't read that - try again or use the form")
    return build(db, ws.id, got, hotels)


def build(db: Session, ws_id: str, got: dict, hotels: list[Vendor]) -> DraftOut:
    """The days from the towns and nights; each night a hotel of the catalogue in its town; the client matched."""
    days: list[DraftDay] = []
    by_town: dict[str, Vendor] = {}
    for h in sorted(hotels, key=lambda h: h.name.lower()):
        by_town.setdefault(geo.town_key(h.city or ""), h)
    for row in got.get("towns") or []:
        town = str(row.get("town") or "").strip()[:100]
        n = max(1, min(int(row.get("nights") or 1), 30))
        h = by_town.get(geo.town_key(town))
        days += [DraftDay(city=town, hotel_id=h.id if h else None, hotel=h.name if h else "") for _ in range(n)]
    if days:
        end = str(got.get("end_town") or "").strip()[:100] or days[-1].city
        days.append(DraftDay(city=end))           # the last day: no night
    want = int(got.get("days") or 0)
    if want and days and len(days) < want:        # "8 days" with fewer nights said: the last town stays
        days[-1:-1] = [DraftDay(city=days[-2].city, hotel_id=days[-2].hotel_id, hotel=days[-2].hotel)
                       for _ in range(want - len(days))] if len(days) > 1 else []
    start = None
    try:
        start = date.fromisoformat(str(got.get("start_date") or "")[:10])
    except ValueError:
        pass
    name = str(got.get("client") or "").strip()[:200]
    client_id = None
    if name:
        key = name.casefold()
        for c in db.scalars(select(Client).where(Client.workspace_id == ws_id)):
            if c.name.casefold() == key or key in c.name.casefold():
                client_id = c.id
                break
    return DraftOut(start_date=start, days=days[:60], pax=got.get("pax"), leaders=got.get("leaders"),
                    client_id=client_id, client_name=name, notes=str(got.get("notes") or "")[:500])


