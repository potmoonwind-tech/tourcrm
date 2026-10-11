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
