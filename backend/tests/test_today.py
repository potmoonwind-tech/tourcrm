"""The operator's "Today": each group's day hour by hour, and how its suppliers are booked."""
from datetime import date

from .test_tours import agency


def test_today_has_the_programme_and_bookings(make_client):
    c, base, _ = agency(make_client)
    h = c.post(f"{base}/vendors", json={"name": "Old Town Hotel", "type": "hotel", "city": "Tbilisi"}).json()
    tour = c.post(f"{base}/tours", json={"start_date": "2026-11-03", "end_date": "2026-11-04", "pax": 10}).json()
    days = [{"city": "Tbilisi", "hotel_id": h["id"]}, {"city": "Tbilisi"}]
    assert c.put(f"{base}/tours/{tour['id']}/itinerary", json={"days": days}).status_code == 200
    rows = c.get(f"{base}/day/2026-11-03").json()
    assert len(rows) == 1
    r = rows[0]
    assert r["programme"] is not None and any("Old Town Hotel" in s["text"] for s in r["programme"]["steps"])
    assert isinstance(r["bookings"], dict)


def test_timeline_has_the_towns_by_day(make_client):
    c, base, _ = agency(make_client)
    tour = c.post(f"{base}/tours", json={"start_date": "2026-11-03", "end_date": "2026-11-05", "pax": 10}).json()
    c.put(f"{base}/tours/{tour['id']}/itinerary", json={"days": [{"city": "Tbilisi"}, {"city": "Kazbegi"}, {"city": "Tbilisi"}]})
    rows = c.get(f"{base}/timeline", params={"date_from": "2026-11-01", "date_to": "2026-11-30"}).json()
    assert [d["city"] for d in rows[0]["days"]] == ["Tbilisi", "Kazbegi", "Tbilisi"]
    assert rows[0]["days"][0]["todo"] is True       # no hotel, no meals yet


def test_timeline_has_the_staff_by_dates(make_client):
    c, base, _ = agency(make_client)
    guide = c.post(f"{base}/vendors", json={"name": "Nino", "type": "guide"}).json()
    tour = c.post(f"{base}/tours", json={"start_date": "2026-11-03", "end_date": "2026-11-06", "pax": 10}).json()
    c.post(f"{base}/tours/{tour['id']}/staff", json={"vendor_id": guide["id"], "role": "guide", "start_day": 2})
    rows = c.get(f"{base}/timeline", params={"date_from": "2026-11-01", "date_to": "2026-11-30"}).json()
    assert [(s["name"], s["role"], s["start"], s["end"]) for s in rows[0]["staff"]] == [("Nino", "guide", "2026-11-04", "2026-11-06")]
    assert rows[0]["days"][0]["hotel"] == ""


def test_the_agency_time_zone_is_kept(make_client):
    c, base, _ = agency(make_client)
    ws = base.rsplit("/", 1)[-1]
    r = c.patch(f"/api/workspaces/{ws}", json={"timezone": "Asia/Tbilisi"})
    assert r.status_code == 200 and r.json()["timezone"] == "Asia/Tbilisi"
    assert c.patch(f"/api/workspaces/{ws}", json={"timezone": "not a zone"}).status_code == 422
