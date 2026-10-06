"""Road distances between the cities of a route, from OpenStreetMap — as a suggestion.

- Where a place is: Nominatim (https://nominatim.openstreetmap.org). Its usage policy asks for
  a real User-Agent and at most one request per second, so lookups are paced and every answer
  is kept in `geo_places`.
- How far by road: OSRM (https://router.project-osrm.org), kept in `road_distances`.
- Names while typing: Photon (https://photon.komoot.io), made for search-as-you-type (Nominatim's
  policy forbids that). Picking a suggestion pins the name to that exact spot for the agency, so
  km and driving times use it ("Friendship Monument" → the one on the Georgian Military Road).

Both are public services with no account. Only place names and coordinates are sent — never
anything about a tour or a client. People can always correct the kilometres by hand.
"""
import math
import threading
import time
import unicodedata

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import GeoPlace, RoadDistance, utcnow

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OSRM = "https://router.project-osrm.org/route/v1/driving/{a};{b}"
PHOTON = "https://photon.komoot.io/api/"
HEADERS = {"User-Agent": "TourCRM/0.1 (group tour operations; contact: admin@tourcrm.app)"}
_last_call = [0.0]
_pace_lock = threading.Lock()
MAX_NEW_LOOKUPS = 12      # per request: more unknown places than this are left for the next click


class _Budget:
    def __init__(self, n: int):
        self.left = n
        self.pending: set[str] = set()      # names not asked because the per-request limit was used up


# The end of the map's address ("…, Kazbegi Municipality, Georgia") for the agency's countries.
COUNTRY_NAMES = {"ge": ("georgia",), "am": ("armenia",), "az": ("azerbaijan",), "tr": ("turkey", "türkiye"),
                 "ru": ("russia",), "ua": ("ukraine",), "kz": ("kazakhstan",), "uz": ("uzbekistan",),
                 "kg": ("kyrgyzstan",), "tj": ("tajikistan",), "tm": ("turkmenistan",), "ir": ("iran",),
                 "il": ("israel",), "jo": ("jordan",), "eg": ("egypt",), "ae": ("united arab emirates",),
                 "cn": ("china",), "gr": ("greece",), "it": ("italy",), "es": ("spain",), "fr": ("france",),
                 "de": ("germany",), "at": ("austria",), "ch": ("switzerland",), "pl": ("poland",),
                 "cz": ("czechia", "czech republic"), "hu": ("hungary",), "rs": ("serbia",), "me": ("montenegro",),
                 "al": ("albania",), "bg": ("bulgaria",), "ro": ("romania",), "md": ("moldova",), "by": ("belarus",)}


class _NoAsk(_Budget):
    """Look in what's kept only: asking the map without the limit would waste a lookup."""
    def __init__(self, parent: _Budget):
        super().__init__(0)
        self.pending = set()


def _in_countries(g: "GeoPlace", countries: list[str]) -> bool | None:
    """True/False from the address's last part; None when we can't tell (unknown country code)."""
    names = [n for c in countries for n in COUNTRY_NAMES.get(c, ())]
    if len(names) < len(countries) or not g.name:
        return None
    last = g.name.rsplit(",", 1)[-1].strip().casefold()
    return last in names


def key(name: str) -> str:
    """'  Tbilisi ' / 'TBILISI' → 'tbilisi' (accents kept apart from case and spaces)."""
    return unicodedata.normalize("NFC", " ".join(name.split())).casefold()[:120]


def _pace() -> None:
    with _pace_lock:            # one request a second across all users (Nominatim's rule)
        wait = 1.05 - (time.monotonic() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.monotonic()


ALL = "#all"          # marker: every place with this name is known (k, k#0, k#1...)
RANK_KM = 15          # prefer the map's first answer unless another one makes the route clearly shorter


def _km(a: GeoPlace, b: GeoPlace) -> float:
    """Straight-line distance (haversine)."""
    la1, lo1, la2, lo2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def candidates(db: Session, client: httpx.Client, name: str, budget: "_Budget | None" = None,
               countries: list[str] | None = None) -> list[GeoPlace]:
    """Every place the map knows by this name, the map's first answer first. Names repeat (a
    Khertvisi fortress near Vardzia, a Khertvisi village in Adjara), so all are kept. With the
    agency's countries the map searches only there (no "Friendship monument" in Tirana)."""
    cc = ",".join(sorted(countries or []))
    if cc and key(name):
        # Already known without the limit (most places are): keep the ones in the agency's countries.
        plain = candidates(db, client, name, _NoAsk(budget or _Budget(0)))
        known = [x for x in plain if _in_countries(x, countries or []) is True]
        if known:
            return known
    k = key(name)[:100] + (f"|{cc}" if cc and key(name) else "")
    if not k:
        return []
    hit = db.get(GeoPlace, k)
    if hit is not None and hit.lat is None:
        return []
    if db.get(GeoPlace, k + ALL) is not None:
        others = db.scalars(select(GeoPlace).where(GeoPlace.key.startswith(k + "#", autoescape=True),
                                                   GeoPlace.lat.is_not(None)).order_by(GeoPlace.key)).all()
        return [hit, *others] if hit is not None else list(others)
    if budget is not None:
        if budget.left <= 0:
            if hit is None:
                budget.pending.add(key(name))
            return [hit] if hit is not None else []
        budget.left -= 1
    _pace()
    try:
        r = client.get(NOMINATIM, params={"q": name, "format": "json", "limit": 8, "accept-language": "en",
                                          **({"countrycodes": cc} if cc else {})})
        r.raise_for_status()
        rows = [x for x in r.json() if x.get("lat") and x.get("lon")]
    except (httpx.HTTPError, ValueError):
        return [hit] if hit is not None else []      # not cached: try again next time
    found = [GeoPlace(key=f"{k}#{i}" if (i or hit is not None) else k, name=x.get("display_name", "")[:300],
                      lat=float(x["lat"]), lon=float(x["lon"]), fetched_at=utcnow()) for i, x in enumerate(rows)]
    for g in found:
        db.merge(g)
    if not found and hit is None:
        db.merge(GeoPlace(key=k, name="", lat=None, lon=None, fetched_at=utcnow()))
    db.merge(GeoPlace(key=k + ALL, name="", lat=None, lon=None, fetched_at=utcnow()))
    db.flush()
    return ([hit] if hit is not None else []) + found


NEAR_PAD = 0.6       # degrees (~60 km) around the neighbouring stops


def near(db: Session, client: httpx.Client, name: str, around: list["GeoPlace"], budget: "_Budget | None" = None) -> "GeoPlace | None":
    """The place with this name inside the area of the stops around it — "Friendship monument"
    between Ananuri and Stepantsminda is the one on the Georgian Military Road, not Tirana's.
    Kept per name and area; None when the map has nothing there either."""
    k = key(name)[:70]
    lats, lons = [float(g.lat) for g in around], [float(g.lon) for g in around]   # Decimal from the database
    box = (min(lons) - NEAR_PAD, max(lats) + NEAR_PAD, max(lons) + NEAR_PAD, min(lats) - NEAR_PAD)
    ck = f"{k}@{box[0]:.1f},{box[1]:.1f},{box[2]:.1f},{box[3]:.1f}"[:120]
    hit = db.get(GeoPlace, ck)
    if hit is not None:
        return hit if hit.lat is not None else None
    if budget is not None:
        if budget.left <= 0:
            return None
        budget.left -= 1
    _pace()
    try:
        r = client.get(NOMINATIM, params={"q": name, "format": "json", "limit": 1, "accept-language": "en",
                                          "viewbox": ",".join(f"{x:.4f}" for x in box), "bounded": 1})
        r.raise_for_status()
        rows = [x for x in r.json() if x.get("lat") and x.get("lon")]
    except (httpx.HTTPError, ValueError):
        return None                      # not cached: try again next time
    found = GeoPlace(key=ck, name=rows[0].get("display_name", "")[:300] if rows else "",
                     lat=float(rows[0]["lat"]) if rows else None, lon=float(rows[0]["lon"]) if rows else None,
                     fetched_at=utcnow())
    db.merge(found)
    db.flush()
    return found if rows else None


def place(db: Session, client: httpx.Client, name: str, budget: "_Budget | None" = None,
          near: GeoPlace | None = None) -> GeoPlace | None:
    """One place: the map's first answer, or (given `near`) the one closest to it."""
    found = candidates(db, client, name, budget)
    if not found:
        return None
    return min(found, key=lambda g: _km(g, near)) if near is not None else found[0]


def choose(stops: list[list[GeoPlace]]) -> list[GeoPlace | None]:
    """One place per stop so that the whole path is shortest (a stop between two others is not on
    the far side of the country), preferring the map's first answers. Unknown stops split the path."""
    out: list[GeoPlace | None] = [None] * len(stops)
    i = 0
    while i < len(stops):
        if not stops[i]:
            i += 1
            continue
        j = i
        while j < len(stops) and stops[j]:
            j += 1
        seg = stops[i:j]
        cost = [r * RANK_KM for r in range(len(seg[0]))]
        back: list[list[int]] = []
        for s in range(1, len(seg)):
            new, bk = [], []
            for r, c in enumerate(seg[s]):
                p = min(range(len(seg[s - 1])), key=lambda q: cost[q] + _km(seg[s - 1][q], c))
                new.append(cost[p] + _km(seg[s - 1][p], c) + r * RANK_KM)
                bk.append(p)
            cost = new
            back.append(bk)
        pick = min(range(len(cost)), key=lambda x: cost[x])
        picks = [pick]
        for bk in reversed(back):
            pick = bk[pick]
            picks.append(pick)
        for s, q in enumerate(reversed(picks)):
            out[i + s] = seg[s][q]
        i = j
    return out


def road_between(db: Session, client: httpx.Client, pa: GeoPlace, pb: GeoPlace) -> int | None:
    """Kilometres by road between two places found on the map (cached by the places, not the names)."""
    if pa.key == pb.key or (pa.lat, pa.lon) == (pb.lat, pb.lon):
        return 0
    hit = db.get(RoadDistance, (pa.key, pb.key))
    if hit is not None and (hit.km is None or hit.minutes is not None):
        return hit.km
    # Not asked yet, or asked before driving times were kept: ask (once) for all of it.
    row = _ask_road(db, client, pa, pb)
    return row.km if row is not None else None


def _ask_road(db: Session, client: httpx.Client, pa: GeoPlace, pb: GeoPlace) -> "RoadDistance | None":
    """OSRM once for a pair: km, car minutes and the road's (simplified) shape, kept."""
    try:
        r = client.get(OSRM.format(a=f"{pa.lon},{pa.lat}", b=f"{pb.lon},{pb.lat}"),
                       params={"overview": "simplified", "geometries": "polyline"})
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    ok = data.get("code") == "Ok" and data.get("routes")
    route = data["routes"][0] if ok else {}
    row = RoadDistance(from_key=pa.key, to_key=pb.key, km=round(route["distance"] / 1000) if ok else None,
                       minutes=round(route["duration"] / 60) if ok and route.get("duration") is not None else None,
                       geometry=route.get("geometry") if ok else None, fetched_at=utcnow())
    db.merge(row)
    db.flush()
    return row


def road_shape(db: Session, client: httpx.Client, pa: GeoPlace, pb: GeoPlace, budget: "_Budget") -> str | None:
    """The road between two places as an encoded polyline (asked once, then kept); None = none known."""
    if pa.key == pb.key:
        return None
    hit = db.get(RoadDistance, (pa.key, pb.key))
    if hit is not None and (hit.geometry or hit.km is None):
        return hit.geometry
    if budget.left <= 0:
        return None
    budget.left -= 1
    row = _ask_road(db, client, pa, pb)
    return row.geometry if row is not None else None


def road_km(db: Session, client: httpx.Client, a: str, b: str, budget: "_Budget | None" = None) -> int | None:
    """Kilometres by road from a to b; None when a place or a road can't be found."""
    if key(a) and key(a) == key(b):
        return 0
    pa, pb = choose([candidates(db, client, a, budget), candidates(db, client, b, budget)])
    return road_between(db, client, pa, pb) if pa and pb else None


FAR_KM = 200         # a stop that adds more than this (and more than 1.5× the direct way) is the wrong place


def far_stops(chosen: list["GeoPlace | None"]) -> set[int]:
    """Stops the map only knows far off the way (a "Friendship monument" in Tirana between Mtskheta
    and Gudauri): driving there would add hundreds of km. Checked against the stops kept so far."""
    far: set[int] = set()
    known = [i for i, c in enumerate(chosen) if c is not None]
    for n, i in enumerate(known):
        prev = next((k for k in reversed(known[:n]) if k not in far), None)
        nxt = known[n + 1] if n + 1 < len(known) else None
        if prev is None or nxt is None:
            continue
        a, b, c = chosen[prev], chosen[i], chosen[nxt]
        direct = _km(a, c)
        if _km(a, b) + _km(b, c) - direct > max(FAR_KM, 1.5 * direct):
            far.add(i)
    return far


def road_minutes(db: Session, pa: "GeoPlace", pb: "GeoPlace") -> int | None:
    """Car minutes between two places, if the road was asked for (road_between keeps them)."""
    if pa.key == pb.key or (pa.lat, pa.lon) == (pb.lat, pb.lon):
        return 0
    hit = db.get(RoadDistance, (pa.key, pb.key))
    return hit.minutes if hit is not None else None


# --- names while typing, and the agency's pinned places --------------------------------------------

# The map area of a country (min lon, min lat, max lon, max lat): suggestions are searched inside the
# agency's countries, else the world's many "Ananuri"s crowd the right one out.
COUNTRY_BBOX = {"ge": (39.9, 41.0, 46.8, 43.6), "am": (43.4, 38.8, 46.7, 41.4), "az": (44.7, 38.3, 50.4, 41.95),
                "tr": (25.6, 35.8, 44.9, 42.2), "uz": (55.9, 37.1, 73.2, 45.6), "kz": (46.4, 40.5, 87.4, 55.5),
                "kg": (69.2, 39.1, 80.3, 43.3), "tj": (67.3, 36.6, 75.2, 41.1), "tm": (52.4, 35.1, 66.7, 42.8),
                "ir": (44.0, 25.0, 63.4, 39.8), "gr": (19.3, 34.8, 29.7, 41.8), "it": (6.6, 35.4, 18.6, 47.1),
                "es": (-9.4, 35.9, 3.4, 43.8), "fr": (-5.2, 41.3, 9.6, 51.1), "il": (34.2, 29.4, 35.9, 33.4),
                "jo": (34.9, 29.1, 39.4, 33.4), "eg": (24.7, 22.0, 36.9, 31.7), "ae": (51.5, 22.6, 56.4, 26.1)}


def _bbox(countries: list[str]) -> str | None:
    boxes = [COUNTRY_BBOX.get(c) for c in countries]
    if not boxes or any(b is None for b in boxes):
        return None
    return ",".join(str(x) for x in (min(b[0] for b in boxes), min(b[1] for b in boxes),
                                      max(b[2] for b in boxes), max(b[3] for b in boxes)))


NOT_FOR_TOURS = {"shop", "office", "craft", "healthcare", "emergency", "power", "landuse", "telecom", "advertising"}
TOUR_AMENITIES = {"place_of_worship", "restaurant", "cafe", "theatre", "arts_centre", "marketplace", "fountain",
                  "monastery", "bus_station", "ferry_terminal", "townhall", "university", "library"}
_suggest_cache: dict[tuple[str, str], list[dict]] = {}
SUGGEST_CACHE_MAX = 3000


def suggest(q: str, countries: list[str] | None = None, timeout: float = 4.0) -> list[dict]:
    """Real places whose name starts like `q`, in the agency's countries: [{name, detail, kind, lat, lon}]."""
    q = " ".join(q.split())[:80]
    cc = sorted(countries or [])
    ck = (q.casefold(), ",".join(cc))
    if ck in _suggest_cache:
        return _suggest_cache[ck]
    try:
        with httpx.Client(timeout=timeout, headers=HEADERS) as client:
            box = _bbox(cc)
            r = client.get(PHOTON, params={"q": q, "limit": 15, "lang": "en", **({"bbox": box} if box else {})})
            r.raise_for_status()
            feats = r.json().get("features", [])
    except (httpx.HTTPError, ValueError):
        return []                      # not cached: try again on the next key
    out, seen = [], set()
    for f in feats:
        p, g = f.get("properties") or {}, (f.get("geometry") or {}).get("coordinates") or []
        if len(g) != 2:
            continue
        if not p.get("name") and p.get("street"):          # an address: "Rustaveli Ave 12"
            p["name"] = " ".join(x for x in (p.get("street"), p.get("housenumber")) if x)
        if not p.get("name"):
            continue
        if cc and (p.get("countrycode") or "").lower() not in cc:
            continue
        # A tour goes to towns, sights and nature, not to hairdressers and offices.
        if p.get("osm_key") in NOT_FOR_TOURS or (p.get("osm_key") == "amenity" and p.get("osm_value") not in TOUR_AMENITIES):
            continue
        detail = ", ".join(x for x in (p.get("city") if p.get("city") != p.get("name") else None, p.get("county"),
                                       p.get("state"), p.get("country")) if x)
        k = (p["name"].casefold(), detail.casefold())
        if k in seen:
            continue
        seen.add(k)
        # Its street address and town, to fill a supplier's address and city when picked.
        street = " ".join(x for x in (p.get("street"), p.get("housenumber")) if x)
        town = p["name"] if p.get("osm_key") == "place" else (p.get("city") or p.get("district") or p.get("county") or "")
        out.append({"name": p["name"][:100], "detail": detail[:200], "kind": (p.get("osm_value") or "")[:30],
                    "lat": float(g[1]), "lon": float(g[0]), "street": street[:150], "city": town[:100]})
        if len(out) == 7:
            break
    if len(_suggest_cache) > SUGGEST_CACHE_MAX:
        _suggest_cache.clear()
    _suggest_cache[ck] = out
    return out


def pin_key(workspace_id: str, name: str) -> str:
    return f"pin:{workspace_id}:{key(name)}"[:120]


def pin(db: Session, workspace_id: str, name: str, lat: float, lon: float, label: str) -> None:
    """This agency's name means this exact spot (picked from the suggestions)."""
    db.merge(GeoPlace(key=pin_key(workspace_id, name), name=label[:300], lat=lat, lon=lon, fetched_at=utcnow()))
    db.flush()


def pinned(db: Session, workspace_id: str | None, name: str) -> "GeoPlace | None":
    if not workspace_id or not key(name):
        return None
    hit = db.get(GeoPlace, pin_key(workspace_id, name))
    return hit if hit is not None and hit.lat is not None else None


def resolve(db: Session, client: httpx.Client, names: list[str], budget: _Budget, countries: list[str] | None,
            workspace_id: str | None) -> tuple[list["GeoPlace | None"], set[int]]:
    """Where each name of a path is: the agency's pinned spot, else the map's place that keeps the whole
    path shortest; unknown or far-off ones are searched again near their neighbours. Returns the places
    (None = not found) and the ones still only known far off the way."""
    found = [([p] if (p := pinned(db, workspace_id, n)) else candidates(db, client, n, budget, countries)) if n else []
             for n in names]
    chosen = choose(found)
    far = far_stops(chosen)
    for i, n in enumerate(names):
        if not n or (chosen[i] is not None and i not in far):
            continue
        around = [g for g in (next((chosen[j] for j in range(i - 1, -1, -1) if chosen[j] is not None and j not in far), None),
                              next((chosen[j] for j in range(i + 1, len(names)) if chosen[j] is not None and j not in far), None)) if g]
        if around and (hit := near(db, client, n, around, budget)) is not None:
            chosen[i] = hit
            far.discard(i)
    return chosen, far_stops(chosen)


MAX_SHAPES = 40      # new roads asked per map (a 10-day tour has ~30 legs; the rest come next time)


def path_map(db: Session, names: list[str], countries: list[str] | None = None, workspace_id: str | None = None,
             timeout: float = 10.0) -> dict:
    """A path for a map: each place with where it is (or why not), and the road between each place found
    and the next one found, as encoded polylines."""
    names = [(n or "").strip() for n in names]
    budget = _Budget(MAX_NEW_LOOKUPS)
    shapes = _Budget(MAX_SHAPES)
    with httpx.Client(timeout=timeout, headers=HEADERS) as client:
        chosen, far = resolve(db, client, names, budget, countries, workspace_id)
        points, roads, prev = [], [], None
        for i, n in enumerate(names):
            g = chosen[i] if i not in far else None
            points.append({"name": n, "lat": float(g.lat) if g else None, "lon": float(g.lon) if g else None,
                           "where": (g.name if g else "")[:160],
                           "missing": None if g else ("far" if i in far else "pending" if key(n) in budget.pending else "not_found")})
            if g is None:
                continue
            if prev is not None and (prev[1].lat, prev[1].lon) != (g.lat, g.lon):
                roads.append({"from": prev[0], "to": i, "polyline": road_shape(db, client, prev[1], g, shapes)})
            prev = (i, g)
    return {"points": points, "roads": roads}


def legs(db: Session, cities: list[str], timeout: float = 8.0, countries: list[str] | None = None,
         workspace_id: str | None = None) -> list[dict]:
    """For each stop: km from the previous one (the first: 0). Same city → 0 without asking.
    Places are chosen for the whole path at once, so same-named towns don't send the route astray.
    A stop the map doesn't know, or only knows far away, is left out (km 0, `skipped` says why)
    and the next leg starts from the stop before it — the day still gets its km."""
    names = [(c or "").strip() for c in cities]
    budget = _Budget(MAX_NEW_LOOKUPS)
    with httpx.Client(timeout=timeout, headers=HEADERS) as client:
        chosen, far = resolve(db, client, names, budget, countries, workspace_id)
        out: list[dict] = []
        prev_i = None
        for i, n in enumerate(names):
            skipped, where = None, ""
            if n and chosen[i] is None:
                skipped = "pending" if key(n) in budget.pending else "not_found"
            elif i in far:
                skipped, where = "far", (chosen[i].name or "")[:120]
            if skipped:
                out.append({"from": names[prev_i] if prev_i is not None else None, "to": n, "km": 0, "minutes": 0,
                            "skipped": skipped, "where": where})
                continue
            minutes = None
            if prev_i is None or not n:
                km = 0 if prev_i is None and n else None
                minutes = km
            elif key(names[prev_i]) == key(n):
                km = minutes = 0
            else:
                pa, pb = chosen[prev_i], chosen[i]
                km = road_between(db, client, pa, pb) if pa and pb else None
                minutes = road_minutes(db, pa, pb) if km is not None else None
            out.append({"from": names[prev_i] if prev_i is not None else None, "to": n, "km": km, "minutes": minutes,
                        "skipped": None, "where": ""})
            if n:
                prev_i = i
    return out
