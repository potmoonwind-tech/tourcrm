"""Real tours follow the calculator's crew rules: where the driver and guide sleep (and at what price), and
the leader + driver + guide at their own table - in the costs, the bookings and the booking emails."""
from .test_tours import agency, mk


def rates(c, base, vendor, *codes_prices):
    r = c.put(f"{base}/vendors/{vendor["id"]}/services", json=[
        {"code": code, "name": code, "category": cat, "unit": unit, "rates": [{"price": price, "currency": "GEL"}]}
        for code, cat, unit, price in codes_prices])
    assert r.status_code == 200, r.text


def setup(c, base, day1: dict):
    hotel = mk(c, f"{base}/vendors", {"name": "Group Hotel", "type": "hotel"})
    rates(c, base, hotel, ("room_DBL", "hotel", "room_night", "200"), ("room_SGL", "hotel", "room_night", "150"))
    guest = mk(c, f"{base}/vendors", {"name": "Guest House", "type": "hotel", "email": "gh@x.ge"})
    rates(c, base, guest, ("staff_room", "hotel", "room_night", "40"))
    cafe = mk(c, f"{base}/vendors", {"name": "Cafe", "type": "restaurant"})
    rates(c, base, cafe, ("dinner", "meal", "person", "50"), ("staff_meal", "meal", "person", "20"))
    route = mk(c, f"{base}/series", {"code": "C", "days": [
        {"city": "Kazbegi", "hotel_id": hotel["id"], "dinner_id": cafe["id"], **day1(guest)}, {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"code": "C-1", "series_id": route["id"], "start_date": "2026-11-01", "pax": 20, "rooms": "10 DBL"})
    g = mk(c, f"{base}/vendors", {"name": "Nino", "type": "guide"})
    d = mk(c, f"{base}/vendors", {"name": "Gia", "type": "driver"})
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": g["id"], "role": "guide"})
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": d["id"], "role": "driver"})
    return t, hotel, guest, cafe


def lines(c, base, t):
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    return c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]


def test_staff_in_another_hotel_is_costed_and_booked(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {"staff_stay": "own", "staff_hotel_id": gh["id"]})
    day = c.get(f"{base}/tours/{t['id']}").json()["days"][0]
    assert day["staff_stay"] == "own" and day["staff_hotel"]["name"] == "Guest House"      # copied from the route
    staff = next(x for x in lines(c, base, t) if x["vendor"]["name"] == "Guest House")
    assert staff["quantity"] == 2 and staff["unit_price"] == 40                             # 2 rooms at the staff price
    b = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["vendor"]["name"] == "Guest House")
    assert b["details"]["staff_rooms"] == {"rooms": {"SGL": 2}, "nights": 1} and "rooms" not in b["details"]
    body = c.post(f"{base}/tours/{t['id']}/bookings/{b['id']}/email-draft", json={"language": "en"}).json()["body"]
    assert "Driver and guide: 2 SGL · 1 night" in body


def test_same_hotel_sharing_a_room_and_free(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {"staff_stay": "same", "staff_twin": True})
    staff = next(x for x in lines(c, base, t) if x["description"].startswith("staff"))
    assert staff["vendor"]["name"] == "Group Hotel" and staff["quantity"] == 1 and staff["unit_price"] == 200
    did = c.get(f"{base}/tours/{t['id']}").json()["days"][0]["id"]
    c.patch(f"{base}/tours/{t['id']}/days/{did}", json={"staff_stay": "free"})
    assert not [x for x in lines(c, base, t) if x["description"].startswith("staff")]


def test_staff_table(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {})
    meal = [x for x in lines(c, base, t) if x["category"] == "meal"]
    assert [(x["quantity"], x["unit_price"]) for x in meal] == [(22, 50)]                  # 20 + guide + driver, one table
    c.patch(f"{base}/tours/{t['id']}", json={"leaders": 1, "staff_table": True})
    meal = sorted((x["quantity"], x["unit_price"]) for x in lines(c, base, t) if x["category"] == "meal")
    assert meal == [(3, 20), (19, 50)]                                                      # 19 tourists · leader + 2 staff
    b = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["vendor"]["name"] == "Cafe")
    body = c.post(f"{base}/tours/{t['id']}/bookings/{b['id']}/email-draft", json={"language": "en"}).json()["body"]
    assert "separate staff table" in body


def test_calculation_from_the_tour_takes_its_crew(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {"staff_stay": "own", "staff_hotel_id": gh["id"]})
    c.patch(f"{base}/tours/{t['id']}", json={"leaders": 2})
    q = c.post(f"{base}/quotes", json={"preset": "blank", "tour_id": t["id"]}).json()
    doc = q["doc"] if "doc" in q else q
    n = doc["nights"][0]
    assert doc["leaders"] == 2
    assert (n["staff_stay"], n["staff_hotel"], float(n["staff_price"])) == ("own", "Guest House", 40)
