"""A tour's or route's day-by-day programme for clients and partners - in English, Georgian or Chinese.

Built from the days as they are on screen (saved or a draft): the day's route through its places, road km and
coach driving time, the hotel, meals, activities and tickets, the timed programme, flights and notes. No prices,
supplier contacts or team details. The fixed words come from LABELS; the agency's own texts (place and hotel
names, programme steps, notes) are translated by AI when they're in another language, and every translation is
kept (TextTranslation), so a text is paid for once.
"""
import hashlib
import json
import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta

Day = date      # the type, for a field that is itself called "date"
from decimal import Decimal
from urllib.parse import quote

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from . import dishes as dish_util, geo, seating
from .config import settings
from .models import Service, TextTranslation, Tour, Vendor, Workspace
from .schemas import DayFields, ScheduleItem

LANGS = ("en", "ka", "zh")
LANG_NAME = {"en": "English", "ka": "Georgian", "zh": "Simplified Chinese"}

def _same_place(a: str, b: str) -> bool:
    """'Gelati' and 'Gelati Monastery': one name starts the other (as the catalogue matches stops)."""
    a, b = a.casefold().strip(), b.casefold().strip()
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 4 and (long_ == short or long_.startswith(short + " ") or long_.startswith(short + ","))


def tbd_town(d, meal: str) -> str:
    """Where an included lunch or dinner with no place chosen yet will be - so a programme sent out says
    "TBD · Yerevan" instead of leaving the meal out: the town marked for it, else lunch at the day's first stop
    (on the way) or in its town, dinner in the night's town. Empty when the meal has a place or is the group's own."""
    mode, vid = (d.lunch_mode, d.lunch_id) if meal == "lunch" else (d.dinner_mode, d.dinner_id)
    if mode == "own" or vid:
        return ""
    marked = (getattr(d, "meal_tbd", None) or {}).get(meal)
    if marked:
        return marked
    return ((d.stops or [""])[0] if meal == "lunch" else "") or d.city or ""


LABELS: dict[str, dict[str, str]] = {
    "en": {"day": "Day {n}", "programme": "Programme", "route": "Route", "distance": "Distance", "driving": "Driving",
           "overnight": "Overnight", "meals": "Meals", "breakfast": "Breakfast", "lunch": "Lunch", "tbd": "TBD", "dinner": "Dinner",
           "activities": "Activities and tickets", "optional": "optional", "own": "own arrangements",
           "tourists": "paid on the spot", "at_hotel": "at the hotel", "arrival": "Arrival", "departure": "Departure",
           "border": "Border crossing", "notes": "Notes", "km": "km", "h": "h", "min": "min", "total": "Total distance",
           "days": "{n} days", "checkin": "Check-in", "free": "Free time", "transfer": "Transfer", "no_hotel": "End of the tour", "tab_days": "Days", "tab_menu": "Menu", "map": "Map", "day_map": "The day on the map", "today": "Today", "no_menu": "Menu not chosen yet", "people": "{n} people", "jump": "Go to day", "table_group": "Group", "table_staff": "Staff", "role_leader": "tour leader", "role_guide": "guide", "role_driver": "driver", "role_assistant": "assistant", "role_guest": "guest", "plates_word": "plates", "portions_word": "portions", "plates": "{n} plates", "portions": "{n} portions"},
    "ka": {"day": "დღე {n}", "programme": "პროგრამა", "route": "მარშრუტი", "distance": "მანძილი", "driving": "გზაში",
           "overnight": "ღამისთევა", "meals": "კვება", "breakfast": "საუზმე", "lunch": "სადილი", "tbd": "დასაზუსტებელია", "dinner": "ვახშამი",
           "activities": "აქტივობები და ბილეთები", "optional": "სურვილისამებრ", "own": "საკუთარი ხარჯით",
           "tourists": "ადგილზე გადახდით", "at_hotel": "სასტუმროში", "arrival": "ჩამოფრენა", "departure": "გაფრენა",
           "border": "საზღვრის კვეთა", "notes": "შენიშვნები", "km": "კმ", "h": "სთ", "min": "წთ", "total": "სულ მანძილი",
           "days": "{n} დღე", "checkin": "შესახლება", "free": "თავისუფალი დრო", "transfer": "გადაადგილება", "no_hotel": "ტურის დასასრული", "tab_days": "დღეები", "tab_menu": "მენიუ", "map": "რუკა", "day_map": "დღის მარშრუტი რუკაზე", "today": "დღეს", "no_menu": "მენიუ ჯერ არ არის არჩეული", "people": "{n} ადამიანი", "jump": "დღეზე გადასვლა", "table_group": "ჯგუფი", "table_staff": "პერსონალი", "role_leader": "ტურლიდერი", "role_guide": "გიდი", "role_driver": "მძღოლი", "role_assistant": "ასისტენტი", "role_guest": "სტუმარი", "plates_word": "თეფში", "portions_word": "პორცია", "plates": "{n} თეფში", "portions": "{n} პორცია"},
    "zh": {"day": "第{n}天", "programme": "行程", "route": "路线", "distance": "距离", "driving": "车程",
           "overnight": "住宿", "meals": "餐食", "breakfast": "早餐", "lunch": "午餐", "tbd": "待定", "dinner": "晚餐",
           "activities": "活动与门票", "optional": "自选", "own": "自理", "tourists": "现场自付", "at_hotel": "酒店内",
           "arrival": "抵达", "departure": "离开", "border": "过境", "notes": "备注", "km": "公里", "h": "小时", "min": "分钟",
           "total": "总里程", "days": "{n}天", "checkin": "入住", "free": "自由活动", "transfer": "交通", "no_hotel": "行程结束", "tab_days": "行程", "tab_menu": "菜单", "map": "地图", "day_map": "当天路线图", "today": "今天", "no_menu": "尚未选定菜单", "people": "{n}人", "jump": "跳转到某天", "table_group": "团队", "table_staff": "工作人员", "role_leader": "领队", "role_guide": "导游", "role_driver": "司机", "role_assistant": "助理", "role_guest": "客人", "plates_word": "盘", "portions_word": "份", "plates": "{n}盘", "portions": "{n}份"},
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
    phones: bool = True              # the phone of each hotel, restaurant and place (a call button on the web page)


class ProgrammeIn(BaseModel):
    title: str = ""
    start_date: date | None = None
    days: list[DayFields]
    lang: str = "en"
    include: Include = Include()
    translate: bool = True
    only_days: list[int] | None = None       # the day numbers to put in the file; None = every day
    people: int | None = Field(default=None, ge=1, le=500)       # who eats: each dish's plates (portions)
    plate_share: int | None = Field(default=None, ge=1, le=20)   # the tour's people per plate (else the agency's)
    tour_id: str | None = None       # a tour's programme: its group, tour leaders, staff of each day and staff table


class PTable(BaseModel):
    """A table at a meal: the group's, or the staff's (tour leaders, guide, driver) when they eat apart."""
    who: str                         # "all" (one table), "group", "staff"
    people: int
    roles: list[str] = []            # who sits there besides the group: "tour leader", "guide", "2 drivers"


class PDish(BaseModel):
    """One dish of a set menu and how much of it: "Khinkali · 3 plates (1 plate for 4)"."""
    name: str
    plates: int | None = None        # plates (portions) for the group; None when the group size isn't known
    per_plate: int = 1               # people sharing one plate (1 = everyone their own portion)
    plates_at: list[int] = []        # plates for each of the step's tables, in order


class PStep(BaseModel):
    time: str = ""
    end: str = ""
    text: str
    drive: "PLeg | None" = None      # the drive that leads to this step (km, time), shown just before it
    note: str = ""                   # under it: a meal's menu ("Khinkali, Mtsvadi, Salad")
    kind: str = ""                   # breakfast, meal, visit, checkin, flight, free, arrive (the day's town)…
    meal: str = ""                   # breakfast / lunch / dinner: the meal this step is (its order, on the guide's page)
    map: str = ""                    # the place on Google Maps
    phone: str = ""                  # the place's phone (hotel, restaurant, sight)
    dishes: list[PDish] = []         # a meal's menu, dish by dish, with its plates
    place: str = ""                  # the hotel / restaurant / place it is at ("Svan Tower Tavern")
    menu: str = ""                   # the set menu's name ("Georgian supra"), when one is chosen
    tables: list[PTable] = []        # who eats, table by table (the dishes' plates_at follow this order)
    memo: str = ""                   # the step's own note, written in the timeline ("Bring swimsuits")


class PLeg(BaseModel):
    """One drive between two places of the day: "Tbilisi → Mtskheta · 25 km · 35 min"."""
    start: str
    end: str
    km: int | None = None
    drive: str = ""
    minutes: int = 0                 # coach minutes (rounded to 5)
    map: str = ""                    # the road on Google Maps (from → to)
    depart: str = ""                 # when the drive starts and ends: "08:30" → "10:00"
    arrive: str = ""


PStep.model_rebuild()


class PDay(BaseModel):
    number: int
    date: Day | None = None
    title: str                       # "Day 1 · Tbilisi → Mtskheta → Gudauri"
    route: list[str] = []
    km: int | None = None
    drive: str = ""                  # "2 h 30 min" (coach)
    legs: list[PLeg] = []            # place to place, with km and time
    map: str = ""                    # the whole day's road on Google Maps (every place on the way)
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
    # A name the agency set itself (Settings → Place names) is used even when the text is already in that
    # language ("Tbilisi" → "Tbilisi, the capital"); the AI is only asked for texts in another language.
    every = sorted(t for t in texts if t and re.search(r"[^\W\d_]", t))
    todo = [t for t in every if _needs(t, lang)]
    key = lambda t: hashlib.sha1(t.encode()).hexdigest()
    kept = {r.source_hash: r.result for r in db.scalars(select(TextTranslation).where(
        TextTranslation.workspace_id == ws.id, TextTranslation.lang == lang,
        TextTranslation.source_hash.in_([key(t) for t in every])))} if every else {}
    out = {t: kept[key(t)] for t in every if key(t) in kept}
    if not todo:
        return out
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

def _hm(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _clock(n: int) -> str:
    n = max(0, min(n, 23 * 60 + 55))
    return f"{n // 60:02d}:{n % 60:02d}"


def _time_the_drives(steps: list[PStep]) -> None:
    """Each drive's own time window: from when the stop before it ends to when the next one starts
    ("13:45–18:00 ↓ 218 km · 7 h"). Without one of the two ends, the coach time fills it in; the drive
    to the day's town at the end gives that arrival its time."""
    # A meal with no place of its own (lunch on their own) between two places, reached by the drive's end:
    # the group eats where it arrives, so the drive leads to the meal - not to the place after it (no idle
    # morning, no squeezed road). A meal before a long drive (lunch, then the road on) keeps the road after it.
    for k in range(2, len(steps)):
        q, p, s = steps[k - 2], steps[k - 1], steps[k]
        left = q.end or q.time
        if (s.drive and not p.drive and not p.place and p.kind in ("meal", "free") and p.time and left
                and _hm(left) < _hm(p.time) and _hm(left) + s.drive.minutes <= _hm(p.time) + 30):
            p.drive, s.drive = s.drive, None
    prev_end = ""
    for s in steps:
        g = s.drive
        if g:
            depart = prev_end or (_clock(_hm(s.time) - g.minutes) if s.time and g.minutes else "")
            arrive = s.time or (_clock(_hm(prev_end) + g.minutes) if prev_end and g.minutes else "")
            if s.kind == "flight" and s.time:
                # To a flight home: at the airport 2 hours before it, leaving just in time for that.
                arrive = _clock(_hm(s.time) - 120)
                depart = _clock(max(_hm(arrive) - max(g.minutes, 15), _hm(prev_end) if prev_end else 0))
            if depart and arrive and _hm(arrive) >= _hm(depart):
                g.depart, g.arrive = depart, arrive
            if s.kind == "arrive" and g.arrive:
                s.time = g.arrive
        prev_end = s.end or s.time or prev_end


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
            elif (d.meal_tbd or {}).get(r):
                # No restaurant (yet, or they eat on their own): the town or place given counts for the road.
                push(d.meal_tbd[r], d.meal_tbd[r], x.id)
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


def _place_of(x, d: DayFields, prev: DayFields | None, vendors: dict[str, Vendor], services: dict[str, Service]) -> str:
    """What the map should look for at a step that is a hotel, restaurant or activity place: its name and
    address ("Imereti Family Kitchen, Kutaisi") - more precise than the town."""
    v = _vendor_of(x, d, prev, vendors, services)
    if v is None and x.ref in ("lunch", "dinner"):
        # Still to decide, or on their own: the town or place given for it.
        return tbd_town(d, x.ref) or (d.meal_tbd or {}).get(x.ref, "")
    return ", ".join(p for p in (v.name, v.address or v.city) if p) if v else ""


def _vendor_of(x, d: DayFields, prev: DayFields | None, vendors: dict[str, Vendor], services: dict[str, Service]) -> Vendor | None:
    """The hotel, restaurant or place a step is at (breakfast at the hotel: where the group slept)."""
    r = x.ref or ""
    vid = None
    if r == "breakfast":
        vid = (prev.hotel_id if prev else None) if d.breakfast_mode == "hotel" else d.breakfast_id if d.breakfast_mode != "own" else None
    elif r == "hotel":
        vid = d.hotel_id
    elif r in ("lunch", "dinner"):
        vid = None if (d.lunch_mode if r == "lunch" else d.dinner_mode) == "own" else d.lunch_id if r == "lunch" else d.dinner_id
    elif r.startswith("extra:"):
        slot = next((e for e in d.extras if e.id == r[6:]), None)
        s = services.get(slot.service_id) if slot else None
        vid = s.vendor_id if s else None
    elif not r and x.kind == "visit":
        sight = _sight(x.title, vendors)
        vid = sight.id if sight else None
    return vendors.get(vid or "")


def map_search(where: str) -> str:
    return f"https://www.google.com/maps/search/?api=1&query={quote(where)}" if where else ""


def map_day(places: list[str]) -> str:
    """The day's road through all its places (Google takes up to 9 places on the way)."""
    ps = [x for x in places if x]
    if len(ps) < 2:
        return ""
    via = "|".join(ps[1:-1][:9])
    return map_route(ps[0], ps[-1]) + (f"&waypoints={quote(via)}" if via else "")


def map_route(a: str, b: str) -> str:
    return f"https://www.google.com/maps/dir/?api=1&origin={quote(a)}&destination={quote(b)}&travelmode=driving" if a and b else ""


# --- the suggested programme (the day plan's `suggest` and `withEnds`, DayProgramme.tsx) ----------------------

USUAL_LEN = {"breakfast": 30, "meal": 45, "visit": 60, "transfer": 30, "free": 60, "checkin": 30, "checkout": 15, "flight": 0, "other": 30}


def _item(**kw) -> ScheduleItem:
    return ScheduleItem(id=uuid.uuid4().hex[:12], **kw)


def suggest(d: DayFields, index: int, last: bool, services: dict[str, Service], factor: float = 1.25) -> list[ScheduleItem]:
    """A day without its own programme gets what the day plan suggests: breakfast at 08:00, leave at 09:00
    and drive to each stop (an hour there), lunch after 12:30, the hotel on arrival, dinner at 19:30."""
    out: list[ScheduleItem] = []
    hm = lambda t: f"{min(t, 23 * 60 + 45) // 60:02d}:{min(t, 23 * 60 + 45) % 60:02d}"
    for k, f in enumerate(d.flights):
        if f.direction == "arrival":
            out.append(_item(kind="flight", time=f.time, ref=f"flight:{k}", place=f.airport))
    bmode = d.breakfast_mode or "hotel"
    if bmode != "own" and (index > 0 or (bmode != "hotel" and d.breakfast_id)):
        out.append(_item(kind="breakfast", time="08:00", ref="breakfast"))
    places = [*d.stops, d.city]
    legs = list(d.drive_minutes)
    timed = 0 < len(legs) <= len(places)

    def drive_to(p: int) -> int:
        k = p - (len(places) - len(legs))
        return int(round(legs[k] * factor / 15) * 15) if timed and k >= 0 else 0

    at = 9 * 60 if timed else 9 * 60 + 30
    lunched = False

    def lunch() -> None:
        nonlocal at, lunched
        if lunched:
            return
        lunched = True
        time = hm(max(13 * 60, at))
        if d.lunch_mode == "own":
            out.append(_item(kind="free", time=time, ref="lunch"))
        elif d.lunch_id or tbd_town(d, "lunch"):
            out.append(_item(kind="meal", time=time, ref="lunch"))
        else:
            return
        at = max(13 * 60, at) + 90

    seen: set[str] = set()

    def activity_at(stop: str):
        """The day's activity at this stop's place (Gelati the stop, Gelati the ticket): one visit, not two."""
        for e in d.extras:
            s = services.get(e.service_id)
            if s and s.category not in ("transport", "guide", "meal") and s.vendor and _same_place(s.vendor.name, stop):
                return e, s
        return None

    for i, stop in enumerate(d.stops):
        at += drive_to(i)
        if at >= (12 * 60 + 30 if timed else 13 * 60):
            lunch()
        hit = activity_at(stop)
        if hit and hit[1].vendor_id not in seen:
            seen.add(hit[1].vendor_id)
            out.append(_item(kind="visit", time=hm(at), ref=f"extra:{hit[0].id}"))
        else:
            out.append(_item(kind="visit", time=hm(at), title=stop, place=stop))
        at += 60
    for e in d.extras:
        s = services.get(e.service_id)
        if s and s.category not in ("transport", "guide", "meal") and s.vendor_id not in seen:
            seen.add(s.vendor_id)                 # one visit per place
            out.append(_item(kind="visit", ref=f"extra:{e.id}"))
    if timed:
        if at >= 12 * 60:
            lunch()
        at += drive_to(len(places) - 1)
    lunch()
    checkin = max(14 * 60, math.ceil(at / 15) * 15) if timed else max(18 * 60, at)
    if d.hotel_id and not last:
        out.append(_item(kind="checkin", time=hm(checkin), ref="hotel"))
    dinner = hm(max(19 * 60 + 30, checkin + 90))
    # Flying home: no dinner after they must leave for the airport (2½ h before the flight).
    leaves = min((_hm(f.time) - 150 for f in d.flights if f.direction == "departure" and f.time), default=None)
    if leaves is None or _hm(dinner) <= leaves:
        if d.dinner_mode == "own":
            out.append(_item(kind="free", time=dinner, ref="dinner"))
        elif d.dinner_id or tbd_town(d, "dinner"):
            out.append(_item(kind="meal", time=dinner, ref="dinner"))
    for k, f in enumerate(d.flights):
        if f.direction == "departure":
            out.append(_item(kind="flight", time=f.time, ref=f"flight:{k}", place=f.airport))
    return out


def with_ends(d: DayFields, items: list[ScheduleItem], vendors: dict[str, Vendor], services: dict[str, Service]) -> list[ScheduleItem]:
    """Each timed step with its end: its activity's length, its place's usual visit, else the kind's."""
    def usual(x: ScheduleItem) -> int:
        if (x.ref or "").startswith("extra:"):
            slot = next((e for e in d.extras if e.id == x.ref[6:]), None)
            s = services.get(slot.service_id) if slot else None
            if s:
                v = vendors.get(s.vendor_id)
                return s.minutes or (v.visit_minutes if v else None) or USUAL_LEN[x.kind]
        sight = _sight(x.title, vendors) if x.kind == "visit" and not x.ref else None
        return (sight.visit_minutes if sight else None) or USUAL_LEN[x.kind]
    return [x.model_copy(update={"end": _clock(_hm(x.time) + usual(x))})
            if x.time and not x.end and x.kind in ("breakfast", "meal", "visit", "free", "other") else x for x in items]


@dataclass
class _Ctx:
    vendors: dict[str, Vendor]
    services: dict[str, Service]
    texts: set[str] = field(default_factory=set)

    def name(self, vid: str | None) -> str:
        v = self.vendors.get(vid or "")
        return v.name if v else ""


def build(db: Session, ws: Workspace, body: ProgrammeIn, *, fill: bool = False) -> ProgrammeOut:
    """`fill`: a day without its own programme gets the suggested one (the guide's page; the office's
    dialog sends it filled already)."""
    lang = body.lang if body.lang in LANGS else "en"
    L = LABELS[lang]
    inc = body.include
    vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id))}
    sids = {e.service_id for d in body.days for e in d.extras}
    services = {s.id: s for s in db.scalars(select(Service).join(Vendor).where(Vendor.workspace_id == ws.id, Service.id.in_(sids)))} if sids else {}
    if fill:
        f = float(ws.drive_factor or Decimal("1.25"))
        body = body.model_copy(update={"days": [
            d if d.schedule else d.model_copy(update={"schedule": with_ends(d, suggest(d, i, i == len(body.days) - 1, services, f), vendors, services)})
            for i, d in enumerate(body.days)]})
    # The menus of the day's meal places: the chosen set menu, else the place's usual one (its lunch /
    # dinner / breakfast price) - its dishes go under the restaurant.
    meal_places = {x for d in body.days for x in (d.breakfast_id, d.lunch_id, d.dinner_id) if x}
    menus: dict[str, list[Service]] = {}
    for s in db.scalars(select(Service).where(Service.vendor_id.in_(meal_places))) if meal_places else []:
        menus.setdefault(s.vendor_id, []).append(s)

    def dishes(d: DayFields, meal: str, summary: bool = False) -> str:
        # In the meals summary only when the timeline doesn't already show that meal with its menu.
        if summary and body.include.schedule and any(x.ref == meal for x in d.schedule):
            return ""
        vid, mid = getattr(d, f"{meal}_id"), getattr(d, f"{meal}_menu_id")
        if not vid:
            return ""
        own = menus.get(vid, [])
        m = next((s for s in own if s.id == mid), None)          # only a menu that was chosen (no "usual" dishes)
        names = [x["name"] for x in dish_util.normalize(dish_util.served(d, meal, m))]
        return ", ".join(T(n) for n in names)

    def menu_of(d: DayFields, meal: str) -> Service | None:
        vid, mid = getattr(d, f"{meal}_id"), getattr(d, f"{meal}_menu_id")
        own = menus.get(vid or "", [])
        return next((s for s in own if s.id == mid), None)       # no menu chosen: none

    # Who eats, table by table (app/seating.py): a tour's group (tour leaders are part of it) and that
    # day's guides and drivers, each with the group, at the staff table, or not with us - each table gets
    # its own plates (18 at 1 per 5 -> 4 plates; staff of 3 -> 1 more). Without a tour: the group size sent.
    group, plate_share, tour = body.people, body.plate_share, None
    if body.tour_id:
        from .finance import group_size
        tour = db.scalar(select(Tour).where(Tour.id == body.tour_id, Tour.workspace_id == ws.id)
                         .options(selectinload(Tour.staff), selectinload(Tour.participants)))
        if tour:
            group = group_size(tour) or group
            plate_share = plate_share or tour.plate_share

    def roles(c) -> list[str]:
        """["tour leader", "guide", "2 drivers"]: who is at a table besides the group."""
        return [f"{c[r]} {L['role_' + r]}" if c[r] > 1 else L["role_" + r] for r in ("leader", "guide", "driver", "assistant", "guest") if c[r]]

    def tables(n: int, meal: str) -> list[PTable]:
        if not group:
            return []
        if not tour:
            return [PTable(who="all", people=group)]
        seat = seating.tables(tour, n, group, meal)
        if not seat.staff:
            return [PTable(who="all", people=seat.group, roles=roles(seat.group_roles))]
        return [PTable(who="group", people=seat.group, roles=roles(seat.group_roles)),
                PTable(who="staff", people=seat.staff, roles=roles(seat.staff_roles))]

    def portions(d: DayFields, meal: str, at: list[PTable]) -> list[PDish]:
        """The meal's set menu dish by dish, with how many plates at each table."""
        m = menu_of(d, meal)
        out = []
        for x in dish_util.normalize(dish_util.served(d, meal, m)):
            per = dish_util.share_of(x, plate_share, ws.plate_share)
            each = [dish_util.plates(t.people, per) for t in at]
            out.append(PDish(name=T(x["name"]), per_plate=per, plates=sum(each) if at else None, plates_at=each))
        return out
    c = _Ctx(vendors, services)
    T = lambda s: (c.texts.add(s), s)[1] if s else s      # remember a text to translate
    days: list[PDay] = []
    total = 0
    for i, d in enumerate(body.days):
        if body.only_days and i + 1 not in body.only_days:
            continue                     # not asked for: no roads to work out (the day before is read from `body`)
        prev = body.days[i - 1] if i else None
        route = [T(x) for x in ([prev.city] if prev and prev.city and prev.city != d.city else []) + list(d.stops) + [d.city] if x]
        factor = ws.drive_factor or Decimal("1.25")
        stops, leg_km, leg_min = route, list(d.drive_km), list(d.drive_minutes)
        # With a day programme: destination to destination in its order (last night's town, each sight,
        # restaurant and the hotel) - the drives the day plan shows.
        path = _day_path(d, prev, vendors, i == len(body.days) - 1, lang) if d.schedule else []
        where_of = {step: q for q, _, step in path if step}       # each step's place, for its map button
        wheres = list(stops)                 # where the map looks for each place of `stops`
        ends: list[str | None] = []          # the step each drive leads to (None: the day's town)
        if inc.distance and len(path) >= 2:
            got = _map_legs(db, ws, [q for q, _, _ in path])
            if got:
                stops, (leg_km, leg_min) = [T(label) for _, label, _ in path], got
                wheres = [q for q, _, _ in path]
                ends = [step for _, _, step in path][1:]
        # Not saved on the day: the map's answer for the same road - what the day plan shows.
        if inc.distance and len(stops) >= 2 and len(leg_km) != len(stops) - 1:
            got = _map_legs(db, ws, stops)
            if got:
                leg_km, leg_min = got
        day_map = map_day(wheres) if len(wheres) >= 2 else ""
        km = d.km or (sum(leg_km) or None)
        total += km or 0
        drive = _drive(sum(leg_min), factor, L) if leg_min else ""
        p = PDay(number=i + 1, date=body.start_date + timedelta(days=i) if body.start_date else None,
                 title="", route=route, km=km if inc.distance else None, drive=drive if inc.distance else "", map=day_map)
        # Place to place, every leg of the day (in order).
        if inc.distance and len(stops) >= 2 and len(leg_km) == len(stops) - 1:
            for j, (a, b) in enumerate(zip(stops, stops[1:])):
                mins = leg_min[j] if j < len(leg_min) else 0
                coach = int(round(mins * float(factor) / 5) * 5) if mins else 0
                p.legs.append(PLeg(start=a, end=b, km=leg_km[j] or None, drive=_drive(mins, factor, L) if mins else "", minutes=coach,
                                   map=map_route(wheres[j], wheres[j + 1]) if j + 1 < len(wheres) else ""))
        last = i == len(body.days) - 1
        if inc.hotels:
            p.hotel = T(c.name(d.hotel_id)) or ("" if not last else "")
        if inc.meals:
            slept = c.name(prev.hotel_id) if prev else ""
            bmode = d.breakfast_mode
            if i > 0 and bmode == "hotel":
                p.meals.append((L["breakfast"], T(slept) or L["at_hotel"]))
            elif bmode in ("included", "tourists") and d.breakfast_id:
                menu = dishes(d, "breakfast", summary=True)
                p.meals.append((L["breakfast"], T(c.name(d.breakfast_id)) + (f" ({L['tourists']})" if bmode == "tourists" else "")
                                + (f": {menu}" if menu else "")))
            elif bmode == "own" and i > 0:
                p.meals.append((L["breakfast"], L["own"]))
            for meal, word, mode, vid in (("lunch", L["lunch"], d.lunch_mode, d.lunch_id), ("dinner", L["dinner"], d.dinner_mode, d.dinner_id)):
                if mode == "own":
                    where = (d.meal_tbd or {}).get(meal)
                    p.meals.append((word, L["own"] + (f" · {T(where)}" if where else "")))
                elif vid:
                    menu = dishes(d, meal, summary=True)
                    p.meals.append((word, T(c.name(vid)) + (f" ({L['tourists']})" if mode == "tourists" else "") + (f": {menu}" if menu else "")))
                elif tbd_town(d, meal):
                    p.meals.append((word, f"{L['tbd']} · {T(tbd_town(d, meal))}"))
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
                    meal = x.ref if x.ref in ("lunch", "dinner") else "breakfast" if x.ref == "breakfast" and d.breakfast_mode in ("included", "tourists") else ""
                    at = _vendor_of(x, d, prev, vendors, services)
                    p.steps.append(PStep(time=x.time, end=x.end, text=text, drive=to_step.get(x.id), kind=x.kind,
                                         phone=(at.phone or at.phone2) if at and inc.phones else "",
                                         memo=T(x.notes.strip()) if (x.notes or "").strip() else "",
                                         meal=x.ref if x.ref in ("breakfast", "lunch", "dinner") and x.kind != "free" else "",
                                         map=map_search(_place_of(x, d, prev, vendors, services) or where_of.get(x.id, "")),
                                         note=dishes(d, meal) if meal and inc.meals else "",
                                         dishes=portions(d, meal, tables(i + 1, meal)) if meal and inc.meals else [],
                                         tables=tables(i + 1, meal) if meal and inc.meals else [],
                                         place=T(at.name) if at else "",
                                         menu=T(m.name) if meal and inc.meals and (m := menu_of(d, meal)) and not m.code else ""))
            if ends and len(ends) == len(p.legs) and p.steps:
                p.steps += [PStep(text=g.end, drive=g, kind="arrive", map=map_search(wheres[j + 1]))
                            for j, (e, g) in enumerate(zip(ends, p.legs)) if e is None]
                p.legs = []
                _time_the_drives(p.steps)
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
        p.legs = [g.model_copy(update={"start": t(g.start), "end": t(g.end)}) for g in p.legs]
        p.hotel = t(p.hotel)
        p.meals = [(a, t(b) if b in tr else _tr_inside(b, tr)) for a, b in p.meals]
        p.activities = [_tr_inside(a, tr) for a in p.activities]
        p.steps = [s.model_copy(update={"text": _tr_inside(s.text, tr), "note": _tr_inside(s.note, tr) if s.note else "",
                                        "dishes": [x.model_copy(update={"name": t(x.name)}) for x in s.dishes],
                                        "place": t(s.place), "menu": t(s.menu), "memo": t(s.memo),
                                        "drive": s.drive.model_copy(update={"start": t(s.drive.start), "end": t(s.drive.end)}) if s.drive else None})
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
            where = (d.meal_tbd or {}).get(r)
            return f"{L[r]}: {L['own']}" + (f" · {T(where)}" if where else "")
        if not vid and tbd_town(d, r):
            return f"{L[r]}: {L['tbd']} · {T(tbd_town(d, r))}"
        return f"{L[r]}: {T(c.name(vid))}" if vid else ""
    if r.startswith("extra:"):
        slot = next((e for e in d.extras if e.id == r[6:]), None)
        s = c.services.get(slot.service_id) if slot else None
        if s:
            return T(s.vendor.name) if s.vendor and s.category in ("ticket", "activity") else T(s.name)
        return T(x.title) if x.title else ""
    return T(x.title) if x.title else ""
