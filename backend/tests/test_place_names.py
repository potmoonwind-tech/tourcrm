"""Settings → Place names: every place name in use, renamed everywhere, the map's name, names for clients."""
from app import geo

from .test_tours import agency


def route(c, base, days):
    r = c.post(f"{base}/series", json={"code": "R1", "name": "R", "days": days})
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_names_in_use_and_renamed_everywhere(make_client):
    c, base, _ = agency(make_client)
    route(c, base, [
        {"city": "თბილისი", "stops": ["Mtskheta"], "schedule": [{"id": "a", "kind": "visit", "time": "", "end": "", "title": "Jvari", "ref": None, "place": "", "notes": ""}]},
        {"city": "Tbilisi"},
    ])
    rows = {r["name"]: r for r in c.get(f"{base}/place-names").json()}
    assert rows["თბილისი"]["uses"] == 1 and rows["Tbilisi"]["uses"] == 1 and "Jvari" in rows and "Mtskheta" in rows
    c.post(f"{base}/places/pin", json={"name": "თბილისი", "lat": 41.7, "lon": 44.8})
    assert c.post(f"{base}/place-names/rename", json={"old": "თბილისი", "new": "Tbilisi"}).json() == {"changed": 1}
    rows = {r["name"]: r for r in c.get(f"{base}/place-names").json()}
    assert "თბილისი" not in rows and rows["Tbilisi"]["uses"] == 2 and rows["Tbilisi"]["on_map"]


def test_client_names_are_kept_and_used(make_client):
    c, base, _ = agency(make_client)
    route(c, base, [{"city": "Jvari"}])
    assert c.put(f"{base}/place-names/client-name", json={"name": "Jvari", "lang": "en", "text": "Jvari Monastery"}).status_code == 204
    row = next(r for r in c.get(f"{base}/place-names").json() if r["name"] == "Jvari")
    assert row["client"]["en"] == "Jvari Monastery"
    c.put(f"{base}/place-names/client-name", json={"name": "Jvari", "lang": "en", "text": ""})
    row = next(r for r in c.get(f"{base}/place-names").json() if r["name"] == "Jvari")
    assert row["client"]["en"] == ""


def test_map_name_in_the_place_language(make_client, monkeypatch):
    c, base, _ = agency(make_client)
    monkeypatch.setattr(geo, "google", lambda: True)
    asked = {}
    monkeypatch.setattr(geo, "suggest", lambda q, cc=None, **k: asked.update(k) or [{"name": "Jvari Monastery", "place_id": "g1"}])
    assert c.post(f"{base}/place-names/map-name", json={"name": "ჯვარი"}).json() == {"name": "Jvari Monastery"}
    assert asked["lang"] == "en"


def test_suppliers_are_listed_and_renamed_in_the_catalogue(make_client):
    c, base, _ = agency(make_client)
    v = c.post(f"{base}/vendors", json={"name": "სასტუმრო ქალაქი", "type": "hotel", "city": "Tbilisi"}).json()
    route(c, base, [{"city": "Tbilisi", "hotel_id": v["id"]}, {"city": "Tbilisi"}])
    row = next(r for r in c.get(f"{base}/place-names").json() if r.get("vendor_id") == v["id"])
    assert row["kind"] == "hotel" and row["uses"] == 1
    c.put(f"{base}/place-names/client-name", json={"name": "სასტუმრო ქალაქი", "lang": "en", "text": "City Hotel"})
    assert c.post(f"{base}/place-names/rename", json={"old": "სასტუმრო ქალაქი", "new": "City Hotel Tbilisi", "vendor_id": v["id"]}).json() == {"changed": 1}
    assert c.get(f"{base}/vendors/{v['id']}").json()["name"] == "City Hotel Tbilisi"
    row = next(r for r in c.get(f"{base}/place-names").json() if r.get("vendor_id") == v["id"])
    assert row["client"]["en"] == "City Hotel"


def test_info_and_renaming_in_the_supplier_form(make_client):
    c, base, _ = agency(make_client)
    v = c.post(f"{base}/vendors", json={"name": "Old Cellar", "type": "restaurant", "city": "Tbilisi"}).json()
    c.post(f"{base}/places/pin", json={"name": "Old Cellar", "lat": 41.7, "lon": 44.8, "label": "Old Cellar, Tbilisi"})
    c.put(f"{base}/place-names/client-name", json={"name": "Old Cellar", "lang": "zh", "text": "老酒窖"})
    assert c.get(f"{base}/place-names/info", params={"name": "Old Cellar"}).json() == {"map": "Old Cellar, Tbilisi", "client": {"en": "", "ka": "", "zh": "老酒窖"}}
    c.patch(f"{base}/vendors/{v['id']}", json={"name": "Old Tbilisi Cellar"})
    got = c.get(f"{base}/place-names/info", params={"name": "Old Tbilisi Cellar"}).json()
    assert got["map"] == "Old Cellar, Tbilisi" and got["client"]["zh"] == "老酒窖"
