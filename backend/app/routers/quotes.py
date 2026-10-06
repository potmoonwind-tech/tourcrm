"""Tour price calculations: edit, preview, price lists, and turning a quote into a tour.

Manager and up (prices and margins). A quote is one JSON document validated by
QuoteIn; every vendor / route / client id inside it is checked to belong to the
workspace before saving, like any other link in the app.
"""
import io
import uuid
import re
from types import SimpleNamespace
from datetime import date, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import finance, route_build, schedule
from ..db import get_db
from ..xlsx_safe import defuse
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import utcnow, Client, Invoice, InvoiceLine, Quote, QuoteScenario, QuoteVersion, Series, Service, Tour, Vendor
from ..quote_diff import apply_patch, diff_docs, price_impact
from ..quote_engine import breakdown, check_formula, compute, in_season, people_for, price_range, season_on
from ..quote_presets import PRESETS, PRICE_LIST_LABELS
from ..quote_schemas import (
    CalcStyle,
    CostKind,
    SavedFormula,
    Breakdown, CompareOut, FormulaCheck, FormulaCheckIn, QuoteIn, QuoteItemIn, QuoteNightIn, QuoteOut, QuoteResult, QuoteSummary,
    ScenarioIn, ScenarioOut, ScenarioResult, VersionDiff, VersionOut,
)
from ..schemas import TourStatus
from ..scoping import check_refs, get_owned
from .budget import take_budget
from .tours import _code_taken, _generate_code, sync_days

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["quotes"])
can_ope_sal_fin = require_jobs('operations', 'sales', 'finance')
can_ope_sal = require_jobs('operations', 'sales')


# --- helpers -------------------------------------------------------------------------------

def doc_of(q: Quote) -> QuoteIn:
    return QuoteIn.model_validate(q.doc)


def _check_refs(db: Session, ctx: WorkspaceCtx, body: QuoteIn) -> None:
    check_refs(db, ctx, {"series_id": (Series, body.series_id), "client_id": (Client, body.client_id)})
    vendor_ids = {x.vendor_id for x in [*body.nights, *body.items] if x.vendor_id}
    for vid in vendor_ids:
        check_refs(db, ctx, {"vendor_id": (Vendor, vid)})
    service_ids = {x.service_id for x in body.items if x.service_id}
    if service_ids:
        found = set(db.scalars(select(Service.id).join(Vendor)
                               .where(Service.id.in_(service_ids), Vendor.workspace_id == ctx.workspace.id)))
        if service_ids - found:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "service_id: unknown service")


def _store(q: Quote, body: QuoteIn) -> None:
    q.doc = body.model_dump(mode="json")
    q.name, q.status, q.series_id, q.client_id = body.name, body.status, body.series_id, body.client_id
    q.currency, q.valid_from, q.valid_to = body.currency, body.valid_from, body.valid_to


def _latest_version(db: Session, q: Quote) -> int:
    return db.scalar(select(func.max(QuoteVersion.number)).where(QuoteVersion.quote_id == q.id)) or 0


AUTOSAVE_WINDOW = timedelta(minutes=10)


def _last_version(db: Session, q: Quote) -> QuoteVersion | None:
    return db.scalar(select(QuoteVersion).where(QuoteVersion.quote_id == q.id).order_by(QuoteVersion.number.desc()).limit(1))


def save_doc(db: Session, q: Quote, body: QuoteIn, user_id: str | None, note: str = "", autosave: bool = False) -> bool:
    """Store a new state of the calculation and, if anything changed, a version for it.

    Saved by itself while someone edits (autosave): the changes of one sitting go into one version - the
    same person's unnamed version from the last 10 minutes is brought up to date instead of adding one per
    keystroke. A named save always keeps its own version; the first version (how it began) is never changed.
    A named save with nothing new names the latest version."""
    changed = q.doc is None or bool(diff_docs(doc_of(q), body))
    _store(q, body)
    if changed:
        db.flush()  # q.id for a new quote
        last = _last_version(db, q)
        if autosave and not note and last and last.number > 1 and not last.note and last.created_by_id == user_id:
            at = last.created_at if last.created_at.tzinfo else last.created_at.replace(tzinfo=timezone.utc)
            if utcnow() - at < AUTOSAVE_WINDOW:
                last.doc = q.doc
                # Changed and then changed back in the same sitting: nothing to keep.
                prev = db.scalar(select(QuoteVersion).where(QuoteVersion.quote_id == q.id, QuoteVersion.number == last.number - 1))
                if prev and not diff_docs(QuoteIn.model_validate(prev.doc), body):
                    db.delete(last)
                return changed
        db.add(QuoteVersion(quote_id=q.id, number=_latest_version(db, q) + 1, doc=q.doc,
                            note=note[:300], created_by_id=user_id))
    elif note:
        last = _last_version(db, q)
        if last and not last.note:
            last.note = note[:300]
    return changed


def _out(q: Quote, db: Session) -> QuoteOut:
    body = doc_of(q)
    return QuoteOut(**body.model_dump(), id=q.id, updated_at=q.updated_at, version=_latest_version(db, q),
                    result=compute(body))


def _get(db: Session, ctx: WorkspaceCtx, quote_id: str) -> Quote:
    return get_owned(db, ctx, Quote, quote_id)


# --- CRUD ------------------------------------------------------------------------------------

@router.get("/quote-presets")
def presets(ctx: WorkspaceCtx = Depends(can_ope_sal_fin)):
    return [{"key": k, "name": f().name} for k, f in PRESETS.items()]


@router.get("/quotes", response_model=list[QuoteSummary])
def list_quotes(ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    tours = dict(db.execute(select(Tour.quote_id, func.count()).where(Tour.workspace_id == ctx.workspace.id,
                                                                     Tour.quote_id.is_not(None)).group_by(Tour.quote_id)).all())
    rows = db.scalars(select(Quote).where(Quote.workspace_id == ctx.workspace.id)
                      .options(selectinload(Quote.series), selectinload(Quote.client))
                      .order_by(Quote.updated_at.desc())).all()
    out = []
    for q in rows:
        d = q.doc
        try:
            rng = price_range(QuoteIn.model_validate(d))
        except (ValueError, ArithmeticError):
            rng = None
        out.append(QuoteSummary(
            price_from=rng[0] if rng else None, price_to=rng[1] if rng else None,
            id=q.id, name=q.name, status=q.status, series_id=q.series_id, series_code=q.series.code if q.series else None,
            series_color=q.series.color if q.series else None, client_name=q.client.name if q.client else None,
            days=d["days"], pax_min=d["pax_min"], pax_max=d["pax_max"], leaders=_free_at(d), currency=q.currency,
            valid_from=q.valid_from, valid_to=q.valid_to, updated_at=q.updated_at, tours=tours.get(q.id, 0)))
    return out


class QuoteCreate(BaseModel):
    preset: str | None = "blank"
    copy_of: str | None = None
    scenario_id: str | None = None  # with copy_of: the copy takes that scenario's changes
    name: str | None = Field(default=None, max_length=200)
    # From a route: hotels, meals and day services priced from the catalog for this date.
    series_id: str | None = None
    on_date: date | None = None
    # From a tour (tours first): its own days — hotels as changed on the tour, meals, services — on
    # its dates, for its group size. The calculation can then be given to the tour ("apply").
    tour_id: str | None = None


@router.post("/quotes", response_model=QuoteOut, status_code=status.HTTP_201_CREATED)
def create_quote(body: QuoteCreate, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    note = f"preset:{body.preset}"
    if body.copy_of:
        source = _get(db, ctx, body.copy_of)
        src = doc_of(source)
        note = f"copy:{source.name}"
        if body.scenario_id:
            sc = _scenario(db, source, body.scenario_id)
            src, _ = apply_patch(src, ScenarioIn.model_validate({"name": sc.name, "patch": sc.patch}).patch)
            note = f"scenario:{sc.name}"
        src.name, src.status = body.name or f"{src.name} (copy)", "draft"
    else:
        if body.preset not in PRESETS:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown preset")
        src = PRESETS[body.preset]()
        if body.name:
            src.name = body.name
        if body.preset == "blank":  # a fresh calculation prices in the agency's own currency, its own way
            src.currency = ctx.workspace.base_currency
            for i in src.items:      # the empty placeholders (guide, bus…) too: no rate needed for a 0
                i.currency = src.currency
            style_into(src, ctx.workspace.calc_style)
    warnings: list[str] = []
    tour = None
    if body.tour_id and not body.copy_of:
        tour = db.scalar(select(Tour).where(Tour.id == body.tour_id, Tour.workspace_id == ctx.workspace.id)
                         .options(selectinload(Tour.days), selectinload(Tour.series)))
        if tour is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    if (body.series_id or tour is not None) and not body.copy_of:
        if tour is not None:
            # The tour's own days stand in for a route (same fields); its route's guide plan still prices guides.
            route = SimpleNamespace(id=tour.series_id, workspace_id=tour.workspace_id, code=tour.code,
                                    name=body.name or tour.code, days=sorted(tour.days, key=lambda d: d.day_number),
                                    staff_plan=tour.series.staff_plan if tour.series else [])
            on = tour.start_date
        else:
            route = _route(db, ctx, body.series_id)
            on = body.on_date or date.today()
        built = route_build.build(db, route, src, on)
        # Keep the preset's lines the route can't know (guide, bus) — unless the route has them already;
        # drop its placeholder meals.
        covered = {i.category for i in built.items if i not in built.staff}
        per_day = {i.category for i in built.staff}     # the route's guides replace "Guide × days" only
        keep = [i for i in src.items if i.standard or (i.category not in ("meal", "hotel") and i.category not in covered
                and not (i.category in per_day and i.quantity.strip() == "days"))]
        if src.transport is not None:
            # The vehicles come from the plan: the route's own bus lines would count them twice;
            # the plan's distance is the route's road km.
            built.items = [i for i in built.items if not (i.category == "transport" and i.day is None)]
            if not src.transport.km:
                src.transport.km = Decimal(sum(d.km or 0 for d in route.days))
        back = (tour.bus_return if tour is not None else getattr(route, "bus_return", None)) or {}
        if back:
            if src.transport is not None:
                src.transport.km += Decimal(back.get("km") or 0)
                if back.get("on") == "next":
                    src.transport.extra_days += 1
            if "bus_extra_days" in src.variables:   # the agency's own "empty bus days" input
                src.variables["bus_extra_days"] = Decimal(1 if back.get("on") == "next" else 0)
        fx = {**suggested_fx(db, ctx, src.currency, _used_currencies(built.nights, built.items)), **src.fx}
        src = QuoteIn.model_validate({
            **src.model_dump(), "fx": fx, "series_id": route.id, "days": max(1, len(route.days)), "valid_from": on,
            "valid_to": src.valid_to if src.valid_to and src.valid_to >= on else None,
            "nights": [n.model_dump() for n in built.nights], "items": [i.model_dump() for i in built.items + keep]})
        if tour is not None:
            src.name = body.name or tour.code
            if tour.leaders:
                src.leaders = min(tour.leaders, 10)        # the group's own free leaders (19+1)
                free = next((p for p in src.people if p.role == "free" and p.count is not None), None)
                if free:
                    free.count, free.per = tour.leaders, None
            # The group must be inside the calculation's sizes, or it can't be given to the tour.
            tourists = src.tourists_in(tour.pax) or 0
            if tourists:
                src.pax_min, src.pax_max = min(src.pax_min, tourists), max(src.pax_max, tourists)
            note, warnings = f"tour:{tour.code}", built.warnings
        else:
            if not body.name:
                named = route.name.split()[0].strip("·-:").upper() == route.code if route.name else False   # "ZK · Georgia…"
                src.name = (route.name if named else f"{route.code} · {route.name}") if route.name else route.code
            note, warnings = f"route:{route.code}", built.warnings
    q = Quote(workspace_id=ctx.workspace.id)
    db.add(q)
    save_doc(db, q, src, ctx.user.id, note)
    db.commit()
    out = _out(q, db)
    out.notices = warnings
    return out


def style_into(src: QuoteIn, style: dict | None) -> None:
    """Start a calculation the agency's own way (its people and recipe), when it saved one."""
    if not style:
        return
    st = CalcStyle.model_validate(style)
    src.people, src.recipe, src.single_profit = st.people, st.recipe, st.single_profit
    if st.transport:
        src.transport = st.transport.model_copy(update={"km": Decimal(0), "fixed": []})
        src.items = [i for i in src.items if i.category != "transport"]   # the plan replaces the placeholder bus
    if st.items:
        # The agency's standard lines (tips, water, border…), each a new line of this calculation.
        src.items += [i.model_copy(update={"id": uuid.uuid4().hex[:12]}) for i in st.items]
    src.variables = {**src.variables, **st.variables}
    src.variable_notes = {**src.variable_notes, **st.variable_notes}


@router.get("/calc-style", response_model=CalcStyle)
def get_style(ctx: WorkspaceCtx = Depends(can_ope_sal_fin)):
    return CalcStyle.model_validate(ctx.workspace.calc_style or {})


@router.put("/calc-style", response_model=CalcStyle)
def put_style(body: CalcStyle, ctx: WorkspaceCtx = Depends(require_jobs('operations')), db: Session = Depends(get_db)):
    """Save "our way" (nothing in it: back to the app's defaults). The agency's kinds of cost are kept
    unless the body sends them."""
    old = CalcStyle.model_validate(ctx.workspace.calc_style or {})
    if "kinds" not in body.model_fields_set:
        body.kinds = old.kinds
    if "formulas" not in body.model_fields_set:
        body.formulas = old.formulas
    keep = body.people or body.recipe or body.transport or body.items or body.kinds or body.formulas
    ctx.workspace.calc_style = body.model_dump(mode="json") if keep else None
    db.commit()
    return body


@router.put("/calc-style/formulas", response_model=CalcStyle)
def put_formulas(body: list[SavedFormula], ctx: WorkspaceCtx = Depends(require_jobs('operations', 'sales')), db: Session = Depends(get_db)):
    """The agency's formula library: formulas it reuses across calculations."""
    style = CalcStyle.model_validate(ctx.workspace.calc_style or {})
    style.formulas = body
    ctx.workspace.calc_style = style.model_dump(mode="json")
    db.commit()
    return style


@router.put("/calc-style/kinds", response_model=CalcStyle)
def put_kinds(body: list[CostKind], ctx: WorkspaceCtx = Depends(require_jobs('operations', 'sales')), db: Session = Depends(get_db)):
    """The agency's own kinds of cost (Flight, Train, Visa…), shared by all its calculations."""
    if len({k.id for k in body}) != len(body):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Two kinds have the same id")
    style = CalcStyle.model_validate(ctx.workspace.calc_style or {})
    style.kinds = body
    ctx.workspace.calc_style = style.model_dump(mode="json")
    db.commit()
    return style


@router.get("/quotes/{quote_id}", response_model=QuoteOut)
def get_quote(quote_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    return _out(_get(db, ctx, quote_id), db)


@router.put("/quotes/{quote_id}", response_model=QuoteOut)
def save_quote(quote_id: str, body: QuoteIn, note: str = Query(default="", max_length=300), autosave: bool = False,
               ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    q = _get(db, ctx, quote_id)
    _check_refs(db, ctx, body)
    save_doc(db, q, body, ctx.user.id, note, autosave)
    db.commit()
    db.refresh(q)
    return _out(q, db)


@router.delete("/quotes/{quote_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_quote(quote_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    db.delete(_get(db, ctx, quote_id))  # tours keep existing; their link is cleared
    db.commit()


# --- live preview (nothing saved) ---------------------------------------------------------------

@router.post("/quotes/preview", response_model=QuoteResult)
def preview(body: QuoteIn, ctx: WorkspaceCtx = Depends(can_ope_sal)):
    return compute(body)


@router.post("/quotes/preview/breakdown", response_model=Breakdown)
def preview_breakdown(body: QuoteIn, tourists: int, season: str | None = None, ctx: WorkspaceCtx = Depends(can_ope_sal)):
    if not body.pax_min <= tourists <= body.pax_max:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Group size outside the calculation range")
    return breakdown(in_season(body, season) if season and any(s.id == season for s in body.seasons) else body, tourists)


@router.post("/quotes/preview/formula", response_model=FormulaCheck)
def preview_formula(body: FormulaCheckIn, ctx: WorkspaceCtx = Depends(can_ope_sal)):
    """Live help while typing a quantity formula."""
    return check_formula(body.doc, body.expression, body.tourists)


# --- build from a route and the price catalog -------------------------------------------------

class RouteFill(BaseModel):
    series_id: str
    on_date: date | None = None   # travel start: which season's prices (default: today)
    meals: bool = True            # meal lines from the route's lunches/dinners
    extras: bool = True           # lines for the services planned on each day
    # The calculation being filled: currency for unpriced lines, group sizes for price bands.
    currency: str = "USD"
    pax_min: int = Field(default=10, ge=1, le=500)
    pax_max: int = Field(default=25, ge=1, le=500)
    pax: int | None = Field(default=None, ge=1, le=500)  # group size for hotel group rates (nights have one price)


class RouteFillOut(BaseModel):
    days: int
    nights: list[QuoteNightIn]
    items: list[QuoteItemIn]
    fx: dict[str, Decimal]        # rates from Settings for the currencies used (the editor adds missing ones)
    warnings: list[str]


def suggested_fx(db: Session, ctx: WorkspaceCtx, quote_currency: str, currencies: set[str]) -> dict[str, Decimal]:
    """Calculation rates (units of X per 1 quote currency) from the workspace's
    exchange rates (1 X = rate base), for the currencies the lines use."""
    table = finance.rates(db, ctx.workspace)
    q_rate = table.get(quote_currency)
    out = {}
    for cur in currencies - {quote_currency}:
        if q_rate and table.get(cur):
            out[cur] = (q_rate / table[cur]).quantize(Decimal("0.000001"))
    return out


def _used_currencies(nights, items) -> set[str]:
    return {x.currency for x in [*nights, *items]}


def _route(db: Session, ctx: WorkspaceCtx, series_id: str) -> Series:
    s = db.scalar(select(Series).where(Series.id == series_id, Series.workspace_id == ctx.workspace.id)
                  .options(selectinload(Series.days)))
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Route not found")
    return s


@router.post("/quotes/route-fill", response_model=RouteFillOut)
def route_fill(body: RouteFill, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """Hotel nights, meal lines and day-service lines from a route, priced from the
    catalog for the travel date (each day on its own date) and every group size."""
    s = _route(db, ctx, body.series_id)
    if body.pax_max < body.pax_min or body.pax_max - body.pax_min > 60:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Group sizes: 'to' must be ≥ 'from', at most 61 sizes")
    shell = QuoteIn(name="route", currency=body.currency, days=max(1, len(s.days)),
                    pax_min=body.pax_min, pax_max=body.pax_max)
    b = route_build.build(db, s, shell, body.on_date or date.today(), meals=body.meals, extras=body.extras, pax=body.pax)
    fx = suggested_fx(db, ctx, body.currency, _used_currencies(b.nights, b.items))
    return RouteFillOut(days=len(s.days), nights=b.nights, items=b.items, fx=fx, warnings=b.warnings)


class RepriceIn(BaseModel):
    doc: QuoteIn
    on_date: date


class PriceChangeOut(BaseModel):
    kind: str
    id: str
    name: str
    currency: str
    before: float | None
    after: float | None


class RepriceOut(BaseModel):
    doc: QuoteIn
    changes: list[PriceChangeOut]
    warnings: list[str]
    unlinked: int


@router.post("/quotes/reprice", response_model=RepriceOut)
def reprice(body: RepriceIn, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """The calculation with every catalog price taken again for another travel date.
    Nothing is saved: the editor shows the changes and the user saves them."""
    _check_refs(db, ctx, body.doc)
    r = route_build.reprice(db, ctx.workspace.id, body.doc, body.on_date)
    return RepriceOut(doc=r.doc, changes=[PriceChangeOut(**vars(c)) for c in r.changes],
                      warnings=r.warnings, unlinked=r.unlinked)


# --- partner price list -----------------------------------------------------------------------------

def _free_at(d: dict) -> int:
    """Free places at the smallest group size ("10–25 +1"), whichever way the calculation counts them."""
    try:
        doc = QuoteIn.model_validate(d)
        return doc.leaders_for(doc.pax_min)
    except ValueError:
        return d.get("leaders", 0)


def price_list_data(q: Quote, lang: str) -> dict:
    body = doc_of(q)
    labels = {**PRICE_LIST_LABELS["en"], **PRICE_LIST_LABELS.get(lang, {})}
    texts = body.texts.get(lang) or body.texts.get("en") or {}
    # Texts may override table headings (col_*), but "meals"/"included"/… are the
    # paragraphs themselves, not their headings, so they never replace labels.
    labels.update({k: v for k, v in texts.items() if k.startswith("col_") and v})
    result = compute(body)
    seasons = [(labels["season_base"], body.valid_from, body.valid_to, result.tiers)] + [
        (s.name, s.from_date, s.to_date, s.tiers) for s in result.seasons]
    return {
        "lang": lang, "title": texts.get("title") or body.name, "texts": texts, "labels": labels,
        "currency": body.currency, "valid_from": body.valid_from, "valid_to": body.valid_to, "leaders": body.leaders,
        "hotels": [{"city": n.city, "hotel": n.hotel_name} for n in body.nights if n.price_dbl is not None],
        "tiers": [t.model_dump() for t in result.tiers], "errors": result.errors,
        "show_trp": any(t.price_trp is not None for t in result.tiers),
        "sections": [_price_table(body, labels, name, a, b, tiers, len(seasons) > 1) for name, a, b, tiers in seasons],
        "extras": _extras(result.tiers),
    }


def _price_table(doc: QuoteIn, L: dict, name: str, start, end, tiers, titled: bool) -> dict:
    """One season's price table: per person (or per room), in every selling currency, and the price of
    every other paying type of person (children…)."""
    trp = any(t.price_trp is not None for t in tiers)
    quad = any(t.price_quad is not None for t in tiers)
    currencies = [doc.currency] + [c.currency for c in doc.sell_in if c.currency != doc.currency]
    many = len(currencies) > 1

    def prices(t, cur):
        if cur == doc.currency:
            return t.price_dbl, t.price_sgl, t.single_supplement, t.price_trp, t.price_quad
        o = next((x for x in t.other if x.currency == cur), None)
        if o is None:
            return None, None, None, None, None
        return o.price_dbl, o.price_sgl, o.price_sgl - o.price_dbl, o.price_trp, o.price_quad

    cols = [L["col_group"]]
    for cur in currencies:
        tag = f" · {cur}" if many else ""
        if doc.per_room:
            cols += [L["col_room_dbl"] + tag, L["col_room_sgl"] + tag] + ([L["col_room_trp"] + tag] if trp else []) + ([L["col_room_quad"] + tag] if quad else [])
        else:
            cols += [L["col_dbl"] + tag, L["col_supplement"] + tag] + ([L["col_trp"] + tag] if trp else []) + ([L["col_quad"] + tag] if quad else [])
    kinds: dict[str, str] = {}               # every other paying type, in order, even if absent at some sizes
    for t in tiers:
        for x in t.types[1:]:
            kinds.setdefault(x.id, x.name)
    tag0 = f" · {doc.currency}" if many else ""
    cols += [f"{k}, {L['per_person']}{tag0}" for k in kinds.values()] + [L["col_vehicle"]]
    rows = []
    for t in tiers:
        plus = L["adults_plus"].format(leaders=t.leaders) if t.leaders else ""
        row: list = [f"{t.tourists} {plus}".strip()]
        for cur in currencies:
            dbl, sgl, sup, tr, qd = prices(t, cur)
            if doc.per_room:
                row += [dbl * 2 if dbl is not None else None, sgl] + ([tr * 3 if tr is not None else None] if trp else []) + ([qd * 4 if qd is not None else None] if quad else [])
            else:
                row += [dbl, sup] + ([tr] if trp else []) + ([qd] if quad else [])
        by_id = {x.id: x.price for x in t.types[1:]}
        row += [by_id.get(k) for k in kinds] + [t.vehicle]
        rows.append(row)
    dates = f"{start or ''} – {end or ''}" if (start or end) else ""
    return {"title": (f"{name} · {dates}" if dates else name) if titled else "", "columns": cols, "rows": rows}


def _extras(tiers) -> list[dict]:
    """Optional extras with their price range over the group sizes ("45" or "45–60")."""
    out: dict[str, list[float]] = {}
    for t in tiers:
        for x in t.extras:
            out.setdefault(x.name, []).append(x.price)
    return [{"name": k, "from": min(v), "to": max(v)} for k, v in out.items()]


@router.get("/quotes/{quote_id}/price-list")
def price_list(quote_id: str, lang: str = "en", ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    return price_list_data(_get(db, ctx, quote_id), lang)


@router.get("/quotes/{quote_id}/price-list.xlsx")
def price_list_xlsx(quote_id: str, lang: str = "en", ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    q = _get(db, ctx, quote_id)
    d = price_list_data(q, lang)
    if d["errors"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Fix the calculation errors first")
    L = d["labels"]
    wb = Workbook()
    ws = wb.active
    ws.title = "Price list"
    bold = Font(bold=True)
    head = PatternFill("solid", fgColor="4F46E5")
    ws.append([ctx.workspace.name])
    ws.append([d["title"]])
    ws["A2"].font = Font(bold=True, size=14)
    if d["valid_from"] or d["valid_to"]:
        ws.append([f"{L['valid']}: {d['valid_from'] or ''} – {d['valid_to'] or ''}"])
    ws.append([L["currency"].format(currency=d["currency"])])
    ws.append([])
    ws.append([L["col_city"], L["col_hotel"]])
    for c in ws[ws.max_row]:
        c.font = bold
    for h in d["hotels"]:
        ws.append([h["city"], h["hotel"]])
    for key in ("meals", "included", "not_included"):
        if d["texts"].get(key):
            ws.append([])
            ws.append([L[key] if key != "meals" else L["meals"], d["texts"][key]])
            ws.cell(ws.max_row, 1).font = bold
    for sec in d["sections"]:
        ws.append([])
        if sec["title"]:
            ws.append([sec["title"]])
            ws.cell(ws.max_row, 1).font = Font(bold=True, size=12)
        ws.append(sec["columns"])
        for c in ws[ws.max_row]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = head
            c.alignment = Alignment(wrap_text=True, vertical="center")
        for row in sec["rows"]:
            ws.append(row)
            for c in ws[ws.max_row][1:-1]:
                c.number_format = "#,##0.##"
    if d["extras"]:
        ws.append([])
        ws.append([L["extras"]])
        ws.cell(ws.max_row, 1).font = bold
        for x in d["extras"]:
            ws.append([x["name"], x["from"] if x["from"] == x["to"] else f"{x['from']:g}–{x['to']:g}"])
    width = max((len(s["columns"]) for s in d["sections"]), default=5)
    for i in range(width):
        ws.column_dimensions[chr(ord("A") + i)].width = 26 if i == 0 else 18
    buf = io.BytesIO()
    defuse(wb)
    wb.save(buf)
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", q.name).strip("_") or "price-list"
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}-{lang}.xlsx"'})


# --- quote → tour (+ invoice) ------------------------------------------------------------------------

class CreateTourIn(BaseModel):
    tourists: int = Field(ge=1, le=500)
    start_date: date
    client_id: str | None = None
    code: str | None = Field(default=None, max_length=40)
    status: TourStatus = "confirmed"
    with_invoice: bool = True
    singles: int = Field(default=0, ge=0, le=500)  # tourists who booked a single room

    @model_validator(mode="after")
    def _singles_fit(self):
        if self.singles > self.tourists:
            raise ValueError("More single rooms than tourists")
        return self


class CreateTourOut(BaseModel):
    tour_id: str
    tour_code: str
    invoice_id: str | None
    invoice_ids: list[str] = []  # deposit and balance when the client's terms ask for a deposit
    warnings: list[str] = []   # from taking the budget (e.g. missing exchange rates)
    hotel_changes: list[str] = []   # days whose hotel came from the calculation, not the route


@router.post("/quotes/{quote_id}/create-tour", response_model=CreateTourOut, status_code=status.HTTP_201_CREATED)
def create_tour(quote_id: str, body: CreateTourIn, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """A confirmed group: the tour (itinerary from the route, or from the quote's hotel
    nights) and a draft invoice at the quoted price for that group size."""
    q = _get(db, ctx, quote_id)
    doc = doc_of(q)
    if not doc.pax_min <= body.tourists <= doc.pax_max:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            f"The calculation covers {doc.pax_min}–{doc.pax_max} tourists")
    result = compute(season_on(doc, body.start_date))      # priced in the season it travels
    if result.errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Fix the calculation errors first")
    tier = next(t for t in result.tiers if t.tourists == body.tourists)
    client_id = body.client_id or doc.client_id
    check_refs(db, ctx, {"client_id": (Client, client_id)})
    series = get_owned(db, ctx, Series, doc.series_id) if doc.series_id else None

    n_days = len(series.days) if series and series.days else doc.days
    code = (body.code or "").strip().upper() or _generate_code(db, ctx, series, body.start_date)
    if _code_taken(db, ctx, code):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Tour code {code} already exists")
    t = Tour(workspace_id=ctx.workspace.id, code=code, series_id=series.id if series else None, client_id=client_id,
             start_date=body.start_date, end_date=body.start_date + timedelta(days=n_days - 1), status=body.status,
             pax=body.tourists + doc.others_for(body.tourists), quote_id=q.id, quote_tourists=body.tourists,
             rooms=_rooms_text(doc, body.tourists, body.singles))
    db.add(t)
    sync_days(t, series.days if series else None)
    hotel_changes: list[str] = []
    if not series:  # no route: take cities and hotels from the quote's nights
        for day, night in zip(t.days, doc.nights):
            day.city, day.hotel_id = night.city, night.vendor_id
    else:
        hotel_changes = _hotels_from_calc(db, ctx, t, doc)
    db.flush()
    # The calculation at this size becomes the tour's budget: costs are measured against it.
    budget_warnings = take_budget(db, ctx, t, q, doc, body.tourists)
    # The price sold at this size is the tour's price per person.
    t.price_pp, t.price_currency = Decimal(str(tier.price_dbl)), doc.currency

    invoice_id = None
    invoice_ids: list[str] = []
    if body.with_invoice and client_id:
        # Draft invoices by the client's payment terms: deposit + balance, or one invoice.
        title = (doc.texts.get("en") or {}).get("title") or doc.name
        lines = [(f"{title} · {code} · {tier.label}", Decimal(body.tourists), Decimal(str(tier.price_dbl)))]
        if body.singles:
            lines.append(("Single room supplement", Decimal(body.singles), Decimal(str(tier.single_supplement))))
        # Everyone else who pays (children…), at their own price.
        lines += [(f"{x.name} · {code}", Decimal(x.count), Decimal(str(x.price))) for x in tier.types[1:] if x.count]
        client = db.get(Client, client_id)
        terms, _ = schedule.terms_for(ctx.workspace, client)
        for inv in schedule.make_invoices(ctx.workspace, t, client_id, doc.currency,
                                          finance.rate_for(finance.rates(db, ctx.workspace), doc.currency), lines, terms):
            db.add(inv)
            db.flush()
            invoice_ids.append(inv.id)
        invoice_id = invoice_ids[-1]   # the one with the full price (the balance, or the only one)
    if doc.status in ("draft", "sent"):
        doc.status = "accepted"
        save_doc(db, q, doc, ctx.user.id, f"tour:{code}")
    db.commit()
    return CreateTourOut(tour_id=t.id, tour_code=t.code, invoice_id=invoice_id, invoice_ids=invoice_ids,
                         warnings=budget_warnings, hotel_changes=hotel_changes)


# --- a calculation for a whole series ------------------------------------------------------------
# Either way round: make the departures from the calculation, or give the calculation to departures
# that already exist (made from the route). Each tour then has it as its budget and its price.

class QuoteDeparture(BaseModel):
    code: str | None = Field(default=None, max_length=40)
    start_date: date


class QuoteDeparturesIn(BaseModel):
    departures: list[QuoteDeparture] = Field(min_length=1, max_length=60)
    tourists: int = Field(ge=1, le=500)
    singles: int = Field(default=0, ge=0, le=500)
    client_id: str | None = None
    status: TourStatus = "inquiry"
    with_invoice: bool = False


class SeriesResult(BaseModel):
    tour_id: str | None
    code: str | None
    start_date: date | None = None
    error: str = ""
    notes: list[str] = []       # warnings: outside the calculation's dates, price kept (invoiced)...


def _outside(doc: QuoteIn, start: date) -> list[str]:
    if (doc.valid_from and start < doc.valid_from) or (doc.valid_to and start > doc.valid_to):
        return [f"Starts {start}, outside the calculation's dates ({doc.valid_from or '…'} – {doc.valid_to or '…'})"]
    return []


@router.post("/quotes/{quote_id}/departures", response_model=list[SeriesResult])
def create_departures(quote_id: str, body: QuoteDeparturesIn, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """Calculation first: many departures of its route, each with the calculation as budget and price."""
    q = _get(db, ctx, quote_id)
    doc = doc_of(q)
    if not doc.series_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Link the calculation to a route first")
    out = []
    for d in body.departures:
        try:
            made = create_tour(quote_id, CreateTourIn(tourists=body.tourists, singles=body.singles, start_date=d.start_date,
                                                      code=d.code, client_id=body.client_id, status=body.status,
                                                      with_invoice=body.with_invoice), ctx=ctx, db=db)
            out.append(SeriesResult(tour_id=made.tour_id, code=made.tour_code, start_date=d.start_date,
                                    notes=[*_outside(doc, d.start_date), *made.warnings, *made.hotel_changes]))
        except HTTPException as e:
            db.rollback()
            out.append(SeriesResult(tour_id=None, code=d.code, start_date=d.start_date, error=str(e.detail)))
    return out


class ApplyIn(BaseModel):
    tour_ids: list[str] = Field(min_length=1, max_length=200)
    tourists: int | None = Field(default=None, ge=1, le=500)   # None: each tour's own group size


@router.post("/quotes/{quote_id}/apply", response_model=list[SeriesResult])
def apply_to_tours(quote_id: str, body: ApplyIn, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """Tours first: give this calculation to departures that exist — budget at their size and price
    per person. A closed tour is left alone; an invoiced one keeps the price it was invoiced at."""
    q = _get(db, ctx, quote_id)
    doc = doc_of(q)
    result = compute(doc)
    if result.errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Fix the calculation errors first")
    out = []
    for tid in body.tour_ids:
        t = db.scalar(select(Tour).where(Tour.id == tid, Tour.workspace_id == ctx.workspace.id))
        if t is None:
            out.append(SeriesResult(tour_id=None, code=None, error="Tour not found"))
            continue
        res = SeriesResult(tour_id=t.id, code=t.code, start_date=t.start_date)
        if t.closed_at is not None or t.status == "cancelled":
            res.error = "Closed or cancelled — left as it is"
        elif doc.series_id and t.series_id != doc.series_id:
            res.error = "Another route — this calculation is for a different one"
        else:
            tourists = body.tourists or doc.tourists_in(t.pax)
            if tourists is None:
                res.error = "Group size unknown — choose one size for all"
            elif not doc.pax_min <= tourists <= doc.pax_max:
                res.error = f"{tourists} tourists: the calculation covers {doc.pax_min}–{doc.pax_max}"
            else:
                try:
                    t.quote_id, t.quote_tourists = q.id, tourists
                    res.notes = [*_outside(doc, t.start_date), *take_budget(db, ctx, t, q, doc, tourists)]
                    seasonal = compute(season_on(doc, t.start_date)) if doc.seasons else result
                    tier = next(x for x in seasonal.tiers if x.tourists == tourists)
                    invoiced = db.scalar(select(Invoice.id).where(Invoice.tour_id == t.id, Invoice.status == "issued").limit(1))
                    if invoiced:
                        res.notes.append("Already invoiced: price per person kept")
                    else:
                        t.price_pp, t.price_currency = Decimal(str(tier.price_dbl)), doc.currency
                    db.commit()
                except HTTPException as e:
                    db.rollback()
                    res.error = str(e.detail)
        out.append(res)
    return out


def _hotels_from_calc(db: Session, ctx: WorkspaceCtx, t: Tour, doc: QuoteIn) -> list[str]:
    """The client bought the calculation, so its hotel per night replaces the route's.
    Nights pair with the route's hotel days in order; when the counts differ (nights were
    added or removed in the calculation) nothing is guessed and the team is told to check."""
    hotel_days = [d for d in t.days if d.hotel_id]
    if len(hotel_days) != len(doc.nights):
        return [f"The calculation has {len(doc.nights)} hotel nights, the route {len(hotel_days)}: check the tour's hotels"]
    out = []
    for day, night in zip(hotel_days, doc.nights):
        if not night.vendor_id or night.vendor_id == day.hotel_id:
            continue
        v = db.get(Vendor, night.vendor_id)
        if v is None or v.workspace_id != ctx.workspace.id:
            continue
        old = db.get(Vendor, day.hotel_id)
        day.hotel_id = v.id
        out.append(f"Day {day.day_number}: {v.name}" + (f" instead of {old.name}" if old else ""))
    return out


def _rooms_text(doc: QuoteIn, tourists: int, singles: int) -> str:
    """The group's rooms: its doubles and singles, and every other guest's beds (children
    sharing a triple, the leader's single or free room…). Staff rooms are booked apart."""
    rooms = {"DBL": (tourists - singles + 1) // 2, "SGL": singles, "TRP": 0}
    for p in people_for(doc, tourists):
        if p.group or not p.count or p.role == "staff":
            continue
        if p.room in ("sgl", "free"):
            rooms["SGL"] += p.count
        elif p.room == "dbl":
            rooms["DBL"] += -(-p.count // 2)
        elif p.room == "trp":
            rooms["TRP"] += -(-p.count // 3)
    return " + ".join(f"{n} {k}" for k, n in rooms.items() if n)


# --- planned (quote) vs actual (costs & invoices) ---------------------------------------------------

# --- history ---------------------------------------------------------------------------------

def _versions(db: Session, q: Quote) -> list[QuoteVersion]:
    return db.scalars(select(QuoteVersion).where(QuoteVersion.quote_id == q.id)
                      .options(selectinload(QuoteVersion.created_by)).order_by(QuoteVersion.number)).all()


@router.get("/quotes/{quote_id}/versions", response_model=list[VersionOut])
def list_versions(quote_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    vs = _versions(db, _get(db, ctx, quote_id))
    docs = [QuoteIn.model_validate(v.doc) for v in vs]
    out = [VersionOut(number=v.number, note=v.note, created_at=v.created_at,
                      created_by=(v.created_by.full_name or v.created_by.email) if v.created_by else None,
                      changes=len(diff_docs(docs[i - 1], docs[i])) if i else 0)
           for i, v in enumerate(vs)]
    return list(reversed(out))  # newest first


class VersionNote(BaseModel):
    note: str = Field(default="", max_length=300)


@router.patch("/quotes/{quote_id}/versions/{number}")
def name_version(quote_id: str, number: int, body: VersionNote, ctx: WorkspaceCtx = Depends(can_ope_sal),
                 db: Session = Depends(get_db)):
    """Give a version a name ("Sent to the client") - or take it away."""
    q = _get(db, ctx, quote_id)
    v = db.scalar(select(QuoteVersion).where(QuoteVersion.quote_id == q.id, QuoteVersion.number == number))
    if v is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such version")
    v.note = body.note.strip()
    db.commit()
    return {"ok": True}


@router.get("/quotes/{quote_id}/versions/{number}", response_model=VersionDiff)
def version_diff(quote_id: str, number: int, against: int | None = None,
                 ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    """What version `number` changed compared with `against` (default: the version before it)."""
    vs = {v.number: v for v in _versions(db, _get(db, ctx, quote_id))}
    if number not in vs:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    other = against if against is not None else max((n for n in vs if n < number), default=None)
    if other is not None and other not in vs:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    new = QuoteIn.model_validate(vs[number].doc)
    if other is None:
        return VersionDiff(number=number, against=None, changes=[], impact=price_impact(new, new))
    old = QuoteIn.model_validate(vs[other].doc)
    return VersionDiff(number=number, against=other, changes=diff_docs(old, new), impact=price_impact(old, new))


@router.post("/quotes/{quote_id}/versions/{number}/restore", response_model=QuoteOut)
def restore_version(quote_id: str, number: int, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """Make an old version current again. History is kept: the restore is a new version."""
    q = _get(db, ctx, quote_id)
    v = db.scalar(select(QuoteVersion).where(QuoteVersion.quote_id == q.id, QuoteVersion.number == number))
    if not v:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    body = QuoteIn.model_validate(v.doc)
    _check_refs(db, ctx, body)  # a vendor or route used then may have been deleted since
    save_doc(db, q, body, ctx.user.id, f"restore:{number}")
    db.commit()
    db.refresh(q)
    return _out(q, db)


# --- scenarios -------------------------------------------------------------------------------

def _scenario(db: Session, q: Quote, scenario_id: str) -> QuoteScenario:
    sc = db.scalar(select(QuoteScenario).where(QuoteScenario.id == scenario_id, QuoteScenario.quote_id == q.id))
    if not sc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Scenario not found")
    return sc


def _scenario_out(q: Quote, sc: QuoteScenario) -> ScenarioOut:
    base = doc_of(q)
    patch = ScenarioIn.model_validate({"name": sc.name, "patch": sc.patch}).patch
    doc, stale = apply_patch(base, patch)
    return ScenarioOut(id=sc.id, name=sc.name, patch=patch, changes=diff_docs(base, doc), stale=stale,
                       updated_at=sc.updated_at)


def _check_patch_refs(db: Session, ctx: WorkspaceCtx, body: ScenarioIn) -> None:
    for n in body.patch.nights.values():
        if n.vendor_id:
            check_refs(db, ctx, {"vendor_id": (Vendor, n.vendor_id)})


@router.get("/quotes/{quote_id}/scenarios", response_model=list[ScenarioOut])
def list_scenarios(quote_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    q = _get(db, ctx, quote_id)
    rows = db.scalars(select(QuoteScenario).where(QuoteScenario.quote_id == q.id).order_by(QuoteScenario.created_at))
    return [_scenario_out(q, sc) for sc in rows]


@router.post("/quotes/{quote_id}/scenarios", response_model=ScenarioOut, status_code=status.HTTP_201_CREATED)
def create_scenario(quote_id: str, body: ScenarioIn, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    q = _get(db, ctx, quote_id)
    _check_patch_refs(db, ctx, body)
    sc = QuoteScenario(quote_id=q.id, name=body.name, patch=body.patch.model_dump(mode="json", exclude_none=True),
                       created_by_id=ctx.user.id)
    db.add(sc)
    db.commit()
    return _scenario_out(q, sc)


@router.put("/quotes/{quote_id}/scenarios/{scenario_id}", response_model=ScenarioOut)
def update_scenario(quote_id: str, scenario_id: str, body: ScenarioIn, ctx: WorkspaceCtx = Depends(can_ope_sal),
                    db: Session = Depends(get_db)):
    q = _get(db, ctx, quote_id)
    sc = _scenario(db, q, scenario_id)
    _check_patch_refs(db, ctx, body)
    sc.name, sc.patch = body.name, body.patch.model_dump(mode="json", exclude_none=True)
    db.commit()
    return _scenario_out(q, sc)


@router.delete("/quotes/{quote_id}/scenarios/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_scenario(quote_id: str, scenario_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    db.delete(_scenario(db, _get(db, ctx, quote_id), scenario_id))
    db.commit()


@router.post("/quotes/{quote_id}/scenarios/{scenario_id}/apply", response_model=QuoteOut)
def apply_scenario(quote_id: str, scenario_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """Make a scenario the calculation itself (a new version); the scenario is then done."""
    q = _get(db, ctx, quote_id)
    sc = _scenario(db, q, scenario_id)
    doc, _ = apply_patch(doc_of(q), ScenarioIn.model_validate({"name": sc.name, "patch": sc.patch}).patch)
    save_doc(db, q, doc, ctx.user.id, f"scenario:{sc.name}")
    db.delete(sc)
    db.commit()
    db.refresh(q)
    return _out(q, db)


@router.post("/quotes/{quote_id}/scenarios/preview", response_model=ScenarioResult)
def preview_scenario(quote_id: str, body: ScenarioIn, ctx: WorkspaceCtx = Depends(can_ope_sal), db: Session = Depends(get_db)):
    """Prices for a scenario being edited, before it is saved."""
    q = _get(db, ctx, quote_id)
    base = doc_of(q)
    doc, _ = apply_patch(base, body.patch)
    return ScenarioResult(id=None, name=body.name, result=compute(doc), changes=diff_docs(base, doc))


@router.get("/quotes/{quote_id}/compare", response_model=CompareOut)
def compare(quote_id: str, ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    """The calculation and all its scenarios, priced side by side."""
    q = _get(db, ctx, quote_id)
    base = doc_of(q)
    out = []
    for sc in db.scalars(select(QuoteScenario).where(QuoteScenario.quote_id == q.id).order_by(QuoteScenario.created_at)):
        doc, _ = apply_patch(base, ScenarioIn.model_validate({"name": sc.name, "patch": sc.patch}).patch)
        out.append(ScenarioResult(id=sc.id, name=sc.name, result=compute(doc), changes=diff_docs(base, doc)))
    return CompareOut(base=compute(base), scenarios=out)


@router.get("/quotes/{quote_id}/calculation.xlsx")
def calculation_xlsx(quote_id: str, lang: str = "en", tourists: int | None = None, season: str | None = None,
                     ctx: WorkspaceCtx = Depends(can_ope_sal_fin), db: Session = Depends(get_db)):
    """The whole saved calculation as a workbook: prices, lines, hotels, one size worked through, formulas."""
    from ..calc_export import workbook
    q = _get(db, ctx, quote_id)
    doc = doc_of(q)
    try:
        data = workbook(db, ctx.workspace, q, doc, _latest_version(db, q), lang, tourists or 19, season)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Fix the calculation errors first")
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", q.name).strip("_") or "calculation"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}-calculation-{lang}.xlsx"'})
