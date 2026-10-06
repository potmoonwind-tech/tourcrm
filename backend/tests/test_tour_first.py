"""Tours first, then the price: a calculation made from the tour's own days (its hotels, even when changed
from the route), on its dates and for its group size, then given back to the tour (price + budget)."""
from .test_tours import agency, mk


def test_calculate_a_tour_that_exists(make_client):
    c, base, _ = agency(make_client)
    route_hotel = mk(c, f"{base}/vendors", {"name": "Route Hotel", "type": "hotel"})
    better = mk(c, f"{base}/vendors", {"name": "Better Hotel", "type": "hotel"})
    for h, price in ((route_hotel, "60"), (better, "90")):
        c.put(f"{base}/vendors/{h['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "category": "hotel", "unit": "room_night",
                                                           "rates": [{"price": price, "currency": "USD"}]}])
    route = mk(c, f"{base}/series", {"code": "R", "days": [{"city": "Tbilisi", "hotel_id": route_hotel["id"]},
                                                          {"city": "Tbilisi", "hotel_id": route_hotel["id"]}, {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"code": "R-0601", "series_id": route["id"], "start_date": "2026-06-01", "pax": 31})
    # On this tour the second night moved to a better hotel.
    d2 = c.get(f"{base}/tours/{t['id']}").json()["days"][1]
    c.patch(f"{base}/tours/{t['id']}/days/{d2['id']}", json={"hotel_id": better["id"]})

    r = c.post(f"{base}/quotes", json={"preset": "blank", "tour_id": t["id"]})
    assert r.status_code == 201, r.text
    q = r.json()
    doc = q["doc"] if "doc" in q else q
    assert doc["name"] == "R-0601" and doc["series_id"] == route["id"] and doc["valid_from"] == "2026-06-01"
    assert [n["hotel_name"] for n in doc["nights"]] == ["Route Hotel", "Better Hotel"]          # the tour's own hotels
    assert doc["pax_min"] <= 31 - doc["leaders"] <= doc["pax_max"]                              # its group fits

    res = c.post(f"{base}/quotes/{q['id']}/apply", json={"tour_ids": [t["id"]]}).json()
    assert res[0]["error"] == "", res
    after = c.get(f"{base}/tours/{t['id']}").json()
    assert after["quote_id"] == q["id"] and after["price_pp"] and after["price_pp"] > 0
    assert c.get(f"{base}/tours/{t['id']}/budget").json()["set"]


def test_a_tour_without_a_route_can_be_calculated_too(make_client):
    c, base, _ = agency(make_client)
    t = mk(c, f"{base}/tours", {"code": "ONE-OFF", "start_date": "2026-07-01", "end_date": "2026-07-04", "pax": 8})
    r = c.post(f"{base}/quotes", json={"preset": "blank", "tour_id": t["id"]})
    assert r.status_code == 201, r.text
    assert c.post(f"{base}/quotes", json={"preset": "blank", "tour_id": "nope"}).status_code == 404
