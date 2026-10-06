from datetime import date, timedelta

from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_tours import agency, mk


def invoice_body(client_id, tour_id=None, **kw):
    body = {"client_id": client_id, "tour_id": tour_id, "issue_date": "2026-08-01", "due_date": "2026-08-20",
            "currency": "USD", "lines": [{"description": "Tour package", "quantity": "5", "unit_price": "400"},
                                         {"description": "Single supplement", "quantity": "1", "unit_price": "120.50"}]}
    body.update(kw)
    return body


def test_invoice_lifecycle_and_numbering(make_client):
    c, base, _ = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"]))
    assert inv["number"] is None and inv["status"] == "draft" and inv["display_status"] == "draft"
    assert inv["total"] == 2120.5 and inv["balance"] == 2120.5

    # Numbers are given at issue, in issue order, per year: drafts deleted in
    # between leave no gaps.
    def issue(body):
        d = mk(c, f"{base}/invoices", body)
        return c.post(f"{base}/invoices/{d['id']}/issue").json()["number"]
    gone = mk(c, f"{base}/invoices", invoice_body(cl["id"]))
    assert issue(invoice_body(cl["id"])) == "2026-0001"
    c.delete(f"{base}/invoices/{gone['id']}")
    assert issue(invoice_body(cl["id"])) == "2026-0002"
    assert issue(invoice_body(cl["id"], issue_date="2027-01-02", due_date="2027-01-10")) == "2027-0001"

    url = f"{base}/invoices/{inv['id']}"
    # Drafts are editable; payments only on issued invoices.
    upd = c.put(url, json=invoice_body(cl["id"], lines=[{"description": "Tour", "quantity": "2", "unit_price": "500"}])).json()
    assert upd["total"] == 1000
    assert c.post(f"{url}/payments", json={"amount": "10", "received_on": "2026-08-02"}).status_code == 409

    issued = c.post(f"{url}/issue").json()
    assert issued["status"] == "issued" and issued["number"] == "2026-0003"
    assert c.post(f"{url}/issue").status_code == 409
    assert c.put(url, json=invoice_body(cl["id"])).status_code == 409          # locked once issued
    assert c.delete(url).status_code == 409                                    # void, don't delete
    assert c.patch(url, json={"notes": "Bank: TBC"}).json()["notes"] == "Bank: TBC"

    p = mk(c, f"{url}/payments", {"amount": "400", "received_on": "2026-08-05", "reference": "SWIFT 1"})
    got = c.get(url).json()
    assert got["paid"] == 400 and got["balance"] == 600
    assert got["display_status"] in ("partial", "overdue")
    assert c.post(f"{url}/void").status_code == 409                           # has a payment
    c.delete(f"{url}/payments/{p['id']}")
    assert c.post(f"{url}/void").json()["display_status"] == "void"
    # A void invoice keeps its number; the next one continues the sequence.
    assert issue(invoice_body(cl["id"])) == "2026-0004"


def test_issue_requires_amount_and_dates_are_checked(make_client):
    c, base, _ = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "X"})
    empty = mk(c, f"{base}/invoices", invoice_body(cl["id"], lines=[]))
    assert c.post(f"{base}/invoices/{empty['id']}/issue").status_code == 422
    r = c.post(f"{base}/invoices", json=invoice_body(cl["id"], due_date="2026-07-01"))
    assert r.status_code == 422


def test_status_paid_and_overdue(make_client):
    c, base, _ = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "X"})
    past = (date.today() - timedelta(days=40)).isoformat()
    due = (date.today() - timedelta(days=10)).isoformat()
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], issue_date=past, due_date=due,
                                                 lines=[{"description": "T", "unit_price": "100"}]))
    url = f"{base}/invoices/{inv['id']}"
    c.post(f"{url}/issue")
    assert c.get(url).json()["display_status"] == "overdue"
    assert [i["id"] for i in c.get(f"{base}/invoices", params={"status": "overdue"}).json()] == [inv["id"]]
    mk(c, f"{url}/payments", {"amount": "100", "received_on": due})
    assert c.get(url).json()["display_status"] == "paid"
    assert c.get(f"{base}/invoices", params={"status": "open"}).json() == []


def test_client_debts(make_client):
    c, base, _ = agency(make_client)
    a = mk(c, f"{base}/clients", {"name": "A"})
    b = mk(c, f"{base}/clients", {"name": "B"})
    old = (date.today() - timedelta(days=30)).isoformat()
    soon = (date.today() + timedelta(days=30)).isoformat()
    for cl, due, cur in ((a, old, "USD"), (a, soon, "EUR"), (b, soon, "USD")):
        inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], issue_date=old, due_date=due, currency=cur,
                                                     lines=[{"description": "T", "unit_price": "100"}]))
        c.post(f"{base}/invoices/{inv['id']}/issue")
    mk(c, f"{base}/invoices", invoice_body(b["id"]))  # draft: not a debt
    debts = c.get(f"{base}/debts").json()
    assert [d["client"]["name"] for d in debts] == ["A", "B"]  # overdue first
    assert debts[0]["open"] == {"USD": 100, "EUR": 100} and debts[0]["overdue"] == {"USD": 100}
    assert debts[1]["open_invoices"] == 1


def test_client_with_invoices_cannot_be_deleted(make_client):
    c, base, _ = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "X"})
    mk(c, f"{base}/invoices", invoice_body(cl["id"]))
    assert c.delete(f"{base}/clients/{cl['id']}").status_code == 409


def test_profit_per_tour_month_and_route(make_client):
    c, base, _ = agency(make_client)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.4"}, {"currency": "EUR", "rate": "1.1"}])
    t, *_ = setup_tour(c, base, start="2026-09-06", rooms="1 DBL", pax=5)
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    cost = c.get(f"{base}/tours/{t['id']}/costs").json()["totals"]["base_total"]
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"], currency="EUR",
                                                 lines=[{"description": "Tour", "quantity": "5", "unit_price": "300"}]))
    # Draft: not revenue yet.
    p = c.get(f"{base}/tours/{t['id']}/profit").json()
    assert p["revenue"] == 0 and p["uninvoiced"] == 1 and p["margin"] is None
    c.post(f"{base}/invoices/{inv['id']}/issue")
    p = c.get(f"{base}/tours/{t['id']}/profit").json()
    assert p["revenue"] == 1650.0  # 1500 EUR × 1.1
    assert p["cost"] == cost and p["profit"] == round(1650 - cost, 2)
    assert p["uninvoiced"] == 0 and p["margin"] == round((1650 - cost) / 1650 * 100, 1)

    # A second, cost-free tour of no route in another month.
    t2 = mk(c, f"{base}/tours", {"code": "X1", "start_date": "2026-10-02", "end_date": "2026-10-03", "pax": 2})
    inv2 = mk(c, f"{base}/invoices", invoice_body(cl["id"], t2["id"], lines=[{"description": "Car", "unit_price": "200"}]))
    c.post(f"{base}/invoices/{inv2['id']}/issue")

    q = {"date_from": "2026-01-01", "date_to": "2026-12-31"}
    by_tour = c.get(f"{base}/reports/profit", params={**q, "group": "tour"}).json()
    assert [r["label"] for r in by_tour["rows"]] == [t["code"], "X1"]
    assert by_tour["totals"]["revenue"] == 1850 and by_tour["totals"]["tours"] == 2 and by_tour["totals"]["pax"] == 7
    by_month = c.get(f"{base}/reports/profit", params={**q, "group": "month"}).json()
    assert [r["key"] for r in by_month["rows"]] == ["2026-09", "2026-10"]
    by_route = c.get(f"{base}/reports/profit", params={**q, "group": "route"}).json()
    assert {r["key"] for r in by_route["rows"]} == {"TT", "—"}

    # Voiding takes revenue back out.
    c.post(f"{base}/invoices/{inv2['id']}/void")
    assert c.get(f"{base}/reports/profit", params=q).json()["totals"]["revenue"] == 1650


def test_invoice_without_exchange_rate_is_flagged(make_client):
    c, base, _ = agency(make_client)
    t = mk(c, f"{base}/tours", {"code": "Z", "start_date": "2026-09-01", "end_date": "2026-09-01"})
    cl = mk(c, f"{base}/clients", {"name": "X"})
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"], currency="CNY"))
    c.post(f"{base}/invoices/{inv['id']}/issue")
    p = c.get(f"{base}/tours/{t['id']}/profit").json()
    assert p["missing_rates"] is True and p["revenue"] == 0


def test_invoices_are_manager_only_and_scoped(make_client):
    owner, base, ws = agency(make_client)
    cl = mk(owner, f"{base}/clients", {"name": "X"})
    inv = mk(owner, f"{base}/invoices", invoice_body(cl["id"]))
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    for path in ("/invoices", f"/invoices/{inv['id']}", "/debts", "/reports/profit"):
        assert staff.get(f"{base}{path}").status_code == 403, path

    other, base_b, _ = agency(make_client, "b@b.com", "B")
    assert other.get(f"{base_b}/invoices/{inv['id']}").status_code == 404
    assert other.post(f"{base_b}/invoices/{inv['id']}/issue").status_code == 404
    # B can't invoice A's client or attach A's tour.
    t_a = mk(owner, f"{base}/tours", {"code": "A1", "start_date": "2026-09-01", "end_date": "2026-09-01"})
    cl_b = mk(other, f"{base_b}/clients", {"name": "Mine"})
    assert other.post(f"{base_b}/invoices", json=invoice_body(cl["id"])).status_code == 422
    assert other.post(f"{base_b}/invoices", json=invoice_body(cl_b["id"], t_a["id"])).status_code == 422
    # Numbering is per agency.
    owner.post(f"{base}/invoices/{inv['id']}/issue")
    mine = mk(other, f"{base_b}/invoices", invoice_body(cl_b["id"]))
    assert other.post(f"{base_b}/invoices/{mine['id']}/issue").json()["number"] == "2026-0001"
    assert [d["client"]["name"] for d in other.get(f"{base_b}/debts").json()] == ["Mine"]  # never A's client
