"""A tour's or route's day-by-day programme for clients and partners - in English, Georgian or Chinese.

Built from the days as they are on screen (saved or a draft): the day's route through its places, road km and
coach driving time, the hotel, meals, activities and tickets, the timed programme, flights and notes. No prices,
supplier contacts or team details. The fixed words come from LABELS; the agency's own texts (place and hotel
names, programme steps, notes) are translated by AI when they're in another language, and every translation is
kept (TextTranslation), so a text is paid for once.
"""
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

Day = date      # the type, for a field that is itself called "date"
from decimal import Decimal

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import geo
from .config import settings
from .models import Service, TextTranslation, Vendor, Workspace
from .schemas import DayFields

LANGS = ("en", "ka", "zh")
LANG_NAME = {"en": "English", "ka": "Georgian", "zh": "Simplified Chinese"}

LABELS: dict[str, dict[str, str]] = {
    "en": {"day": "Day {n}", "programme": "Programme", "route": "Route", "distance": "Distance", "driving": "Driving",
           "overnight": "Overnight", "meals": "Meals", "breakfast": "Breakfast", "lunch": "Lunch", "dinner": "Dinner",
           "activities": "Activities and tickets", "optional": "optional", "own": "own arrangements",
           "tourists": "paid on the spot", "at_hotel": "at the hotel", "arrival": "Arrival", "departure": "Departure",
           "border": "Border crossing", "notes": "Notes", "km": "km", "h": "h", "min": "min", "total": "Total distance",
           "days": "{n} days", "checkin": "Check-in", "free": "Free time", "transfer": "Transfer", "no_hotel": "End of the tour"},
    "ka": {"day": "დღე {n}", "programme": "პროგრამა", "route": "მარშრუტი", "distance": "მანძილი", "driving": "გზაში",
           "overnight": "ღამისთევა", "meals": "კვება", "breakfast": "საუზმე", "lunch": "სადილი", "dinner": "ვახშამი",
           "activities": "აქტივობები და ბილეთები", "optional": "სურვილისამებრ", "own": "საკუთარი ხარჯით",
           "tourists": "ადგილზე გადახდით", "at_hotel": "სასტუმროში", "arrival": "ჩამოფრენა", "departure": "გაფრენა",
           "border": "საზღვრის კვეთა", "notes": "შენიშვნები", "km": "კმ", "h": "სთ", "min": "წთ", "total": "სულ მანძილი",
           "days": "{n} დღე", "checkin": "განთავსება", "free": "თავისუფალი დრო", "transfer": "გადაადგილება", "no_hotel": "ტურის დასასრული"},
    "zh": {"day": "第{n}天", "programme": "行程", "route": "路线", "distance": "距离", "driving": "车程",
           "overnight": "住宿", "meals": "餐食", "breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐",
           "activities": "活动与门票", "optional": "自选", "own": "自理", "tourists": "现场自付", "at_hotel": "酒店内",
           "arrival": "抵达", "departure": "离开", "border": "过境", "notes": "备注", "km": "公里", "h": "小时", "min": "分钟",
           "total": "总里程", "days": "{n}天", "checkin": "入住", "free": "自由活动", "transfer": "交通", "no_hotel": "行程结束"},
}


# The region's airports by code, in each language (a code not here stays as typed: "Istanbul", "IST").
AIRPORTS: dict[str, dict[str, str]] = {
    "TBS": {"en": "Tbilisi International Airport", "ka": "თბილისის საერთაშორისო აეროპორტი", "zh": "第比利斯国际机场"},
    "KUT": {"en": "Kutaisi International Airport", "ka": "ქუთაისის საერთაშორისო აეროპორტი", "zh": "库塔伊西国际机场"},
    "BUS": {"en": "Batumi International Airport", "ka": "ბათუმის საერთაშორისო აეროპორტი", "zh": "巴统国际机场"},
    "EVN": {"en": "Zvartnots International Airport (Yerevan)", "ka": "ზვართნოცის საერთაშორისო აეროპორტი (ერევანი)", "zh": "兹瓦尔特诺茨国际机场（埃里温）"},
    "GYD": {"en": "Heydar Aliyev International Airport (Baku)", "ka": "ჰეიდარ ალიევის საერთაშორისო აეროპორტი (ბაქო)", "zh": "盖达尔·阿利耶夫国际机场（巴库）"},
}


def airport(code: str, lang: str = "en") -> str:
    names = AIRPORTS.get((code or "").strip().upper())
    return names.get(lang, names["en"]) if names else (code or "").strip()


def _flight_line(f, lang: str, L: dict[str, str]) -> str:
    """ "Arrival TK 384 (Istanbul) · Tbilisi International Airport" - the time is the step's own."""
    word = L["arrival"] if f.direction == "arrival" else L["departure"]
    head = " ".join(x for x in (word, f.number, f"({f.other})" if f.other else "") if x)
    where = airport(f.airport, lang)
    return f"{head} \u00b7 {where}" if where else head


class Include(BaseModel):
    distance: bool = True
    hotels: bool = True
    meals: bool = True
    activities: bool = True
    schedule: bool = True
    notes: bool = True


class ProgrammeIn(BaseModel):
    title: str = ""
    start_date: date | None = None
    days: list[DayFields]
    lang: str = "en"
    include: Include = Include()
    translate: bool = True
    only_days: list[int] | None = None       # the day numbers to put in the file; None = every day


class PStep(BaseModel):
    time: str = ""
    end: str = ""
    text: str
    drive: "PLeg | None" = None      # the drive that leads to this step (km, time), shown just before it


class PLeg(BaseModel):
    """One drive between two places of the day: "Tbilisi → Mtskheta · 25 km · 35 min"."""
    start: str
    end: str
    km: int | None = None
    drive: str = ""


PStep.model_rebuild()


class PDay(BaseModel):
    number: int
    date: Day | None = None
    title: str                       # "Day 1 · Tbilisi → Mtskheta → Gudauri"
    route: list[str] = []
    km: int | None = None
    drive: str = ""                  # "2 h 30 min" (coach)
    legs: list[PLeg] = []            # place to place, with km and time
    hotel: str = ""
    meals: list[tuple[str, str]] = []           # (label, text)
    activities: list[str] = []
    steps: list[PStep] = []
    flights: list[str] = []
    border: str = ""
    notes: str = ""


class ProgrammeOut(BaseModel):
    title: str
    subtitle: str
    agency: str
    lang: str
    labels: dict[str, str]
    days: list[PDay]
    total_km: int
    warnings: list[str] = []


# --- translation --------------------------------------------------------------------------------------

_SCRIPT = {"ka": re.compile(r"[Ⴀ-ჿ]"), "zh": re.compile(r"[一-鿿]")}


def _needs(text: str, lang: str) -> bool:
    """Is this text in another language than `lang`? (Letters only; numbers and times need nothing.)"""
    if not re.search(r"[^\W\d_]", text):
        return False
    if lang in _SCRIPT:
        return not _SCRIPT[lang].search(text)
    return bool(_SCRIPT["ka"].search(text) or _SCRIPT["zh"].search(text) or re.search(r"[Ѐ-ӿ]", text))


def make_client(ws: Workspace):
    """Tests replace this."""
    from .ai.agent import make_client as ai_client
    return ai_client(ws)


def translate(db: Session, ws: Workspace, texts: set[str], lang: str, warnings: list[str]) -> dict[str, str]:
    """Each text in `lang`: kept translations first, the rest asked of the AI in one go (and kept)."""
    todo = sorted(t for t in texts if t and _needs(t, lang))
    if not todo:
        return {}
    key = lambda t: hashlib.sha1(t.encode()).hexdigest()
    kept = {r.source_hash: r.result for r in db.scalars(select(TextTranslation).where(
        TextTranslation.workspace_id == ws.id, TextTranslation.lang == lang,
        TextTranslation.source_hash.in_([key(t) for t in todo])))}
    out = {t: kept[key(t)] for t in todo if key(t) in kept}
    ask = [t for t in todo if t not in out]
    if not ask:
        return out
    from .ai import keys
    if not keys.key_for(ws):
        warnings.append("no_ai_key")
        return out
    prompt = (
        f"Translate each item of this JSON list into {LANG_NAME[lang]}. They come from a travel agency's tour "
        "programme (Georgia, Armenia, Azerbaijan): names of towns, sights, hotels and restaurants, and short "
        "programme lines and notes. Use the established name of a place in that language (Tbilisi = 第比利斯 = "
        "თბილისი). Hotel and restaurant brand names: keep them as they are written in Latin letters, translating "
        "only generic words if useful. Keep times, numbers and codes unchanged. Answer with only a JSON list of "
        "strings, same length and order.\n\n" + json.dumps(ask, ensure_ascii=False))
    try:
        msg = make_client(ws).messages.create(model=settings.ai_translate_model, max_tokens=8000,
                                              messages=[{"role": "user", "content": prompt}])
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        got = json.loads(text[text.index("["): text.rindex("]") + 1])
        if not isinstance(got, list) or len(got) != len(ask):
            raise ValueError("wrong length")
    except Exception:          # noqa: BLE001 - the programme is still made, in the texts as written
        warnings.append("ai_failed")
        return out
    for src, res in zip(ask, got):
        res = str(res).strip()[:2000]
        if res:
            out[src] = res
            db.add(TextTranslation(workspace_id=ws.id, lang=lang, source_hash=key(src), source=src[:4000], result=res))
    db.commit()
    return out


# --- building ------------------------------------------------------------------------------------------

def _sight(title: str, vendors: dict[str, Vendor]) -> Vendor | None:
    """The catalogue's sight a visit is called after ("Garni" is "Garni Temple" when it's the only one)."""
    n = title.strip().lower()
    if not n:
        return None
    places = [v for v in vendors.values() if v.type in ("activity", "other")]
    exact = next((v for v in places if v.name.strip().lower() == n), None)
    if exact:
        return exact
    starts = [v for v in places if v.name.strip().lower().startswith(n)]
    return starts[0] if len(starts) == 1 else None


def _day_path(d: DayFields, prev: DayFields | None, vendors: dict[str, Vendor], last: bool, lang: str = "en") -> list[tuple[str, str, str | None]]:
    """The day's destinations in its programme's order, as (where the map should look, name to show, the
    step it is - None for last night's town and the day's town at the end):
    last night's town, each visit, restaurant and the hotel, then the day's town when there's no
    check-in. The same place twice in a row is one stop (the day plan's pathOf)."""
    pts: list[tuple[str, str, str | None]] = []

    def push(where: str | None, label: str | None, step: str | None = None) -> None:
        w = (where or "").strip()
        if w and (not pts or pts[-1][0].lower() != w.lower()):
            pts.append((w, (label or w).strip(), step))

    if prev:
        slept = vendors.get(prev.hotel_id or "")
        push((slept.address if slept else "") or prev.city, prev.city or (slept.name if slept else ""))
    for x in d.schedule:
        r = x.ref or ""
        if r.startswith("flight:"):
            f = d.flights[int(r[7:])] if r[7:].isdigit() and int(r[7:]) < len(d.flights) else None
            if f and f.airport:
                push(airport(f.airport), airport(f.airport, lang), x.id)
        elif r == "hotel":
            h = vendors.get(d.hotel_id or "")
            push((h.address if h else "") or d.city, h.name if h else d.city, x.id)
        elif r == "breakfast":
            b = vendors.get(d.breakfast_id or "") if d.breakfast_mode in ("included", "tourists") else None
            if b:
                push(b.address or b.city, b.name, x.id)
        elif r in ("lunch", "dinner"):
            mode, vid = (d.lunch_mode, d.lunch_id) if r == "lunch" else (d.dinner_mode, d.dinner_id)
            m = vendors.get(vid or "") if mode != "own" else None
            if m:
                push(m.address or m.city, m.name, x.id)
        elif not r and x.kind == "visit":
            at = None
            if x.place and x.place.strip().lower() != x.title.strip().lower():
                at = next((v for v in vendors.values() if v.name.strip().lower() == x.place.strip().lower()), None)
            if at:
                push(at.address or at.name, at.name, x.id)
            else:
                sight = _sight(x.title, vendors)
                push((sight.address if sight else "") or x.place or x.title, x.title or x.place, x.id)
    # Where the day ends (the day plan's rule): at the airport when it ends with a flight; else, with no
    # check-in in the programme, at the night's hotel (no drive when they're already there - dinner at the
    # hotel) or the day's town, unless the last place is already in that town.
    leaving = any((x.ref or "").startswith("flight:") and pts and pts[-1][2] == x.id for x in d.schedule)
    if leaving:
        return pts
    if not any(x.ref == "hotel" for x in d.schedule):
        hotel = None if last else vendors.get(d.hotel_id or "")
        end = pts[-1][0].lower() if pts else ""
        if hotel:
            push(hotel.address or hotel.name, hotel.name)
        elif not (d.city and d.city.strip().lower() in end):
            push(d.city, d.city)
    elif last:
        push(d.city, d.city)
    return pts


def _map_legs(db: Session, ws: Workspace, route: list[str]) -> tuple[list[int], list[int]] | None:
    """Road km and car minutes for each leg of a day, from the map (kept answers first, as the day plan
    asks). None when the map can't say - the programme then just has no distance for that day."""
    try:
        rows = geo.legs(db, route, countries=ws.countries or None, workspace_id=ws.id)[1:]
    except Exception:          # noqa: BLE001 - no map, no distance; the programme is still made
        return None
    if len(rows) != len(route) - 1 or not any(r.get("km") for r in rows):
        return None
    return [int(r.get("km") or 0) for r in rows], [int(r.get("minutes") or 0) for r in rows]


def _drive(minutes: int, factor: Decimal, L: dict[str, str]) -> str:
    m = int(round(minutes * float(factor) / 5) * 5)
    if m <= 0:
        return ""
    h, r = divmod(m, 60)
    return " ".join(x for x in (f"{h} {L['h']}" if h else "", f"{r} {L['min']}" if r else "") if x)


@dataclass
class _Ctx:
    vendors: dict[str, Vendor]
    services: dict[str, Service]
    texts: set[str] = field(default_factory=set)

    def name(self, vid: str | None) -> str:
        v = self.vendors.get(vid or "")
        return v.name if v else ""


def build(db: Session, ws: Workspace, body: ProgrammeIn) -> ProgrammeOut:
    lang = body.lang if body.lang in LANGS else "en"
    L = LABELS[lang]
    inc = body.include
    vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id))}
    sids = {e.service_id for d in body.days for e in d.extras}
    services = {s.id: s for s in db.scalars(select(Service).join(Vendor).where(Vendor.workspace_id == ws.id, Service.id.in_(sids)))} if sids else {}
    c = _Ctx(vendors, services)
    T = lambda s: (c.texts.add(s), s)[1] if s else s      # remember a text to translate
    days: list[PDay] = []
    total = 0
    for i, d in enumerate(body.days):
        prev = body.days[i - 1] if i else None
        route = [T(x) for x in ([prev.city] if prev and prev.city and prev.city != d.city else []) + list(d.stops) + [d.city] if x]
        factor = ws.drive_factor or Decimal("1.25")
        stops, leg_km, leg_min = route, list(d.drive_km), list(d.drive_minutes)
        # With a day programme: destination to destination in its order (last night's town, each sight,
        # restaurant and the hotel) - the drives the day plan shows.
        path = _day_path(d, prev, vendors, i == len(body.days) - 1, lang) if inc.distance and d.schedule else []
        ends: list[str | None] = []          # the step each drive leads to (None: the day's town)
        if len(path) >= 2:
            got = _map_legs(db, ws, [q for q, _, _ in path])
            if got:
                stops, (leg_km, leg_min) = [T(label) for _, label, _ in path], got
                ends = [step for _, _, step in path][1:]
        # Not saved on the day: the map's answer for the same road - what the day plan shows.
        if inc.distance and len(stops) >= 2 and len(leg_km) != len(stops) - 1:
            got = _map_legs(db, ws, stops)
            if got:
                leg_km, leg_min = got
        km = d.km or (sum(leg_km) or None)
        total += km or 0
        drive = _drive(sum(leg_min), factor, L) if leg_min else ""
        p = PDay(number=i + 1, date=body.start_date + timedelta(days=i) if body.start_date else None,
                 title="", route=route, km=km if inc.distance else None, drive=drive if inc.distance else "")
        # Place to place, every leg of the day (in order).
        if inc.distance and len(stops) >= 2 and len(leg_km) == len(stops) - 1:
            for j, (a, b) in enumerate(zip(stops, stops[1:])):
                mins = leg_min[j] if j < len(leg_min) else 0
                p.legs.append(PLeg(start=a, end=b, km=leg_km[j] or None, drive=_drive(mins, factor, L) if mins else ""))
        last = i == len(body.days) - 1
        if inc.hotels:
            p.hotel = T(c.name(d.hotel_id)) or ("" if not last else "")
        if inc.meals:
            slept = c.name(prev.hotel_id) if prev else ""
            bmode = d.breakfast_mode
            if i > 0 and bmode == "hotel":
                p.meals.append((L["breakfast"], T(slept) or L["at_hotel"]))
            elif bmode in ("included", "tourists") and d.breakfast_id:
                p.meals.append((L["breakfast"], T(c.name(d.breakfast_id)) + (f" ({L['tourists']})" if bmode == "tourists" else "")))
            elif bmode == "own" and i > 0:
                p.meals.append((L["breakfast"], L["own"]))
            for word, mode, vid in ((L["lunch"], d.lunch_mode, d.lunch_id), (L["dinner"], d.dinner_mode, d.dinner_id)):
                if mode == "own":
                    p.meals.append((word, L["own"]))
                elif vid:
                    p.meals.append((word, T(c.name(vid)) + (f" ({L['tourists']})" if mode == "tourists" else "")))
        if inc.activities:
            for e in d.extras:
                s = services.get(e.service_id)
                if s and s.category not in ("hotel", "meal", "transport", "guide"):
                    v = T(s.vendor.name) if s.vendor else ""
                    nm = T(s.name)
                    p.activities.append(f"{v}: {nm}" if v and v.lower() not in nm.lower() else nm or v)
                    if e.optional:
                        p.activities[-1] += f" ({L['optional']})"
        if inc.schedule:
            # One timeline: each drive just before the place it leads to; the drive to the day's town at
            # the end. The separate place-to-place list is then not needed.
            to_step = {e: g for e, g in zip(ends, p.legs) if e} if ends and len(ends) == len(p.legs) else {}
            for x in d.schedule:
                text = _step_text(x, d, prev, c, L, lang)
                if text:
                    p.steps.append(PStep(time=x.time, end=x.end, text=text, drive=to_step.get(x.id)))
            if to_step:
                p.steps += [PStep(text=g.end, drive=g) for e, g in zip(ends, p.legs) if e is None]
                p.legs = []
        in_timeline = {x.ref for x in d.schedule} if inc.schedule else set()
        for k, f in enumerate(d.flights):
            if f"flight:{k}" not in in_timeline:
                if f.other:
                    T(f.other)
                p.flights.append(" ".join(x for x in (f.time, _flight_line(f, lang, L)) if x))
        if d.border_crossing:
            p.border = T(d.border_crossing)
        if inc.notes and d.notes.strip():
            p.notes = T(d.notes.strip())
        days.append(p)

    if body.only_days:
        keep = set(body.only_days)
        days = [p for p in days if p.number in keep]     # the rest still gave the route and last night's hotel
        total = sum(p.km or 0 for p in days)
    warnings: list[str] = []
    tr = translate(db, ws, c.texts, lang, warnings) if body.translate else {}
    t = lambda s: tr.get(s, s)
    for p in days:
        p.route = [t(x) for x in p.route]
        p.legs = [PLeg(start=t(g.start), end=t(g.end), km=g.km, drive=g.drive) for g in p.legs]
        p.hotel = t(p.hotel)
        p.meals = [(a, t(b) if b in tr else _tr_inside(b, tr)) for a, b in p.meals]
        p.activities = [_tr_inside(a, tr) for a in p.activities]
        p.steps = [PStep(time=s.time, end=s.end, text=_tr_inside(s.text, tr),
                         drive=PLeg(start=t(s.drive.start), end=t(s.drive.end), km=s.drive.km, drive=s.drive.drive) if s.drive else None)
                   for s in p.steps]
        p.border, p.notes = t(p.border), t(p.notes)
        p.title = f"{L['day'].format(n=p.number)} · {' → '.join(p.route)}" if p.route else L["day"].format(n=p.number)
    title = t(T(body.title)) if body.title else L["programme"]
    if body.title and body.translate and title == body.title and _needs(body.title, lang):
        title = translate(db, ws, {body.title}, lang, warnings).get(body.title, body.title)
    span = f"{days[0].date.isoformat()} – {days[-1].date.isoformat()}" if days and days[0].date else ""
    subtitle = " · ".join(x for x in (L["days"].format(n=len(days)), span, f"{L['total']}: {total} {L['km']}" if inc.distance and total else "") if x)
    return ProgrammeOut(title=title, subtitle=subtitle, agency=ws.name, lang=lang, labels=L, days=days,
                        total_km=total, warnings=sorted(set(warnings)))


def _tr_inside(text: str, tr: dict[str, str]) -> str:
    """The line translated: whole, or the known texts inside a composed line ("Wine Cellar: Tasting
    (optional)") - in one pass, longest first, so a translated part is never translated again."""
    if text in tr:
        return tr[text]
    keys = sorted((k for k in tr if k), key=len, reverse=True)
    if not keys:
        return text
    return re.sub("|".join(re.escape(k) for k in keys), lambda m: tr[m.group(0)], text)


def _step_text(x, d: DayFields, prev: DayFields | None, c: _Ctx, L: dict[str, str], lang: str = "en") -> str:
    """One programme line, as the day programme shows it."""
    r = x.ref or ""
    T = lambda s: (c.texts.add(s), s)[1] if s else s
    if r.startswith("flight:"):
        k = r[7:]
        f = d.flights[int(k)] if k.isdigit() and int(k) < len(d.flights) else None
        if f and f.other:
            T(f.other)
        return _flight_line(f, lang, L) if f else ""
    if not r:
        text = x.title or x.place
        return T(text) if text else (L["free"] if x.kind == "free" else "")
    if r == "breakfast":
        if d.breakfast_mode == "hotel":
            return f"{L['breakfast']}: {T(c.name(prev.hotel_id)) or L['at_hotel']}" if prev else ""
        if d.breakfast_mode == "own":
            return f"{L['breakfast']}: {L['own']}"
        return f"{L['breakfast']}: {T(c.name(d.breakfast_id))}" if d.breakfast_id else ""
    if r == "hotel":
        return f"{L['checkin']}: {T(c.name(d.hotel_id))}" if d.hotel_id else ""
    if r in ("lunch", "dinner"):
        mode, vid = (d.lunch_mode, d.lunch_id) if r == "lunch" else (d.dinner_mode, d.dinner_id)
        if mode == "own":
            return f"{L[r]}: {L['own']}"
        return f"{L[r]}: {T(c.name(vid))}" if vid else ""
    if r.startswith("extra:"):
        slot = next((e for e in d.extras if e.id == r[6:]), None)
        s = c.services.get(slot.service_id) if slot else None
        if s:
            return T(s.vendor.name) if s.vendor and s.category in ("ticket", "activity") else T(s.name)
        return T(x.title) if x.title else ""
    return T(x.title) if x.title else ""
