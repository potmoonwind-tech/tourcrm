"""Opening hours of picked places: kept with the pin, given back by name for a day's timeline."""
from app import geo

from .test_tours import agency


def test_google_hours_become_periods():
    raw = {"periods": [{"open": {"day": 2, "hour": 10, "minute": 0}, "close": {"day": 2, "hour": 18, "minute": 0}}],
           "weekdayDescriptions": ["Monday: Closed", "Tuesday: 10:00 AM - 6:00 PM"]}
    assert geo.opening_hours(raw) == {"periods": [{"day": 2, "open": "10:00", "close": "18:00"}],
                                      "text": ["Monday: Closed", "Tuesday: 10:00 AM - 6:00 PM"]}
    always = geo.opening_hours({"periods": [{"open": {"day": 0, "hour": 0, "minute": 0}}]})
    assert len(always["periods"]) == 7 and always["periods"][0] == {"day": 0, "open": "00:00", "close": "24:00"}
    assert geo.opening_hours(None) is None


def test_a_pinned_place_keeps_its_hours(make_client):
    c, base, _ = agency(make_client)
    hours = {"periods": [{"day": 2, "open": "10:00", "close": "18:00"}, {"day": 9, "open": "x", "close": "y"}], "text": ["Tue 10-18"]}
    assert c.post(f"{base}/places/pin", json={"name": "Prometheus Cave", "lat": 42.37, "lon": 42.6, "hours": hours}).status_code == 204
    got = c.post(f"{base}/places/hours", json={"names": ["Prometheus Cave", "Nowhere"]}).json()
    assert got == {"Prometheus Cave": {"periods": [{"day": 2, "open": "10:00", "close": "18:00"}], "text": ["Tue 10-18"]}}



def test_hours_from_the_map_for_a_supplier(make_client, monkeypatch):
    c, base, _ = agency(make_client)
    v = c.post(f"{base}/vendors", json={"name": "Prometheus Cave", "type": "activity", "city": "Kutaisi"}).json()
    monkeypatch.setattr(geo, "google", lambda: True)
    monkeypatch.setattr(geo, "suggest", lambda q, *a, **k: [{"name": "Prometheus Cave", "place_id": "g1"}])
    hours = {"periods": [{"day": 3, "open": "10:00", "close": "17:00"}], "text": ["Wednesday: 10-17"]}
    monkeypatch.setattr(geo, "place_details", lambda pid, *a, **k: {"lat": 42.3, "lon": 42.6, "detail": "Tskaltubo", "hours": hours} if pid == "g1" else None)
    r = c.post(f"{base}/vendors/{v['id']}/hours")
    assert r.status_code == 200 and r.json()["hours"] == hours
    assert c.post(f"{base}/places/hours", json={"names": ["Prometheus Cave"]}).json() == {"Prometheus Cave": hours}
