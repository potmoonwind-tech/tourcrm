"""Alerts: conflicts and missing pieces, per tour and across the agency."""
from datetime import date, timedelta

from .conftest import invite_and_join, signup
from .test_tours import agency, mk

TODAY = date.today()


def d(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


def codes(rows, tour_id=None):
    return {a["code"] for a in rows if tour_id is None or a["tour_id"] == tour_id}


def test_people_double_booked_but_not_bus_companies(make_client):
    c, base, _ = agency(make_client)
    guide = mk(c, f"{base}/vendors", {"name": "Nino", "type": "guide"})
    coach = mk(c, f"{base}/vendors", {"name": "Coaches Ltd", "type": "transport"})
    a = mk(c, f"{base}/tours", {"code": "A", "start_date": d(10), "end_date": d(15)})
    b = mk(c, f"{base}/tours", {"code": "B", "start_date": d(14), "end_date": d(18)})
    for t in (a, b):
        mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": guide["id"], "role": "guide"})
        mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": coach["id"], "role": "transport"})
    rows = c.get(f"{base}/tours/{a['id']}/alerts").json()
    clash = [x for x in rows if x["code"] == "staff_double_booked"]
    assert len(clash) == 1 and clash[0]["severity"] == "error"
    assert clash[0]["params"] == {"vendor": "Nino", "other": "B", "from": d(14), "to": d(15)} and clash[0]["day"] == 5
    # Fix it: Nino stops on day 4 of tour A.
    staff = c.get(f"{base}/tours/{a['id']}").json()["staff"]
    nino = next(s for s in staff if s["vendor"]["id"] == guide["id"])
    c.patch(f"{base}/tours/{a['id']}/staff/{nino['id']}", json={"end_day": 4})
    assert "staff_double_booked" not in codes(c.get(f"{base}/tours/{a['id']}/alerts").json())


def test_itinerary_and_people_checks(make_client):
    c, base, _ = agency(make_client)
    hotel = mk(c, f"{base}/vendors", {"name": "Gudauri Inn", "type": "hotel", "city": "Gudauri"})
    route = mk(c, f"{base}/series", {"code": "R", "days": [
        {"city": "Kazbegi", "hotel_id": hotel["id"]}, {"city": "Tbilisi"}, {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": d(5), "pax": 3})
    rows = c.get(f"{base}/tours/{t['id']}/alerts").json()
    by = {a["code"]: a for a in rows}
    assert by["no_hotel"]["params"] == {"days": "2", "n": 1} and by["no_hotel"]["day"] == 2
    assert by["hotel_city"]["day"] == 1 and by["hotel_city"]["params"]["hotel_city"] == "Gudauri"
    assert by["no_guide"]["params"]["days"] == 5 and by["no_participants"]["link"] == "participants"
    assert by["no_client"]["severity"] == "warning"
    mk(c, f"{base}/tours/{t['id']}/participants", {"full_name": "A", "passport_expiry": d(30)})
    rows = c.get(f"{base}/tours/{t['id']}/alerts").json()
    assert {"passports", "pax_mismatch", "rooms_unassigned"} <= codes(rows) and "no_participants" not in codes(rows)


def test_money_alerts_only_for_managers_and_closed_tours_are_quiet(make_client):
    owner, base, ws = agency(make_client)
    cl = mk(owner, f"{base}/clients", {"name": "Orient"})
    t = mk(owner, f"{base}/tours", {"code": "M", "start_date": d(-20), "end_date": d(-18), "client_id": cl["id"]})
    inv = mk(owner, f"{base}/invoices", {"client_id": cl["id"], "tour_id": t["id"], "issue_date": d(-30), "due_date": d(-25),
                                         "currency": "USD", "lines": [{"description": "Tour", "unit_price": "100"}]})
    owner.post(f"{base}/invoices/{inv['id']}/issue")
    rows = owner.get(f"{base}/alerts").json()
    assert {"client_overdue", "not_closed"} <= codes(rows, t["id"])
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    assert "client_overdue" not in codes(staff.get(f"{base}/alerts").json(), t["id"])
    mk(owner, f"{base}/invoices/{inv['id']}/payments", {"amount": "100", "received_on": d(-1)})
    owner.post(f"{base}/tours/{t['id']}/close", json={})
    assert owner.get(f"{base}/tours/{t['id']}/alerts").json() == []
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    assert b.get(f"{base_b}/tours/{t['id']}/alerts").status_code == 404


def test_setup_progress_counts_what_a_new_agency_has(make_client):
    c, base, ws = agency(make_client)
    s = c.get(f"{base}/setup").json()
    assert s == {"vendors": 0, "priced_services": 0, "routes": 0, "clients": 0, "tours": 0, "members": 1}
    v = c.post(f"{base}/vendors", json={"name": "Inn", "type": "hotel"}).json()
    c.put(f"{base}/vendors/{v['id']}/services", json=[
        {"name": "Room", "category": "hotel", "rates": [{"price": "80", "currency": "GEL"}]},
        {"name": "Extra bed", "category": "hotel", "rates": []}])
    c.post(f"{base}/clients", json={"name": "Partner"})
    s = c.get(f"{base}/setup").json()
    assert (s["vendors"], s["priced_services"], s["clients"]) == (1, 1, 1)


def test_missing_rate_and_unknown_rooms_are_alerts_and_rates_fix_them(make_client):
    from .test_finance import setup_tour
    c, base, ws = agency(make_client)
    t, *_ = setup_tour(c, base, start=d(10), rooms="")
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    rows = c.get(f"{base}/tours/{t['id']}/alerts").json()
    assert "rooms_unknown" in codes(rows)
    miss = next(a for a in rows if a["code"] == "rate_missing")
    assert miss["severity"] == "error" and miss["params"]["currencies"] == "GEL"
    p = c.get(f"{base}/tours/{t['id']}/profit").json()
    assert p["missing_rates"] is True and p["missing_currencies"] == ["GEL"]
    # Plain words count as rooms; setting the rate values the lines already made.
    c.patch(f"{base}/tours/{t['id']}", json={"rooms": "2 double + 1 single"})
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    rows = c.get(f"{base}/tours/{t['id']}/alerts").json()
    assert "rooms_unknown" not in codes(rows) and "rate_missing" not in codes(rows)
    assert c.get(f"{base}/tours/{t['id']}/profit").json()["missing_currencies"] == []


def test_same_supplier_on_staff_and_as_day_service_is_counted_twice(make_client):
    c, base, ws = agency(make_client)
    bus = mk(c, f"{base}/vendors", {"name": "Coach Co", "type": "transport"})
    svc = c.put(f"{base}/vendors/{bus['id']}/services", json=[
        {"code": "day", "name": "Coach day", "category": "transport", "unit": "vehicle_day", "rates": [{"price": "300", "currency": "USD"}]}]).json()[0]
    t = mk(c, f"{base}/tours", {"start_date": d(5), "end_date": d(7), "pax": 10})
    day1 = c.get(f"{base}/tours/{t['id']}").json()["days"][0]
    c.patch(f"{base}/tours/{t['id']}/days/{day1['id']}", json={"extras": [{"service_id": svc["id"], "quantity": None, "notes": ""}]})
    assert "counted_twice" not in codes(c.get(f"{base}/tours/{t['id']}/alerts").json())
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": bus["id"], "role": "transport"})
    a = next(x for x in c.get(f"{base}/tours/{t['id']}/alerts").json() if x["code"] == "counted_twice")
    assert a["params"] == {"name": "Coach Co", "days": "1"} and a["link"] == "staff"


def test_guide_away_on_tour_days(make_client):
    from datetime import date, timedelta
    c, base, _ = agency(make_client)
    start = date.today() + timedelta(days=20)
    nino = mk(c, f"{base}/vendors", {"name": "Nino", "type": "guide", "languages": ["English", " german ", "english"],
                                     "unavailable": [{"start": (start + timedelta(days=1)).isoformat(),
                                                      "end": (start + timedelta(days=9)).isoformat(), "note": "Vacation"}]})
    assert nino["languages"] == ["English", "german"]
    assert c.patch(f"{base}/vendors/{nino['id']}", json={"unavailable": [{"start": "2026-12-05", "end": "2026-12-01"}]}).status_code == 422
    t = mk(c, f"{base}/tours", {"start_date": start.isoformat(), "end_date": (start + timedelta(days=3)).isoformat(), "pax": 10})
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": nino["id"], "role": "guide"})
    away = [a for a in c.get(f"{base}/tours/{t['id']}/alerts").json() if a["code"] == "staff_unavailable"]
    assert len(away) == 1 and away[0]["day"] == 2 and away[0]["severity"] == "error"
    assert away[0]["params"]["note"] == "Vacation" and away[0]["params"]["to"] == (start + timedelta(days=3)).isoformat()
    # Back from vacation earlier: the alert goes.
    c.patch(f"{base}/vendors/{nino['id']}", json={"unavailable": []})
    assert not [a for a in c.get(f"{base}/tours/{t['id']}/alerts").json() if a["code"] == "staff_unavailable"]


def test_a_tour_with_only_hotels_says_what_is_not_planned(make_client):
    """A route made from the partner's list of hotels: in six weeks, no meals, no transport, no guide."""
    c, base, _ = agency(make_client)
    hotel = mk(c, f"{base}/vendors", {"name": "Hualing", "type": "hotel", "city": "Tbilisi"})
    route = mk(c, f"{base}/series", {"code": "ZV", "days": [{"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi"}]})
    start = (date.today() + timedelta(days=20)).isoformat()
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": start, "pax": 20, "rooms": "10 TWN"})
    gap = [a for a in c.get(f"{base}/tours/{t['id']}/alerts").json() if a["code"] == "plan_incomplete"]
    assert gap and gap[0]["params"]["what"] == "meals,transport,guide"
    # Far away: not yet.
    later = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": (date.today() + timedelta(days=90)).isoformat(), "pax": 20})
    assert not [a for a in c.get(f"{base}/tours/{later['id']}/alerts").json() if a["code"] == "plan_incomplete"]


def test_a_flight_just_after_midnight_needs_a_late_check_out_too(make_client):
    c, base, _ = agency(make_client)
    bus = mk(c, f"{base}/vendors", {"name": "Coach", "type": "transport"})
    svc = c.put(f"{base}/vendors/{bus['id']}/services", json=[{"name": "Coach", "category": "transport", "unit": "vehicle_day",
                                                               "rates": [{"price": "500", "currency": "GEL"}]}]).json()
    route = mk(c, f"{base}/series", {"code": "ZV", "days": [{"city": "Yerevan"}, {"city": "Yerevan", "extras": [{"service_id": svc[0]["id"]}],
                                                            "flights": [{"direction": "departure", "number": "CZ8164", "time": "00:45", "airport": "EVN"}]}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": d(30), "pax": 20})
    assert "flight_late_checkout" in codes(c.get(f"{base}/tours/{t['id']}/alerts").json())



def test_a_long_day_on_the_road(make_client):
    c, base, _ = agency(make_client)
    route = mk(c, f"{base}/series", {"code": "LD", "days": [{"city": "Batumi"}, {"city": "Yerevan", "stops": ["Vardzia"], "drive_minutes": [240, 260]}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": d(30), "pax": 20})
    long = [a for a in c.get(f"{base}/tours/{t['id']}/alerts").json() if a["code"] == "long_drive"]
    assert long and long[0]["day"] == 2 and long[0]["params"]["hours"] == "10:25"      # 500 min × 1.25
    # A day room at the hotel that day answers it.
    hotel = mk(c, f"{base}/vendors", {"name": "Radisson", "type": "hotel"})
    room = c.put(f"{base}/vendors/{hotel['id']}/services", json=[{"name": "Day room", "category": "hotel", "unit": "item",
                                                                  "rates": [{"price": "120", "currency": "USD"}]}]).json()
    last = c.get(f"{base}/tours/{t['id']}").json()["days"][-1]
    c.patch(f"{base}/tours/{t['id']}/days/{last['id']}", json={"extras": [*last["extras"], {"service_id": room[0]["id"], "quantity": 2}]})
    assert "flight_late_checkout" not in codes(c.get(f"{base}/tours/{t['id']}/alerts").json())
