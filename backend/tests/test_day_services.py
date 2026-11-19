"""Any catalog service on any day of a route or tour, priced into tour costs."""
from .conftest import invite_and_join, signup
from .test_tours import agency, mk


def setup(c, base):
    boat = mk(c, f"{base}/vendors", {"name": "Rioni Boats", "type": "activity"})
    services = c.put(f"{base}/vendors/{boat['id']}/services", json=[
        {"name": "Boat trip", "category": "activity", "unit": "person", "rates": [
            {"price": "10", "currency": "GEL"},
            {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "15", "currency": "GEL"}]},
        {"name": "Fuel", "category": "transport", "unit": "litre", "rates": [{"price": "3", "currency": "GEL"}]},
        {"name": "Boat hire", "category": "activity", "unit": "group", "rates": [{"price": "200", "currency": "GEL"}]},
    ]).json()
    return boat, {s["name"]: s["id"] for s in services}


def test_route_services_flow_into_tour_costs(make_client):
    c, base, _ = agency(make_client)
    boat, svc = setup(c, base)
    route = mk(c, f"{base}/series", {"code": "W", "days": [
        {"city": "Kutaisi", "extras": [{"service_id": svc["Boat trip"]}, {"service_id": svc["Fuel"], "quantity": "40"}]},
        {"city": "Kutaisi", "extras": [{"service_id": svc["Boat hire"], "notes": "private"}, {"service_id": svc["Fuel"]}]},
    ]})
    assert float(route["days"][0]["extras"][1]["quantity"]) == 40
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-05-31", "pax": 12})
    tour = c.get(f"{base}/tours/{t['id']}").json()
    assert [x["service_id"] for x in tour["days"][1]["extras"]] == [svc["Boat hire"], svc["Fuel"]]
    assert tour["days"][1]["extras"][0]["notes"] == "private"

    r = c.post(f"{base}/tours/{t['id']}/costs/generate").json()
    assert any("set how many 'Fuel'" in w for w in r["warnings"])
    lines = {(x["service_date"], x["description"]): x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]}
    assert lines[("2026-05-31", "Boat trip × 12")]["unit_price"] == 10          # low season, per person
    assert lines[("2026-05-31", "Fuel × 40")]["amount"] == 120                  # fixed quantity
    assert lines[("2026-06-01", "Boat hire × 1")]["amount"] == 200              # per group
    assert lines[("2026-06-01", "Fuel × 1")]["category"] == "transport"         # unknown quantity → 1, warned
    assert lines[("2026-05-31", "Boat trip × 12")]["category"] == "ticket"
    assert lines[("2026-05-31", "Boat trip × 12")]["vendor"]["id"] == boat["id"]

    # Editing a tour day's services refreshes its cost lines on the next generate.
    day2 = tour["days"][1]
    ok = c.patch(f"{base}/tours/{t['id']}/days/{day2['id']}", json={"extras": [{"service_id": svc["Boat trip"], "quantity": "5"}]})
    assert ok.status_code == 200 and len(ok.json()["extras"]) == 1
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    descs = {(x["service_date"], x["description"], x["unit_price"]) for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]}
    assert ("2026-06-01", "Boat trip × 5", 15) in descs                         # high season on 1 June
    assert not any(d[1].startswith(("Boat hire", "Fuel × 1")) for d in descs)


def test_removed_service_is_reported(make_client):
    c, base, _ = agency(make_client)
    boat, svc = setup(c, base)
    route = mk(c, f"{base}/series", {"code": "W", "days": [{"extras": [{"service_id": svc["Boat hire"]}]}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-03-01", "pax": 4})
    c.put(f"{base}/vendors/{boat['id']}/services", json=[])
    r = c.post(f"{base}/tours/{t['id']}/costs/generate").json()
    assert any("removed from the price catalog" in w for w in r["warnings"])


def test_services_from_other_workspaces_are_rejected(make_client):
    a, base_a, _ = agency(make_client)
    _, svc = setup(a, base_a)
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    r = b.post(f"{base_b}/series", json={"code": "X", "days": [{"extras": [{"service_id": svc["Boat trip"]}]}]})
    assert r.status_code == 422
    t = mk(b, f"{base_b}/tours", {"code": "B1", "start_date": "2026-09-01", "end_date": "2026-09-01"})
    day = b.get(f"{base_b}/tours/{t['id']}").json()["days"][0]
    r = b.patch(f"{base_b}/tours/{t['id']}/days/{day['id']}", json={"extras": [{"service_id": svc["Boat trip"]}]})
    assert r.status_code == 422
    assert b.post(f"{base_b}/series", json={"code": "Y", "days": [{"extras": [{"service_id": "x", "quantity": "-1"}]}]}).status_code == 422


def test_staff_see_services_without_prices(make_client):
    owner, base, ws = agency(make_client)
    setup(owner, base)
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    rows = staff.get(f"{base}/services").json()
    assert {r["name"] for r in rows} == {"Boat trip", "Fuel", "Boat hire"}
    assert all("rates" not in r and "price" not in r for r in rows)
    assert staff.get(f"{base}/catalog").status_code == 403
    guide = make_client()
    signup(guide, "g@a.com")
    invite_and_join(owner, ws, guide, "g@a.com", "guide")
    assert guide.get(f"{base}/services").status_code == 403


def test_save_whole_itinerary_reorders_content_not_dates(make_client):
    c, base, _ = agency(make_client)
    boat, svc = setup(c, base)
    t = mk(c, f"{base}/tours", {"code": "IT", "start_date": "2026-05-01", "end_date": "2026-05-03"})
    days = [{"city": "Tbilisi"}, {"city": "Kutaisi", "extras": [{"service_id": svc["Boat trip"]}]}, {"city": "Batumi"}]
    r = c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": days})
    assert r.status_code == 200 and [d["city"] for d in r.json()["days"]] == ["Tbilisi", "Kutaisi", "Batumi"]
    moved = c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": [days[1], days[0], days[2]]}).json()["days"]
    assert [(d["date"], d["city"]) for d in moved] == [("2026-05-01", "Kutaisi"), ("2026-05-02", "Tbilisi"), ("2026-05-03", "Batumi")]
    assert moved[0]["extras"][0]["service_id"] == svc["Boat trip"]
    assert c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": days[:2]}).status_code == 422
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    assert b.put(f"{base_b}/tours/{t['id']}/itinerary", json={"days": days}).status_code == 404


def test_a_place_with_activities_some_optional(make_client):
    """KTW Patardzeuli: wine tasting and bread baking booked, a churchkhela class only offered."""
    c, base, _ = agency(make_client)
    ktw = mk(c, f"{base}/vendors", {"name": "KTW Patardzeuli", "type": "activity"})
    sid = {s["name"]: s["id"] for s in c.put(f"{base}/vendors/{ktw['id']}/services", json=[
        {"name": n, "category": "activity", "unit": "person", "rates": [{"price": p, "currency": "GEL"}]}
        for n, p in (("Wine tasting", "25"), ("Bread baking", "15"), ("Churchkhela class", "20"))]).json()}
    day = [{"service_id": sid["Wine tasting"]}, {"service_id": sid["Bread baking"]},
           {"service_id": sid["Churchkhela class"], "optional": True}]
    route = mk(c, f"{base}/series", {"code": "K", "days": [{"city": "Sighnaghi", "extras": day}, {"city": "Tbilisi"}]})
    assert [x["optional"] for x in route["days"][0]["extras"]] == [False, False, True]

    # Calculation: the class is an optional extra, not in the price.
    q = c.post(f"{base}/quotes", json={"series_id": route["id"], "on_date": "2026-05-01"}).json()
    lines = {i["name"]: i for i in q["items"] if i["service_id"]}
    assert lines["KTW Patardzeuli: Churchkhela class"]["optional"] and not lines["KTW Patardzeuli: Wine tasting"]["optional"]

    # Tour costs: only what's booked; taking the class (unticking "optional") adds it.
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-05-01", "pax": 10})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    descs = {x["description"] for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]}
    assert {"Wine tasting × 10", "Bread baking × 10"} <= descs and not any(d.startswith("Churchkhela") for d in descs)
    d1 = c.get(f"{base}/tours/{t['id']}").json()["days"][0]
    c.patch(f"{base}/tours/{t['id']}/days/{d1['id']}", json={"extras": [{**x, "optional": False} for x in d1["extras"]]})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    assert "Churchkhela class × 10" in {x["description"] for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]}


def test_the_guide_sees_one_line_per_place():
    from types import SimpleNamespace as NS
    from app.routers.field import _extras
    ktw, garni = NS(name="KTW Patardzeuli"), NS(name="Garni Temple")
    services = {"a": NS(name="Wine tasting", vendor_id="k", vendor=ktw), "b": NS(name="Bread baking", vendor_id="k", vendor=ktw),
                "c": NS(name="Garni Temple entrance", vendor_id="g", vendor=garni)}
    slots = [{"service_id": "a"}, {"service_id": "c"}, {"service_id": "b", "optional": True}, {"service_id": "gone"}]
    assert _extras(slots, services) == ["KTW Patardzeuli · Wine tasting, Bread baking (optional)", "Garni Temple entrance"]


def test_the_bus_drives_back_to_its_garage(make_client):
    """The tour ends in Batumi; the bus goes back to Tbilisi the next day: one more bus day, and its km."""
    c, base, _ = agency(make_client)
    bus = mk(c, f"{base}/vendors", {"name": "Caucasus Coaches", "type": "transport"})
    route = mk(c, f"{base}/series", {"code": "BT", "days": [{"city": "Tbilisi"}, {"city": "Kutaisi", "km": 230}, {"city": "Batumi", "km": 150}],
                                     "bus_return": {"on": "next", "to": "Tbilisi", "km": 380}})
    assert route["bus_return"] == {"on": "next", "to": "Tbilisi", "km": 380}

    # A tour from the route keeps it; its bus is paid one more day.
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-05-01", "pax": 20})
    tour = c.get(f"{base}/tours/{t['id']}").json()
    assert tour["bus_return"]["on"] == "next"
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": bus["id"], "role": "transport"})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    line = next(x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["vendor"]["id"] == bus["id"])
    assert line["quantity"] == 4 and "drive back to Tbilisi" in line["description"]

    # Back the same day: the bus days stay; saving the itinerary without it clears it.
    days = [{k: v for k, v in d.items() if k not in ("id", "day_number", "date", "hotel", "lunch", "dinner", "breakfast")} for d in tour["days"]]
    for d in days:
        for slot in ("hotel", "lunch", "dinner", "breakfast", "staff_hotel"):
            d.pop(slot, None)
    r = c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": days, "bus_return": {"on": "last", "to": "Tbilisi", "km": 380}})
    assert r.status_code == 200, r.text
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    line = next(x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["vendor"]["id"] == bus["id"])
    assert line["quantity"] == 3

    # A calculation from the route: the agency's "empty bus days" input is the return day.
    q = c.post(f"{base}/quotes", json={"preset": "hm", "series_id": route["id"]}).json()
    assert float(q["variables"]["bus_extra_days"]) == 1


def test_the_bus_comes_to_the_border_where_the_tour_starts(make_client):
    """The group crosses from Azerbaijan at Lagodekhi; the bus comes from Tbilisi the day before:
    one more bus day, and its km on the first day and in the calculation."""
    c, base, _ = agency(make_client)
    _, svc = setup(c, base)
    bus = mk(c, f"{base}/vendors", {"name": "Caucasus Coaches", "type": "transport"})
    route = mk(c, f"{base}/series", {"code": "AZ", "days": [
        {"city": "Tbilisi", "stops": ["Lagodekhi", "Sighnaghi"], "km": 250, "extras": [{"service_id": svc["Fuel"]}]},
        {"city": "Kutaisi", "km": 230}],
        "bus_start": {"on": "before", "town": "Tbilisi", "km": 160},
        "bus_return": {"on": "last", "to": "Tbilisi", "km": 230}})
    assert route["bus_start"] == {"on": "before", "town": "Tbilisi", "km": 160}

    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-05-01", "pax": 20})
    tour = c.get(f"{base}/tours/{t['id']}").json()
    assert tour["bus_start"]["town"] == "Tbilisi"
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": bus["id"], "role": "transport"})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    lines = c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]
    line = next(x for x in lines if x["vendor"]["id"] == bus["id"])
    assert line["quantity"] == 3 and "drive to the start from Tbilisi" in line["description"]
    fuel = next(x for x in lines if "Fuel" in x["description"])
    assert float(fuel["quantity"]) == (250 + 160) * 30 / 100      # day 1: the road and the drive to the border

    # The ZK sheet's own inputs: km = the days' road + to the border + back; one empty bus day.
    q = c.post(f"{base}/quotes", json={"preset": "zk", "series_id": route["id"]}).json()
    assert float(q["variables"]["km_route"]) == 250 + 230 + 160 + 230
    assert float(q["variables"]["bus_extra_days"]) == 1

    # "Fill from route" in an open calculation says the same.
    r = c.post(f"{base}/quotes/route-fill", json={"series_id": route["id"]}).json()
    assert (r["km"], r["bus_extra_days"]) == (870, 1)

    # Saving the tour's itinerary without it: the bus starts where the group does.
    days = [{k: v for k, v in d.items() if k not in ("id", "day_number", "date", "hotel", "lunch", "dinner", "breakfast", "staff_hotel")}
            for d in tour["days"]]
    r = c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": days, "bus_return": tour["bus_return"]})
    assert r.status_code == 200, r.text
    assert r.json()["bus_start"] is None
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    line = next(x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["vendor"]["id"] == bus["id"])
    assert line["quantity"] == 2
