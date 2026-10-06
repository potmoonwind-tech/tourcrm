"""VAT inside suppliers' prices (claimed back) and who paid a supplier."""
from .test_tours import agency, mk


def setup_tour(c, base):
    hotel = mk(c, f"{base}/vendors", {"name": "Hotel", "type": "hotel", "vat_invoice": True})
    guide = mk(c, f"{base}/vendors", {"name": "Nino", "type": "guide"})
    t = mk(c, f"{base}/tours", {"code": "V", "start_date": "2026-09-01", "end_date": "2026-09-03"})
    url = f"{base}/tours/{t['id']}"
    mk(c, f"{url}/costs", {"vendor_id": hotel["id"], "service_date": "2026-09-01", "unit_price": "1180", "currency": "USD"})
    mk(c, f"{url}/costs", {"vendor_id": guide["id"], "service_date": "2026-09-01", "unit_price": "300", "currency": "USD"})
    return hotel, guide, t, url


def test_no_vat_until_the_agency_sets_a_rate(make_client):
    c, base, _ = agency(make_client)
    _, _, _, url = setup_tour(c, base)
    costs = c.get(f"{url}/costs").json()
    assert costs["totals"]["vat_base"] is None and all(x["vat"] is None for x in costs["lines"])
    assert c.get(f"{url}/profit").json()["profit_after_vat"] is None


def test_vat_from_the_supplier_and_by_hand(make_client):
    c, base, ws = agency(make_client)
    assert c.patch(base, json={"vat_rate": "18"}).json()["vat_rate"] == 18
    hotel, guide, _, url = setup_tour(c, base)
    lines = {x["vendor"]["name"]: x for x in c.get(f"{url}/costs").json()["lines"]}
    assert lines["Hotel"]["vat"] == 180 and lines["Hotel"]["vat_rate"] == 18 and not lines["Hotel"]["vat_by_hand"]
    assert lines["Nino"]["vat"] == 0
    assert c.get(f"{url}/costs").json()["totals"]["vat_base"] == 180
    p = c.get(f"{url}/profit").json()
    assert p["vat"] == 180 and p["profit_after_vat"] == p["profit"] + 180
    assert c.get(f"{base}/reports/profit?date_from=2026-01-01&date_to=2026-12-31").json()["totals"]["vat"] == 180

    # This time the hotel gave no VAT invoice: 0 on the line; null goes back to the supplier's usual.
    r = c.patch(f"{url}/costs/{lines['Hotel']['id']}", json={"vat_rate": "0"}).json()
    assert r["vat"] == 0 and r["vat_by_hand"]
    r = c.patch(f"{url}/costs/{lines['Hotel']['id']}", json={"vat_rate": None}).json()
    assert r["vat"] == 180 and not r["vat_by_hand"]
    # Turning VAT off for the agency.
    assert c.patch(base, json={"vat_rate": None}).json()["vat_rate"] is None
    assert c.get(f"{url}/costs").json()["totals"]["vat_base"] is None


def test_paid_by_a_guide_counts_against_their_advance(make_client):
    c, base, ws = agency(make_client)
    hotel, guide, t, url = setup_tour(c, base)
    mk(c, f"{url}/payments", {"vendor_id": guide["id"], "currency": "USD", "amount": "1000", "paid_on": "2026-08-30",
                              "method": "cash", "reference": "Cash advance"})
    p = mk(c, f"{url}/payments", {"vendor_id": hotel["id"], "currency": "USD", "amount": "600", "paid_on": "2026-09-01",
                                  "method": "cash", "paid_by_vendor_id": guide["id"]})
    assert p["paid_by"] == {"kind": "staff", "id": guide["id"], "name": "Nino"}
    pay = {x["vendor"]["name"]: x for x in c.get(f"{url}/costs").json()["payables"]}
    # 1000 cash − 600 paid for us = 400 net; owed 300 → the guide brings back 100.
    assert pay["Nino"]["paid"] == 400 and pay["Nino"]["balance"] == -100
    assert pay["Hotel"]["paid"] == 600

    me = c.get("/api/auth/me").json()["user"]["id"]
    p = mk(c, f"{url}/payments", {"vendor_id": hotel["id"], "currency": "USD", "amount": "10", "paid_on": "2026-09-01",
                                  "paid_by_user_id": me})
    assert p["paid_by"]["kind"] == "user" and p["paid_by"]["id"] == me
    assert c.post(f"{url}/payments", json={"vendor_id": hotel["id"], "currency": "USD", "amount": "10", "paid_on": "2026-09-01",
                                           "paid_by_user_id": "nobody"}).status_code == 422
    assert c.post(f"{url}/payments", json={"vendor_id": hotel["id"], "currency": "USD", "amount": "10", "paid_on": "2026-09-01",
                                           "paid_by_user_id": me, "paid_by_vendor_id": guide["id"]}).status_code == 422
