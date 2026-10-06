"""Calculations built from a route and the price catalog, and re-priced for another date."""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace as R

from app.quote_engine import tier_for
from app.quote_schemas import QuoteItemIn
from app.route_build import priced

from .test_tours import agency, mk


def rate(price, cur="GEL", frm=None, to=None, lo=None, hi=None):
    return R(price=Decimal(price), currency=cur, valid_from=date.fromisoformat(frm) if frm else None,
             valid_to=date.fromisoformat(to) if to else None, min_pax=lo, max_pax=hi)


def test_group_size_bands_become_tiers():
    p = priced([rate(50), rate(40, lo=20)], date(2026, 3, 1), 10, 25)
    assert p.unit_price == 50 and [(t.max_pax, t.unit_price) for t in p.tiers] == [(19, 50), (500, 40)]
    item = QuoteItemIn(name="x", currency="GEL", unit_price=p.unit_price, tiers=p.tiers)
    assert tier_for(item, 12).unit_price == 50 and tier_for(item, 25).unit_price == 40
    assert priced([rate(50)], date(2026, 3, 1), 10, 25).tiers == []            # one price → no tiers
    gap = priced([rate(30, hi=15)], date(2026, 3, 1), 10, 20)
    assert gap.missing == [16, 17, 18, 19, 20] and gap.tiers[-1].unit_price == 0
    assert priced([], date(2026, 3, 1), 10, 12).currency is None


def catalog_route(c, base):
    hotel = mk(c, f"{base}/vendors", {"name": "Rioni Hotel", "type": "hotel"})
    c.put(f"{base}/vendors/{hotel['id']}/services", json=[
        {"code": "room_DBL", "name": "DBL", "rates": [
            {"price": "80", "currency": "USD"}, {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "100", "currency": "USD"}]},
        {"code": "room_SGL", "name": "SGL", "rates": [{"price": "70", "currency": "USD"}]}])
    resto = mk(c, f"{base}/vendors", {"name": "Supra", "type": "restaurant"})
    c.put(f"{base}/vendors/{resto['id']}/services", json=[{"code": "dinner", "name": "Dinner", "rates": [
        {"price": "40", "currency": "GEL"}, {"min_pax": 20, "price": "35", "currency": "GEL"}]}])
    park = mk(c, f"{base}/vendors", {"name": "Martvili", "type": "activity"})
    svc = c.put(f"{base}/vendors/{park['id']}/services", json=[
        {"name": "Canyon + boat", "category": "ticket", "unit": "person", "rates": [
            {"price": "50", "currency": "GEL"}, {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "60", "currency": "GEL"}]},
        {"name": "Jeep", "category": "transport", "unit": "vehicle_day", "rates": [{"price": "150", "currency": "GEL"}]}]).json()
    sid = {s["name"]: s["id"] for s in svc}
    route = mk(c, f"{base}/series", {"code": "KU", "name": "Kutaisi", "days": [
        {"city": "Kutaisi", "hotel_id": hotel["id"], "dinner_id": resto["id"], "extras": [{"service_id": sid["Canyon + boat"]}]},
        {"city": "Kutaisi", "hotel_id": hotel["id"], "dinner_id": resto["id"], "extras": [{"service_id": sid["Jeep"], "quantity": "3"}]},
        {"city": "Kutaisi"}]})
    return route, sid


def test_new_calculation_from_route(make_client):
    c, base, _ = agency(make_client)
    route, sid = catalog_route(c, base)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])   # base USD: 1 GEL = 0.37 USD
    r = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-09-30"})
    assert r.status_code == 201, r.text
    q = r.json()
    assert q["name"] == "KU · Kutaisi" and q["days"] == 3 and q["valid_from"] == "2026-09-30" and q["series_id"] == route["id"]
    # Night 1 on 30 Sep (high season), night 2 on 1 Oct.
    assert [float(n["price_dbl"]) for n in q["nights"]] == [100, 80]
    items = {i["name"]: i for i in q["items"]}
    dinner = items["Dinner: Supra"]
    assert dinner["quantity"] == "2" and dinner["who"] == "everyone" and dinner["service_id"]
    assert [(t["max_pax"], float(t["unit_price"])) for t in dinner["tiers"]] == [(19, 40), (500, 35)]
    canyon = items["Martvili: Canyon + boat"]       # the supplier first: "Entrance" alone says nothing
    assert canyon["service_id"] == sid["Canyon + boat"] and canyon["day"] == 1 and float(canyon["unit_price"]) == 60
    assert canyon["basis"] == "per_person" and canyon["who"] == "persons"
    jeep = items["Martvili: Jeep"]
    assert jeep["basis"] == "group" and jeep["quantity"] == "3" and jeep["day"] == 2
    assert "Guide" in items and "Meals" not in items          # preset guide/bus kept, placeholder meals dropped
    assert items["Guide"]["currency"] == "USD"                # the agency's currency: an empty line needs no rate
    # Lunches we pay for (the default) with no restaurant yet: there, empty, to fill - not silently missing.
    empty = [i for i in q["items"] if i["category"] == "meal" and not i["vendor_id"]]
    assert [i["name"] for i in empty] == ["Lunch · day 1 · Kutaisi", "Lunch · day 2 · Kutaisi", "Lunch · day 3 · Kutaisi", "Dinner · day 3 · Kutaisi"]
    assert all(float(i["unit_price"]) == 0 and i["who"] == "everyone" for i in empty)
    assert q["result"]["errors"] == [] and q["notices"] == ["4 meals have no restaurant yet: they are in the calculation without a price"]
    assert abs(float(q["fx"]["GEL"]) - 1 / 0.37) < 0.0001             # taken from Settings
    assert c.get(f"{base}/quotes/{q['id']}/versions").json()[0]["note"] == "route:KU"


def test_reprice_for_another_date(make_client):
    c, base, _ = agency(make_client)
    route, _ = catalog_route(c, base)
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-07-01"}).json()
    doc = {k: v for k, v in q.items() if k not in ("id", "updated_at", "version", "result", "notices")}
    r = c.post(f"{base}/quotes/reprice", json={"doc": doc, "on_date": "2026-11-01"}).json()
    changed = {x["name"]: (x["before"], x["after"]) for x in r["changes"]}
    assert changed == {"1. Rioni Hotel": (100, 80), "2. Rioni Hotel": (100, 80), "Martvili: Canyon + boat": (60, 50)}
    assert r["unlinked"] == 5                                   # the guide is typed in by hand, and 4 meals have no restaurant yet
    assert [float(n["price_dbl"]) for n in r["doc"]["nights"]] == [80, 80]
    assert float(c.get(f"{base}/quotes/{q['id']}").json()["nights"][0]["price_dbl"]) == 100   # nothing saved


def test_services_of_other_workspaces_are_refused(make_client):
    a, base_a, _ = agency(make_client)
    _, sid = catalog_route(a, base_a)
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    q = b.post(f"{base_b}/quotes", json={"preset": "blank"}).json()
    doc = {k: v for k, v in q.items() if k not in ("id", "updated_at", "version", "result", "notices")}
    doc["items"][0]["service_id"] = sid["Jeep"]
    assert b.put(f"{base_b}/quotes/{q['id']}", json=doc).status_code == 422
    assert b.post(f"{base_b}/quotes/reprice", json={"doc": doc, "on_date": "2026-11-01"}).status_code == 422
    assert b.post(f"{base_b}/quotes", json={"preset": "blank", "series_id": "nope"}).status_code == 404


def test_same_service_on_several_days_is_one_line():
    from app.route_build import _merge_days
    bus = dict(category="transport", name="Bus", service_id="s1", currency="GEL", unit_price=Decimal("450"), quantity="1",
               basis="group", who="persons")
    items = [QuoteItemIn(**bus, day=d) for d in (1, 2, 3)] + [QuoteItemIn(**{**bus, "service_id": "s2", "name": "Vardzia"}, day=6)]
    merged = _merge_days(items)
    assert [(i.name, i.quantity, i.day, i.notes) for i in merged] == [("Bus", "3", None, "days 1, 2, 3"), ("Vardzia", "1", 6, "")]
