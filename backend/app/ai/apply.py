"""Saving the proposals a person confirmed — through the same functions the app's forms call,
so every rule (permissions, codes, overlapping prices, closed tours) applies exactly as by hand.

Each proposal is saved on its own: one that fails (say, a tour code taken since) is marked with
the reason and the rest go on. Proposals that point at other proposals ("prices for p3") need
those saved first — the order below takes care of that when both are confirmed together.
"""
from datetime import date

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import WorkspaceCtx
from ..models import AiSession, Quote, Service, Vendor
from ..quote_schemas import CalcStyle, QuoteIn, QuoteItemIn
from ..routers import catalog as catalog_api, people, pricing, quotes, series, tours
from ..routers.pricing import ServiceIn
from ..schemas import ClientCreate, DayFields, ParticipantIn, SeriesIn, TourCreate, VendorCreate
from .tools import PROPOSAL

ORDER = ["vendor", "client", "prices", "route", "calculation", "tour", "participants"]


class Skip(Exception):
    pass


def apply(db: Session, ctx: WorkspaceCtx, s: AiSession, ids: list[str]) -> list[dict]:
    wanted = set(ids)
    plan = [dict(p) for p in s.plan]
    by_id = {p["id"]: p for p in plan}

    def resolve(value: str | None) -> str | None:
        if not value or not PROPOSAL.match(value):
            return value
        p = by_id.get(value)
        if not p or p["status"] != "applied":
            raise Skip(f"needs {value} ({p['label'] if p else 'unknown'}) to be saved first")
        return p["result_id"]

    for kind in ORDER:
        for p in plan:
            if p["kind"] != kind or p["id"] not in wanted or p["status"] not in ("proposed", "failed"):
                continue
            try:
                p["result_id"] = SAVE[kind](db, ctx, p["data"], resolve)
                p["status"], p["error"] = "applied", ""
            except Skip as e:
                db.rollback()
                p["status"], p["error"] = "failed", str(e)
            except HTTPException as e:
                db.rollback()
                p["status"], p["error"] = "failed", str(e.detail)
            except ValidationError as e:
                db.rollback()
                p["status"], p["error"] = "failed", "; ".join(err["msg"] for err in e.errors()[:3])
    s.plan = plan
    db.commit()
    return plan


def _vendor(db, ctx, d, resolve):
    return catalog_api.create_vendor(VendorCreate.model_validate(d), ctx=ctx, db=db).id


def _client(db, ctx, d, resolve):
    return catalog_api.create_client(ClientCreate.model_validate(d), ctx=ctx, db=db).id


def _prices(db, ctx, d, resolve):
    vendor_id = resolve(d["vendor"])
    v = db.get(Vendor, vendor_id)
    current = [ServiceIn(id=x.id, code=x.code, name=x.name, category=x.category, unit=x.unit, notes=x.notes,
                         dishes=x.dishes or [], is_active=x.is_active,
                         rates=[{"id": r.id, "valid_from": r.valid_from, "valid_to": r.valid_to, "min_pax": r.min_pax,
                                 "max_pax": r.max_pax, "price": r.price, "currency": r.currency, "notes": r.notes}
                                for r in x.rates]) for x in v.services]
    for new in (ServiceIn.model_validate(x) for x in d["services"]):
        # Same code, or same name: this service's prices are replaced; otherwise it's added.
        i = next((i for i, c in enumerate(current) if (new.code and c.code == new.code)
                  or c.name.strip().lower() == new.name.strip().lower()), None)
        if i is None:
            current.append(new)
        else:
            current[i] = new.model_copy(update={"id": current[i].id})
    pricing.save_services(vendor_id, current, ctx=ctx, db=db)
    return vendor_id


def _days(db, ctx, days: list[dict], resolve) -> list[DayFields]:
    out = []
    for d in days:
        extras = []
        for x in d.get("extras") or []:
            vid = resolve(x["vendor"])
            svc = next((s for s in db.scalars(select(Service).where(Service.vendor_id == vid))
                        if s.name.strip().lower() == x["service"].strip().lower()), None)
            if svc is None:
                raise Skip(f"no service {x['service']!r} at {db.get(Vendor, vid).name} — save its prices first")
            extras.append({"service_id": svc.id, "quantity": x.get("quantity"), "notes": "", "optional": bool(x.get("optional"))})
        out.append(DayFields(city=d.get("city") or "", stops=d.get("stops") or [],
                             lunch_mode=d.get("lunch_mode") or "included", dinner_mode=d.get("dinner_mode") or "included",
                             flights=d.get("flights") or [], hotel_id=resolve(d.get("hotel")), lunch_id=resolve(d.get("lunch")),
                             dinner_id=resolve(d.get("dinner")), border_crossing=d.get("border_crossing") or "",
                             notes=d.get("notes") or "", km=d.get("km"), extras=extras))
    return out


def _route(db, ctx, d, resolve):
    body = SeriesIn(code=d["code"], name=d.get("name") or "", color=d.get("color") or "indigo", notes=d.get("notes") or "",
                    days=_days(db, ctx, d["days"], resolve))
    return series.create_series(body, ctx=ctx, db=db).id


def _tour(db, ctx, d, resolve):
    body = TourCreate(series_id=resolve(d.get("route")), client_id=resolve(d.get("client")), code=d.get("code"),
                      name=d.get("name"), start_date=date.fromisoformat(d["start_date"]),
                      end_date=date.fromisoformat(d["end_date"]) if d.get("end_date") else None,
                      pax=d.get("pax", 0), pax_estimated=d.get("pax_estimated", False), rooms=d.get("rooms"), status=d.get("status", "confirmed"),
                      price_pp=d.get("price_pp"), price_currency=d.get("price_currency"), notes=d.get("notes"))
    days = _days(db, ctx, d["days"], resolve) if d.get("days") else None    # before creating: a missing service skips cleanly
    t = tours.create_tour(body, ctx=ctx, db=db)
    if days:
        tours.save_itinerary(t.id, tours.ItineraryIn(days=days), ctx=ctx, db=db)
    return t.id


def _calculation(db, ctx, d, resolve):
    """Made exactly like "New calculation → from a route" (the agency's way, prices on that date), then the
    group sizes, free places and extra lines. Lines without a price stay empty: "to fill"."""
    route_id, client_id = resolve(d["route"]), resolve(d.get("client"))
    own = {k.id: k for k in CalcStyle.model_validate(ctx.workspace.calc_style or {}).kinds}
    currency = ctx.workspace.base_currency
    lines = []
    for x in d.get("lines") or []:
        kind = own.get(x["kind"])
        lines.append(QuoteItemIn(
            name=x["name"], category=kind.base if kind else x["kind"], kind=kind.id if kind else None,
            currency=x.get("currency") or currency, unit_price=x.get("price") or 0, quantity=x.get("quantity") or "1",
            basis="per_person" if x.get("per", "person") == "person" else "group", notes=x.get("notes") or ""))
    made = quotes.create_quote(quotes.QuoteCreate(preset="blank", series_id=route_id, name=d.get("name"),
                                                  on_date=date.fromisoformat(d["prices_on"]) if d.get("prices_on") else None),
                               ctx=ctx, db=db)
    q = db.get(Quote, made.id)
    doc = quotes.doc_of(q)
    doc.pax_min, doc.pax_max = d.get("pax_min", doc.pax_min), d.get("pax_max", doc.pax_max)
    if d.get("leaders") is not None:
        doc.leaders = d["leaders"]
        free = next((p for p in doc.people if p.role == "free" and p.count is not None), None)
        if free:
            free.count, free.per = d["leaders"], None
    if d.get("valid_to"):
        doc.valid_to = date.fromisoformat(d["valid_to"])
    doc.client_id = client_id or doc.client_id
    doc.notes = d.get("notes") or doc.notes
    doc.items = [*doc.items, *lines]
    doc = QuoteIn.model_validate(doc.model_dump())
    quotes.save_doc(db, q, doc, ctx.user.id, "assistant")
    db.commit()
    return q.id


def _participants(db, ctx, d, resolve):
    tour_id = resolve(d["tour"])
    for person in d["people"]:
        people.add_participant(tour_id, ParticipantIn.model_validate(person), ctx=ctx, db=db)
    return tour_id


SAVE = {"vendor": _vendor, "client": _client, "prices": _prices, "route": _route, "calculation": _calculation, "tour": _tour,
        "participants": _participants}
