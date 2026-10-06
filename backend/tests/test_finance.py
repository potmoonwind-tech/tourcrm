from datetime import date, timedelta

from .conftest import invite_and_join, signup
from .test_tours import agency, mk


def set_prices(c, base, vendor_id, **prices):
    """One all-year price per system code, e.g. room_DBL=("80", "USD")."""
    r = c.put(f"{base}/vendors/{vendor_id}/services", json=[
        {"code": code, "name": code, "rates": [{"price": p, "currency": cur}]} for code, (p, cur) in prices.items()])
    assert r.status_code == 200, r.text
    return r.json()


def setup_tour(c, base, start="2026-09-06", rooms="2 DBL + 1 SGL", pax=5):
    """3-day tour: hotel nights 1-2, lunch day 1, dinner day 2, guide days 1-3."""
    hotel = mk(c, f"{base}/vendors", {"name": "Hotel", "type": "hotel", "payment_timing": "after", "payment_days": 7})
    resto = mk(c, f"{base}/vendors", {"name": "Resto", "type": "restaurant", "payment_timing": "after", "payment_days": 0})
    guide = mk(c, f"{base}/vendors", {"name": "Guide", "type": "guide", "payment_timing": "before", "payment_days": 3})
    set_prices(c, base, hotel["id"], room_DBL=("80", "USD"), room_SGL=("60", "USD"))
    set_prices(c, base, resto["id"], lunch=("20", "GEL"), dinner=("35.50", "GEL"))
    set_prices(c, base, guide["id"], day=("100", "USD"))
    series = mk(c, f"{base}/series", {"code": "TT", "days": [
        {"city": "Tbilisi", "hotel_id": hotel["id"], "lunch_id": resto["id"]},
        {"city": "Tbilisi", "hotel_id": hotel["id"], "dinner_id": resto["id"]},
        {"city": "Tbilisi"},
    ]})
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": start, "pax": pax, "rooms": rooms})
    mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": guide["id"], "role": "guide"})
    return t, hotel, resto, guide


def test_generate_costs_from_itinerary(make_client):
    c, base, _ = agency(make_client)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    t, hotel, resto, guide = setup_tour(c, base)
    r = c.post(f"{base}/tours/{t['id']}/costs/generate").json()
    assert r["created"] == 7 and r["warnings"] == []  # 2 nights × 2 room types, 2 meals, 1 guide line

    costs = c.get(f"{base}/tours/{t['id']}/costs").json()
    by_vendor = {}
    for line in costs["lines"]:
        by_vendor.setdefault(line["vendor"]["name"], 0)
        by_vendor[line["vendor"]["name"]] += line["amount"]
    # Meals: 5 tourists + the guide, who eats with the group.
    assert by_vendor == {"Hotel": 2 * (2 * 80 + 60), "Resto": 6 * 20 + 6 * 35.5, "Guide": 300}
    assert costs["totals"]["by_currency"] == {"GEL": 333.0, "USD": 740.0}
    # Each line is converted and rounded to the cent, then summed: 44.40 + 78.81
    assert costs["totals"]["base_total"] == 863.21
    assert costs["totals"]["missing_rates"] == []

    pay = {p["vendor"]["name"]: p for p in costs["payables"]}
    assert pay["Hotel"]["due_date"] == "2026-09-14"   # last night 09-07 + 7 days
    assert pay["Resto"]["due_date"] == "2026-09-07"   # last meal + 0
    assert pay["Guide"]["due_date"] == "2026-09-03"   # 3 days before day 1
    assert pay["Guide"]["last_service"] == "2026-09-08"


def test_regenerate_updates_and_respects_paid_and_locked(make_client):
    c, base, _ = agency(make_client)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    t, hotel, resto, guide = setup_tour(c, base, rooms="2 DBL")
    url = f"{base}/tours/{t['id']}"
    c.post(f"{url}/costs/generate")
    assert c.post(f"{url}/costs/generate").json() == {"created": 0, "updated": 0, "removed": 0, "kept": 0, "linked": 0, "warnings": []}

    # Hand-edit one meal line: it becomes locked.
    lines = c.get(f"{url}/costs").json()["lines"]
    lunch = next(x for x in lines if x["description"].startswith("lunch"))
    edited = c.patch(f"{url}/costs/{lunch['id']}", json={"unit_price": "25"}).json()
    assert edited["locked"] and edited["amount"] == 150

    # Pay the guide, then change pax and rooms and regenerate.
    mk(c, f"{url}/payments", {"vendor_id": guide["id"], "currency": "USD", "amount": "300", "paid_on": "2026-09-01"})
    c.patch(url, json={"pax": 8, "rooms": "4 DBL"})
    c.delete(f"{url}/staff/{c.get(url).json()['staff'][0]['id']}")  # guide removed from tour
    r = c.post(f"{url}/costs/generate").json()
    assert r["updated"] == 3  # 2 hotel nights + dinner
    assert r["kept"] == 2     # locked lunch, paid guide line (kept even though the guide is gone)
    lines = {x["description"]: x for x in c.get(f"{url}/costs").json()["lines"]}
    assert lines["lunch × 6 (5 + 1 staff)"]["unit_price"] == 25   # locked line untouched
    assert lines["dinner × 8"]["amount"] == 8 * 35.5
    assert "guide × 3 days" in lines


def test_payment_status_lifecycle(make_client):
    c, base, _ = agency(make_client)
    past = (date.today() - timedelta(days=30)).isoformat()
    t, hotel, *_ = setup_tour(c, base, start=past, rooms="1 DBL")
    url = f"{base}/tours/{t['id']}"
    c.post(f"{url}/costs/generate")

    def hotel_payable():
        return next(p for p in c.get(f"{url}/costs").json()["payables"] if p["vendor"]["name"] == "Hotel")

    assert hotel_payable()["status"] == "overdue" and hotel_payable()["balance"] == 160
    p1 = mk(c, f"{url}/payments", {"vendor_id": hotel["id"], "currency": "USD", "amount": "100", "paid_on": past})
    assert hotel_payable()["status"] == "overdue" and hotel_payable()["balance"] == 60  # still late
    mk(c, f"{url}/payments", {"vendor_id": hotel["id"], "currency": "USD", "amount": "60", "paid_on": past})
    assert hotel_payable()["status"] == "paid"
    assert c.delete(f"{url}/payments/{p1['id']}").status_code == 204
    assert hotel_payable()["paid"] == 60


def test_schedule_and_summary(make_client):
    c, base, _ = agency(make_client)
    soon = (date.today() + timedelta(days=2)).isoformat()
    t, hotel, resto, guide = setup_tour(c, base, start=soon, rooms="1 DBL")
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    s = c.get(f"{base}/payments/schedule").json()
    assert [p["vendor"]["name"] for p in s["items"]][0] == "Guide"  # guide due first (before tour)
    assert s["overdue"] == {"USD": 300.0}  # due 3 days before a tour starting in 2 days
    assert "GEL" in s["due_7"] and "USD" in s["due_30"] or "USD" in s["due_7"]
    only_hotel = c.get(f"{base}/payments/schedule", params={"vendor_id": hotel["id"]}).json()["items"]
    assert [p["vendor"]["name"] for p in only_hotel] == ["Hotel"]
    assert c.get(f"{base}/payments/schedule", params={"status": "paid"}).json()["items"] == []


def test_missing_rates_are_flagged_then_filled(make_client):
    c, base, _ = agency(make_client)
    t, *_ = setup_tour(c, base)
    r = c.post(f"{base}/tours/{t['id']}/costs/generate").json()
    assert any("GEL" in w for w in r["warnings"])
    totals = c.get(f"{base}/tours/{t['id']}/costs").json()["totals"]
    assert totals["missing_rates"] == ["GEL"] and totals["base_total"] == 740
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.4"}])
    totals = c.get(f"{base}/tours/{t['id']}/costs").json()["totals"]
    assert totals["missing_rates"] == [] and totals["base_total"] == 740 + 48 + 85.2


def test_missing_vendor_prices_warn(make_client):
    c, base, _ = agency(make_client)
    t, hotel, *_ = setup_tour(c, base, rooms="1 TWN")
    r = c.post(f"{base}/tours/{t['id']}/costs/generate").json()
    assert any("Hotel" in w and "room_TWN" in w for w in r["warnings"])


def test_manual_costs_and_decimal_precision(make_client):
    c, base, _ = agency(make_client)
    t, hotel, *_ = setup_tour(c, base)
    url = f"{base}/tours/{t['id']}/costs"
    for _ in range(3):
        mk(c, url, {"category": "ticket", "description": "Museum", "service_date": "2026-09-06",
                    "quantity": "3", "unit_price": "0.10", "currency": "USD"})
    totals = c.get(url).json()["totals"]
    assert totals["by_currency"] == {"USD": 0.9}  # no float drift
    assert c.post(url, json={"service_date": "2026-09-06", "unit_price": "-1", "currency": "USD"}).status_code == 422
    assert c.post(url, json={"service_date": "2026-09-06", "unit_price": "1", "currency": "US"}).status_code == 422


def test_finance_is_manager_only_and_scoped(make_client):
    owner, base, ws = agency(make_client)
    t, hotel, *_ = setup_tour(owner, base)
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    for path in (f"/tours/{t['id']}/costs", "/payments/schedule", "/exchange-rates", f"/vendors/{hotel['id']}/services", "/catalog"):
        assert staff.get(f"{base}{path}").status_code == 403, path
    assert staff.post(f"{base}/tours/{t['id']}/costs/generate").status_code == 403

    other, base_b, _ = agency(make_client, "b@b.com", "B")
    assert other.get(f"{base_b}/tours/{t['id']}/costs").status_code == 404
    assert other.get(f"{base_b}/vendors/{hotel['id']}/services").status_code == 404
    # B can't pay A's vendor from its own tour, nor see A's payables.
    t_b = mk(other, f"{base_b}/tours", {"code": "B1", "start_date": "2026-09-01", "end_date": "2026-09-01"})
    r = other.post(f"{base_b}/tours/{t_b['id']}/payments",
                   json={"vendor_id": hotel["id"], "currency": "USD", "amount": "1", "paid_on": "2026-09-01"})
    assert r.status_code == 422
    owner.post(f"{base}/tours/{t['id']}/costs/generate")
    assert other.get(f"{base_b}/payments/schedule").json()["items"] == []


def test_cancelled_tour_cannot_generate(make_client):
    c, base, _ = agency(make_client)
    t, *_ = setup_tour(c, base)
    c.patch(f"{base}/tours/{t['id']}", json={"status": "cancelled"})
    assert c.post(f"{base}/tours/{t['id']}/costs/generate").status_code == 409


def test_rooms_field_understands_words_in_any_language():
    from types import SimpleNamespace
    from app.finance import room_counts
    def rooms(text):
        return room_counts(SimpleNamespace(participants=[], rooms=text))
    assert rooms("12 DBL + 2 SGL") == {"DBL": 12, "SGL": 2}
    assert rooms("8 double + 2 single, 1 twin") == {"DBL": 8, "SGL": 2, "TWN": 1}
    assert rooms("8 ორადგილიანი + 2 ერთადგილიანი") == {"DBL": 8, "SGL": 2}
    assert rooms("3 двухместных + 1 трехместный") == {"DBL": 3, "TRP": 1}
    assert rooms("18 pax") == {}


def test_rate_suggestion_from_the_national_bank(make_client, monkeypatch):
    from decimal import Decimal
    from app import nbg
    gel = {"USD": Decimal("2.7"), "EUR": Decimal("3.0"), "GEL": Decimal(1)}

    def fake(cur, client):
        if cur not in gel:
            raise nbg.Unavailable(cur)
        return gel[cur]
    monkeypatch.setattr(nbg, "_gel_per_unit", fake)
    c, base, _ = agency(make_client)                        # agency currency: USD
    r = c.get(f"{base}/exchange-rates/suggest?currencies=GEL,EUR,XYZ,USD").json()
    assert r["base"] == "USD" and r["source"] == "nbg"
    assert r["rates"] == {"GEL": 0.37037, "EUR": 1.111111}  # 1 GEL = 1/2.7 USD; XYZ isn't quoted; USD is the base
    assert c.get(f"{base}/exchange-rates").json() == []     # only a suggestion, nothing saved

    def down(cur, client):
        raise nbg.Unavailable(cur)
    monkeypatch.setattr(nbg, "_gel_per_unit", down)
    assert c.get(f"{base}/exchange-rates/suggest?currencies=GEL").status_code == 503
    assert c.get(f"{base}/exchange-rates/suggest?currencies=US$").status_code == 422


def test_supplier_refunds_and_currency_lock(make_client):
    from decimal import Decimal as D

    from app.finance import status_of
    today = date.today()
    assert status_of(D("-50"), D("0"), None, today) == "owed_to_us"
    assert status_of(D("-50"), D("-50"), None, today) == "paid"
    assert status_of(D("0"), D("0"), None, today) == "unpaid"

    c, base, _ = agency(make_client)
    past = (date.today() - timedelta(days=30)).isoformat()
    t, hotel, *_ = setup_tour(c, base, start=past, rooms="1 DBL")
    url = f"{base}/tours/{t['id']}"
    c.post(f"{url}/costs/generate")
    assert c.post(f"{url}/payments", json={"vendor_id": hotel["id"], "currency": "USD", "amount": "0", "paid_on": past}).status_code == 422
    mk(c, f"{url}/payments", {"vendor_id": hotel["id"], "currency": "USD", "amount": "200", "paid_on": past})
    mk(c, f"{url}/payments", {"vendor_id": hotel["id"], "currency": "USD", "amount": "-40", "paid_on": past})   # refund back
    p = next(p for p in c.get(f"{url}/costs").json()["payables"] if p["vendor"]["name"] == "Hotel")
    assert p["paid"] == 160 and p["status"] == "paid"
    # Money already counted in USD: the agency's currency stays.
    assert c.patch(base, json={"base_currency": "EUR"}).status_code == 409
