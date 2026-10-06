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
