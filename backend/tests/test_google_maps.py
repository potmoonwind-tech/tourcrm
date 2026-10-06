"""Google Maps instead of OpenStreetMap when the agency's server has a key: the same jobs (where a
place is, road km and minutes, names while typing), and nothing kept longer than Google allows (30 days)."""
from contextlib import contextmanager
from datetime import timedelta

import pytest

from app import geo
from app.config import settings
from app.models import GeoPlace, RoadDistance, utcnow


@pytest.fixture
def google(monkeypatch):
    monkeypatch.setattr(settings, "google_maps_key", "test-key")
    calls = []

    def get(client, url, params, headers=None):
        calls.append(("get", url, params))
        if url == geo.GOOGLE_GEOCODE:
            if params["address"] == "Batumi":
                return {"status": "OK", "results": [
                    {"formatted_address": "Batumi, Georgia", "geometry": {"location": {"lat": 41.64, "lng": 41.63}},
                     "address_components": [{"short_name": "GE", "types": ["country"]}]},
                    {"formatted_address": "Batumi, Elsewhere", "geometry": {"location": {"lat": 1.0, "lng": 2.0}},
                     "address_components": [{"short_name": "XX", "types": ["country"]}]}]}
            return {"status": "ZERO_RESULTS", "results": []}
        if url.startswith("https://places.googleapis.com/v1/places/"):
            return {"location": {"latitude": 41.65, "longitude": 41.64}, "formattedAddress": "Rustaveli Ave 1, Batumi, Georgia",
                    "addressComponents": [{"longText": "Rustaveli Ave", "types": ["route"]}, {"longText": "1", "types": ["street_number"]},
                                          {"longText": "Batumi", "types": ["locality"]}]}
        raise AssertionError(url)

    def post(client, url, body, headers):
        calls.append(("post", url, body))
        if url == geo.GOOGLE_ROUTES:
            return {"routes": [{"distanceMeters": 165400, "duration": "10800s", "polyline": {"encodedPolyline": "abc"}}]}
        if url == geo.GOOGLE_AUTOCOMPLETE:
            return {"suggestions": [{"placePrediction": {"placeId": "ChIJgreenwood", "types": ["lodging", "establishment"],
                                                         "structuredFormat": {"mainText": {"text": "Greenwood Batumi"},
                                                                              "secondaryText": {"text": "Batumi, Georgia"}}}}]}
        raise AssertionError(url)
    monkeypatch.setattr(geo, "_google_get", get)
    monkeypatch.setattr(geo, "_google_post", post)
    return calls


@contextmanager
def _test_db():
    """A session on the test database (make_client's), never the app's own."""
    from app.db import get_db
    from app.main import app
    gen = app.dependency_overrides[get_db]()
    try:
        yield next(gen)
    finally:
        gen.close()


def test_places_and_roads_come_from_google(google, make_client):
    import httpx
    make_client()
    with _test_db() as db, httpx.Client() as client:
        found = geo.candidates(db, client, "Batumi", countries=["ge"])
        assert [(f.name, float(f.lat)) for f in found] == [("Batumi, Georgia", 41.64)]      # the other country left out
        a, b = GeoPlace(key="a", lat=41.69, lon=44.80), GeoPlace(key="b", lat=42.66, lon=44.64)
        assert geo.road_between(db, client, a, b) == 165 and geo.road_minutes(db, a, b) == 180
        assert db.get(RoadDistance, ("a", "b")).geometry == "abc"
        n = len(google)
        assert geo.road_between(db, client, a, b) == 165 and len(google) == n            # kept: not asked again
        # Older than Google allows: asked again.
        db.get(RoadDistance, ("a", "b")).fetched_at = utcnow() - timedelta(days=31)
        assert geo.road_between(db, client, a, b) == 165 and len(google) == n + 1


def test_typing_then_picking_a_google_place(google, make_client):
    from .test_tours import agency
    c, base, _ = agency(make_client)
    c.patch(base, json={"countries": ["GE"]})
    s = c.get(f"{base}/places?q=Greenwood&session=s1").json()
    assert s == [{"name": "Greenwood Batumi", "detail": "Batumi, Georgia", "kind": "lodging", "lat": None, "lon": None,
                  "street": "", "city": "", "place_id": "ChIJgreenwood"}]
    body = next(x for x in google if x[1] == geo.GOOGLE_AUTOCOMPLETE)[2]
    assert body["includedRegionCodes"] == ["ge"] and body["sessionToken"] == "s1"
    d = c.get(f"{base}/places/details?id=ChIJgreenwood&session=s1").json()
    assert (d["lat"], d["street"], d["city"]) == (41.65, "Rustaveli Ave 1", "Batumi")
    assert c.post(f"{base}/places/pin", json={"name": "Greenwood Batumi", "lat": d["lat"], "lon": d["lon"],
                                              "place_id": "ChIJgreenwood"}).status_code == 204
    # 31 days later the pin is looked up again by its Google id before it's used.
    with _test_db() as db:
        ws_id = base.rsplit("/", 1)[-1]
        row = db.get(GeoPlace, geo.pin_key(ws_id, "Greenwood Batumi"))
        row.fetched_at, row.lat = utcnow() - timedelta(days=31), 0
        db.commit()
        n = len(google)
        p = geo.pinned(db, ws_id, "Greenwood Batumi")
        assert float(p.lat) == 41.65 and len(google) == n + 1


def test_the_browser_learns_which_map_to_draw(make_client, monkeypatch):
    c = make_client()
    assert c.get("/api/config").json() == {"maps": "osm", "maps_key": ""}
    monkeypatch.setattr(settings, "google_maps_key", "server")
    monkeypatch.setattr(settings, "google_maps_browser_key", "browser")
    assert c.get("/api/config").json() == {"maps": "google", "maps_key": "browser"}


def test_a_town_is_the_same_in_any_alphabet():
    k = geo.town_key
    assert k("თბილისი") == k("Tbilisi") == k("Тбилиси") == k(" tbilisi, Georgia")
    assert k("სიღნაღი") == k("Sighnaghi") and k("ბათუმი") == k("Batumi") and k("ქუთაისი") == k("Kutaisi")
    assert k("ყაზბეგი") == k("Kazbegi") == k("Qazbegi") and k("მცხეთა") == k("Mtskheta")
    assert k("Tbilisi") != k("Batumi")
    # Georgian adds "-ი" to foreign names and has no "Y": still the same town.
    assert k("ერევანი") == k("Yerevan") == k("Ереван") == k("Erevan")
    assert k("გუდაური") == k("Gudauri") != k("Kazbegi")


def test_google_answers_in_the_agencys_language(google, make_client):
    from .test_tours import agency
    c, base, _ = agency(make_client)
    c.patch(base, json={"language": "ka"})
    c.get(f"{base}/places?q=Greenwood&session=s2")
    body = next(x for x in google if x[1] == geo.GOOGLE_AUTOCOMPLETE)[2]
    assert body["languageCode"] == "ka"
    c.get(f"{base}/places/details?id=ChIJgreenwood&session=s2")
    params = next(x for x in google if x[1].startswith("https://places.googleapis.com/v1/places/"))[2]
    assert params["languageCode"] == "ka"
