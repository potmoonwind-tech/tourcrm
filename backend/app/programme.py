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


class PStep(BaseModel):
    time: str = ""
    end: str = ""
    text: str


class PDay(BaseModel):
    number: int
    date: Day | None = None
    title: str                       # "Day 1 · Tbilisi → Mtskheta → Gudauri"
    route: list[str] = []
    km: int | None = None
    drive: str = ""                  # "2 h 30 min" (coach)
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
    ids = {x for d in body.days for x in (d.hotel_id, d.breakfast_id, d.lunch_id, d.dinner_id) if x}
    vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id, Vendor.id.in_(ids)))} if ids else {}
    sids = {e.service_id for d in body.days for e in d.extras}
    services = {s.id: s for s in db.scalars(select(Service).join(Vendor).where(Vendor.workspace_id == ws.id, Service.id.in_(sids)))} if sids else {}
    c = _Ctx(vendors, services)
    T = lambda s: (c.texts.add(s), s)[1] if s else s      # remember a text to translate
    days: list[PDay] = []
    total = 0
    for i, d in enumerate(body.days):
        prev = body.days[i - 1] if i else None
        route = [T(x) for x in ([prev.city] if prev and prev.city and prev.city != d.city else []) + list(d.stops) + [d.city] if x]
        km = d.km if d.km is not None else (sum(d.drive_km) or None)
        total += km or 0
        drive = _drive(sum(d.drive_minutes), ws.drive_factor or Decimal("1.25"), L) if d.drive_minutes else ""
        p = PDay(number=i + 1, date=body.start_date + timedelta(days=i) if body.start_date else None,
                 title="", route=route, km=km if inc.distance else None, drive=drive if inc.distance else "")
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
            for x in d.schedule:
                text = _step_text(x, d, prev, c, L)
                if text:
                    p.steps.append(PStep(time=x.time, end=x.end, text=text))
        for f in d.flights:
            word = L["arrival"] if f.direction == "arrival" else L["departure"]
            p.flights.append(" ".join(x for x in (word, f.number, f.time, f.airport) if x))
        if d.border_crossing:
            p.border = T(d.border_crossing)
        if inc.notes and d.notes.strip():
            p.notes = T(d.notes.strip())
        days.append(p)

    warnings: list[str] = []
    tr = translate(db, ws, c.texts, lang, warnings) if body.translate else {}
    t = lambda s: tr.get(s, s)
    for p in days:
        p.route = [t(x) for x in p.route]
        p.hotel = t(p.hotel)
        p.meals = [(a, t(b) if b in tr else _tr_inside(b, tr)) for a, b in p.meals]
        p.activities = [_tr_inside(a, tr) for a in p.activities]
        p.steps = [PStep(time=s.time, end=s.end, text=_tr_inside(s.text, tr)) for s in p.steps]
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


def _step_text(x, d: DayFields, prev: DayFields | None, c: _Ctx, L: dict[str, str]) -> str:
    """One programme line, as the day programme shows it."""
    r = x.ref or ""
    T = lambda s: (c.texts.add(s), s)[1] if s else s
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
