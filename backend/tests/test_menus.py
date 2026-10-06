"""Set menus: a restaurant's meal services chosen per lunch/dinner, priced into costs and calculations."""
from .test_tours import agency, mk


def setup(c, base):
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    resto = mk(c, f"{base}/vendors", {"name": "Supra House", "type": "restaurant"})
    services = c.put(f"{base}/vendors/{resto['id']}/services", json=[
        {"code": "dinner", "name": "Dinner", "category": "meal", "unit": "person", "rates": [{"price": "40", "currency": "GEL"}]},
        {"name": "Georgian supra menu", "category": "meal", "unit": "person",
         "notes": "Khinkali, khachapuri, mtsvadi, salads, wine", "rates": [{"price": "60", "currency": "GEL"}]},
    ]).json()
    menu = next(s for s in services if s["name"] == "Georgian supra menu")
    other = mk(c, f"{base}/vendors", {"name": "Other Resto", "type": "restaurant"})
    return resto, menu, other


def test_menu_on_route_flows_to_tour_costs(make_client):
    c, base, _ = agency(make_client)
    resto, menu, other = setup(c, base)
    route = mk(c, f"{base}/series", {"code": "M", "days": [
        {"city": "Tbilisi", "dinner_id": resto["id"], "dinner_menu_id": menu["id"]}, {"city": "Tbilisi", "dinner_id": resto["id"]}]})
    assert route["days"][0]["dinner_menu_id"] == menu["id"]
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-11-01", "pax": 10})
    day1 = c.get(f"{base}/tours/{t['id']}").json()["days"][0]
    assert day1["dinner_menu_id"] == menu["id"]
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    lines = {x["description"]: x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]}
    assert lines["dinner × 10 · Georgian supra menu"]["unit_price"] == 60
    assert lines["dinner × 10"]["unit_price"] == 40            # day 2: the usual dinner price
    # Changing the restaurant drops a menu that isn't theirs.
    r = c.patch(f"{base}/tours/{t['id']}/days/{day1['id']}", json={"dinner_id": other["id"]})
    assert r.json()["dinner_menu_id"] is None
    # A menu must belong to the chosen restaurant.
    bad = c.patch(f"{base}/tours/{t['id']}/days/{day1['id']}", json={"dinner_id": other["id"], "dinner_menu_id": menu["id"]})
    assert bad.status_code == 422 and "another restaurant" in bad.json()["detail"]


def test_menu_priced_in_calculation_and_visible_to_staff(make_client):
    c, base, _ = agency(make_client)
    resto, menu, _ = setup(c, base)
    route = mk(c, f"{base}/series", {"code": "M", "days": [
        {"city": "Tbilisi", "dinner_id": resto["id"], "dinner_menu_id": menu["id"]}, {"city": "Tbilisi"}]})
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-11-01"}).json()
    item = next(i for i in q["items"] if i["category"] == "meal")
    assert item["name"] == "Dinner: Supra House · Georgian supra menu" and float(item["unit_price"]) == 60
    assert item["service_id"] == menu["id"]
    brief = next(s for s in c.get(f"{base}/services").json() if s["id"] == menu["id"])
    assert brief["notes"].startswith("Khinkali") and "rates" not in brief


def test_repeated_food_is_flagged(make_client):
    c, base, _ = agency(make_client)
    resto = mk(c, f"{base}/vendors", {"name": "Supra House", "type": "restaurant"})
    menus = c.put(f"{base}/vendors/{resto['id']}/services", json=[
        {"name": "Lunch A", "category": "meal", "dishes": ["Khinkali", "Salad", " salad "], "rates": [{"price": "30", "currency": "GEL"}]},
        {"name": "Dinner B", "category": "meal", "dishes": ["khinkali", "Mtsvadi"], "rates": [{"price": "50", "currency": "GEL"}]},
        {"name": "Dinner C", "category": "meal", "dishes": ["Badrijani", "Mtsvadi"], "rates": [{"price": "50", "currency": "GEL"}]},
    ]).json()
    m = {s["name"]: s for s in menus}
    assert [d["name"] for d in m["Lunch A"]["dishes"]] == ["Khinkali", "Salad"]   # tidied, duplicates dropped
    meal = lambda lunch, dinner: {"city": "Tbilisi", "lunch_id": resto["id"], "dinner_id": resto["id"],  # noqa: E731
                                  "lunch_menu_id": m[lunch]["id"], "dinner_menu_id": m[dinner]["id"]}
    from datetime import date, timedelta
    start = (date.today() + timedelta(days=30)).isoformat()
    route = mk(c, f"{base}/series", {"code": "F", "days": [meal("Lunch A", "Dinner B"), meal("Lunch A", "Dinner C"),
                                                          meal("Lunch A", "Dinner C"), {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": start, "pax": 10})
    alerts = c.get(f"{base}/tours/{t['id']}/alerts").json()
    same = [(a["day"], a["params"]["dishes"]) for a in alerts if a["code"] == "dish_same_day"]
    assert same == [(1, "Khinkali")]                                       # lunch and dinner on day 1
    nxt = {a["day"]: a["params"]["dishes"] for a in alerts if a["code"] == "dish_next_day"}
    assert "Mtsvadi" in nxt[2] and "Khinkali" in nxt[2] and "Badrijani" in nxt[3]
    often = [a["params"] for a in alerts if a["code"] == "dish_often"]
    assert often == [{"dishes": "Khinkali (3), Mtsvadi (3), Salad (3)", "n": 3}]   # one line, most repeated first


def test_meals_view_dish_by_dish(make_client):
    from datetime import date, timedelta
    from .conftest import invite_and_join, signup
    c, base, ws = agency(make_client)
    supra = mk(c, f"{base}/vendors", {"name": "Supra House", "type": "restaurant"})
    other = mk(c, f"{base}/vendors", {"name": "Old Cellar", "type": "restaurant"})
    sm = {s["name"]: s for s in c.put(f"{base}/vendors/{supra['id']}/services", json=[
        {"name": "Supra", "category": "meal", "rates": [{"price": "60", "currency": "GEL"}],
         "dishes": [{"name": "Khinkali", "price": 2.5}, {"name": "Mtsvadi", "price": 18}]}]).json()}
    om = {s["name"]: s for s in c.put(f"{base}/vendors/{other['id']}/services", json=[
        {"name": "Cellar", "category": "meal", "rates": [{"price": "45", "currency": "GEL"}],
         "dishes": [{"name": "khinkali", "price": 3}, {"name": "Lobio", "price": 8}]}]).json()}
    start = (date.today() + timedelta(days=20)).isoformat()
    route = mk(c, f"{base}/series", {"code": "MV", "days": [
        {"lunch_id": supra["id"], "lunch_menu_id": sm["Supra"]["id"], "dinner_id": other["id"], "dinner_menu_id": om["Cellar"]["id"]},
        {"dinner_id": other["id"], "dinner_menu_id": om["Cellar"]["id"]}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": start, "pax": 10})
    v = c.get(f"{base}/tours/{t['id']}/meals").json()
    assert [(r["day"], r["meal"], r["menu_name"], r["price_pp"], r["people"], r["total"]) for r in v["rows"]] == [
        (1, "lunch", "Supra", 60, 10, 600), (1, "dinner", "Cellar", 45, 10, 450), (2, "dinner", "Cellar", 45, 10, 450)]
    lunch = v["rows"][0]
    assert lunch["dish_sum"] == 20.5 and {k: lunch["dishes"][0][k] for k in ("name", "price", "same_day", "prev_day")} == {"name": "Khinkali", "price": 2.5, "same_day": True, "prev_day": False}
    assert v["rows"][2]["dishes"][1]["prev_day"] is True               # Lobio again on day 2
    assert v["totals"] == {"GEL": 1500}
    k = next(d for d in v["dishes"] if d["name"] == "Khinkali")
    assert (k["days"], k["servings"], k["min_price"], k["max_price"]) == ([1, 2], 3, 2.5, 3)
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    sv = staff.get(f"{base}/tours/{t['id']}/meals").json()
    assert sv["sees_prices"] is False and sv["rows"][0]["price_pp"] is None and sv["rows"][0]["dishes"][0]["price"] is None
    assert all(d["price"] is None for s in staff.get(f"{base}/services").json() for d in s["dishes"])
