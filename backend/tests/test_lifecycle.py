"""Tour lifecycle: phases, the close checklist, closing (final + locked) and reopening."""
from datetime import date, timedelta

from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_invoices import invoice_body
from .test_tours import agency, mk

PAST = (date.today() - timedelta(days=30)).isoformat()


def settled_tour(c, base):
    """A tour that ended, invoiced and paid, every vendor paid."""
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    t, *_ = setup_tour(c, base, start=PAST)
    url = f"{base}/tours/{t['id']}"
    c.post(f"{url}/costs/generate")
    for p in c.get(f"{url}/costs").json()["payables"]:
        mk(c, f"{url}/payments", {"vendor_id": p["vendor"]["id"], "currency": p["currency"], "amount": str(p["balance"]),
                                  "paid_on": PAST})
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    c.patch(url, json={"client_id": cl["id"]})
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"], lines=[{"description": "Tour", "unit_price": "2000"}]))
    c.post(f"{base}/invoices/{inv['id']}/issue")
    mk(c, f"{base}/invoices/{inv['id']}/payments", {"amount": "2000", "received_on": PAST})
    return t, url, inv


def test_close_a_settled_tour_and_it_is_locked(make_client):
    c, base, ws = agency(make_client)
    t, url, inv = settled_tour(c, base)
    assert c.get(url).json()["phase"] == "settling"
    chk = c.get(f"{url}/close-check").json()
    assert chk["ready"] and all(i["ok"] for i in chk["items"] if i["blocking"]), chk["items"]
    closed = c.post(f"{url}/close", json={"note": "all good"}).json()
    assert closed["phase"] == "closed" and closed["final_revenue"] == 2000 and closed["closed_by"] == "boss"
    assert closed["final_cost"] == chk["cost"]
    assert c.get(url).json()["phase"] == "closed"
    # Locked: nothing about it changes...
    locked = [
        c.patch(url, json={"notes": "late edit"}),
        c.post(f"{url}/costs", json={"service_date": PAST, "unit_price": "1", "currency": "USD"}),
        c.post(f"{url}/costs/generate"),
        c.post(f"{url}/participants", json={"full_name": "Late Guest"}),
        c.post(f"{url}/incidents", json={"title": "x"}),
        c.post(f"{base}/invoices/{inv['id']}/credit-note", json={}),
        c.delete(url),
    ]
    assert [r.status_code for r in locked] == [409] * len(locked), [r.text for r in locked]
    assert "closed" in locked[0].json()["detail"]
    # ...but everything still reads.
    assert c.get(f"{url}/costs").status_code == 200 and c.get(f"{url}/budget").status_code == 200
    assert c.post(f"{url}/close", json={}).status_code == 409


def test_reopen_needs_admin_and_a_reason(make_client):
    c, base, ws = agency(make_client)
    t, url, _ = settled_tour(c, base)
    c.post(f"{url}/close", json={})
    manager = make_client()
    signup(manager, "m@a.com")
    invite_and_join(c, ws, manager, "m@a.com", "manager")
    assert manager.post(f"{url}/reopen", json={"note": "fix"}).status_code == 403
    assert c.post(f"{url}/reopen", json={"note": ""}).status_code == 422
    r = c.post(f"{url}/reopen", json={"note": "hotel sent a late invoice"}).json()
    assert r["phase"] == "settling" and r["close_note"] == "Reopened: hotel sent a late invoice" and r["final_revenue"] is None
    assert c.patch(url, json={"notes": "now it works"}).status_code == 200


def test_checklist_names_what_is_open(make_client):
    c, base, ws = agency(make_client)
    soon = (date.today() + timedelta(days=10)).isoformat()
    future = mk(c, f"{base}/tours", {"code": "FUT", "start_date": soon, "end_date": soon})
    t, *_ = setup_tour(c, base, start=PAST)
    url = f"{base}/tours/{t['id']}"
    c.post(f"{url}/costs/generate")
    mk(c, f"{url}/incidents", {"title": "Lost luggage"})
    chk = {i["key"]: i for i in c.get(f"{url}/close-check").json()["items"]}
    assert chk["ended"]["ok"] and not chk["invoiced"]["ok"] and not chk["incidents"]["ok"]
    assert not chk["vendors_settled"]["ok"] and chk["vendors_settled"]["count"] == 3 and "USD" in chk["vendors_settled"]["detail"]
    assert chk["incidents"]["count"] == 1
    assert not chk["rates"]["ok"]                     # GEL meals, no rate set
    r = c.post(f"{url}/close", json={})
    assert r.status_code == 409 and "vendors_settled" in r.json()["detail"]
    todo = {x["code"]: x["open_items"] for x in c.get(f"{base}/tours-to-close").json()}
    assert "incidents" in todo[t["code"]] and future["code"] not in todo
    # An admin/owner can close anyway, writing the rest off, with a reason.
    manager = make_client()
    signup(manager, "m@a.com")
    invite_and_join(c, ws, manager, "m@a.com", "manager")
    assert manager.post(f"{url}/close", json={"force": True, "note": "x"}).status_code == 403
    assert c.post(f"{url}/close", json={"force": True}).status_code == 422
    ok = c.post(f"{url}/close", json={"force": True, "note": "client went bankrupt; written off"}).json()
    assert ok["phase"] == "closed" and ok["close_note"].startswith("client went bankrupt")
    assert c.post(f"{base}/tours/{future['id']}/close", json={"force": True, "note": "x"}).status_code == 409


def test_phases(make_client):
    c, base, _ = agency(make_client)
    soon = (date.today() + timedelta(days=20)).isoformat()
    now = date.today().isoformat()
    q = mk(c, f"{base}/tours", {"code": "Q", "start_date": soon, "end_date": soon, "status": "inquiry"})
    f = mk(c, f"{base}/tours", {"code": "F", "start_date": soon, "end_date": soon})
    o = mk(c, f"{base}/tours", {"code": "O", "start_date": now, "end_date": now})
    x = mk(c, f"{base}/tours", {"code": "X", "start_date": soon, "end_date": soon, "status": "cancelled"})
    assert [q["phase"], f["phase"], o["phase"], x["phase"]] == ["inquiry", "confirmed", "operating", "cancelled"]
