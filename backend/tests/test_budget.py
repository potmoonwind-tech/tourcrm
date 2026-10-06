"""A tour's budget (its calculation at the sold size) and costs measured against it."""
from .conftest import invite_and_join, signup
from .test_route_build import catalog_route
from .test_tours import agency, mk


def sold_tour(c, base, tourists=12):
    route, sid = catalog_route(c, base)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-09-30"}).json()
    doc = {k: v for k, v in q.items() if k not in ("id", "updated_at", "version", "result", "notices")}
    for item in doc["items"]:
        if item["name"] == "Guide":
            item["unit_price"] = "100"   # 100 USD × 3 days
    assert c.put(f"{base}/quotes/{q['id']}", json=doc).status_code == 200
    r = mk(c, f"{base}/quotes/{q['id']}/create-tour", {"tourists": tourists, "start_date": "2026-09-30", "with_invoice": False})
    return r["tour_id"], q, sid


def test_budget_is_the_calculation_at_the_sold_size(make_client):
    c, base, _ = agency(make_client)
    tid, q, _ = sold_tour(c, base)
    tier = next(t for t in c.get(f"{base}/quotes/{q['id']}").json()["result"]["tiers"] if t["tourists"] == 12)
    b = c.get(f"{base}/tours/{tid}/budget").json()
    assert b["source"].endswith("· 12+1") and b["quote_range"] == [10, 25]
    assert abs(b["totals"]["planned"] - tier["group_cost"]) < 0.5
    lines = {x["name"]: x for x in b["lines"]}
    night1 = lines["Rioni Hotel · night 1"]
    assert night1["kind"] == "hotel" and night1["amount"] == 100 / 2 * 12 + 70 and night1["day"] == 1
    assert lines["Guide"]["amount"] == 300 and lines["Martvili: Jeep"]["quantity"] == 3
    assert all(x["status"] == "no_cost" for x in b["lines"]) and b["totals"]["not_costed"] == b["totals"]["planned"]


def test_generated_costs_are_linked_and_compared(make_client):
    c, base, _ = agency(make_client)
    tid, _, _ = sold_tour(c, base)
    g = c.post(f"{base}/tours/{tid}/costs/generate").json()
    assert g["linked"] == g["created"] and g["created"] > 0
    b = c.get(f"{base}/tours/{tid}/budget").json()
    lines = {x["name"]: x for x in b["lines"]}
    # Hotel: 6 DBL + 1 SGL for 12+1, as planned → on budget.
    assert lines["Rioni Hotel · night 1"]["status"] == "on_budget" and lines["Rioni Hotel · night 1"]["costs"] == 2  # DBL + SGL
    assert lines["Dinner: Supra"]["costs"] == 2                      # two dinners, one planned line
    assert lines["Martvili: Canyon + boat"]["costs"] == 1 and lines["Martvili: Jeep"]["status"] == "on_budget"
    assert lines["Guide"]["status"] == "no_cost"                     # no guide assigned on the tour yet
    assert b["unbudgeted"] == []

    # Lines nothing on the itinerary covers get costs with the planned values.
    b = c.post(f"{base}/tours/{tid}/budget/costs", json={}).json()
    assert {x["name"]: x["status"] for x in b["lines"]}["Guide"] == "on_budget"
    assert all(x["status"] != "no_cost" for x in b["lines"])
    # The calculation feeds 2 staff at every dinner; no guide or driver is assigned yet,
    # so the dinners are exactly 2 people × 2 dinners × 40 GEL under budget.
    dinner = next(x for x in b["lines"] if x["name"] == "Dinner: Supra")
    assert dinner["status"] == "under" and dinner["variance_base"] == round(-2 * 2 * 40 * 0.37, 2)
    assert abs(b["totals"]["variance"] - dinner["variance_base"]) < 1

    # A real invoice comes in higher: the line shows over budget.
    costs = c.get(f"{base}/tours/{tid}/costs").json()["lines"]
    guide = next(x for x in costs if x["description"] == "Guide")
    c.patch(f"{base}/tours/{tid}/costs/{guide['id']}", json={"unit_price": "130"})
    b = c.get(f"{base}/tours/{tid}/budget").json()
    g_line = next(x for x in b["lines"] if x["name"] == "Guide")
    assert g_line["status"] == "over" and g_line["variance_base"] == 90

    # Unlinking moves a cost to "not in the budget"; it isn't locked by that.
    jeep = next(x for x in costs if x["description"].startswith("Jeep"))
    r = c.patch(f"{base}/tours/{tid}/costs/{jeep['id']}", json={"budget_line_id": None})
    assert r.status_code == 200 and r.json()["locked"] is False
    b = c.get(f"{base}/tours/{tid}/budget").json()
    assert [x["description"] for x in b["unbudgeted"]] == [jeep["description"]]
    assert b["totals"]["unbudgeted"] == round(3 * 150 * 0.37, 2)
    c.post(f"{base}/tours/{tid}/costs/generate")                       # regenerating doesn't re-link it
    assert len(c.get(f"{base}/tours/{tid}/budget").json()["unbudgeted"]) == 1


def test_retake_budget_keeps_links(make_client):
    c, base, _ = agency(make_client)
    tid, _, _ = sold_tour(c, base)
    c.post(f"{base}/tours/{tid}/costs/generate")
    before = c.get(f"{base}/tours/{tid}/budget").json()
    after = c.post(f"{base}/tours/{tid}/budget", json={"tourists": 15}).json()
    assert after["tourists"] == 15 and [x["id"] for x in after["lines"]] == [x["id"] for x in before["lines"]]
    assert {x["name"]: x["costs"] for x in after["lines"]} == {x["name"]: x["costs"] for x in before["lines"]}
    assert after["totals"]["planned"] > before["totals"]["planned"]
    assert c.post(f"{base}/tours/{tid}/budget", json={"tourists": 40}).status_code == 422


def test_budget_links_are_checked_and_manager_only(make_client):
    owner, base, ws = agency(make_client)
    tid, _, _ = sold_tour(owner, base)
    other = mk(owner, f"{base}/tours", {"code": "O", "start_date": "2026-09-30", "end_date": "2026-09-30"})
    line_id = owner.get(f"{base}/tours/{tid}/budget").json()["lines"][0]["id"]
    r = owner.post(f"{base}/tours/{other['id']}/costs", json={"service_date": "2026-09-30", "unit_price": "1",
                                                              "currency": "USD", "budget_line_id": line_id})
    assert r.status_code == 422                                        # another tour's budget line
    assert owner.post(f"{base}/tours/{tid}/budget/costs", json={"line_ids": ["nope"]}).status_code == 422
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    assert staff.get(f"{base}/tours/{tid}/budget").status_code == 403
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    assert b.get(f"{base_b}/tours/{tid}/budget").status_code == 404


def test_staff_on_the_tour_eat_with_the_group(make_client):
    c, base, _ = agency(make_client)
    tid, _, _ = sold_tour(c, base)
    for name, role in (("Nino", "guide"), ("Gia", "driver")):
        v = mk(c, f"{base}/vendors", {"name": name, "type": "guide" if role == "guide" else "driver"})
        mk(c, f"{base}/tours/{tid}/staff", {"vendor_id": v["id"], "role": role})
    c.post(f"{base}/tours/{tid}/costs/generate")
    lines = c.get(f"{base}/tours/{tid}/costs").json()["lines"]
    assert any(x["description"] == "dinner × 15 (13 + 2 staff)" for x in lines)
    dinner = next(x for x in c.get(f"{base}/tours/{tid}/budget").json()["lines"] if x["name"] == "Dinner: Supra")
    assert dinner["status"] == "on_budget"


def test_link_several_costs_at_once(make_client):
    c, base, _ = agency(make_client)
    tid, _, _ = sold_tour(c, base)
    a = mk(c, f"{base}/tours/{tid}/costs", {"description": "Lunch market", "category": "meal", "service_date": "2026-09-30",
                                             "unit_price": "10", "currency": "USD"})
    b = mk(c, f"{base}/tours/{tid}/costs", {"description": "Lunch market", "category": "meal", "service_date": "2026-10-01",
                                             "unit_price": "10", "currency": "USD"})
    budget = c.get(f"{base}/tours/{tid}/budget").json()
    assert len(budget["unbudgeted"]) == 2
    dinner = next(x for x in budget["lines"] if x["name"] == "Dinner: Supra")
    out = c.post(f"{base}/tours/{tid}/budget/link", json={"cost_ids": [a["id"], b["id"]], "budget_line_id": dinner["id"]}).json()
    assert out["unbudgeted"] == [] and next(x for x in out["lines"] if x["id"] == dinner["id"])["costs"] == 2
    assert c.post(f"{base}/tours/{tid}/budget/link", json={"cost_ids": ["x"], "budget_line_id": None}).status_code == 422


def test_lunch_and_dinner_at_one_restaurant_both_link(make_client):
    """Borjomi: the same restaurant for lunch and dinner on one day — two budget lines, two costs."""
    c, base, _ = agency(make_client)
    route, sid = catalog_route(c, base)
    resto = next(v for v in c.get(f"{base}/vendors").json() if v["name"] == "Supra")
    c.put(f"{base}/vendors/{resto['id']}/services", json=[
        {"code": "dinner", "name": "Dinner", "rates": [{"price": "40", "currency": "GEL"}]},
        {"code": "lunch", "name": "Lunch", "rates": [{"price": "30", "currency": "GEL"}]}])
    s = c.get(f"{base}/series/{route['id']}").json()
    days = [{k: v for k, v in d.items() if k != "day_number"} for d in s["days"]]
    days[0]["lunch_id"] = resto["id"]                    # day 1: lunch and dinner at Supra
    c.put(f"{base}/series/{route['id']}", json={**s, "days": days})
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-09-30"}).json()
    tid = mk(c, f"{base}/quotes/{q['id']}/create-tour", {"tourists": 12, "start_date": "2026-09-30", "with_invoice": False})["tour_id"]
    c.post(f"{base}/tours/{tid}/costs/generate")
    b = c.get(f"{base}/tours/{tid}/budget").json()
    supra = [x for x in b["lines"] if x["name"].startswith(("Lunch: Supra", "Dinner: Supra"))]
    assert {x["name"].split(":")[0] for x in supra} == {"Lunch", "Dinner"}
    assert all(x["costs"] >= 1 for x in supra if x["day"] in (1, None))
    assert not [x for x in b["unbudgeted"] if x["vendor"]["name"] == "Supra" and x["service_date"] == "2026-09-30"]

