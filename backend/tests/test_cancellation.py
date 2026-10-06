"""Cancelling a tour: client scale (agency or the client's own), vendor release terms, one step."""
from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_invoices import invoice_body
from .test_tours import agency, mk


def setup(make_client, with_invoice=True):
    c, base, ws = agency(make_client)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    t, hotel, resto, guide = setup_tour(c, base)      # starts 2026-09-06, 3 days, pax 5
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    c.patch(f"{base}/tours/{t['id']}", json={"client_id": cl["id"]})
    c.patch(f"{base}/vendors/{hotel['id']}", json={"cancel_terms": [{"within_days": 21, "percent": 50}]})
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    mk(c, f"{base}/tours/{t['id']}/payments", {"vendor_id": guide["id"], "currency": "USD", "amount": "300",
                                               "paid_on": "2026-08-01"})
    inv = None
    if with_invoice:
        inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"], lines=[{"description": "Tour", "unit_price": "1000"}]))
        c.post(f"{base}/invoices/{inv['id']}/issue")
        mk(c, f"{base}/invoices/{inv['id']}/payments", {"amount": "400", "received_on": "2026-08-02"})
    return c, base, ws, t, hotel, guide, cl, inv


def test_preview_by_agency_scale_and_vendor_terms(make_client):
    c, base, ws, t, hotel, guide, cl, inv = setup(make_client)
    p = c.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-08-20"}).json()
    # 17 days before arrival: the agency's default "within 30 days → 30%".
    assert p["days_left"] == 17 and p["scale_source"] == "agency" and p["rule"] == {"within_days": 30, "percent": 30}
    assert p["percent"] == 30
    assert [(x["keep"], x["credit"], x["refund"]) for x in p["client"]] == [(300, 700, 100)]   # paid 400, keeps 300
    v = {x["vendor"]["name"]: x for x in p["vendors"]}
    assert (v["Hotel"]["booked"], v["Hotel"]["percent"], v["Hotel"]["penalty"]) == (440, 50, 220)
    assert v["Resto"]["penalty"] == 0                       # no release terms: free
    assert v["Guide"]["owes_back"] == 300                   # paid in advance, no penalty
    # Early enough, nothing is due to anyone.
    early = c.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-05-01"}).json()
    assert early["percent"] == 0 and early["rule"] is None and all(x["penalty"] == 0 for x in early["vendors"])
    # Every percent can be changed before applying.
    o = c.post(f"{base}/tours/{t['id']}/cancellation/preview",
               json={"on_date": "2026-08-20", "client_percent": "50", "vendor_percents": {hotel["id"]: "100"}}).json()
    assert o["client"][0]["keep"] == 500 and o["client"][0]["refund"] == 0
    assert {x["vendor"]["name"]: x["penalty"] for x in o["vendors"]}["Hotel"] == 440


def test_cancel_applies_both_sides(make_client):
    c, base, ws, t, hotel, guide, cl, inv = setup(make_client)
    r = c.post(f"{base}/tours/{t['id']}/cancel", json={"on_date": "2026-08-20", "client_percent": "20", "note": "Visa refused"})
    assert r.status_code == 200, r.text
    out = r.json()
    tour = c.get(f"{base}/tours/{t['id']}").json()
    assert tour["status"] == "cancelled"
    cn = c.get(f"{base}/invoices/{out['documents'][0]}").json()
    assert cn["kind"] == "credit_note" and cn["status"] == "draft" and cn["total"] == 800 and cn["credits"]["id"] == inv["id"]
    c.post(f"{base}/invoices/{cn['id']}/issue")
    after = c.get(f"{base}/invoices/{inv['id']}").json()
    assert after["balance"] == -200 and after["display_status"] == "refund_due"   # paid 400, keep 200
    costs = c.get(f"{base}/tours/{t['id']}/costs").json()
    assert [(x["vendor"]["name"], x["amount"], x["reason"]) for x in costs["lines"]] == [("Hotel", 220, "incident")]
    pay = {p["vendor"]["name"]: p for p in costs["payables"]}
    assert pay["Hotel"]["total"] == 220 and pay["Guide"]["total"] == 0 and pay["Guide"]["balance"] == -300
    inc = c.get(f"{base}/incidents", params={"tour_id": t["id"]}).json()[0]
    assert inc["kind"] == "cancellation" and inc["status"] == "approved" and inc["description"] == "Visa refused"
    assert c.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-08-21"}).status_code == 409


def test_client_own_scale_and_no_invoice_yet(make_client):
    c, base, ws, t, hotel, guide, cl, _ = setup(make_client, with_invoice=False)
    draft = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"], lines=[{"description": "Tour", "unit_price": "500"}]))
    p = c.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-08-20"}).json()
    assert p["client"][0]["new_invoice"] and p["client"][0]["keep"] == 150 and p["drafts_removed"] == ["500.00 USD"]
    # This client's contract: free until 10 days before, then 80%.
    r = c.patch(f"{base}/clients/{cl['id']}", json={"cancellation_scale": [{"within_days": 10, "percent": 80}]})
    assert r.json()["cancellation_scale"] == [{"within_days": 10, "percent": 80}]
    p = c.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-08-30"}).json()
    assert p["scale_source"] == "client" and p["percent"] == 80 and p["client"][0]["keep"] == 400
    out = c.post(f"{base}/tours/{t['id']}/cancel", json={"on_date": "2026-08-30"}).json()
    fee = c.get(f"{base}/invoices/{out['documents'][0]}").json()
    assert fee["kind"] == "invoice" and fee["status"] == "draft" and fee["total"] == 400
    assert c.get(f"{base}/invoices/{draft['id']}").status_code == 404     # the old draft is gone
    # Back to the agency's scale.
    assert c.patch(f"{base}/clients/{cl['id']}", json={"cancellation_scale": None}).json()["cancellation_scale"] is None


def test_limits_and_validation(make_client):
    c, base, ws, t, hotel, guide, cl, inv = setup(make_client)
    manager = make_client()
    signup(manager, "m@a.com")
    invite_and_join(c, ws, manager, "m@a.com", "manager")
    c.patch(f"/api/workspaces/{ws}", json={"incident_approval_limit": "100"})
    p = manager.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-08-20"}).json()
    assert p["needs"] == "admin" and not p["can_apply"]
    assert manager.post(f"{base}/tours/{t['id']}/cancel", json={"on_date": "2026-08-20"}).status_code == 403
    assert c.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-10-01"}).status_code == 409
    bad = [{"within_days": 30, "percent": 10}, {"within_days": 30, "percent": 20}]
    assert c.patch(f"/api/workspaces/{ws}", json={"cancellation_scale": bad}).status_code == 422
    assert c.patch(f"/api/workspaces/{ws}", json={"cancellation_scale": [{"within_days": 5, "percent": 120}]}).status_code == 422
    ok = c.patch(f"/api/workspaces/{ws}", json={"cancellation_scale": [{"within_days": 7, "percent": 100}, {"within_days": 45, "percent": 20}]})
    assert ok.json()["cancellation_scale"][0]["within_days"] == 45        # kept widest first
    assert c.post(f"{base}/tours/{t['id']}/cancellation/preview",
                  json={"on_date": "2026-08-20", "vendor_percents": {"nope": "10"}}).status_code == 422
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    assert staff.post(f"{base}/tours/{t['id']}/cancellation/preview", json={"on_date": "2026-08-20"}).status_code == 403
