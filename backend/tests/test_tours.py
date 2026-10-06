from .conftest import invite_and_join, signup


def agency(make_client, email="boss@a.com", name="A"):
    c = make_client()
    ws = signup(c, email, name)["workspaces"][0]["id"]
    return c, f"/api/workspaces/{ws}", ws


def mk(c, url, body, code=201):
    r = c.post(url, json=body)
    assert r.status_code == code, r.text
    return r.json()


def seed_route(c, base):
    hotel = mk(c, f"{base}/vendors", {"name": "Pullman Tbilisi", "type": "hotel", "city": "Tbilisi", "phone": "+995 1"})
    resto = mk(c, f"{base}/vendors", {"name": "Barbarestan", "type": "restaurant", "city": "Tbilisi"})
    kaz = mk(c, f"{base}/vendors", {"name": "Rooms Kazbegi", "type": "hotel", "city": "Kazbegi"})
    series = mk(c, f"{base}/series", {"code": "hm", "name": "Highlights", "color": "emerald", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"], "dinner_id": resto["id"]},
        {"city": "Tbilisi", "hotel_id": hotel["id"], "lunch_id": resto["id"]},
        {"city": "Kazbegi", "hotel_id": kaz["id"], "border_crossing": "Upper Lars"},
    ]})
    return hotel, resto, kaz, series


def test_tour_from_series_copies_itinerary_and_generates_code(make_client):
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    assert series["code"] == "HM"
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-06", "pax": 24})
    assert t["code"] == "HM-0906"
    assert t["end_date"] == "2026-09-08"
    assert [d["date"] for d in t["days"]] == ["2026-09-06", "2026-09-07", "2026-09-08"]
    assert t["days"][0]["hotel"]["name"] == "Pullman Tbilisi"
    assert t["days"][0]["dinner"]["id"] == resto["id"]
    assert t["days"][2]["border_crossing"] == "Upper Lars"
    assert t["color"] == "emerald" and t["series_code"] == "HM"

    # A second group of the same series on the same day gets a suffix.
    t2 = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-06"})
    assert t2["code"] == "HM-0906B"


def test_moving_and_resizing_tour_keeps_day_content(make_client):
    c, base, _ = agency(make_client)
    *_, series = seed_route(c, base)
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-06"})
    day2 = t["days"][1]
    c.patch(f"{base}/tours/{t['id']}/days/{day2['id']}", json={"notes": "Wine tasting"})

    # Shift start: length preserved, content moves with the days.
    r = c.patch(f"{base}/tours/{t['id']}", json={"start_date": "2026-09-10"}).json()
    assert (r["start_date"], r["end_date"]) == ("2026-09-10", "2026-09-12")
    assert r["days"][1]["date"] == "2026-09-11" and r["days"][1]["notes"] == "Wine tasting"

    # Shorten, then lengthen: dropped day comes back from the template.
    r = c.patch(f"{base}/tours/{t['id']}", json={"end_date": "2026-09-11"}).json()
    assert len(r["days"]) == 2
    r = c.patch(f"{base}/tours/{t['id']}", json={"end_date": "2026-09-13"}).json()
    assert len(r["days"]) == 4
    assert r["days"][2]["city"] == "Kazbegi" and r["days"][3]["city"] == ""

    assert c.patch(f"{base}/tours/{t['id']}", json={"end_date": "2026-09-01"}).status_code == 422


def test_blank_tour_needs_end_date(make_client):
    c, base, _ = agency(make_client)
    assert c.post(f"{base}/tours", json={"start_date": "2026-09-01"}).status_code == 422
    t = mk(c, f"{base}/tours", {"code": "vip-1", "start_date": "2026-09-01", "end_date": "2026-09-02"})
    assert t["code"] == "VIP-1" and len(t["days"]) == 2
    assert c.post(f"{base}/tours", json={"code": "VIP-1", "start_date": "2026-09-01",
                                          "end_date": "2026-09-01"}).status_code == 409


def test_day_view_and_date_filters(make_client):
    c, base, _ = agency(make_client)
    *_, series = seed_route(c, base)
    a = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-06"})
    b = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-08"})
    x = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-07", "status": "cancelled"})

    rows = c.get(f"{base}/day/2026-09-08").json()
    assert {r["tour"]["code"]: (r["day"]["city"], r["is_first_day"], r["is_last_day"]) for r in rows} == {
        a["code"]: ("Kazbegi", False, True),
        b["code"]: ("Tbilisi", True, False),
    }
    assert len(c.get(f"{base}/day/2026-09-08?include_cancelled=true").json()) == 3

    codes = [t["code"] for t in c.get(f"{base}/tours?date_from=2026-09-09&date_to=2026-09-30").json()]
    assert codes == [x["code"], b["code"]] or set(codes) == {b["code"], x["code"]}
    assert [t["code"] for t in c.get(f"{base}/tours?status=cancelled").json()] == [x["code"]]


def test_cannot_reference_another_workspaces_records(make_client):
    a, base_a, _ = agency(make_client, "a@a.com", "A")
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    hotel_b, _, _, series_b = seed_route(b, base_b)
    client_b = mk(b, f"{base_b}/clients", {"name": "B's client"})
    tour_b = mk(b, f"{base_b}/tours", {"series_id": series_b["id"], "start_date": "2026-09-01"})

    # Reading by id: indistinguishable from missing.
    assert a.get(f"{base_a}/vendors/{hotel_b['id']}").status_code == 404
    assert a.get(f"{base_a}/tours/{tour_b['id']}").status_code == 404
    assert a.get(f"{base_a}/series/{series_b['id']}").status_code == 404
    assert a.patch(f"{base_a}/tours/{tour_b['id']}/days/{tour_b['days'][0]['id']}", json={"notes": "x"}).status_code == 404
    assert a.delete(f"{base_a}/clients/{client_b['id']}").status_code == 404

    # Linking: A can't point its own records at B's vendors / clients / series.
    assert a.post(f"{base_a}/tours", json={"series_id": series_b["id"], "start_date": "2026-09-01"}).status_code == 404
    assert a.post(f"{base_a}/tours", json={"code": "X", "start_date": "2026-09-01", "end_date": "2026-09-01",
                                           "client_id": client_b["id"]}).status_code == 422
    assert a.post(f"{base_a}/series", json={"code": "Z", "days": [{"hotel_id": hotel_b["id"]}]}).status_code == 422
    own = mk(a, f"{base_a}/tours", {"code": "OWN", "start_date": "2026-09-01", "end_date": "2026-09-01"})
    assert a.post(f"{base_a}/tours/{own['id']}/staff", json={"vendor_id": hotel_b["id"], "role": "guide"}).status_code == 422
    assert a.patch(f"{base_a}/tours/{own['id']}/days/{own['days'][0]['id']}",
                   json={"hotel_id": hotel_b["id"]}).status_code == 422

    # Listings never leak.
    assert a.get(f"{base_a}/vendors").json() == []
    assert [t["code"] for t in a.get(f"{base_a}/tours").json()] == ["OWN"]
    assert a.get(f"{base_a}/day/2026-09-01").json()[0]["tour"]["code"] == "OWN"


def test_role_permissions_for_tours(make_client):
    owner, base, ws = agency(make_client)
    *_, series = seed_route(owner, base)
    staff, guide = make_client(), make_client()
    signup(staff, "s@a.com")
    signup(guide, "g@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    invite_and_join(owner, ws, guide, "g@a.com", "guide")

    t = mk(staff, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-01"})  # staff create tours
    assert staff.patch(f"{base}/tours/{t['id']}", json={"pax": 30}).status_code == 200
    assert staff.delete(f"{base}/tours/{t['id']}").status_code == 403
    assert staff.post(f"{base}/vendors", json={"name": "x", "type": "hotel"}).status_code == 403
    assert staff.put(f"{base}/series/{series['id']}", json={"code": "HM"}).status_code == 403
    assert staff.get(f"{base}/vendors").status_code == 200

    # Guides get the dedicated guide portal later, not the office API.
    assert guide.get(f"{base}/tours").status_code == 403
    assert guide.get(f"{base}/day/2026-09-01").status_code == 403

    assert owner.delete(f"{base}/tours/{t['id']}").status_code == 204


def test_clearing_links_and_deleting_vendor(make_client):
    c, base, _ = agency(make_client)
    hotel, *_ , series = seed_route(c, base)
    guide = mk(c, f"{base}/vendors", {"name": "Levan", "type": "guide", "phone": "555"})
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2026-09-01"})
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": guide["id"], "role": "guide"})
    t = c.get(f"{base}/tours/{t['id']}").json()
    assert t["staff"][0]["vendor"]["phone"] == "555"

    other = mk(c, f"{base}/vendors", {"name": "Hualing", "type": "hotel"})
    d = c.patch(f"{base}/tours/{t['id']}/days/{t['days'][1]['id']}", json={"hotel_id": other["id"]}).json()
    assert d["hotel"]["name"] == "Hualing"
    d = c.patch(f"{base}/tours/{t['id']}/days/{t['days'][1]['id']}", json={"hotel_id": None}).json()
    assert d["hotel"] is None

    assert c.delete(f"{base}/vendors/{hotel['id']}").status_code == 204
    t = c.get(f"{base}/tours/{t['id']}").json()
    assert t["days"][0]["hotel"] is None  # link cleared, tour intact
    assert c.delete(f"{base}/vendors/{guide['id']}").status_code == 204
    assert c.get(f"{base}/tours/{t['id']}").json()["staff"] == []  # assignment goes with the vendor


def test_series_code_unique_per_workspace(make_client):
    a, base_a, _ = agency(make_client, "a@a.com", "A")
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    mk(a, f"{base_a}/series", {"code": "HM"})
    mk(a, f"{base_a}/series", {"code": "hm"}, code=409)
    mk(b, f"{base_b}/series", {"code": "HM"})  # other agency may reuse it


def test_tour_price_per_person_gives_expected_profit_and_is_for_managers(make_client):
    from .conftest import invite_and_join, signup
    c, base, ws = agency(make_client)
    t = mk(c, f"{base}/tours", {"start_date": "2026-11-02", "end_date": "2026-11-04", "pax": 10, "price_pp": "400"})
    assert (t["price_pp"], t["price_currency"]) == (400, "USD")          # agency currency by default
    p = c.get(f"{base}/tours/{t['id']}/profit").json()
    assert p["expected_revenue"] == 4000 and p["expected_profit"] == 4000 and p["revenue"] == 0
    # A price in another currency needs that rate.
    c.patch(f"{base}/tours/{t['id']}", json={"price_currency": "EUR"})
    p = c.get(f"{base}/tours/{t['id']}/profit").json()
    assert p["expected_revenue"] is None and p["missing_currencies"] == ["EUR"]
    c.put(f"{base}/exchange-rates", json=[{"currency": "EUR", "rate": "1.1"}])
    assert c.get(f"{base}/tours/{t['id']}/profit").json()["expected_revenue"] == 4400
    # The payment schedule starts from pax × price.
    sched = c.post(f"{base}/tours/{t['id']}/invoice-schedule/preview", json={}).json()
    assert (sched["total"], sched["currency"]) == (4000, "EUR")
    # Staff don't see or set prices.
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    assert staff.get(f"{base}/tours/{t['id']}").json()["price_pp"] is None
    assert staff.patch(f"{base}/tours/{t['id']}", json={"price_pp": "1"}).status_code == 403
    assert staff.patch(f"{base}/tours/{t['id']}", json={"pax": 11}).status_code == 200
    # Clearing the price.
    assert c.patch(f"{base}/tours/{t['id']}", json={"price_pp": None}).json()["price_pp"] is None


def test_custom_days_stops_and_estimated_pax(make_client):
    from datetime import date, timedelta
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    # A route day can visit other places before the night's city.
    s = c.put(f"{base}/series/{series['id']}", json={"code": "HM", "name": "Highlights", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"]},
        {"city": "Tbilisi", "stops": [" Mtskheta ", "", "Gori"], "hotel_id": hotel["id"], "lunch_id": resto["id"]},
        {"city": "Kazbegi"}]}).json()
    assert s["days"][1]["stops"] == ["Mtskheta", "Gori"]
    soon = (date.today() + timedelta(days=10)).isoformat()
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": soon, "pax": 20, "pax_estimated": True})
    assert t["days"][1]["stops"] == ["Mtskheta", "Gori"] and t["pax_estimated"] is True
    day = t["days"][2]
    assert c.patch(f"{base}/tours/{t['id']}/days/{day['id']}", json={"stops": ["Ananuri"]}).json()["stops"] == ["Ananuri"]
    # A guessed group size three weeks before: a reminder until it's confirmed.
    alerts = lambda: [a["code"] for a in c.get(f"{base}/tours/{t['id']}/alerts").json()]
    assert "pax_unconfirmed" in alerts()
    c.patch(f"{base}/tours/{t['id']}", json={"pax_estimated": False})
    assert "pax_unconfirmed" not in alerts()
    # Custom length without a route: just the dates.
    free = mk(c, f"{base}/tours", {"start_date": soon, "end_date": (date.today() + timedelta(days=16)).isoformat()})
    assert len(free["days"]) == 7 and free["pax"] == 0 and "pax_unconfirmed" in [a["code"] for a in c.get(f"{base}/tours/{free['id']}/alerts").json()]


def test_many_departures_of_a_series(make_client):
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    deps = [{"code": "HM-1025", "start_date": "2026-10-27"}, {"code": "HM-1101", "start_date": "2026-11-03"},
            {"start_date": "2026-11-10"}]
    r = c.post(f"{base}/tours/departures", json={"series_id": series["id"], "departures": deps, "pax": 20, "pax_estimated": True,
                                                 "rooms": "10 TWN"})
    assert r.status_code == 200, r.text
    res = r.json()
    assert [x["code"] for x in res] == ["HM-1025", "HM-1101", "HM-1110"] and all(x["tour_id"] for x in res)
    t = c.get(f"{base}/tours/{res[0]['tour_id']}").json()
    assert (t["start_date"], t["end_date"], t["pax"], t["pax_estimated"], t["status"]) == ("2026-10-27", "2026-10-29", 20, True, "inquiry")
    assert t["days"][0]["hotel"]["name"] == "Pullman Tbilisi"
    # A code already taken: that one is reported, the rest are made.
    again = c.post(f"{base}/tours/departures", json={"series_id": series["id"], "departures": [
        {"code": "HM-1025", "start_date": "2026-10-27"}, {"code": "HM-1117", "start_date": "2026-11-17"}]}).json()
    assert again[0]["tour_id"] is None and "already exists" in again[0]["error"] and again[1]["tour_id"]
    assert c.post(f"{base}/tours/departures", json={"series_id": series["id"], "departures": [
        {"code": "X-1", "start_date": "2026-10-27"}, {"code": "x-1", "start_date": "2026-11-03"}]}).status_code == 422


def test_flights_on_route_days_reach_every_departure(make_client):
    from datetime import date, timedelta
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    flight = {"direction": "departure", "number": "cz 6040", "time": "22:45", "airport": "TBS", "other": "Urumqi"}
    s = c.put(f"{base}/series/{series['id']}", json={"code": "HM", "name": "x", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"], "flights": [{"direction": "arrival", "number": "TK380", "time": "03:10", "airport": "TBS"}]},
        {"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi", "flights": [flight]}]}).json()
    assert s["days"][2]["flights"][0]["number"] == "CZ6040"
    assert c.put(f"{base}/series/{series['id']}", json={"code": "HM", "days": [{"city": "x", "flights": [{**flight, "time": "25:00"}]}]}).status_code == 422
    start = (date.today() + timedelta(days=30)).isoformat()
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": start, "pax": 10})
    assert t["days"][2]["flights"][0]["time"] == "22:45" and t["days"][0]["flights"][0]["number"] == "TK380"
    codes = [a["code"] for a in c.get(f"{base}/tours/{t['id']}/alerts").json()]
    assert codes.count("flight_no_transport") == 2 and "flight_late_checkout" in codes
    bus = mk(c, f"{base}/vendors", {"name": "Coach", "type": "transport"})
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": bus["id"], "role": "transport"})
    assert "flight_no_transport" not in [a["code"] for a in c.get(f"{base}/tours/{t['id']}/alerts").json()]


def test_route_changes_pushed_to_departures(make_client):
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    made = c.post(f"{base}/tours/departures", json={"series_id": series["id"], "departures": [
        {"start_date": "2026-11-10"}, {"start_date": "2026-11-17"}]}).json()
    days = [{"city": "Tbilisi", "hotel_id": hotel["id"], "dinner_mode": "own"},
            {"city": "Tbilisi", "hotel_id": hotel["id"], "lunch_id": resto["id"], "lunch_mode": "tourists"},
            {"city": "Kazbegi", "flights": [{"direction": "departure", "number": "CZ6040", "time": "22:45"}]}]
    c.put(f"{base}/series/{series['id']}", json={"code": "HM", "name": "x", "days": days})
    first = made[0]["tour_id"]
    assert c.get(f"{base}/tours/{first}").json()["route_changed"] is True
    res = c.post(f"{base}/series/{series['id']}/push", json={"tour_ids": [first]}).json()
    assert res[0]["error"] == ""
    t = c.get(f"{base}/tours/{first}").json()
    assert t["route_changed"] is False and t["days"][2]["flights"][0]["number"] == "CZ6040" and t["days"][1]["lunch_mode"] == "tourists"
    assert c.get(f"{base}/tours/{made[1]['tour_id']}").json()["days"][2]["flights"] == []      # not chosen: untouched


def test_day_programme_with_times(make_client):
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    prog = [{"id": "a", "kind": "breakfast", "time": "08:00", "title": "Breakfast", "ref": "hotel"},
            {"id": "b", "kind": "visit", "time": "10:00", "end": "11:30", "title": "Narikala", "place": "Tbilisi"},
            {"id": "c", "kind": "meal", "time": "13:00", "title": "Lunch", "ref": "lunch"},
            {"id": "d", "kind": "free", "time": "15:00", "title": "Free time"}]
    s = c.put(f"{base}/series/{series['id']}", json={"code": "HM", "name": "x", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"], "lunch_id": resto["id"], "schedule": prog}, {"city": "Tbilisi"}]}).json()
    assert [x["title"] for x in s["days"][0]["schedule"]] == ["Breakfast", "Narikala", "Lunch", "Free time"]
    assert c.put(f"{base}/series/{series['id']}", json={"code": "HM", "days": [{"city": "x", "schedule": [{"id": "z", "time": "8am"}]}]}).status_code == 422
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-04-01", "pax": 5})
    assert t["days"][0]["schedule"][1]["end"] == "11:30"
    # Reordered on the tour only.
    day = t["days"][0]
    new = [prog[1], prog[0], prog[2], prog[3]]
    assert [x["id"] for x in c.patch(f"{base}/tours/{t['id']}/days/{day['id']}", json={"schedule": new}).json()["schedule"]] == ["b", "a", "c", "d"]


def test_free_sights_from_routes_become_activities(make_client):
    """Stops the routes pass (Bodbe, Jvari) that aren't suppliers are offered as activities with no price,
    with how long a visit usually takes."""
    c, base, _ = agency(make_client)
    mk(c, f"{base}/series", {"code": "ZK", "days": [
        {"city": "Tbilisi", "stops": ["Lagodekhi", "Bodbe Monastery", "Sighnaghi"]},
        {"city": "Gudauri", "stops": ["Jvari Monastery", "Ananuri"],
         "schedule": [{"id": "a", "kind": "visit", "time": "10:00", "title": "Jvari Monastery"},
                      {"id": "b", "kind": "visit", "time": "12:00", "title": "Gergeti Trinity Church"}]}]})
    mk(c, f"{base}/vendors", {"name": "Sighnaghi", "type": "activity"})
    rows = {r["name"]: r for r in c.get(f"{base}/vendors/stop-suggestions").json()}
    assert "Sighnaghi" not in rows and rows["Jvari Monastery"]["uses"] == 2 and rows["Bodbe Monastery"]["routes"] == ["ZK"]
    assert "Gergeti Trinity Church" in rows                       # a visit typed in a day programme
    v = mk(c, f"{base}/vendors", {"name": "Bodbe Monastery", "type": "activity", "visit_minutes": 45})
    assert v["visit_minutes"] == 45
    assert "Bodbe Monastery" not in {r["name"] for r in c.get(f"{base}/vendors/stop-suggestions").json()}
    assert c.patch(f"{base}/vendors/{v['id']}", json={"visit_minutes": None}).json()["visit_minutes"] is None


def test_stop_suggestions_flag_a_supplier_with_a_longer_name(make_client):
    c, base, _ = agency(make_client)
    mk(c, f"{base}/series", {"code": "AR", "days": [{"city": "Yerevan", "stops": ["Garni", "Geghard"]}]})
    mk(c, f"{base}/vendors", {"name": "Garni temple", "type": "activity"})
    rows = {r["name"]: r for r in c.get(f"{base}/vendors/stop-suggestions").json()}
    assert rows["Garni"]["similar"] == "Garni temple" and rows["Geghard"]["similar"] is None
    mk(c, f"{base}/vendors", {"name": "Geghard local restaurant", "type": "restaurant"})
    assert {r["name"]: r for r in c.get(f"{base}/vendors/stop-suggestions").json()}["Geghard"]["similar"] is None


def test_a_driver_works_for_a_bus_company(make_client):
    c, base, _ = agency(make_client)
    bus = mk(c, f"{base}/vendors", {"name": "Coach company", "type": "transport"})
    hotel = mk(c, f"{base}/vendors", {"name": "Hotel", "type": "hotel"})
    d = mk(c, f"{base}/vendors", {"name": "Gela", "type": "driver", "company_id": bus["id"]})
    assert d["company_id"] == bus["id"]
    assert c.post(f"{base}/vendors", json={"name": "X", "type": "driver", "company_id": hotel["id"]}).status_code == 422
    assert c.patch(f"{base}/vendors/{d['id']}", json={"company_id": d["id"]}).status_code == 422     # not itself
    assert c.patch(f"{base}/vendors/{d['id']}", json={"company_id": None}).json()["company_id"] is None
    other, obase, _ = agency(make_client, "x@b.com", "B")
    theirs = mk(other, f"{obase}/vendors", {"name": "Their buses", "type": "transport"})
    assert c.patch(f"{base}/vendors/{d['id']}", json={"company_id": theirs["id"]}).status_code == 422
