"""Price catalog: services with prices by season and group size."""
from datetime import date
from types import SimpleNamespace as R

from app import catalog

from .test_finance import setup_tour
from .test_tours import agency, mk


def rate(price, frm=None, to=None, lo=None, hi=None):
    return R(price=price, valid_from=date.fromisoformat(frm) if frm else None,
             valid_to=date.fromisoformat(to) if to else None, min_pax=lo, max_pax=hi)


def test_narrowest_matching_row_wins():
    year, summer, august = rate(100), rate(130, "2026-06-01", "2026-09-30"), rate(150, "2026-08-01", "2026-08-31")
    big = rate(90, lo=20)
    rows = [year, summer, august, big]
    assert catalog.pick(rows, date(2026, 3, 1)).price == 100
    assert catalog.pick(rows, date(2026, 7, 1)).price == 130
    assert catalog.pick(rows, date(2026, 8, 15)).price == 150
    assert catalog.pick(rows, date(2026, 3, 1), pax=25).price == 90   # big group, low season
    assert catalog.pick([summer], date(2026, 3, 1)) is None              # nothing for that date


def test_overlaps_that_are_ambiguous_are_found():
    assert catalog.conflicts([rate(1), rate(2, "2026-06-01", "2026-09-30")]) == []           # nested
    assert catalog.conflicts([rate(1, "2026-01-01", "2026-06-30"), rate(2, "2026-06-01", "2026-09-30")]) == [(0, 1)]
    assert catalog.conflicts([rate(1), rate(2)]) == [(0, 1)]                                   # identical
    assert catalog.conflicts([rate(1, lo=1, hi=15), rate(2, lo=16)]) == []                     # side by side
    assert catalog.conflicts([rate(1, lo=1, hi=20), rate(2, "2026-06-01", "2026-09-30", lo=10)]) == [(0, 1)]


def test_save_keeps_ids_and_rejects_bad_rows(make_client):
    c, base, _ = agency(make_client)
    v = mk(c, f"{base}/vendors", {"name": "Hotel", "type": "hotel"})
    url = f"{base}/vendors/{v['id']}/services"
    body = [{"code": "room_DBL", "name": "DBL room", "category": "hotel", "unit": "room_night", "rates": [
        {"price": "80", "currency": "usd"}, {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "110", "currency": "USD"}]},
        {"name": "Wine tasting", "category": "activity", "unit": "person", "rates": [{"price": "25", "currency": "GEL"}]}]
    saved = c.put(url, json=body).json()
    assert sorted(s["name"] for s in saved) == ["DBL room", "Wine tasting"]
    dbl = next(s for s in saved if s["code"] == "room_DBL")
    assert dbl["rates"][0]["currency"] == "USD" and len(dbl["rates"]) == 2
    # Editing keeps the service and price-row ids.
    dbl["rates"][1]["price"] = 120
    again = c.put(url, json=saved).json()
    dbl2 = next(s for s in again if s["code"] == "room_DBL")
    assert dbl2["id"] == dbl["id"] and dbl2["rates"][1]["id"] == dbl["rates"][1]["id"] and dbl2["rates"][1]["price"] == 120
    # Saving without ids (e.g. from an import) matches services by system code.
    third = c.put(url, json=body)
    assert third.status_code == 200 and next(s for s in third.json() if s["code"] == "room_DBL")["id"] == dbl["id"]

    clash = [dict(body[0], rates=[{"valid_from": "2026-01-01", "valid_to": "2026-06-30", "price": "1", "currency": "USD"},
                                  {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "2", "currency": "USD"}])]
    r = c.put(url, json=clash)
    assert r.status_code == 422 and "overlap" in r.json()["detail"]
    assert c.put(url, json=[body[0], body[0]]).status_code == 422                       # same code twice
    backwards = [dict(body[0], rates=[{"valid_from": "2026-09-01", "valid_to": "2026-06-01", "price": "1", "currency": "USD"}])]
    assert c.put(url, json=backwards).status_code == 422
    assert c.put(url, json=[dict(body[0], unit="parsec")]).status_code == 422


def test_catalog_shows_price_on_a_date(make_client):
    c, base, _ = agency(make_client)
    v = mk(c, f"{base}/vendors", {"name": "Hotel Rioni", "type": "hotel", "city": "Kutaisi"})
    c.put(f"{base}/vendors/{v['id']}/services", json=[
        {"code": "room_DBL", "name": "DBL room", "rates": [
            {"price": "80", "currency": "USD"}, {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "110", "currency": "USD"}]},
        {"name": "Boat", "rates": [{"valid_from": "2026-05-01", "valid_to": "2026-10-31", "price": "10", "currency": "GEL"}]}])
    low = c.get(f"{base}/catalog", params={"on": "2026-03-01"}).json()
    assert {r["service"]["name"]: r["price"] for r in low} == {"DBL room": 80, "Boat": None}
    high = c.get(f"{base}/catalog", params={"on": "2026-07-01", "q": "kutaisi"}).json()
    assert {r["service"]["name"]: r["price"] for r in high} == {"DBL room": 110, "Boat": 10}
    missing = c.get(f"{base}/catalog", params={"on": "2026-03-01", "missing": True}).json()
    assert [r["service"]["name"] for r in missing] == ["Boat"]


def test_tour_costs_use_the_season_of_each_night(make_client):
    c, base, _ = agency(make_client)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    # Nights on 31 May and 1 June: the second one is in high season.
    t, hotel, *_ = setup_tour(c, base, start="2026-05-31")
    assert c.put(f"{base}/vendors/{hotel['id']}/services", json=[
        {"code": "room_DBL", "name": "DBL", "rates": [
            {"price": "80", "currency": "USD"}, {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "100", "currency": "USD"}]},
        {"code": "room_SGL", "name": "SGL", "rates": [{"price": "60", "currency": "USD"}]}]).status_code == 200
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    lines = c.get(f"{base}/tours/{t['id']}/costs").json()["lines"]
    dbl = sorted((l["service_date"], l["unit_price"]) for l in lines if l["category"] == "hotel" and "DBL" in l["description"])
    assert dbl == [("2026-05-31", 80), ("2026-06-01", 100)]


def test_route_fill_prices_by_season(make_client):
    c, base, _ = agency(make_client)
    hotel = mk(c, f"{base}/vendors", {"name": "Hualing", "type": "hotel"})
    # Big groups get a discount outside high season ("30+ pax all year" would clash with summer).
    r = c.put(f"{base}/vendors/{hotel['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "rates": [
        {"price": "75", "currency": "USD"}, {"valid_from": "2026-06-01", "valid_to": "2026-09-30", "price": "95", "currency": "USD"},
        {"valid_from": "2026-01-01", "valid_to": "2026-05-31", "min_pax": 30, "price": "70", "currency": "USD"}]}])
    assert r.status_code == 200, r.text
    s = mk(c, f"{base}/series", {"code": "HM", "days": [{"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi"}]})
    fill = lambda **kw: c.post(f"{base}/quotes/route-fill", json={"series_id": s["id"], **kw}).json()  # noqa: E731
    assert float(fill(on_date="2026-03-01")["nights"][0]["price_dbl"]) == 75
    assert float(fill(on_date="2026-07-01")["nights"][0]["price_dbl"]) == 95
    assert float(fill(on_date="2026-03-01", pax=35)["nights"][0]["price_dbl"]) == 70
    assert float(fill(on_date="2026-07-01", pax=35)["nights"][0]["price_dbl"]) == 95
