"""Client payment terms: deposit and balance invoices with the right due dates."""
from datetime import date, timedelta

from .test_quotes_api import new_quote
from .test_tours import agency, mk

TODAY = date.today()


def days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


def tour_with_client(c, base, start_in: int, terms=None):
    cl = mk(c, f"{base}/clients", {"name": "Orient", **({"payment_terms": terms} if terms else {})})
    t = mk(c, f"{base}/tours", {"code": f"T{start_in}", "start_date": days(start_in), "end_date": days(start_in + 5),
                                "client_id": cl["id"]})
    return t, cl


def test_deposit_and_balance_by_agency_terms(make_client):
    c, base, ws = agency(make_client)
    r = c.patch(f"/api/workspaces/{ws}", json={"payment_terms": {"deposit_percent": 30, "deposit_days": 7, "balance_days_before": 30}})
    assert r.json()["payment_terms"] == {"deposit_percent": 30, "deposit_days": 7, "balance_days_before": 30}
    t, _ = tour_with_client(c, base, 60)
    url = f"{base}/tours/{t['id']}/invoice-schedule"
    p = c.post(f"{url}/preview", json={"total": "10000", "currency": "USD"}).json()
    assert p["source"] == "agency"
    assert [(x["kind"], x["amount"], x["due_date"]) for x in p["parts"]] == [
        ("deposit", 3000, days(7)), ("balance", 7000, days(30))]
    out = c.post(url, json={"total": "10000", "currency": "USD", "description": "Georgia 6 days"})
    assert out.status_code == 201
    dep, bal = (c.get(f"{base}/invoices/{i}").json() for i in out.json()["created"])
    assert dep["total"] == 3000 and dep["due_date"] == days(7) and dep["lines"][0]["description"].startswith("Deposit 30%")
    # The balance shows the full price and deducts the deposit.
    assert [(x["description"], x["amount"]) for x in bal["lines"]] == [("Georgia 6 days", 10000), ("Less deposit 30%", -3000)]
    assert bal["total"] == 7000 and bal["due_date"] == days(30)
    assert c.post(f"{base}/invoices/{bal['id']}/issue").json()["status"] == "issued"
    assert [x["id"] for x in c.post(f"{url}/preview", json={}).json()["existing"]] == [dep["id"], bal["id"]]


def test_late_booking_is_one_invoice_and_client_terms_win(make_client):
    c, base, ws = agency(make_client)
    c.patch(f"/api/workspaces/{ws}", json={"payment_terms": {"deposit_percent": 30, "deposit_days": 7, "balance_days_before": 30}})
    late, _ = tour_with_client(c, base, 20)          # balance would be due before today
    p = c.post(f"{base}/tours/{late['id']}/invoice-schedule/preview", json={"total": "5000"}).json()
    assert [(x["kind"], x["amount"], x["due_date"]) for x in p["parts"]] == [("full", 5000, days(0))]
    t, cl = tour_with_client(c, base, 90, {"deposit_percent": 50, "deposit_days": 3, "balance_days_before": 45})
    p = c.post(f"{base}/tours/{t['id']}/invoice-schedule/preview", json={"total": "5000"}).json()
    assert p["source"] == "client" and [(x["amount"], x["due_date"]) for x in p["parts"]] == [(2500, days(3)), (2500, days(45))]
    assert c.patch(f"{base}/clients/{cl['id']}", json={"payment_terms": None}).json()["payment_terms"] is None
    assert c.post(f"{base}/tours/{t['id']}/invoice-schedule/preview", json={"total": "5000"}).json()["source"] == "agency"


def test_create_tour_from_calculation_follows_terms(make_client):
    c, base, ws = agency(make_client)
    q = new_quote(c, base)
    cl = mk(c, f"{base}/clients", {"name": "Orient", "payment_terms": {"deposit_percent": 20, "deposit_days": 5,
                                                                         "balance_days_before": 21}})
    price = {x["tourists"]: x for x in q["result"]["tiers"]}[19]
    r = mk(c, f"{base}/quotes/{q['id']}/create-tour",
           {"tourists": 19, "start_date": days(120), "singles": 1, "client_id": cl["id"]})
    assert len(r["invoice_ids"]) == 2 and r["invoice_id"] == r["invoice_ids"][1]
    dep, bal = (c.get(f"{base}/invoices/{i}").json() for i in r["invoice_ids"])
    full = round(19 * price["price_dbl"] + price["single_supplement"], 2)
    assert dep["total"] == round(full * 0.2, 2) and dep["due_date"] == days(5)
    assert bal["lines"][0]["quantity"] == 19 and bal["lines"][1]["description"] == "Single room supplement"
    assert round(bal["total"] + dep["total"], 2) == full and bal["due_date"] == days(99)
    # Without a total, the schedule offers the price the tour was sold at (its budget).
    p = c.post(f"{base}/tours/{r['tour_id']}/invoice-schedule/preview", json={}).json()
    assert p["total"] == price["group_revenue"] and p["currency"] == "USD"


def test_validation(make_client):
    c, base, ws = agency(make_client)
    assert c.patch(f"/api/workspaces/{ws}", json={"payment_terms": {"deposit_percent": 120}}).status_code == 422
    t = mk(c, f"{base}/tours", {"code": "NOCL", "start_date": days(60), "end_date": days(61)})
    r = c.post(f"{base}/tours/{t['id']}/invoice-schedule", json={"total": "100"})
    assert r.status_code == 422 and "client" in r.json()["detail"]
    t2, _ = tour_with_client(c, base, 60)
    assert c.post(f"{base}/tours/{t2['id']}/invoice-schedule", json={}).status_code == 422   # no total known
    cl = mk(c, f"{base}/clients", {"name": "X"})
    neg = mk(c, f"{base}/invoices", {"client_id": cl["id"], "issue_date": days(0), "due_date": days(1), "currency": "USD",
                                     "lines": [{"description": "Refund", "unit_price": "-10"}]})
    assert c.post(f"{base}/invoices/{neg['id']}/issue").status_code == 422   # a total must be positive
