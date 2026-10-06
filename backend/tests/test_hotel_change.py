"""An overbooked series hotel on one departure: move the nights, see the difference, decide who pays."""
from .test_tours import agency, mk, seed_route


def setup(make_client):
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    c.put(f"{base}/vendors/{hotel['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "rates": [{"price": "100", "currency": "USD"}]}])
    other = mk(c, f"{base}/vendors", {"name": "Rioni Palace", "type": "hotel", "city": "Tbilisi"})
    c.put(f"{base}/vendors/{other['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "rates": [{"price": "130", "currency": "USD"}]}])
    client = mk(c, f"{base}/clients", {"name": "Partner"})
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 4, "rooms": "2 DBL",
                                "client_id": client["id"], "price_pp": "1000", "price_currency": "USD"})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    b = next(x for x in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if x["vendor"]["id"] == hotel["id"])
    c.patch(f"{base}/tours/{t['id']}/bookings/{b['id']}", json={"status": "confirmed"})
    return c, base, t, hotel, other


def test_partner_pays_the_difference(make_client):
    c, base, t, hotel, other = setup(make_client)
    url = f"{base}/tours/{t['id']}/change-hotel"
    body = {"from_hotel_id": hotel["id"], "to_hotel_id": other["id"], "days": [2], "who_pays": "client"}
    p = c.post(url, json={**body, "preview": True}).json()
    # One night (day 2), 2 rooms: 2 × 100 → 2 × 130.
    assert (p["old_cost"], p["new_cost"], p["difference"], p["per_person"]) == (200, 260, 60, 15)
    assert "Rioni Palace instead of Pullman Tbilisi" in p["message"] and "+" not in p["message"] and "15.00 USD per person" in p["message"]
    assert c.get(f"{base}/tours/{t['id']}").json()["days"][1]["hotel"]["name"] == "Pullman Tbilisi"      # preview: nothing changed

    r = c.post(url, json=body).json()
    tour = c.get(f"{base}/tours/{t['id']}").json()
    assert [d["hotel"]["name"] if d["hotel"] else None for d in tour["days"]][:2] == ["Pullman Tbilisi", "Rioni Palace"]
    assert r["invoice_id"] and r["incident_id"] and any("hotel Pullman Tbilisi → Rioni Palace" in x for x in r["changes"])
    inv = c.get(f"{base}/invoices/{r['invoice_id']}").json()
    assert inv["total"] == 60 and inv["status"] == "draft"
    # Costs follow; the old hotel (confirmed) now has one night less → "confirm again"; the new one is to book.
    lines = {(x["vendor"]["name"], x["unit_price"]) for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "hotel"}
    assert ("Rioni Palace", 130.0) in lines
    states = {x["vendor"]["name"]: x["state"] for x in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"]}
    assert states["Pullman Tbilisi"] == "changed" and states["Rioni Palace"] == "to_book"


def test_claim_against_the_overbooked_hotel(make_client):
    c, base, t, hotel, other = setup(make_client)
    r = c.post(f"{base}/tours/{t['id']}/change-hotel", json={"from_hotel_id": hotel["id"], "to_hotel_id": other["id"], "who_pays": "hotel"}).json()
    assert r["difference"] == 120 and r["invoice_id"] is None and "doesn't change the price" in r["message"]
    claims = [x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["description"].startswith("Claim:")]
    assert claims and claims[0]["vendor"]["name"] == "Pullman Tbilisi"
