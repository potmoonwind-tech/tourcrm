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
    assert [(x["quantity"], x["unit_price"]) for x in meal] == [(2, 20), (20, 50)]         # guide + driver at their table, staff price
    c.patch(f"{base}/tours/{t['id']}", json={"leaders": 1, "staff_table": True})
    meal = sorted((x["quantity"], x["unit_price"]) for x in lines(c, base, t) if x["category"] == "meal")
    assert meal == [(3, 20), (19, 50)]                                                      # 19 tourists · leader + 2 staff
    b = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["vendor"]["name"] == "Cafe")
    body = c.post(f"{base}/tours/{t['id']}/bookings/{b['id']}/email-draft", json={"language": "en"}).json()["body"]
    assert "separate staff table" in body


def test_each_person_has_a_seat_in_the_costs(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {})
    staff = {a["role"]: a for a in c.get(f"{base}/tours/{t['id']}/staff").json()}
    # The tour leader eats with the group, the guide at the staff table, the driver on his own.
    c.patch(f"{base}/tours/{t['id']}", json={"leaders": 1, "leader_seat": "group"})
    c.patch(f"{base}/tours/{t['id']}/staff/{staff['guide']['id']}", json={"meal_seat": "staff"})
    c.patch(f"{base}/tours/{t['id']}/staff/{staff['driver']['id']}", json={"meal_seat": "none"})
    meal = sorted((x["quantity"], x["unit_price"]) for x in lines(c, base, t) if x["category"] == "meal")
    assert meal == [(1, 20), (20, 50)]                                                      # 20 with the leader · the guide
    b = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["vendor"]["name"] == "Cafe")
    body = c.post(f"{base}/tours/{t['id']}/bookings/{b['id']}/email-draft", json={"language": "en"}).json()["body"]
    assert "20 people · separate staff table × 1" in body


def test_calculation_from_the_tour_takes_its_crew(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {"staff_stay": "own", "staff_hotel_id": gh["id"]})
    c.patch(f"{base}/tours/{t['id']}", json={"leaders": 2})
    q = c.post(f"{base}/quotes", json={"preset": "blank", "tour_id": t["id"]}).json()
    doc = q["doc"] if "doc" in q else q
    n = doc["nights"][0]
    assert doc["leaders"] == 2
    assert (n["staff_stay"], n["staff_hotel"], float(n["staff_price"])) == ("own", "Guest House", 40)


def test_one_meal_seats_people_differently(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {})
    staff = {a["role"]: a for a in c.get(f"{base}/tours/{t['id']}/staff").json()}
    c.patch(f"{base}/tours/{t['id']}", json={"leaders": 1, "leader_seat": "group"})
    for a in staff.values():
        c.patch(f"{base}/tours/{t['id']}/staff/{a['id']}", json={"meal_seat": "group"})
    [row] = [r for r in c.get(f"{base}/tours/{t['id']}/meals").json()["rows"] if r["meal"] == "dinner"]
    assert row["tables"] == [22] and {s["key"]: s["seat"] for s in row["seats"]} == {
        "leader": "group", staff["guide"]["id"]: "group", staff["driver"]["id"]: "group"}
    # At this dinner the leader, guide and driver sit at their own table.
    seats = {"leader": "staff", staff["guide"]["id"]: "staff", staff["driver"]["id"]: "staff"}
    assert c.put(f"{base}/tours/{t['id']}/days/{row['day']}/seating/dinner", json={"seats": seats}).status_code == 204
    [row] = [r for r in c.get(f"{base}/tours/{t['id']}/meals").json()["rows"] if r["meal"] == "dinner"]
    assert row["tables"] == [19, 3] and all(s["seat"] == "staff" and s["usual"] == "group" for s in row["seats"])
    meal = sorted((x["quantity"], x["unit_price"]) for x in lines(c, base, t) if x["category"] == "meal")
    assert meal == [(3, 20), (19, 50)]
    # Back to the usual: nothing kept for that meal.
    c.put(f"{base}/tours/{t['id']}/days/{row['day']}/seating/dinner", json={"seats": {"leader": "group"}})
    assert [r for r in c.get(f"{base}/tours/{t['id']}/meals").json()["rows"] if r["meal"] == "dinner"][0]["tables"] == [22]


def test_the_bus_driver_eats_only_when_chosen(make_client):
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {})
    bus = mk(c, f"{base}/vendors", {"name": "Caucasus Coaches", "type": "transport"})
    a = mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": bus["id"], "role": "transport"})
    meal = sorted((x["quantity"], x["unit_price"]) for x in lines(c, base, t) if x["category"] == "meal")
    assert meal == [(2, 20), (20, 50)]                                       # the bus driver: not counted until chosen
    [row] = [r for r in c.get(f"{base}/tours/{t['id']}/meals").json()["rows"] if r["meal"] == "dinner"]
    assert {s["key"]: s["seat"] for s in row["seats"]}[a["id"]] == "none"     # but in the grid
    c.patch(f"{base}/tours/{t['id']}/staff/{a['id']}", json={"meal_seat": "group"})
    meal = sorted((x["quantity"], x["unit_price"]) for x in lines(c, base, t) if x["category"] == "meal")
    assert meal == [(2, 20), (21, 50)]


def test_a_meal_composed_in_the_tour(make_client):
    """The manager writes the dinner's dishes in the tour (this tour only), seats a photographer at the
    staff table, sees the plates per table, and keeps the menu for the restaurant's next tours."""
    c, base, _ = agency(make_client)
    t, hotel, guest, cafe = setup(c, base, lambda gh: {})
    url = f"{base}/tours/{t['id']}"
    tour = c.get(url).json()
    from app.programme import ProgrammeIn  # noqa: F401 - the same fields as the builder sends
    days = [{k: v for k, v in d.items() if k in ("city", "km", "notes", "border_crossing", "extras", "stops", "schedule",
                                                  "lunch_menu_id", "dinner_menu_id", "breakfast_mode", "lunch_mode", "dinner_mode")}
            | {"hotel_id": (d["hotel"] or {}).get("id"), "dinner_id": (d["dinner"] or {}).get("id"), "lunch_id": None}
            for d in tour["days"]]
    days[0]["meal_dishes"] = {"dinner": [{"name": "Khinkali", "per_plate": 5}, {"name": "Soup"}]}
    days[0]["seating"] = {"dinner": {"_extra": [{"name": "Photographer", "seat": "staff"}]}}
    r = c.put(f"{url}/itinerary", json={"days": days})
    assert r.status_code == 200, r.text
    saved = r.json()["days"][0]
    assert saved["meal_dishes"]["dinner"][0]["name"] == "Khinkali" and saved["seating"]["dinner"]["_extra"][0]["seat"] == "staff"
    [row] = [x for x in c.get(f"{url}/meals").json()["rows"] if x["meal"] == "dinner"]
    # 20 tourists; guide, driver and the photographer at the staff table.
    assert row["tables"] == [20, 3] and [d["name"] for d in row["dishes"]] == ["Khinkali", "Soup"]
    assert row["dishes"][0]["plates"] == 4 + 1                                   # 20/5 -> 4, 3/5 -> 1
    assert any(s["role"] == "guest" and s["name"] == "Photographer" for s in row["seats"])
    # Kept as the restaurant's menu for the next tours.
    m = c.post(f"{base}/vendors/{cafe['id']}/menu", json={"meal": "dinner", "dishes": saved["meal_dishes"]["dinner"]}).json()
    assert m["name"] == "Cafe · Dinner 1"
    menus = [x for x in c.get(f"{base}/vendors/{cafe['id']}/services").json() if x["id"] == m["id"]]
    assert [(d["name"], d["per_plate"]) for d in menus[0]["dishes"]] == [("Khinkali", 5), ("Soup", None)]
