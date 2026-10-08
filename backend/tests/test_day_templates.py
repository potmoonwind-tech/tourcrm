"""Saved days ("Kutaisi day"): kept per agency, renamed, deleted; the tour's date is not part of them."""
from .test_tours import agency, mk


def test_saved_day_is_kept_without_its_date_and_can_be_renamed_and_deleted(make_client):
    c, base, _ = agency(make_client)
    day = {"city": "Kutaisi", "hotel_id": None, "lunch_id": None, "dinner_id": None, "extras": [], "stops": ["Gelati"],
           "schedule": [{"id": "s1", "kind": "visit", "time": "10:00", "end": "", "title": "Gelati", "ref": None, "place": "", "notes": ""}],
           "date": "2026-10-02", "day_number": 2}
    t = mk(c, f"{base}/day-templates", {"name": "Kutaisi day", "city": "Kutaisi", "data": day})
    assert t["city"] == "Kutaisi" and "date" not in t["data"] and "day_number" not in t["data"]
    assert t["data"]["stops"] == ["Gelati"] and t["data"]["schedule"][0]["title"] == "Gelati"
    assert [x["name"] for x in c.get(f"{base}/day-templates").json()] == ["Kutaisi day"]
    r = c.patch(f"{base}/day-templates/{t['id']}", json={"name": "Kutaisi classic"})
    assert r.status_code == 200 and r.json()["name"] == "Kutaisi classic"
    assert c.delete(f"{base}/day-templates/{t['id']}").status_code == 204
    assert c.get(f"{base}/day-templates").json() == []


def test_saved_days_belong_to_their_agency(make_client):
    c, base, _ = agency(make_client)
    t = mk(c, f"{base}/day-templates", {"name": "Tbilisi day", "city": "Tbilisi", "data": {"city": "Tbilisi"}})
    c2, base2, _ = agency(make_client, "other@b.com", "B")
    assert c2.get(f"{base2}/day-templates").json() == []
    assert c2.patch(f"{base2}/day-templates/{t['id']}", json={"name": "x"}).status_code == 404
    assert c2.delete(f"{base2}/day-templates/{t['id']}").status_code == 404
    assert c.post(f"{base}/day-templates", json={"name": "", "city": "", "data": {}}).status_code == 422
