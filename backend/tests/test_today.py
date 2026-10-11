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
