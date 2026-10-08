"""What the setup assistant can do: look things up, read the uploaded sheets, and PROPOSE changes.

Proposals go into the session's plan; nothing is written until a person confirms (app/ai/apply.py).
Every proposal is checked with the same schemas the app's forms use, so a mistake comes back to
the assistant as an error it can fix, not as a broken item in the plan.

A proposal can refer to an existing record by its id, or to another proposal by its plan id
("p3") — e.g. prices for a hotel that is itself only proposed.
"""
import json
import re
from datetime import date, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import catalog
from ..deps import WorkspaceCtx
from ..models import AiSession, Client, Quote, Series, Service, Tour, Vendor
from ..routers.pricing import ServiceIn
from ..quote_schemas import BUILT_IN_KINDS, CalcStyle
from ..schemas import ClientCreate, Flight, ParticipantIn, SeriesColor, TourStatus, VendorCreate
from . import docs, sheets

PLAN_LIMIT = 2000
PROPOSAL = re.compile(r"^p\d+$")
MODEL_OF = {"vendor": Vendor, "client": Client, "route": Series, "tour": Tour, "calculation": Quote}


class ToolError(Exception):
    """Goes back to the assistant as an error result it can act on."""


# --- tool definitions (sent to the model; keep the order and wording stable for caching) --------

_REF = {"type": "string", "description": "An existing record's id, or a plan id like \"p3\" for something proposed in this plan"}
_DAY = {
    "type": "object",
    "properties": {
        "city": {"type": "string", "description": "Where the group sleeps that night (or ends the tour)"},
        "stops": {"type": "array", "items": {"type": "string"}, "description": "Other places visited that day, in order (excursion, lunch on the road)"},
        "hotel": {**_REF, "description": "Hotel for the night (vendor id or plan id); none on the last day"},
        "lunch": {**_REF, "description": "Restaurant (or hotel) for lunch"},
        "dinner": {**_REF, "description": "Restaurant (or hotel) for dinner"},
        "lunch_mode": {"type": "string", "enum": ["included", "tourists", "own"],
                       "description": "included = in our price; tourists = we reserve, they pay; own = free time, no restaurant"},
        "dinner_mode": {"type": "string", "enum": ["included", "tourists", "own"]},
        "flights": {"type": "array", "description": "Group flights that day", "items": {"type": "object", "properties": {
            "direction": {"type": "string", "enum": ["arrival", "departure"]}, "number": {"type": "string"},
            "time": {"type": "string", "description": "HH:MM local"}, "airport": {"type": "string"},
            "other": {"type": "string", "description": "Where from (arrival) or to (departure)"}},
            "required": ["direction", "number"]}},
        "border_crossing": {"type": "string"},
        "notes": {"type": "string"},
        "km": {"type": "integer", "description": "Road km driven that day, if known"},
        "extras": {"type": "array", "description": "What they do that day: activities and tickets at catalogue places (reuse "
                                                   "existing suppliers and services), and other services (transport, guide...)", "items": {
            "type": "object",
            "properties": {"vendor": _REF, "service": {"type": "string", "description": "The service's name at that vendor"},
                           "quantity": {"type": "number", "description": "Leave out to count it from the group (per person, per room...)"},
                           "optional": {"type": "boolean", "description": "Offered only (the group may add it), not included"}},
            "required": ["vendor", "service"]}},
    },
}
_RATE = {
    "type": "object",
    "properties": {
        "price": {"type": "number"}, "currency": {"type": "string", "description": "3-letter code, e.g. GEL"},
        "valid_from": {"type": "string", "description": "YYYY-MM-DD; leave out for all year"},
        "valid_to": {"type": "string", "description": "YYYY-MM-DD"},
        "min_pax": {"type": "integer", "description": "Group size band, if the price depends on it"},
        "max_pax": {"type": "integer"},
        "notes": {"type": "string"},
    },
    "required": ["price", "currency"],
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_records",
        "description": "List what already exists in the agency's CRM, to reuse records instead of proposing duplicates. "
                       "Call it before proposing suppliers, clients, routes or tours. Returns at most 300 rows; use search to narrow.",
        "input_schema": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["vendors", "clients", "routes", "tours", "calculations"]},
            "search": {"type": "string", "description": "Part of a name, code or city"}},
            "required": ["kind"]},
    },
    {
        "name": "get_vendor_prices",
        "description": "The services and prices an existing supplier already has.",
        "input_schema": {"type": "object", "properties": {"vendor_id": {"type": "string"}}, "required": ["vendor_id"]},
    },
    {
        "name": "read_sheet",
        "description": "Read more rows of an uploaded spreadsheet (the message shows only the first rows). Rows are numbered from 1.",
        "input_schema": {"type": "object", "properties": {
            "file": {"type": "string"}, "sheet": {"type": "string"},
            "start_row": {"type": "integer"}, "rows": {"type": "integer", "description": "At most 300"}},
            "required": ["file", "sheet", "start_row"]},
    },
    {
        "name": "read_document",
        "description": "Read more lines of an uploaded Word or text document (the message shows only the start). "
                       "Lines are numbered from 1; a long page is cut short, the result says where to go on.",
        "input_schema": {"type": "object", "properties": {
            "file": {"type": "string"}, "start_line": {"type": "integer"},
            "lines": {"type": "integer", "description": "At most 400"}},
            "required": ["file", "start_line"]},
    },
    {
        "name": "propose_vendors",
        "description": "Propose new suppliers (hotels, restaurants, transport, guides, drivers, activities). Returns their plan ids.",
        "input_schema": {"type": "object", "properties": {"vendors": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "type": {"type": "string", "enum": ["hotel", "restaurant", "transport", "guide", "driver", "activity", "other"]},
            "city": {"type": "string"}, "address": {"type": "string"}, "phone": {"type": "string"}, "email": {"type": "string"},
            "contact_person": {"type": "string"}, "currency": {"type": "string", "description": "Currency of their prices"},
            "notes": {"type": "string"}, "languages": {"type": "array", "items": {"type": "string"}, "description": "Guides/drivers"}},
            "required": ["name", "type"]}}}, "required": ["vendors"]},
    },
    {
        "name": "propose_prices",
        "description": "Propose services and prices for suppliers (new or existing). For an existing supplier, a service with the "
                       "same code or name gets these prices instead of its old ones; others are added. Hotel rooms use codes "
                       "room_SGL/room_DBL/room_TWN/room_TRP/room_QUAD with unit room_night (price per room per night); a "
                       "restaurant's lunch/dinner use codes lunch/dinner with unit person. A set menu: category meal, no code, dishes listed.",
        "input_schema": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
            "vendor": _REF,
            "services": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"},
                "code": {"type": "string", "enum": ["room_SGL", "room_DBL", "room_TWN", "room_TRP", "room_QUAD",
                                                    "lunch", "dinner", "day", "person", "group"]},
                "category": {"type": "string", "enum": ["hotel", "meal", "transport", "guide", "ticket", "activity", "tips", "border", "other"]},
                "unit": {"type": "string", "enum": ["room_night", "person", "vehicle_day", "day", "group", "item", "km", "litre"]},
                "notes": {"type": "string"},
                "dishes": {"type": "array", "items": {"type": "string"}},
                "rates": {"type": "array", "items": _RATE}},
                "required": ["name", "category", "unit", "rates"]}}},
            "required": ["vendor", "services"]}}}, "required": ["items"]},
    },
    {
        "name": "propose_clients",
        "description": "Propose new clients (partner agencies or direct customers).",
        "input_schema": {"type": "object", "properties": {"clients": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "type": {"type": "string", "enum": ["agency", "direct"]},
            "country": {"type": "string"}, "contact_person": {"type": "string"}, "email": {"type": "string"},
            "phone": {"type": "string"}, "notes": {"type": "string"}},
            "required": ["name"]}}}, "required": ["clients"]},
    },
    {
        "name": "propose_route",
        "description": "Propose a route: a reusable day-by-day template that tours copy.",
        "input_schema": {"type": "object", "properties": {
            "code": {"type": "string", "description": "Short code, 2-6 letters, e.g. TAK"},
            "name": {"type": "string"}, "notes": {"type": "string"},
            "color": {"type": "string", "enum": ["indigo", "emerald", "amber", "rose", "sky", "violet", "teal", "orange", "slate", "lime"]},
            "days": {"type": "array", "items": _DAY}},
            "required": ["code", "name", "days"]},
    },
    {
        "name": "propose_tours",
        "description": "Propose tours (a group travelling on given dates). Use a route, or give the days directly. "
                       "End date comes from the route or the days when left out.",
        "input_schema": {"type": "object", "properties": {"tours": {"type": "array", "items": {"type": "object", "properties": {
            "route": _REF, "days": {"type": "array", "items": _DAY},
            "code": {"type": "string", "description": "Leave out to generate one"}, "name": {"type": "string"},
            "start_date": {"type": "string", "description": "YYYY-MM-DD"}, "end_date": {"type": "string"},
            "pax": {"type": "integer", "description": "Leave out if unknown"},
            "pax_estimated": {"type": "boolean", "description": "true when the number is only a guess"}, "client": _REF,
            "rooms": {"type": "string", "description": "e.g. \"10 DBL + 2 SGL\""},
            "status": {"type": "string", "enum": ["inquiry", "confirmed"]},
            "price_pp": {"type": "number", "description": "Price per person sold to the client"},
            "price_currency": {"type": "string"}, "notes": {"type": "string"}},
            "required": ["start_date"]}}}, "required": ["tours"]},
    },
    {
        "name": "propose_participants",
        "description": "Propose the people on a tour (rooming list).",
        "input_schema": {"type": "object", "properties": {
            "tour": _REF,
            "people": {"type": "array", "items": {"type": "object", "properties": {
                "full_name": {"type": "string"}, "gender": {"type": "string", "enum": ["", "M", "F"]},
                "birth_date": {"type": "string"}, "nationality": {"type": "string"},
                "passport_number": {"type": "string"}, "passport_expiry": {"type": "string"},
                "room_type": {"type": "string", "enum": ["", "SGL", "DBL", "TWN", "TRP", "QUAD"]},
                "room_group": {"type": "string", "description": "Same value for people sharing a room"},
                "phone": {"type": "string"}, "notes": {"type": "string"}},
                "required": ["full_name"]}}},
            "required": ["tour", "people"]},
    },
    {
        "name": "propose_calculation",
        "description": "Propose a price calculation (cost and selling price per person for each group size) from a route, "
                       "new or existing. Hotels, meals and day services come from the route and are priced from the "
                       "suppliers' saved prices on prices_on; anything without a saved price stays empty for the person "
                       "to fill. Add lines only for costs the route can't know (flights, train, visas, entry tickets...).",
        "input_schema": {"type": "object", "properties": {
            "route": _REF, "name": {"type": "string", "description": "Leave out to name it after the route"},
            "prices_on": {"type": "string", "description": "YYYY-MM-DD: prices valid on this date (the season); default today"},
            "valid_to": {"type": "string", "description": "YYYY-MM-DD: last day the calculation is valid"},
            "pax_min": {"type": "integer", "description": "Smallest paying group size priced"},
            "pax_max": {"type": "integer", "description": "Largest; at most 60 sizes from pax_min"},
            "leaders": {"type": "integer", "description": "Free places (tour leaders): 1 for \"19+1\""},
            "client": _REF, "notes": {"type": "string"},
            "lines": {"type": "array", "description": "Extra costs", "items": {"type": "object", "properties": {
                "name": {"type": "string"},
                "kind": {"type": "string", "description": "hotel, meal, transport, guide, ticket, activity, tips, border, other, "
                                                          "or one of the agency's own kinds (named at the start of the conversation)"},
                "price": {"type": "number", "description": "Leave out when the source gives no price: it stays empty, to fill"},
                "currency": {"type": "string"},
                "per": {"type": "string", "enum": ["person", "group"], "description": "person = each tourist pays it; group = shared"},
                "quantity": {"type": "string", "description": "How many (a number, or \"days\"); default 1"},
                "notes": {"type": "string"}},
                "required": ["name", "kind"]}}},
            "required": ["route"]},
    },
    {
        "name": "remove_proposals",
        "description": "Take proposals out of the plan (to correct them, propose again after removing).",
        "input_schema": {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}}}, "required": ["ids"]},
    },
    {
        "name": "get_route",
        "description": "An existing route day by day (city, stops, hotel, lunch, dinner, activities, notes) with the ids of its "
                       "suppliers - read it before proposing changes to it.",
        "input_schema": {"type": "object", "properties": {
            "route": {"type": "string", "description": "The route's id or its code (e.g. HM)"}}, "required": ["route"]},
    },
    {
        "name": "propose_route_changes",
        "description": "Propose changes to an EXISTING route (never re-propose it as a new route): only the days and fields "
                       "that change. Day numbers are the route's current ones (as get_route shows them). Leave a field out to "
                       "keep it; an empty string clears a hotel, lunch or dinner.",
        "input_schema": {"type": "object", "properties": {
            "route": {"type": "string", "description": "The route's id"},
            "summary": {"type": "string", "description": "What changes, in the person's language and words, e.g. "
                                                         "\"Day 3: dinner at Barbarestan instead of Funicular\""},
            "name": {"type": "string"}, "notes": {"type": "string"},
            "changes": {"type": "array", "items": {"type": "object", "properties": {
                "day": {"type": "integer", "description": "The day's current number; for insert_after, the day the new day "
                                                          "comes after (0 = before day 1)"},
                "op": {"type": "string", "enum": ["edit", "insert_after", "remove"], "description": "Default edit"},
                "city": {"type": "string"},
                "stops": {"type": "array", "items": {"type": "string"}},
                "hotel": _REF, "lunch": _REF, "dinner": _REF,
                "lunch_mode": {"type": "string", "enum": ["included", "tourists", "own"]},
                "dinner_mode": {"type": "string", "enum": ["included", "tourists", "own"]},
                "notes": {"type": "string"}, "border_crossing": {"type": "string"},
                "km": {"type": "integer"},
                "add_extras": _DAY["properties"]["extras"],
                "remove_extras": {"type": "array", "items": {"type": "string"}, "description": "Service names to take off that day"}},
                "required": ["day"]}}},
            "required": ["route", "summary", "changes"]},
    },
]


# --- shapes the model's input must fit --------------------------------------------------------

class ExtraDraft(BaseModel):
    vendor: str
    service: str = Field(min_length=1, max_length=200)
    quantity: float | None = Field(default=None, gt=0)
    optional: bool = False


class DayDraft(BaseModel):
    city: str = Field(default="", max_length=100)
    stops: list[str] = Field(default_factory=list, max_length=8)
    lunch_mode: Literal["included", "tourists", "own"] = "included"
    dinner_mode: Literal["included", "tourists", "own"] = "included"
    flights: list[Flight] = Field(default_factory=list, max_length=6)
    hotel: str | None = None
    lunch: str | None = None
    dinner: str | None = None
    border_crossing: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=2000)
    km: int | None = Field(default=None, ge=0, le=5000)
    extras: list[ExtraDraft] = Field(default_factory=list, max_length=30)


class DayChange(BaseModel):
    day: int = Field(ge=0, le=60)
    op: Literal["edit", "insert_after", "remove"] = "edit"
    city: str | None = Field(default=None, max_length=100)
    stops: list[str] | None = Field(default=None, max_length=8)
    hotel: str | None = None              # "" clears
    lunch: str | None = None
    dinner: str | None = None
    lunch_mode: Literal["included", "tourists", "own"] | None = None
    dinner_mode: Literal["included", "tourists", "own"] | None = None
    notes: str | None = Field(default=None, max_length=2000)
    border_crossing: str | None = Field(default=None, max_length=100)
    km: int | None = Field(default=None, ge=0, le=5000)
    add_extras: list[ExtraDraft] = Field(default_factory=list, max_length=30)
    remove_extras: list[str] = Field(default_factory=list, max_length=30)


class RouteChange(BaseModel):
    route: str
    summary: str = Field(min_length=1, max_length=500)
    name: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=5000)
    changes: list[DayChange] = Field(default_factory=list, max_length=60)


class RouteDraft(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(default="", max_length=200)
    color: SeriesColor = "indigo"
    notes: str = Field(default="", max_length=5000)
    days: list[DayDraft] = Field(min_length=1, max_length=60)


class TourDraft(BaseModel):
    route: str | None = None
    days: list[DayDraft] | None = Field(default=None, max_length=60)
    code: str | None = Field(default=None, max_length=40)
    name: str | None = Field(default=None, max_length=200)
    start_date: date
    end_date: date | None = None
    pax: int = Field(default=0, ge=0, le=10000)
    pax_estimated: bool = False
    client: str | None = None
    rooms: str | None = Field(default=None, max_length=200)
    status: TourStatus = "confirmed"
    price_pp: float | None = Field(default=None, ge=0)
    price_currency: str | None = None
    notes: str | None = Field(default=None, max_length=5000)


class LineDraft(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(min_length=1, max_length=40)
    price: float | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    per: Literal["person", "group"] = "person"
    quantity: str = Field(default="1", max_length=100)
    notes: str = Field(default="", max_length=1000)


class CalcDraft(BaseModel):
    route: str
    name: str | None = Field(default=None, max_length=200)
    prices_on: date | None = None
    valid_to: date | None = None
    pax_min: int = Field(default=10, ge=1, le=500)
    pax_max: int = Field(default=25, ge=1, le=500)
    leaders: int | None = Field(default=None, ge=0, le=10)
    client: str | None = None
    notes: str = Field(default="", max_length=5000)
    lines: list[LineDraft] = Field(default_factory=list, max_length=60)


class Prices(BaseModel):
    vendor: str
    services: list[ServiceIn] = Field(min_length=1, max_length=60)


# --- running a tool ------------------------------------------------------------------------------

def run(db: Session, ctx: WorkspaceCtx, s: AiSession, name: str, args: dict) -> tuple[str, str]:
    """(result for the model, a short line for the person watching)."""
    fn = HANDLERS.get(name)
    if fn is None:
        raise ToolError(f"Unknown tool {name}")
    try:
        return fn(db, ctx, s, args)
    except ValidationError as e:
        raise ToolError(_errors(e)) from e


def _errors(e: ValidationError) -> str:
    return "Invalid: " + "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()[:12])


def _dump(x) -> str:
    return json.dumps(x, ensure_ascii=False, default=str, separators=(",", ":"))


def _list(db: Session, ctx: WorkspaceCtx, s: AiSession, a: dict):
    kind, q = a.get("kind"), (a.get("search") or "").strip().lower()
    ws = ctx.workspace.id

    def hit(*xs):
        return not q or any(q in (x or "").lower() for x in xs)
    if kind == "vendors":
        rows = [{"id": v.id, "name": v.name, "type": v.type, "city": v.city, "currency": v.currency, "services": len(v.services)}
                for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws).options(selectinload(Vendor.services))
                                    .order_by(Vendor.name)) if hit(v.name, v.city, v.type)]
    elif kind == "clients":
        rows = [{"id": c.id, "name": c.name, "type": c.type, "country": c.country}
                for c in db.scalars(select(Client).where(Client.workspace_id == ws).order_by(Client.name)) if hit(c.name, c.country)]
    elif kind == "routes":
        rows = [{"id": r.id, "code": r.code, "name": r.name, "days": len(r.days),
                 "cities": " → ".join(d.city for d in r.days if d.city)}
                for r in db.scalars(select(Series).where(Series.workspace_id == ws).options(selectinload(Series.days))
                                    .order_by(Series.code)) if hit(r.code, r.name)]
    elif kind == "tours":
        rows = [{"id": t.id, "code": t.code, "start": t.start_date, "end": t.end_date, "pax": t.pax, "status": t.status}
                for t in db.scalars(select(Tour).where(Tour.workspace_id == ws).order_by(Tour.start_date.desc())) if hit(t.code, t.name)]
    elif kind == "calculations":
        rows = [{"id": q.id, "name": q.name, "route_id": q.series_id, "currency": q.currency, "valid_to": q.valid_to, "status": q.status}
                for q in db.scalars(select(Quote).where(Quote.workspace_id == ws).order_by(Quote.updated_at.desc())) if hit(q.name)]
    else:
        raise ToolError("kind must be vendors, clients, routes, tours or calculations")
    more = f" (first 300 of {len(rows)} — search to narrow)" if len(rows) > 300 else ""
    return _dump(rows[:300]) + more, f"Looked at {kind}"


def _prices(db: Session, ctx: WorkspaceCtx, s: AiSession, a: dict):
    v = db.scalar(select(Vendor).where(Vendor.id == a.get("vendor_id"), Vendor.workspace_id == ctx.workspace.id)
                  .options(selectinload(Vendor.services)))
    if not v:
        raise ToolError("No such supplier")
    out = [{"name": x.name, "code": x.code, "category": x.category, "unit": x.unit,
            "rates": [{"price": float(r.price), "currency": r.currency, "valid_from": r.valid_from, "valid_to": r.valid_to,
                       "min_pax": r.min_pax, "max_pax": r.max_pax} for r in x.rates]} for x in v.services]
    return _dump(out), f"Looked at {v.name}'s prices"


def _sheet(db: Session, ctx: WorkspaceCtx, s: AiSession, a: dict):
    f = next((f for f in s.files if f["name"] == a.get("file") and f["kind"] == "sheet"), None)
    if not f:
        raise ToolError(f"No spreadsheet named {a.get('file')!r}; files: {[x['name'] for x in s.files]}")
    rows = f["sheets"].get(a.get("sheet"))
    if rows is None:
        raise ToolError(f"No sheet {a.get('sheet')!r}; sheets: {list(f['sheets'])}")
    start = max(1, int(a.get("start_row") or 1))
    n = max(1, min(300, int(a.get("rows") or 200)))
    part = rows[start - 1:start - 1 + n]
    end = start + len(part) - 1
    tail = f"\n(rows {start}–{end} of {len(rows)})" if part else f"(no rows from {start}; the sheet has {len(rows)})"
    return sheets.as_text(part, start) + tail, f"Reading {f['name']} · {a.get('sheet')} rows {start}–{end}"


def _document(db: Session, ctx: WorkspaceCtx, s: AiSession, a: dict):
    f = next((f for f in s.files if f["name"] == a.get("file") and f["kind"] == "doc"), None)
    if not f:
        raise ToolError(f"No document named {a.get('file')!r}; files: {[x['name'] for x in s.files]}")
    lines = f["lines"]
    start = max(1, int(a.get("start_line") or 1))
    n = docs.fit(lines[start - 1:], max(1, min(400, int(a.get("lines") or 200))), docs.PAGE_CHARS)
    part = lines[start - 1:start - 1 + n]
    end = start + len(part) - 1
    tail = f"\n(lines {start}–{end} of {len(lines)})" if part else f"(no lines from {start}; the document has {len(lines)})"
    return docs.as_text(part, start) + tail, f"Reading {f['name']} lines {start}–{end}"


# --- proposals -------------------------------------------------------------------------------------

def _next_id(s: AiSession) -> str:
    return f"p{max((int(p['id'][1:]) for p in s.plan), default=0) + 1}"


def _add(s: AiSession, kind: str, data: dict, label: str) -> str:
    live = [p for p in s.plan if p["status"] != "removed"]
    if len(live) >= PLAN_LIMIT:
        raise ToolError(f"The plan has {PLAN_LIMIT} items — ask the person to confirm these first")
    pid = _next_id(s)
    s.plan = [*s.plan, {"id": pid, "kind": kind, "data": data, "label": label, "status": "proposed", "result_id": None, "error": ""}]
    return pid


def ref(db: Session, ctx: WorkspaceCtx, s: AiSession, value: str | None, kind: str, field: str) -> str | None:
    """An existing record's id or a live plan id, of the right kind."""
    if not value:
        return None
    if PROPOSAL.match(value):
        p = next((p for p in s.plan if p["id"] == value and p["status"] != "removed"), None)
        if not p or p["kind"] != kind:
            raise ToolError(f"{field}: {value} is not a proposed {kind}")
        return value
    model = MODEL_OF[kind]
    if not db.scalar(select(model.id).where(model.id == value, model.workspace_id == ctx.workspace.id)):
        raise ToolError(f"{field}: no {kind} with id {value} (use list_records, or a plan id)")
    return value


def _check_days(db, ctx, s, days: list[DayDraft], where: str) -> list[dict]:
    for i, d in enumerate(days, 1):
        for slot in ("hotel", "lunch", "dinner"):
            ref(db, ctx, s, getattr(d, slot), "vendor", f"{where} day {i} {slot}")
        for x in d.extras:
            ref(db, ctx, s, x.vendor, "vendor", f"{where} day {i} extras")
    return [d.model_dump(mode="json") for d in days]


def _vendors(db, ctx, s, a):
    # Check the whole batch first: one bad item adds nothing, so the batch can simply be resent.
    batch = [VendorCreate.model_validate(v).model_dump(mode="json", exclude_none=True) for v in a.get("vendors") or []]
    made = [{"id": _add(s, "vendor", d, f"{d['name']} · {d['type']}{' · ' + d['city'] if d.get('city') else ''}"), "name": d["name"]}
            for d in batch]
    if not made:
        raise ToolError("No vendors given")
    return _dump(made), f"Proposed {len(made)} supplier{'s' if len(made) != 1 else ''}"


def _price_items(db, ctx, s, a):
    checked = []
    for item in a.get("items") or []:
        p = Prices.model_validate(item)
        ref(db, ctx, s, p.vendor, "vendor", "vendor")
        codes = [x.code for x in p.services if x.code]
        if len(codes) != len(set(codes)):
            raise ToolError(f"{p.vendor}: each code (e.g. room_DBL) once per supplier")
        for x in p.services:
            if bad := catalog.conflicts(x.rates):
                raise ToolError(f"{x.name!r}: price rows {bad[0][0] + 1} and {bad[0][1] + 1} overlap (same dates and group size)")
        checked.append(p)
    made = [_add(s, "prices", {"vendor": p.vendor, "services": [x.model_dump(mode="json", exclude={"id"}) for x in p.services]},
                 f"{len(p.services)} price{'s' if len(p.services) != 1 else ''} for {_name(db, s, p.vendor)}") for p in checked]
    if not made:
        raise ToolError("No items given")
    return _dump(made), f"Proposed prices for {len(made)} supplier{'s' if len(made) != 1 else ''}"


def _clients(db, ctx, s, a):
    batch = [ClientCreate.model_validate(c).model_dump(mode="json", exclude_none=True) for c in a.get("clients") or []]
    made = [{"id": _add(s, "client", d, d["name"]), "name": d["name"]} for d in batch]
    if not made:
        raise ToolError("No clients given")
    return _dump(made), f"Proposed {len(made)} client{'s' if len(made) != 1 else ''}"


def _route(db, ctx, s, a):
    r = RouteDraft.model_validate(a)
    data = r.model_dump(mode="json")
    data["code"] = r.code.strip().upper()
    data["days"] = _check_days(db, ctx, s, r.days, "route")
    taken = db.scalar(select(Series.id).where(Series.workspace_id == ctx.workspace.id, Series.code == data["code"]))
    if taken or any(p["kind"] == "route" and p["status"] == "proposed" and p["data"]["code"] == data["code"] for p in s.plan):
        raise ToolError(f"Route code {data['code']} is already used — pick another")
    pid = _add(s, "route", data, f"{data['code']} · {r.name} · {len(r.days)} days")
    return _dump({"id": pid}), f"Proposed route {data['code']}"


def _tours(db, ctx, s, a):
    checked = []
    for t in a.get("tours") or []:
        d = TourDraft.model_validate(t)
        if d.route and d.days:
            raise ToolError("Give a route or days, not both")
        ref(db, ctx, s, d.route, "route", "route")
        ref(db, ctx, s, d.client, "client", "client")
        data = d.model_dump(mode="json", exclude_none=True)
        if d.days:
            data["days"] = _check_days(db, ctx, s, d.days, "tour")
            end = d.start_date + timedelta(days=len(d.days) - 1)
            if d.end_date and d.end_date != end:
                raise ToolError(f"{len(d.days)} days from {d.start_date} end on {end}, not {d.end_date}")
            data["end_date"] = end.isoformat()
        elif not d.route and not d.end_date:
            raise ToolError("A tour without a route or days needs an end_date")
        if d.end_date and d.end_date < d.start_date:
            raise ToolError("end_date is before start_date")
        title = d.code or d.name or (_name(db, s, d.route) if d.route else "") or "Tour"
        checked.append((data, f"{title} · {d.start_date}{f' · {d.pax} pax' if d.pax else ''}"))
    made = [_add(s, "tour", data, label) for data, label in checked]
    if not made:
        raise ToolError("No tours given")
    return _dump(made), f"Proposed {len(made)} tour{'s' if len(made) != 1 else ''}"


def _calculation(db, ctx, s, a):
    d = CalcDraft.model_validate(a)
    ref(db, ctx, s, d.route, "route", "route")
    ref(db, ctx, s, d.client, "client", "client")
    if d.pax_max < d.pax_min or d.pax_max - d.pax_min > 60:
        raise ToolError("pax_max must be at least pax_min, at most 60 sizes apart")
    if d.prices_on and d.valid_to and d.valid_to < d.prices_on:
        raise ToolError("valid_to is before prices_on")
    own = {k.id for k in CalcStyle.model_validate(ctx.workspace.calc_style or {}).kinds}
    for x in d.lines:
        if x.kind not in BUILT_IN_KINDS and x.kind not in own:
            raise ToolError(f"line {x.name!r}: kind {x.kind!r} is unknown; use one of {sorted(BUILT_IN_KINDS | own)}")
        if x.price is not None and not x.currency:
            raise ToolError(f"line {x.name!r}: a price needs its currency")
    data = d.model_dump(mode="json", exclude_none=True)
    title = d.name or _name(db, s, d.route) or "Calculation"
    pid = _add(s, "calculation", data, f"{title} · {d.pax_min}–{d.pax_max} pax"
                                       f"{f' + {d.leaders} free' if d.leaders else ''}")
    return _dump({"id": pid}), f"Proposed a calculation for {title}"


def _people(db, ctx, s, a):
    tour = ref(db, ctx, s, a.get("tour"), "tour", "tour")
    if not tour:
        raise ToolError("tour is required")
    people = [ParticipantIn.model_validate(p).model_dump(mode="json", exclude_none=True) for p in a.get("people") or []]
    if not people:
        raise ToolError("No people given")
    if len(people) > 500:
        raise ToolError("At most 500 people per proposal")
    pid = _add(s, "participants", {"tour": tour, "people": people}, f"{len(people)} people on {_name(db, s, tour)}")
    return _dump({"id": pid}), f"Proposed {len(people)} participants"


def _remove(db, ctx, s, a):
    ids = set(a.get("ids") or [])
    found = [p["id"] for p in s.plan if p["id"] in ids and p["status"] == "proposed"]
    s.plan = [{**p, "status": "removed"} if p["id"] in found else p for p in s.plan]
    return _dump({"removed": found}), f"Removed {len(found)} from the plan"


def _name(db: Session, s: AiSession, value: str) -> str:
    """A readable name for a reference, for labels."""
    if PROPOSAL.match(value):
        p = next((p for p in s.plan if p["id"] == value), None)
        return (p["data"].get("name") or p["data"].get("code") or p["label"]) if p else value
    for model in (Vendor, Tour, Client, Series):
        x = db.get(model, value)
        if x is not None:
            return getattr(x, "name", None) or getattr(x, "code", value)
    return value


def _find_route(db: Session, ctx: WorkspaceCtx, value: str) -> Series:
    v = (value or "").strip()
    r = db.scalar(select(Series).where(Series.workspace_id == ctx.workspace.id, Series.id == v)) or \
        db.scalar(select(Series).where(Series.workspace_id == ctx.workspace.id, Series.code == v.upper()))
    if r is None:
        raise ToolError(f"No route {value!r} - use list_records kind=routes to find it")
    return r


def _get_route(db, ctx, s, a):
    r = _find_route(db, ctx, a.get("route", ""))
    vendor = {v.id: v.name for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ctx.workspace.id))}
    services = {x.id: (x.name, vendor.get(x.vendor_id, "")) for x in
                db.scalars(select(Service).join(Vendor, Vendor.id == Service.vendor_id).where(Vendor.workspace_id == ctx.workspace.id))}

    def who(i):
        return {"id": i, "name": vendor.get(i, "?")} if i else None
    days = [{"day": d.day_number, "city": d.city, "stops": d.stops or [], "hotel": who(d.hotel_id), "lunch": who(d.lunch_id),
             "lunch_mode": d.lunch_mode, "dinner": who(d.dinner_id), "dinner_mode": d.dinner_mode, "km": d.km, "notes": d.notes,
             "border_crossing": d.border_crossing, "flights": d.flights or [],
             "activities": [{"service": services.get(x.get("service_id"), ("?", ""))[0], "at": services.get(x.get("service_id"), ("", "?"))[1],
                             "optional": bool(x.get("optional"))} for x in (d.extras or [])],
             "timeline_steps": len(d.schedule or [])} for d in r.days]
    return _dump({"id": r.id, "code": r.code, "name": r.name, "notes": r.notes, "days": days}), f"Read route {r.code}"


def _route_change(db, ctx, s, a):
    c = RouteChange.model_validate(a)
    r = _find_route(db, ctx, c.route)
    n = len(r.days)
    for x in c.changes:
        if x.op == "insert_after" and not 0 <= x.day <= n or x.op != "insert_after" and not 1 <= x.day <= n:
            raise ToolError(f"Route {r.code} has days 1-{n}: day {x.day} is not one of them")
        for slot in ("hotel", "lunch", "dinner"):
            if getattr(x, slot):
                ref(db, ctx, s, getattr(x, slot), "vendor", f"day {x.day} {slot}")
        for e in x.add_extras:
            ref(db, ctx, s, e.vendor, "vendor", f"day {x.day} activities")
    if not c.changes and c.name is None and c.notes is None:
        raise ToolError("Nothing to change")
    data = c.model_dump(mode="json")
    data["route"], data["code"] = r.id, r.code
    # Existing suppliers by name, so the plan reads "dinner: Barbarestan", not an id.
    ids = {getattr(x, k) for x in c.changes for k in ("hotel", "lunch", "dinner") if getattr(x, k) and not PROPOSAL.match(getattr(x, k))}
    data["names"] = {v.id: v.name for v in db.scalars(select(Vendor).where(Vendor.id.in_(ids)))} if ids else {}
    pid = _add(s, "route_change", data, f"{r.code} · {c.summary}")
    return _dump({"id": pid}), f"Proposed changes to {r.code}"


HANDLERS = {
    "get_route": _get_route, "propose_route_changes": _route_change,
    "list_records": _list, "get_vendor_prices": _prices, "read_sheet": _sheet, "read_document": _document,
    "propose_vendors": _vendors, "propose_prices": _price_items, "propose_clients": _clients,
    "propose_route": _route, "propose_tours": _tours, "propose_participants": _people, "remove_proposals": _remove,
    "propose_calculation": _calculation,
}
Kind = Literal["vendor", "prices", "client", "route", "tour", "participants"]
