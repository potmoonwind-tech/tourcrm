"""Kilometres per day: suggested from the map (faked here), stored on days, used for per-km and per-litre prices."""
from decimal import Decimal

from app import finance
from .test_tours import agency, mk


def test_per_km_and_per_litre_quantities():
    assert finance.auto_quantity("km", Decimal(10), 0, km=165) == 165
    assert finance.auto_quantity("litre", Decimal(10), 0, km=200, fuel_l_per_100km=Decimal(30)) == Decimal("60.00")
    assert finance.auto_quantity("km", Decimal(10), 0, km=None) is None          # unknown → ask the user


def test_suggested_distances_and_costs_per_km(make_client, monkeypatch):
    from app import geo
    from app.models import GeoPlace
    fake = {("tbilisi", "kazbegi"): 165, ("kazbegi", "tbilisi"): 165}
    spots = {"tbilisi": (41.69, 44.80), "kazbegi": (42.66, 44.64)}

    def candidates(db, client, n, budget=None, countries=None):
        k = geo.key(n)
        return [GeoPlace(key=k, name=n, lat=spots[k][0], lon=spots[k][1])] if k in spots else []
    monkeypatch.setattr(geo, "candidates", candidates)
    monkeypatch.setattr(geo, "road_between", lambda db, client, a, b: fake.get((a.key, b.key)))
    monkeypatch.setattr(geo, "near", lambda *a, **k: None)
    c, base, ws = agency(make_client)
    r = c.post(f"{base}/distances", json={"cities": ["Tbilisi", "Kazbegi", "Kazbegi", "Tbilisi", "Atlantis"]}).json()
    assert [leg["km"] for leg in r["legs"]] == [0, 165, 0, 165, 0] and r["total"] == 330
    assert r["legs"][4]["skipped"] == "not_found"            # unknown: left out, said so

    bus = mk(c, f"{base}/vendors", {"name": "Coach", "type": "transport"})
    svc = c.put(f"{base}/vendors/{bus['id']}/services", json=[
        {"name": "Bus per km", "category": "transport", "unit": "km", "rates": [{"price": "2", "currency": "USD"}]},
        {"name": "Diesel", "category": "transport", "unit": "litre", "rates": [{"price": "1.5", "currency": "USD"}]}]).json()
    extras = [{"service_id": s["id"], "quantity": None, "notes": ""} for s in svc]
    route = mk(c, f"{base}/series", {"code": "KZ", "days": [
        {"city": "Tbilisi", "km": 0}, {"city": "Kazbegi", "km": 165, "extras": extras}, {"city": "Tbilisi", "km": 165}]})
    assert [d["km"] for d in route["days"]] == [0, 165, 165]
    c.patch(base, json={"fuel_l_per_100km": "25"})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-11-20", "pax": 10})
    assert [d["km"] for d in c.get(f"{base}/tours/{t['id']}").json()["days"]] == [0, 165, 165]     # copied from the route
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    lines = {l["description"].split(" ×")[0]: l for l in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]}
    assert lines["Bus per km"]["amount"] == 330                                   # 165 km × 2
    assert lines["Diesel"]["amount"] == 61.88                                     # 165 × 25/100 = 41.25 l × 1.5


def test_same_name_places_follow_the_route(make_client, monkeypatch):
    """Khertvisi is a fortress near Vardzia and a village in Adjara; there are several Vardzias.
    The whole day's path decides: Borjomi → Vardzia (caves) → Khertvisi (fortress) → Yerevan."""
    from types import SimpleNamespace as NS

    from app import geo
    from app.db import get_db
    from app.main import app
    monkeypatch.setattr(geo, "_pace", lambda: None)
    places = {"borjomi": [("41.84", "43.38", "Borjomi")],
              "vardzia": [("41.38", "43.28", "Vardzia caves, Aspindza"), ("41.95", "43.10", "Vardzia village, Imereti")],
              "khertvisi": [("41.54", "41.74", "Khertvisi, Adjara"), ("41.48", "43.29", "Khertvisi, Aspindza")],
              "yerevan": [("40.18", "44.51", "Yerevan")], "batumi": [("41.64", "41.63", "Batumi")]}

    class Client:
        def get(self, url, params=None):
            rows = ([{"lat": a, "lon": b, "display_name": n} for a, b, n in places[geo.key(params["q"])]] if url == geo.NOMINATIM
                    else {"code": "Ok", "routes": [{"distance": 10000}]})
            return NS(raise_for_status=lambda: None, json=lambda: rows)

    agency(make_client)
    db = next(app.dependency_overrides[get_db]())
    client = Client()
    path = geo.choose([geo.candidates(db, client, n) for n in ["Borjomi", "Vardzia", "Khertvisi", "Yerevan"]])
    assert [g.name for g in path] == ["Borjomi", "Vardzia caves, Aspindza", "Khertvisi, Aspindza", "Yerevan"]
    # Next to Batumi, the Adjara Khertvisi is the right one.
    assert geo.choose([geo.candidates(db, client, "Batumi"), geo.candidates(db, client, "Khertvisi")])[1].name == "Khertvisi, Adjara"
    # Alone, the map's first answer.
    assert geo.place(db, client, "Vardzia").name == "Vardzia caves, Aspindza"
    assert geo.road_km(db, client, "Vardzia", "Khertvisi") == 10


def test_a_stop_found_only_far_away_is_left_out(make_client, monkeypatch):
    """"Friendship monument" between Mtskheta and Gudauri: the map knows only Tirana's. Driving there
    made the day 6,084 km; now the stop is left out of the km and named."""
    from app import geo
    from app.models import GeoPlace
    spots = {"mtskheta": (41.84, 44.72), "friendship monument": (41.33, 19.82), "ananuri": (42.16, 44.70), "gudauri": (42.48, 44.48)}
    monkeypatch.setattr(geo, "candidates", lambda db, client, n, budget=None, countries=None: [GeoPlace(key=geo.key(n), name=f"{n} (map)", lat=spots[geo.key(n)][0], lon=spots[geo.key(n)][1])])
    monkeypatch.setattr(geo, "road_between", lambda db, client, a, b: round(geo._km(a, b) * 1.3))
    monkeypatch.setattr(geo, "near", lambda *a, **k: None)          # nothing nearby either
    c, base, _ = agency(make_client)
    r = c.post(f"{base}/distances", json={"cities": ["Mtskheta", "Friendship monument", "Ananuri", "Gudauri"]}).json()
    far = r["legs"][1]
    assert far["skipped"] == "far" and far["km"] == 0 and far["where"] == "Friendship monument (map)"
    assert r["legs"][2]["from_city"] == "Mtskheta" and 0 < r["total"] < 150


def test_a_short_name_is_found_near_the_other_stops(make_client, monkeypatch):
    """"Friendship monument": the plain search gives Tirana; searched again around Ananuri and
    Gudauri, the map finds the one on the Georgian Military Road — no renaming needed."""
    from types import SimpleNamespace as NS

    from app import geo
    monkeypatch.setattr(geo, "_pace", lambda: None)
    world = {"mtskheta": [("41.84", "44.72", "Mtskheta")], "ananuri": [("42.16", "44.70", "Ananuri")],
             "gudauri": [("42.48", "44.48", "Gudauri")], "friendship monument": [("41.33", "19.82", "Tirana")]}
    asked = []

    class Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

        def get(self, url, params=None):
            if url != geo.NOMINATIM:
                return NS(raise_for_status=lambda: None, json=lambda: {"code": "Ok", "routes": [{"distance": 30000}]})
            asked.append(params)
            if params.get("bounded"):       # the search near the neighbours
                rows = [{"lat": "42.49", "lon": "44.45", "display_name": "Georgia-Russia Friendship Monument, Gudauri"}]
            else:
                rows = [{"lat": a, "lon": b, "display_name": n} for a, b, n in world[geo.key(params["q"])]]
            return NS(raise_for_status=lambda: None, json=lambda: rows)
    monkeypatch.setattr(geo.httpx, "Client", Client)
    c, base, _ = agency(make_client)
    r = c.post(f"{base}/distances", json={"cities": ["Mtskheta", "Ananuri", "Friendship monument", "Gudauri"]}).json()
    assert r["legs"][2]["skipped"] is None and r["legs"][2]["km"] == 30
    assert any(p.get("bounded") and p["q"] == "Friendship monument" for p in asked)



def test_countries_limit_the_search_and_driving_time_is_kept(make_client, monkeypatch):
    """The agency works in Georgia and Armenia: the map searches only there. The road service's
    driving time comes back with the km, and is kept (asked once)."""
    from types import SimpleNamespace as NS

    from app import geo
    monkeypatch.setattr(geo, "_pace", lambda: None)
    spots = {"tbilisi": ("41.69", "44.80"), "gudauri": ("42.48", "44.48")}
    asked = []

    class Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

        def get(self, url, params=None):
            asked.append((url, params))
            if url == geo.NOMINATIM:
                lat, lon = spots[geo.key(params["q"])]
                return NS(raise_for_status=lambda: None, json=lambda: [{"lat": lat, "lon": lon, "display_name": params["q"]}])
            return NS(raise_for_status=lambda: None, json=lambda: {"code": "Ok", "routes": [{"distance": 120000, "duration": 7260}]})
    monkeypatch.setattr(geo.httpx, "Client", Client)
    c, base, _ = agency(make_client)
    c.patch(base, json={"countries": ["GE", "am"], "drive_factor": "1.3"})
    ws = c.get(base).json()
    assert ws["countries"] == ["ge", "am"] and ws["drive_factor"] == 1.3
    r = c.post(f"{base}/distances", json={"cities": ["Tbilisi", "Gudauri"]}).json()
    assert r["legs"][1]["km"] == 120 and r["legs"][1]["minutes"] == 121
    assert all(p.get("countrycodes") == "am,ge" for u, p in asked if u == geo.NOMINATIM)
    n = len(asked)
    c.post(f"{base}/distances", json={"cities": ["Tbilisi", "Gudauri"]})
    assert len(asked) == n                     # all kept: nothing asked again


def test_known_places_are_reused_and_the_rest_wait_for_the_next_click(make_client, monkeypatch):
    """Setting the countries doesn't make every place new: Batumi already known in Georgia is used as
    it is; a place known only abroad is asked again in the countries. Past the per-click limit,
    places are 'pending' (press again), not 'not on the map'."""
    from types import SimpleNamespace as NS

    from app import geo
    from app.db import get_db
    from app.main import app
    from app.models import GeoPlace
    monkeypatch.setattr(geo, "_pace", lambda: None)
    asked = []

    class Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

        def get(self, url, params=None):
            if url != geo.NOMINATIM:
                return NS(raise_for_status=lambda: None, json=lambda: {"code": "Ok", "routes": [{"distance": 100000, "duration": 6000}]})
            asked.append(params["q"])
            return NS(raise_for_status=lambda: None, json=lambda: [{"lat": "42.0", "lon": "44.0", "display_name": f"{params['q']}, Georgia"}])
    monkeypatch.setattr(geo.httpx, "Client", Client)
    c, base, _ = agency(make_client)
    db = next(app.dependency_overrides[get_db]())
    for k, lat, lon, name in [("batumi", 41.64, 41.63, "Batumi, Adjara, Georgia"), ("batumi#all", None, None, ""),
                              ("kutaisi", 42.27, 42.70, "Kutaisi, Imereti, Georgia"), ("kutaisi#all", None, None, ""),
                              ("friendship monument", 41.33, 19.82, "Friendship Monument, Tirana, Albania"), ("friendship monument#all", None, None, "")]:
        db.merge(GeoPlace(key=k, name=name, lat=lat, lon=lon))
    db.commit()
    c.patch(base, json={"countries": ["ge"]})
    r = c.post(f"{base}/distances", json={"cities": ["Batumi", "Friendship monument", "Kutaisi"]}).json()
    assert asked == ["Friendship monument"] and all(not x["skipped"] for x in r["legs"])
    monkeypatch.setattr(geo, "MAX_NEW_LOOKUPS", 1)
    r = c.post(f"{base}/distances", json={"cities": ["Batumi", "Gori", "Mestia", "Kutaisi"]}).json()
    assert [x["skipped"] for x in r["legs"]] == [None, None, "pending", None]


def test_place_names_while_typing_and_pinned_places(make_client, monkeypatch):
    """Suggestions come from the map in the agency's countries; picking one pins the name to that spot,
    for this agency only, and km use it instead of the map's other places with that name."""
    from app import geo
    from app.models import GeoPlace
    asked = []
    monkeypatch.setattr(geo, "suggest", lambda q, countries=None: asked.append((q, countries)) or [
        {"name": "Ananuri Castle", "detail": "Dusheti Municipality, Georgia", "kind": "castle", "lat": 42.16, "lon": 44.70}])
    c, base, ws = agency(make_client)
    c.patch(base, json={"countries": ["GE", "AM"]})
    assert c.get(f"{base}/places?q=Anan").json()[0]["name"] == "Ananuri Castle"
    assert asked == [("Anan", ["ge", "am"])]
    assert c.get(f"{base}/places?q=A").status_code == 422          # one letter: nothing to ask yet

    # The map alone puts "Friendship monument" in Albania; the agency picked the Georgian one.
    spots = {"tbilisi": (41.69, 44.80), "friendship monument": (41.33, 19.82), "kazbegi": (42.66, 44.64)}

    def candidates(db, client, n, budget=None, countries=None):
        k = geo.key(n)
        return [GeoPlace(key=k, name=n, lat=spots[k][0], lon=spots[k][1])] if k in spots else []
    monkeypatch.setattr(geo, "candidates", candidates)
    monkeypatch.setattr(geo, "near", lambda *a, **k: None)
    used = []
    monkeypatch.setattr(geo, "road_between", lambda db, client, a, b: used.append((a.key, b.key)) or 50)
    monkeypatch.setattr(geo, "road_minutes", lambda db, a, b: 60)
    r = c.post(f"{base}/distances", json={"cities": ["Tbilisi", "Friendship monument", "Kazbegi"]}).json()
    assert r["legs"][1]["skipped"] == "far"
    assert c.post(f"{base}/places/pin", json={"name": "Friendship monument", "lat": 42.49, "lon": 44.45,
                                              "label": "Georgia-Russia Friendship Monument"}).status_code == 204
    r = c.post(f"{base}/distances", json={"cities": ["Tbilisi", "Friendship monument", "Kazbegi"]}).json()
    assert [l["km"] for l in r["legs"]] == [0, 50, 50] and [l["minutes"] for l in r["legs"]][1:] == [60, 60]
    assert r["legs"][1]["skipped"] is None and used[-2][1].startswith("pin:")
    # Another agency still gets the map's own answer.
    c2, base2, _ = agency(make_client, "other@b.com", "B")
    assert c2.post(f"{base2}/distances", json={"cities": ["Tbilisi", "Friendship monument", "Kazbegi"]}).json()["legs"][1]["skipped"] == "far"


def test_days_keep_km_per_leg(make_client):
    c, base, _ = agency(make_client)
    route = mk(c, f"{base}/series", {"code": "KM", "days": [
        {"city": "Tbilisi"}, {"city": "Kazbegi", "stops": ["Ananuri"], "km": 155, "drive_km": [66, 89], "drive_minutes": [70, 95]}]})
    assert route["days"][1]["drive_km"] == [66, 89]
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-11-20", "pax": 10})
    assert c.get(f"{base}/tours/{t['id']}").json()["days"][1]["drive_km"] == [66, 89]      # copied from the route


def test_map_of_a_path_has_places_and_roads(make_client, monkeypatch):
    from app import geo
    from app.models import GeoPlace
    spots = {"tbilisi": (41.69, 44.80), "mtskheta": (41.84, 44.72), "gudauri": (42.48, 44.48)}

    def candidates(db, client, n, budget=None, countries=None):
        k = geo.key(n)
        return [GeoPlace(key=k, name=f"{n}, Georgia", lat=spots[k][0], lon=spots[k][1])] if k in spots else []
    monkeypatch.setattr(geo, "candidates", candidates)
    monkeypatch.setattr(geo, "near", lambda *a, **k: None)
    asked = []
    monkeypatch.setattr(geo, "road_shape", lambda db, client, a, b, budget: asked.append((a.key, b.key)) or "_p~iF~ps|U")
    c, base, _ = agency(make_client)
    r = c.post(f"{base}/map", json={"places": ["Tbilisi", "Mtskheta", "Atlantis", "Gudauri", "Gudauri"]})
    assert r.status_code == 200, r.text
    m = r.json()
    assert [p["missing"] for p in m["points"]] == [None, None, "not_found", None, None]
    assert m["points"][0]["lat"] == 41.69 and m["points"][0]["where"] == "Tbilisi, Georgia"
    # Roads skip the unknown place and the same place twice in a row.
    assert [(x["from"], x["to"]) for x in m["roads"]] == [(0, 1), (1, 3)] and m["roads"][0]["polyline"] == "_p~iF~ps|U"
    assert asked == [("tbilisi", "mtskheta"), ("mtskheta", "gudauri")]
