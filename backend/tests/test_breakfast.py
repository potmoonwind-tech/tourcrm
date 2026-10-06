"""Breakfast: usually at last night's hotel (in the room price: nothing more to book or pay); sometimes at a
café or restaurant — then it's booked, costed, emailed and on the meals list like lunch and dinner."""
from .test_tours import agency, mk


def setup(c, base, breakfast=None):
    cafe = mk(c, f"{base}/vendors", {"name": "Café Stamba", "type": "restaurant", "email": "hi@stamba.ge"})
    c.put(f"{base}/vendors/{cafe['id']}/services", json=[
        {"code": "breakfast", "name": "Breakfast / person", "category": "meal", "unit": "person", "rates": [{"price": "15", "currency": "GEL"}]}])
    day2 = {"city": "Tbilisi", **(breakfast(cafe["id"]) if breakfast else {})}
    route = mk(c, f"{base}/series", {"code": "B", "days": [{"city": "Tbilisi"}, day2, {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"code": "B-1", "series_id": route["id"], "start_date": "2026-11-10", "pax": 10})
    return cafe, route, t


def test_breakfast_at_the_hotel_is_nothing_extra(make_client):
    c, base, _ = agency(make_client)
    cafe, route, t = setup(c, base)
    day = c.get(f"{base}/tours/{t['id']}").json()["days"][1]
    assert day["breakfast_mode"] == "hotel" and day["breakfast"] is None
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    assert not [x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "meal"]
    assert not [b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["vendor"]["name"] == "Café Stamba"]


def test_breakfast_at_a_cafe_is_booked_costed_and_emailed(make_client):
    c, base, _ = agency(make_client)
    cafe, route, t = setup(c, base, lambda cid: {"breakfast_id": cid, "breakfast_mode": "included"})
    days = c.get(f"{base}/tours/{t['id']}").json()["days"]
    assert days[1]["breakfast"]["name"] == "Café Stamba" and days[1]["breakfast_mode"] == "included"     # copied from the route
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    line = next(x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "meal")
    assert line["quantity"] == 10 and line["unit_price"] == 15 and line["description"].startswith("breakfast")
    b = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["vendor"]["name"] == "Café Stamba")
    assert b["details"]["breakfasts"] == 1 and b["details"]["people"] == 10
    body = c.post(f"{base}/tours/{t['id']}/bookings/{b['id']}/email-draft", json={"language": "en"}).json()["body"]
    assert "Breakfast: 11 Nov 2026 · 10 people" in body
    meals = c.get(f"{base}/tours/{t['id']}/meals").json()["rows"]
    assert [(r["day"], r["meal"]) for r in meals] == [(2, "breakfast")]

    # Back to the hotel on the tour: no cost, no booking.
    did = days[1]["id"]
    c.patch(f"{base}/tours/{t['id']}/days/{did}", json={"breakfast_mode": "hotel", "breakfast_id": None})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    assert not [x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "meal"]
