"""A tour's presentation: photos of its places (own and Wikimedia), the link, and what the client sees."""
import pytest

from app import geo, presentation
from .test_tours import agency

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200


@pytest.fixture
def offline(monkeypatch):
    """No network: Wikimedia knows Mtskheta only; the map puts every place somewhere."""
    asked = []

    def wiki(client, name):
        asked.append(name)
        return {"url": "https://upload.wikimedia.org/a/1600px-Mtskheta.jpg", "thumb": "https://upload.wikimedia.org/a/480px-Mtskheta.jpg",
                "credit": "Jane Doe · CC BY-SA 4.0", "link": "https://commons.wikimedia.org/wiki/File:Mtskheta.jpg"} if name == "Mtskheta" else None
    monkeypatch.setattr(presentation, "wiki_photo", wiki)
    monkeypatch.setattr(geo, "path_map", lambda db, names, *a, **k: {
        "points": [{"name": n, "lat": 41.7 + i / 10, "lon": 44.8, "where": "", "missing": None} for i, n in enumerate(names)],
        "roads": [{"from": 0, "to": 1, "polyline": "abc"}]})
    return asked


def _tour(c, base):
    hotel = c.post(f"{base}/vendors", json={"name": "Old Town Hotel", "type": "hotel", "city": "Tbilisi"}).json()
    guide = c.post(f"{base}/vendors", json={"name": "Nino", "type": "guide"}).json()
    t = c.post(f"{base}/tours", json={"code": "GC-1102", "name": "Georgia Classic", "start_date": "2026-11-02",
                                      "end_date": "2026-11-04", "pax": 12, "price_pp": "1590"}).json()
    days = [{"city": "Tbilisi", "hotel_id": hotel["id"], "stops": ["Mtskheta"]}, {"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi"}]
    c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": days}).raise_for_status()
    c.post(f"{base}/tours/{t['id']}/staff", json={"vendor_id": guide["id"], "role": "guide"}).raise_for_status()
    return t, hotel


def test_photos_of_a_place_own_and_from_wikimedia(make_client):
    c, base, _ = agency(make_client)
    hotel = c.post(f"{base}/vendors", json={"name": "Old Town Hotel", "type": "hotel"}).json()
    up = c.post(f"{base}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, data={"vendor_id": hotel["id"]})
    assert up.status_code == 201, up.text
    assert c.get(up.json()["url"]).status_code == 200
    wiki = c.post(f"{base}/photos/wikimedia", json={"vendor_id": hotel["id"], "url": "https://upload.wikimedia.org/x/1600px-H.jpg",
                                                    "credit": "A · CC BY 4.0", "link": "https://commons.wikimedia.org/wiki/File:H.jpg"})
    assert wiki.status_code == 201
    listed = c.get(f"{base}/photos", params={"vendor_id": hotel["id"]}).json()
    assert [p["id"] for p in listed] == [wiki.json()["id"], up.json()["id"]]          # the newest pick is the main one
    c.post(f"{base}/photos/{up.json()['id']}/main").raise_for_status()
    assert c.get(f"{base}/photos", params={"vendor_id": hotel["id"]}).json()[0]["id"] == up.json()["id"]
    # Only Wikimedia's own addresses
    assert c.post(f"{base}/photos/wikimedia", json={"place": "Tbilisi", "url": "https://evil.example/x.jpg"}).status_code == 422
    assert c.post(f"{base}/photos", files={"file": ("a.txt", b"hello", "text/plain")}, data={"place": "Tbilisi"}).status_code == 422
    assert c.delete(f"{base}/photos/{up.json()['id']}").status_code == 204
    assert len(c.get(f"{base}/photos", params={"vendor_id": hotel["id"]}).json()) == 1


def test_the_presentation_of_a_tour(make_client, offline):
    c, base, _ = agency(make_client)
    t, hotel = _tour(c, base)
    c.post(f"{base}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, data={"vendor_id": hotel["id"]}).raise_for_status()
    places = c.get(f"{base}/tours/{t['id']}/presentation/places").json()
    day1 = {s["name"]: s for s in places[0]}
    assert [s["kind"] for s in places[0]] == ["town", "sight", "hotel"]
    assert day1["Mtskheta"]["photo"]["credit"] == "Jane Doe · CC BY-SA 4.0"       # found on Wikimedia
    assert day1["Tbilisi"]["photo"] is None and day1["Old Town Hotel"]["photo"]["source"] == "upload"
    assert sorted(offline) == ["Mtskheta", "Tbilisi"]
    c.get(f"{base}/tours/{t['id']}/presentation/places")
    assert sorted(offline) == ["Mtskheta", "Tbilisi"]                               # each name searched once

    link = c.post(f"{base}/tours/{t['id']}/presentation", json={"lang": "en", "price": True})
    assert link.status_code == 201, link.text
    token = link.json()["token"]
    assert [x["token"] for x in c.get(f"{base}/tours/{t['id']}/presentation").json()] == [token]
    p = c.get(f"/api/shared/presentation/{token}").json()
    assert p["title"] == "Georgia Classic" and p["start"] == "2026-11-02" and p["people"] == 12
    assert p["cover"]["url"].endswith("1600px-Mtskheta.jpg") and p["price"] == "1,590 USD"
    assert [h["name"] for h in p["hotels"]] == ["Old Town Hotel"] and p["hotels"][0]["nights"] == 2
    assert p["included"][:2] == ["Hotel nights: 2", "Breakfasts: 2"]
    assert "Guide" in p["included"] and len(p["days"]) == 3 and p["points"] and p["roads"] == ["abc"]
    hotel_photo = p["hotels"][0]["photo"]["url"]
    assert hotel_photo.startswith(f"/api/shared/presentation/{token}/photos/") and c.get(hotel_photo).status_code == 200
    # Without the price; and the link stops working when taken back
    plain = c.post(f"{base}/tours/{t['id']}/presentation", json={"lang": "en"}).json()
    assert c.get(f"/api/shared/presentation/{plain['token']}").json()["price"] == ""
    c.delete(f"{base}/programme/share/{plain['id']}").raise_for_status()
    assert c.get(f"/api/shared/presentation/{plain['token']}").status_code == 404
    assert c.get(f"/api/shared/presentation/nope").status_code == 404


def test_a_photo_credit_is_the_author_not_their_note():
    assert presentation.short_author("This Photo was taken by Supanut Arunoprayote . Feel free to use any of my images") == "Supanut Arunoprayote"
    assert presentation.short_author("Jelger Groeneveld") == "Jelger Groeneveld"
    assert presentation.short_author("Commander, U.S. Naval Forces Europe-Africa/U.S. 6th Fleet").startswith("Commander, U.S. Naval")
    assert len(presentation.short_author("x " * 80)) <= 50
