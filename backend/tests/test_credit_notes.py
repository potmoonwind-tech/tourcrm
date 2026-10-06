"""Credit notes: numbered corrections of issued invoices, refunds, and their effect on money."""
from datetime import date

from .test_finance import setup_tour
from .test_invoices import invoice_body
from .test_tours import agency, mk

YEAR = date.today().year


def issued_invoice(c, base, tour_id=None, lines=None):
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    body = invoice_body(cl["id"], tour_id)
    if lines:
        body["lines"] = lines
    inv = mk(c, f"{base}/invoices", body)
    return c.post(f"{base}/invoices/{inv['id']}/issue").json()


def test_credit_note_lifecycle(make_client):
    c, base, _ = agency(make_client)
    t, *_ = setup_tour(c, base)
    inv = issued_invoice(c, base, t["id"], [{"description": "Tour package", "quantity": "5", "unit_price": "200"}])
    assert inv["total"] == 1000 and inv["creditable"] == 1000
    # A draft credit note starts as a copy of the invoice, to edit down.
    cn = mk(c, f"{base}/invoices/{inv['id']}/credit-note", {})
    assert cn["kind"] == "credit_note" and cn["number"] is None and cn["credits"]["number"] == inv["number"]
    assert cn["lines"][0]["description"] == "Tour package" and cn["total"] == 1000
    # Editing keeps it on the invoice's client, tour and currency.
    other = mk(c, f"{base}/clients", {"name": "Someone else"})
    body = invoice_body(other["id"], None, currency="EUR",
                        lines=[{"description": "Group 5 → 4 tourists", "quantity": "1", "unit_price": "200"}])
    cn = c.put(f"{base}/invoices/{cn['id']}", json=body).json()
    assert cn["client"]["name"] == "Orient" and cn["currency"] == "USD" and cn["tour"]["id"] == t["id"] and cn["total"] == 200
    # Drafts don't count yet.
    assert c.get(f"{base}/invoices/{inv['id']}").json()["balance"] == 1000
    cn = c.post(f"{base}/invoices/{cn['id']}/issue").json()
    assert cn["number"] == f"CN-{YEAR}-0001" and cn["display_status"] == "credit_note"
    inv = c.get(f"{base}/invoices/{inv['id']}").json()
    assert inv["credited"] == 200 and inv["balance"] == 800 and inv["creditable"] == 800
    assert [x["number"] for x in inv["credit_notes"]] == [f"CN-{YEAR}-0001"]
    # Revenue counts the credit note negative.
    assert c.get(f"{base}/tours/{t['id']}/profit").json()["revenue"] == 800
    # Never more than is left to credit.
    r = c.post(f"{base}/invoices/{inv['id']}/credit-note", json={"lines": [{"description": "x", "unit_price": "900"}]})
    assert r.status_code == 422 and "800.00" in r.json()["detail"]
    # Invoice numbers are a separate series.
    nxt = issued_invoice(c, base)
    assert nxt["number"].endswith("-0002") and not nxt["number"].startswith("CN")
    # Payments go on the invoice, not the credit note; the invoice can't be voided under it.
    assert c.post(f"{base}/invoices/{cn['id']}/payments", json={"amount": "1", "received_on": "2026-08-02"}).status_code == 409
    assert c.post(f"{base}/invoices/{inv['id']}/void").status_code == 409
    assert c.post(f"{base}/invoices/{cn['id']}/void").json()["status"] == "void"
    assert c.get(f"{base}/invoices/{inv['id']}").json()["balance"] == 1000


def test_refund_after_payment(make_client):
    c, base, _ = agency(make_client)
    inv = issued_invoice(c, base, lines=[{"description": "Tour", "unit_price": "1000"}])
    url = f"{base}/invoices/{inv['id']}"
    mk(c, f"{url}/payments", {"amount": "1000", "received_on": "2026-08-02"})
    cn = mk(c, f"{url}/credit-note", {"lines": [{"description": "Hotel downgrade", "unit_price": "150"}]})
    c.post(f"{base}/invoices/{cn['id']}/issue")
    inv = c.get(url).json()
    assert inv["balance"] == -150 and inv["display_status"] == "refund_due"
    debts = c.get(f"{base}/debts").json()
    assert debts[0]["refund_due"] == {"USD": 150} and debts[0]["open"] == {}
    assert c.get(f"{base}/invoices", params={"status": "open"}).json()[0]["id"] == inv["id"]
    assert c.post(f"{url}/refunds", json={"amount": "200", "paid_on": "2026-08-10"}).status_code == 422
    r = mk(c, f"{url}/refunds", {"amount": "150", "paid_on": "2026-08-10", "reference": "SWIFT 1"})
    assert r["amount"] == -150
    inv = c.get(url).json()
    assert inv["balance"] == 0 and inv["display_status"] == "paid" and inv["paid"] == 850
    assert c.post(f"{url}/refunds", json={"amount": "1", "paid_on": "2026-08-10"}).status_code == 409
    # The credit note can't be voided once its refund was paid out.
    assert c.post(f"{base}/invoices/{cn['id']}/void").status_code == 409


def test_credit_notes_need_an_issued_invoice(make_client):
    c, base, _ = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    draft = mk(c, f"{base}/invoices", invoice_body(cl["id"]))
    assert c.post(f"{base}/invoices/{draft['id']}/credit-note", json={}).status_code == 409
    inv = issued_invoice(c, base)
    full = mk(c, f"{base}/invoices/{inv['id']}/credit-note", {})
    c.post(f"{base}/invoices/{full['id']}/issue")
    assert c.post(f"{base}/invoices/{inv['id']}/credit-note", json={}).status_code == 409   # fully credited
    assert c.post(f"{base}/invoices/{full['id']}/credit-note", json={}).status_code == 409  # not on a credit note
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    assert b.post(f"{base_b}/invoices/{inv['id']}/credit-note", json={}).status_code == 404


def test_incident_compensation_becomes_a_credit_note(make_client):
    c, base, _ = agency(make_client)
    t, hotel, *_ = setup_tour(c, base)
    inc = mk(c, f"{base}/tours/{t['id']}/incidents", {
        "title": "Hotel overbooked, guests moved", "carried_by": "vendor", "vendor_id": hotel["id"],
        "vendor_claim": "100", "claim_currency": "USD", "client_credit": "60", "client_currency": "USD"})
    r = c.post(f"{base}/incidents/{inc['id']}/approve", json={})
    assert r.status_code == 422 and "issued USD invoice" in r.json()["detail"]
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"]))
    c.post(f"{base}/invoices/{inv['id']}/issue")
    ok = c.post(f"{base}/incidents/{inc['id']}/approve", json={}).json()
    cn = c.get(f"{base}/invoices/{ok['invoice_id']}").json()
    assert cn["kind"] == "credit_note" and cn["status"] == "draft" and cn["total"] == 60 and cn["credits"]["id"] == inv["id"]
    c.post(f"{base}/invoices/{cn['id']}/issue")
    money = c.get(f"{base}/tours/{t['id']}/budget").json()["incidents"][0]
    assert (money["vendor_credit"], money["client_charge"], money["net"]) == (-100, -60, 40)
    bad = mk(c, f"{base}/tours/{t['id']}/incidents", {"title": "x", "carried_by": "client", "client_charge": "10",
                                                        "client_credit": "5", "client_currency": "USD"})
    assert c.post(f"{base}/incidents/{bad['id']}/approve", json={}).status_code == 422
