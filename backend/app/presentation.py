"""A tour's presentation for the client: a cover, the route on a map, a page per day with photos of its town,
sights and hotel, the hotels, what's included and (if wanted) the price. Shown by link (/present/<token>) and
printed to PDF from the browser.

Photos: the agency's own (uploaded in the catalogue or here), else a free photo from Wikimedia Commons with its
author and licence - the main image of the Wikipedia article of that town or sight, taken only when the article
is really about it (its title is the name), so a vague name gets no photo rather than a wrong one.
"""
import html
import re
from datetime import date

import httpx
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import geo, programme
from .models import Photo, Service, Tour, Vendor, Workspace

Day = date      # the type, for a field that is itself called "date"
WIKI = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
MAX_AUTO = 24          # new Wikimedia searches per presentation (the rest come next time)

LABELS: dict[str, dict[str, str]] = {
    "en": {"for": "Prepared for {client}", "route": "The route", "days": "{n} days", "nights": "{n} nights", "km": "{n} km",
           "night": "1 night", "day": "Day {n}", "hotels": "Hotels", "included": "Included", "price": "Price per person", "photos": "Photos",
           "save_pdf": "Save as PDF", "overnight": "Overnight", "people": "{n} people", "end": "End of the tour",
           "inc_nights": "Hotel nights: {n}", "inc_breakfast": "Breakfasts: {n}", "inc_lunch": "Lunches: {n}",
           "inc_dinner": "Dinners: {n}", "inc_guide": "Guide", "inc_transport": "Transport throughout the tour"},
    "ka": {"for": "მომზადებულია {client}-სთვის", "route": "მარშრუტი", "days": "{n} დღე", "nights": "{n} ღამე", "km": "{n} კმ",
           "night": "1 ღამე", "day": "დღე {n}", "hotels": "სასტუმროები", "included": "ფასში შედის", "price": "ფასი ერთ ადამიანზე", "photos": "ფოტოები",
           "save_pdf": "PDF-ად შენახვა", "overnight": "ღამისთევა", "people": "{n} ადამიანი", "end": "ტურის დასასრული",
           "inc_nights": "ღამე სასტუმროში: {n}", "inc_breakfast": "საუზმე: {n}", "inc_lunch": "სადილი: {n}",
           "inc_dinner": "ვახშამი: {n}", "inc_guide": "გიდი", "inc_transport": "ტრანსპორტი მთელი ტურის განმავლობაში"},
    "zh": {"for": "为 {client} 准备", "route": "行程路线", "days": "{n}天", "nights": "{n}晚", "km": "{n}公里",
           "night": "1晚", "day": "第{n}天", "hotels": "酒店", "included": "费用包含", "price": "每人价格", "photos": "图片",
           "save_pdf": "保存为PDF", "overnight": "住宿", "people": "{n}人", "end": "行程结束",
           "inc_nights": "{n}晚酒店住宿", "inc_breakfast": "{n}次早餐", "inc_lunch": "{n}次午餐",
           "inc_dinner": "{n}次晚餐", "inc_guide": "导游", "inc_transport": "全程交通"},
}


# --- Wikimedia -----------------------------------------------------------------------------------------

def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^\w]+", " ", s.lower()).split())


# Words that say what kind of place it is, not which: "Narikala Fortress" is the article "Narikala".
_KIND = {"fortress", "castle", "monastery", "church", "cathedral", "temple", "park", "national", "viewpoint", "museum",
         "lake", "canyon", "cave", "valley", "complex", "old", "town", "city", "village", "the"}


def _core(s: str) -> str:
    words = _norm(s).split()
    return " ".join(w for w in words if w not in _KIND) or " ".join(words)


def _plain(h: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", h or "")).split())


def short_author(artist: str) -> str:
    """An author's name, not the note some put in that field ("This Photo was taken by X. Feel free to use...")."""
    a = artist.strip()
    m = re.search(r"(?:taken|photo(?:graph)?(?:ed)?|made) by ([^.(,]+)", a, re.I)
    if m:
        a = m.group(1)
    a = re.split(r"(?<=[a-z]{2})\. |\(|\n", a)[0].strip()      # "U.S. Navy" stays whole
    return a if len(a) <= 50 else a[:47].rsplit(" ", 1)[0] + "…"


def _credit(meta: dict) -> str:
    artist = short_author(_plain((meta.get("Artist") or {}).get("value", "")))
    licence = _plain((meta.get("LicenseShortName") or {}).get("value", ""))
    return " · ".join(x for x in (artist, licence) if x)[:300]


def _files(client: httpx.Client, titles: list[str] | None = None, search: str | None = None, limit: int = 8) -> list[dict]:
    """Commons files (by title, or found by words): the photo (1600 px), a small one, author and licence, its page."""
    params = {"action": "query", "format": "json", "prop": "imageinfo", "iiprop": "url|extmetadata|mime", "iiurlwidth": 1600}
    if titles:
        params["titles"] = "|".join(titles)
    else:
        params.update({"generator": "search", "gsrnamespace": 6, "gsrlimit": limit, "gsrsearch": f"{search} filetype:bitmap"})
    try:
        data = client.get(COMMONS, params=params).json()
    except (httpx.HTTPError, ValueError):
        return []
    pages = sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    out = []
    for p in pages:
        ii = (p.get("imageinfo") or [{}])[0]
        url = ii.get("thumburl") or ii.get("url")
        if not url or not str(ii.get("mime", "")).startswith("image/") or ii.get("mime") == "image/svg+xml":
            continue
        out.append({"url": url, "thumb": url.replace("/1600px-", "/480px-"), "credit": _credit(ii.get("extmetadata") or {}),
                    "link": ii.get("descriptionurl", ""), "title": p.get("title", "")})
    return out


def wiki_photo(client: httpx.Client, name: str) -> dict | None:
    """The main free image of the Wikipedia article about this town or sight - only if the article is about it."""
    try:
        data = client.get(WIKI, params={"action": "query", "format": "json", "generator": "search", "gsrsearch": name,
                                        "gsrlimit": 3, "prop": "pageimages", "piprop": "name", "pilicense": "free"}).json()
    except (httpx.HTTPError, ValueError):
        return None
    want = _core(name)
    for p in sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 0)):
        title = _core(p.get("title", ""))
        if want and (title == want or title.startswith(want + " ")) and p.get("pageimage") and not p["pageimage"].lower().endswith(".svg"):
            found = _files(client, titles=[f"File:{p['pageimage']}"])
            return found[0] if found else None
    return None


def search(name: str, limit: int = 8) -> list[dict]:
    """Free photos on Wikimedia Commons for these words (to pick one by hand)."""
    with httpx.Client(timeout=10, headers=geo.HEADERS) as client:
        return _files(client, search=name, limit=limit)


# --- what a tour shows ----------------------------------------------------------------------------------

class PPhoto(BaseModel):
    id: str
    url: str
    thumb: str
    credit: str = ""
    link: str = ""
    source: str = "upload"


class PSubject(BaseModel):
    """A town, sight or hotel of a day, with its photo (if any)."""
    kind: str                       # town | sight | hotel
    name: str
    vendor_id: str | None = None
    place: str = ""                 # geo.key of the name (a town or sight not in the catalogue)
    photo: PPhoto | None = None


def _subjects(db: Session, ws: Workspace, body: programme.ProgrammeIn) -> list[list[PSubject]]:
    """Each day's town, sights (in the order of the day) and hotel - as named in the agency's data."""
    plan = programme.build(db, ws, body.model_copy(update={"translate": False, "lang": "en"}), fill=True)
    vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id))}
    by_name = {v.name.strip().lower(): v for v in vendors.values() if v.type in ("activity", "other")}
    out: list[list[PSubject]] = []
    for d, p in zip(body.days, plan.days):
        day = [PSubject(kind="town", name=d.city, place=geo.key(d.city))] if d.city.strip() else []
        seen = {geo.key(d.city)}
        for s in p.steps:
            if s.kind != "visit":
                continue
            name = (s.place or s.text).strip()
            v = by_name.get(name.lower())
            k = geo.key(name)
            if not name or k in seen:
                continue
            seen.add(k)
            day.append(PSubject(kind="sight", name=name, vendor_id=v.id if v else None, place=k))
        if d.hotel_id and d.hotel_id in vendors:
            day.append(PSubject(kind="hotel", name=vendors[d.hotel_id].name, vendor_id=d.hotel_id))
        out.append(day)
    return out


def _photos(db: Session, ws_id: str, subjects: list[list[PSubject]]) -> dict[str, list[Photo]]:
    """Photos by vendor id and by place key, main one first (records of 'nothing found' left out)."""
    vids = {s.vendor_id for day in subjects for s in day if s.vendor_id}
    places = {s.place for day in subjects for s in day if s.place}
    rows = db.scalars(select(Photo).where(Photo.workspace_id == ws_id,
                                          (Photo.vendor_id.in_(vids)) | (Photo.place.in_(places)))
                      .order_by(Photo.position, Photo.created_at)).all() if (vids or places) else []
    out: dict[str, list[Photo]] = {}
    for r in rows:
        if r.url or r.storage_key:
            out.setdefault(r.vendor_id or f"place:{r.place}", []).append(r)
    return out


def photo_of(s: PSubject, photos: dict[str, list[Photo]]) -> Photo | None:
    got = (photos.get(s.vendor_id or "") or []) + (photos.get(f"place:{s.place}") or [] if s.place else [])
    return got[0] if got else None


def fill_missing(db: Session, ws: Workspace, subjects: list[list[PSubject]]) -> int:
    """Wikimedia photos for the towns and sights without any (hotels and restaurants: the agency's own only).
    Remembered, found or not, so each name is searched once. Returns how many were found."""
    want = {}
    for day in subjects:
        for s in day:
            if s.kind in ("town", "sight") and s.place:
                want.setdefault(s.place, s)
    if not want:
        return 0
    done = {r.place for r in db.scalars(select(Photo).where(Photo.workspace_id == ws.id, Photo.place.in_(want)))}
    have_vendor = {r.vendor_id for r in db.scalars(select(Photo).where(
        Photo.workspace_id == ws.id, Photo.vendor_id.in_({s.vendor_id for s in want.values() if s.vendor_id})))} if want else set()
    found = asked = 0
    with httpx.Client(timeout=10, headers=geo.HEADERS) as client:
        for k, s in want.items():
            if k in done or (s.vendor_id and s.vendor_id in have_vendor):
                continue
            if asked >= MAX_AUTO:
                break
            asked += 1
            hit = wiki_photo(client, s.name)
            db.add(Photo(workspace_id=ws.id, place=k, source="wikimedia", auto=True,
                         **({"url": hit["url"], "thumb": hit["thumb"], "credit": hit["credit"], "link": hit["link"]} if hit else {})))
            found += bool(hit)
    db.commit()
    return found


# --- the presentation ----------------------------------------------------------------------------------

class PDayOut(BaseModel):
    number: int
    date: Day | None = None
    route: list[str] = []
    km: int | None = None
    drive: str = ""
    hotel: str = ""
    steps: list[programme.PStep] = []
    flights: list[str] = []
    subjects: list[PSubject] = []


class PHotel(BaseModel):
    name: str
    nights: int
    photo: PPhoto | None = None


class PresentationOut(BaseModel):
    title: str
    start: Day | None = None
    end: Day | None = None
    agency: str
    client: str = ""
    people: int | None = None
    lang: str
    labels: dict[str, str]
    cover: PPhoto | None = None
    points: list[dict] = []          # the route on the map: {name, lat, lon, day}
    roads: list[str] = []            # encoded polylines between them
    days: list[PDayOut]
    hotels: list[PHotel] = []
    included: list[str] = []
    price: str = ""                  # "1,590 USD" when shown
    total_km: int = 0


def build(db: Session, ws: Workspace, body: programme.ProgrammeIn, tour: Tour | None, show_price: bool,
          photo_url) -> PresentationOut:
    """`photo_url(photo)`: where an uploaded photo is served (the office's or the link's address)."""
    lang = body.lang if body.lang in programme.LANGS else "en"
    L = LABELS[lang]
    subjects = _subjects(db, ws, body)
    photos = _photos(db, ws.id, subjects)
    shown = programme.build(db, ws, body, fill=True)
    names = {s.name for day in subjects for s in day}
    tr = programme.translate(db, ws, names, lang, []) if lang != "en" or body.translate else {}

    def out(p: Photo | None) -> PPhoto | None:
        if p is None:
            return None
        url = p.url or photo_url(p)
        return PPhoto(id=p.id, url=url, thumb=p.thumb or url, credit=p.credit, link=p.link, source=p.source)

    days: list[PDayOut] = []
    for pd, day in zip(shown.days, subjects):
        days.append(PDayOut(number=pd.number, date=pd.date, route=pd.route, km=pd.km, drive=pd.drive, hotel=pd.hotel,
                            steps=[s for s in pd.steps if s.text], flights=pd.flights,
                            subjects=[s.model_copy(update={"name": tr.get(s.name, s.name), "photo": out(photo_of(s, photos))})
                                      for s in day]))
    # The cover: the tour's first sight with a photo, else a town's.
    cover = next((s.photo for k in ("sight", "town") for d in days for s in d.subjects if s.kind == k and s.photo), None)
    # Each hotel once, in the order first stayed, with all its nights (Tbilisi at the start and again later).
    hotels: dict[str, PHotel] = {}
    for d in days:
        h = next((s for s in d.subjects if s.kind == "hotel"), None)
        if h is not None:
            hotels.setdefault(h.name, PHotel(name=h.name, nights=0, photo=h.photo)).nights += 1
    # The route on the map: each day's stops, then its town.
    path = [(x, d.number) for d, src in zip(days, body.days) for x in [*src.stops, src.city] if x and x.strip()]
    path = [x for i, x in enumerate(path) if i == 0 or geo.key(x[0]) != geo.key(path[i - 1][0])]
    points, roads = [], []
    if len(path) >= 2:
        m = geo.path_map(db, [x for x, _ in path], ws.countries or None, ws.id, roads=True)
        points = [{"name": tr.get(n, n), "lat": pt["lat"], "lon": pt["lon"], "day": dn}
                  for (n, dn), pt in zip(path, m["points"]) if pt["lat"] is not None]
        roads = [r["polyline"] for r in m["roads"] if r.get("polyline")]
    included = _included(db, body, tour, L)
    price = ""
    if show_price and tour is not None and tour.price_pp:
        price = f"{tour.price_pp:,.0f} {tour.price_currency or ws.base_currency}"
    return PresentationOut(
        title=(tour.name or shown.title) if tour else shown.title, start=tour.start_date if tour else body.start_date,
        end=tour.end_date if tour else None, agency=ws.name, client=(tour.client.name if tour and tour.client else ""),
        people=(tour.pax or None) if tour else body.people, lang=lang, labels=L, cover=cover, points=points, roads=roads,
        days=days, hotels=list(hotels.values()), included=included, price=price, total_km=shown.total_km)


def _included(db: Session, body: programme.ProgrammeIn, tour: Tour | None, L: dict[str, str]) -> list[str]:
    """What the price covers, counted from the days: nights, meals, the team, the activities."""
    n = len(body.days)
    nights = sum(1 for i, d in enumerate(body.days) if d.hotel_id and i < n - 1)
    breakfasts = sum(1 for i, d in enumerate(body.days) if i > 0 and d.breakfast_mode in ("hotel", "included"))
    lunches = sum(1 for d in body.days if d.lunch_mode == "included" and d.lunch_id)
    dinners = sum(1 for d in body.days if d.dinner_mode == "included" and d.dinner_id)
    out = [L[k].format(n=v) for k, v in (("inc_nights", nights), ("inc_breakfast", breakfasts),
                                           ("inc_lunch", lunches), ("inc_dinner", dinners)) if v]
    roles = {a.role for a in tour.staff} if tour else set()
    if "guide" in roles:
        out.append(L["inc_guide"])
    if roles & {"transport", "driver"}:
        out.append(L["inc_transport"])
    sids = {e.service_id for d in body.days for e in d.extras if not e.optional}
    if sids:
        for s in db.scalars(select(Service).where(Service.id.in_(sids))):
            if s.category not in ("transport", "guide", "meal", "hotel"):
                name = f"{s.vendor.name}: {s.name}" if s.vendor and s.vendor.name.lower() not in s.name.lower() else s.name
                if name not in out:
                    out.append(name)
    return out
