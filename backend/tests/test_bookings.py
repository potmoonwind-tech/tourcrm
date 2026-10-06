"""Bookings follow the itinerary; status, who books, payment plan; changes after confirming show up."""
from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_tours import agency, mk


def test_bookings_follow_the_tour(make_client):
    c, base, ws = agency(make_client)
    t, hotel, resto, guide = setup_tour(c, base, start="2026-11-10")
    url = f"{base}/tours/{t['id']}/bookings"
    r = c.get(url).json()
    by = {b["vendor"]["name"]: b for b in r["bookings"]}
    assert set(by) == {"Hotel", "Resto", "Guide"} and (r["confirmed"], r["total"]) == (0, 3)
    h = by["Hotel"]
    assert h["kind"] == "hotel" and h["details"]["nights"] == 2 and h["details"]["rooms"] == {"DBL": 2, "SGL": 1}
    assert h["book_by"] == "2026-10-11" and h["state"] == "to_book"           # 30 days before the first night
    assert by["Resto"]["details"] == {"lunches": 1, "dinners": 1, "people": 5}
    assert by["Guide"]["details"]["staff"] == [{"role": "guide", "from": 1, "to": 3}]

    # Confirm the hotel with its number; paid by transfer before arrival.
    r = c.patch(f"{url}/{h['id']}", json={"status": "confirmed", "reference": "RB-778", "pay_when": "before"}).json()
    h = next(b for b in r["bookings"] if b["vendor"]["name"] == "Hotel")
    assert (h["state"], h["reference"], r["confirmed"]) == ("ok", "RB-778", 1)
    # The group changes rooms: the hotel must confirm again.
    c.patch(f"{base}/tours/{t['id']}", json={"rooms": "3 DBL"})
    h = next(b for b in c.get(url).json()["bookings"] if b["vendor"]["name"] == "Hotel")
    assert h["state"] == "changed"

    # The restaurant leaves the itinerary: its untouched booking disappears; a requested one asks to cancel.
    c.patch(f"{url}/{by['Guide']['id']}", json={"status": "requested", "paid_by": "guide", "pay_method": "cash"})
    staff_id = c.get(f"{base}/tours/{t['id']}").json()["staff"][0]["id"]
    c.delete(f"{base}/tours/{t['id']}/staff/{staff_id}")
    days = c.get(f"{base}/tours/{t['id']}").json()["days"]
    for d in days:
        c.patch(f"{base}/tours/{t['id']}/days/{d['id']}", json={"lunch_id": None, "dinner_id": None})
    r = c.get(url).json()
    names = {b["vendor"]["name"]: b for b in r["bookings"]}
    assert "Resto" not in names and names["Guide"]["state"] == "cancel" and not names["Guide"]["in_itinerary"]
    assert (names["Guide"]["paid_by"], names["Guide"]["pay_method"]) == ("guide", "cash")

    # Who does what: hotels go to a colleague; a booking can name someone else.
    staff = make_client()
    signup(staff, "nino@a.com")
    invite_and_join(c, ws, staff, "nino@a.com", "staff")
    nino = next(m["user_id"] for m in c.get(f"{base}/members").json() if m["email"] == "nino@a.com")
    assert c.patch(base, json={"task_owners": {"hotel": nino}}).status_code == 200
    assert names["Hotel"]["default_assignee_id"] is None
    h = next(b for b in c.get(url).json()["bookings"] if b["vendor"]["name"] == "Hotel")
    assert h["default_assignee_id"] == nino
    assert c.patch(base, json={"task_owners": {"hotel": "not-a-member"}}).status_code == 422
    # Staff can work on bookings.
    assert staff.patch(f"{url}/{h['id']}", json={"status": "requested"}).status_code == 200


def test_late_bookings_are_an_alert(make_client):
    from datetime import date, timedelta
    c, base, ws = agency(make_client)
    t, *_ = setup_tour(c, base, start=(date.today() + timedelta(days=10)).isoformat())
    a = next(x for x in c.get(f"{base}/tours/{t['id']}/alerts").json() if x["code"] == "bookings_late")
    assert a["params"]["n"] == 2 and a["link"] == "bookings" and a["severity"] == "warning"   # hotel (30 days ahead) and guide (14); meals are due 7 days ahead


def test_separate_hotel_stays_are_shown_as_such(make_client):
    from .test_tours import seed_route
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    # Tbilisi on night 1, away on night 2, Tbilisi again on night 3: two stays, not one.
    c.put(f"{base}/series/{series['id']}", json={"code": "HM", "name": "x", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Kazbegi", "hotel_id": kaz["id"]},
        {"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 2, "rooms": "1 DBL"})
    b = next(x for x in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if x["vendor"]["name"] == "Pullman Tbilisi")
    assert b["details"]["nights"] == 3
    assert b["details"]["stays"] == [{"check_in": "2027-05-10", "check_out": "2027-05-11", "nights": 1},
                                     {"check_in": "2027-05-12", "check_out": "2027-05-14", "nights": 2}]


def test_meals_the_tourists_pay_or_skip(make_client):
    """Included: a cost. Tourists pay: reserve the restaurant, no cost. On their own: nothing."""
    from .test_tours import seed_route
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    c.put(f"{base}/vendors/{resto['id']}/services", json=[
        {"code": "lunch", "name": "Lunch", "category": "meal", "unit": "person", "rates": [{"price": "30", "currency": "GEL"}]},
        {"code": "dinner", "name": "Dinner", "category": "meal", "unit": "person", "rates": [{"price": "40", "currency": "GEL"}]}])
    c.put(f"{base}/series/{series['id']}", json={"code": "HM", "name": "x", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"], "lunch_id": resto["id"], "dinner_id": resto["id"], "dinner_mode": "tourists"},
        {"city": "Tbilisi", "hotel_id": hotel["id"], "lunch_id": resto["id"], "lunch_mode": "own"},
        {"city": "Kazbegi"}]})
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 10, "rooms": "5 DBL"})
    assert (t["days"][0]["dinner_mode"], t["days"][1]["lunch_mode"]) == ("tourists", "own")
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    meals = [x["description"] for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "meal"]
    assert meals == ["lunch × 10"]                                    # only the one we pay
    b = next(x for x in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if x["vendor"]["id"] == resto["id"])
    assert b["details"]["lunches"] == 1 and b["details"]["dinners"] == 1 and b["details"]["tourists_pay"] == 1


def test_a_series_hotel_is_booked_once_for_all_departures(make_client):
    from datetime import date, timedelta
    from .test_tours import seed_route
    c, base, ws = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    starts = [(date.today() + timedelta(days=40 + 7 * i)).isoformat() for i in range(3)]
    made = c.post(f"{base}/tours/departures", json={"series_id": series["id"], "pax": 20, "rooms": "10 TWN",
                                                    "departures": [{"start_date": s} for s in starts]}).json()
    assert all(m["tour_id"] for m in made)
    # One task per supplier for the whole series, not one per departure.
    tasks = [x for x in c.get(f"{base}/tasks", params={"who": "all"}).json() if x["kind"] == "book"]
    pullman = [x for x in tasks if x["title"] == "Pullman Tbilisi"]
    assert len(pullman) == 1 and pullman[0]["count"] == 3 and pullman[0]["tour_code"] == "HM"
    assert pullman[0]["link"] == f"series/{series['id']}?vendor={hotel['id']}"
    # Give it to one person: every departure's booking.
    me = c.get("/api/auth/me").json()["user"]["id"] if "user" in c.get("/api/auth/me").json() else c.get("/api/auth/me").json()["id"]
    assert c.put(f"{base}/tasks/assign", json={"key": pullman[0]["key"], "assignee_id": me}).status_code == 204
    s = c.get(f"{base}/series/{series['id']}/bookings").json()
    p = next(g for g in s if g["vendor"]["name"] == "Pullman Tbilisi")
    assert p["total"] == 3 and p["confirmed"] == 0 and {t["assignee_id"] for t in p["tours"]} == {me}
    # The allotment is confirmed once, with its contract number.
    s = c.post(f"{base}/series/{series['id']}/bookings", json={"vendor_id": hotel["id"], "status": "confirmed",
                                                                "reference": "ALLOT-2027", "pay_when": "after"}).json()
    p = next(g for g in s if g["vendor"]["name"] == "Pullman Tbilisi")
    assert p["confirmed"] == 3 and {t["reference"] for t in p["tours"]} == {"ALLOT-2027"}
    assert not [x for x in c.get(f"{base}/tasks", params={"who": "all"}).json() if x["title"] == "Pullman Tbilisi"]
    other, base2, _ = agency(make_client, "o@o.com", "O")
    assert other.get(f"{base2}/series/{series['id']}/bookings").status_code == 404
