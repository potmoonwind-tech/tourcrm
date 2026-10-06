"""Incidents: report, add money, approve (with a limit), and the effects on both sides."""
from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_tours import agency, mk


def setup(make_client):
    owner, base, ws = agency(make_client)
    owner.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    t, hotel, resto, guide = setup_tour(owner, base)
    client = mk(owner, f"{base}/clients", {"name": "Orient Travel"})
    owner.patch(f"{base}/tours/{t['id']}", json={"client_id": client["id"]})
    return owner, base, ws, t, hotel, guide


def member(make_client, owner, ws, email, role):
    c = make_client()
    signup(c, email)
    invite_and_join(owner, ws, c, email, role)
    return c


def test_staff_report_managers_add_money(make_client):
    owner, base, ws, t, hotel, _ = setup(make_client)
    staff = member(make_client, owner, ws, "s@a.com", "staff")
    r = staff.post(f"{base}/tours/{t['id']}/incidents", json={"title": "Flight delayed, extra night", "day": 3, "kind": "delay"})
    assert r.status_code == 201
    inc = r.json()
    assert inc["status"] == "open" and inc["costs"] is None and inc["reported_by"] == "s"
    assert inc["date"] == "2026-09-08"
    assert staff.patch(f"{base}/incidents/{inc['id']}", json={"client_charge": "100"}).status_code == 403
    assert staff.post(f"{base}/incidents/{inc['id']}/approve", json={}).status_code == 403
    mine = owner.patch(f"{base}/incidents/{inc['id']}", json={
        "carried_by": "client", "client_charge": "220", "client_currency": "USD",
        "costs": [{"vendor_id": hotel["id"], "category": "hotel", "description": "Extra night 2 DBL", "quantity": "2",
                   "unit_price": "80", "currency": "USD"}]}).json()
    assert mine["costs"][0]["amount"] == 160 and mine["total_base"] == 220 and mine["can_decide"]
    assert staff.get(f"{base}/incidents").json()[0]["client_charge"] is None      # staff never see amounts


def test_approve_creates_costs_invoice_and_shows_in_budget(make_client):
    owner, base, ws, t, hotel, _ = setup(make_client)
    inc = mk(owner, f"{base}/tours/{t['id']}/incidents", {
        "title": "Extra night", "day": 3, "carried_by": "client", "client_charge": "220", "client_currency": "USD",
        "costs": [{"vendor_id": hotel["id"], "category": "hotel", "description": "2 DBL", "quantity": "2",
                   "unit_price": "80", "currency": "USD"}]})
    ok = owner.post(f"{base}/incidents/{inc['id']}/approve", json={"note": "client agreed by email"}).json()
    assert ok["status"] == "approved" and ok["decided_by"] == "boss" and ok["invoice_id"]
    lines = owner.get(f"{base}/tours/{t['id']}/costs").json()["lines"]
    extra = [x for x in lines if x["incident_id"] == inc["id"]]
    assert [(x["description"], x["amount"], x["reason"], x["service_date"]) for x in extra] == \
        [("Extra night: 2 DBL", 160, "incident", "2026-09-08")]
    invoice = owner.get(f"{base}/invoices/{ok['invoice_id']}").json()
    assert invoice["status"] == "draft" and invoice["client"]["name"] == "Orient Travel" and invoice["total"] == 220
    # Regenerating itinerary costs leaves incident lines alone.
    owner.post(f"{base}/tours/{t['id']}/costs/generate")
    assert len([x for x in owner.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["incident_id"]]) == 1
    b = owner.get(f"{base}/tours/{t['id']}/budget").json()
    assert b["totals"]["incidents"] == 160
    assert all(not x["incident_id"] for x in b["unbudgeted"])
    owner.post(f"{base}/invoices/{ok['invoice_id']}/issue")
    b = owner.get(f"{base}/tours/{t['id']}/budget").json()
    assert [(i["cost"], i["client_charge"], i["net"]) for i in b["incidents"]] == [(160, 220, 60)]
    # Once its invoice is issued, the decision can't simply be undone.
    assert owner.post(f"{base}/incidents/{inc['id']}/reopen").status_code == 409
    assert owner.post(f"{base}/incidents/{inc['id']}/settle").json()["status"] == "settled"


def test_vendor_carries_it_with_a_claim(make_client):
    owner, base, ws, t, hotel, guide = setup(make_client)
    backup = mk(owner, f"{base}/vendors", {"name": "Backup Bus", "type": "transport"})
    inc = mk(owner, f"{base}/tours/{t['id']}/incidents", {
        "title": "Bus broke down", "day": 2, "kind": "vendor_failure", "carried_by": "vendor", "vendor_id": guide["id"],
        "vendor_claim": "50", "claim_currency": "USD",
        "costs": [{"vendor_id": backup["id"], "category": "transport", "description": "Replacement bus",
                   "unit_price": "120", "currency": "USD"}]})
    owner.post(f"{base}/tours/{t['id']}/costs/generate")
    before = {p["vendor"]["name"]: p["total"] for p in owner.get(f"{base}/tours/{t['id']}/costs").json()["payables"]}
    assert owner.post(f"{base}/incidents/{inc['id']}/approve", json={}).status_code == 200
    after = {p["vendor"]["name"]: p["total"] for p in owner.get(f"{base}/tours/{t['id']}/costs").json()["payables"]}
    assert after["Guide"] == before["Guide"] - 50 and after["Backup Bus"] == 120
    money = owner.get(f"{base}/tours/{t['id']}/budget").json()["incidents"][0]
    assert (money["cost"], money["vendor_credit"], money["net"]) == (120, -50, -70)
    # Reopening removes what approving created (nothing paid or issued yet).
    assert owner.post(f"{base}/incidents/{inc['id']}/reopen").json()["status"] == "open"
    assert not [x for x in owner.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["incident_id"]]


def test_approval_limit(make_client):
    owner, base, ws, t, hotel, _ = setup(make_client)
    manager = member(make_client, owner, ws, "m@a.com", "manager")
    assert manager.patch(f"/api/workspaces/{ws}", json={"incident_approval_limit": "100"}).status_code == 403
    r = owner.patch(f"/api/workspaces/{ws}", json={"incident_approval_limit": "100"})
    assert r.json()["incident_approval_limit"] == 100
    big = mk(manager, f"{base}/tours/{t['id']}/incidents", {"title": "Penalty", "costs": [
        {"vendor_id": hotel["id"], "description": "Late cancellation", "unit_price": "1000", "currency": "GEL"}]})
    assert big["needs"] == "admin" and big["total_base"] == 370 and not big["can_decide"]
    r = manager.post(f"{base}/incidents/{big['id']}/approve", json={})
    assert r.status_code == 403 and "limit" in r.json()["detail"]
    small = mk(manager, f"{base}/tours/{t['id']}/incidents", {"title": "Water", "costs": [
        {"description": "Water", "unit_price": "50", "currency": "GEL"}]})
    assert small["needs"] == "manager"
    assert manager.post(f"{base}/incidents/{small['id']}/approve", json={}).status_code == 200
    assert owner.post(f"{base}/incidents/{big['id']}/approve", json={}).status_code == 200
    r = owner.patch(f"/api/workspaces/{ws}", json={"incident_approval_limit": None})
    assert r.json()["incident_approval_limit"] is None


def test_what_approving_needs_and_scoping(make_client):
    owner, base, ws, t, hotel, _ = setup(make_client)
    inc = mk(owner, f"{base}/tours/{t['id']}/incidents", {"title": "Extra dinner", "carried_by": "client"})
    r = owner.post(f"{base}/incidents/{inc['id']}/approve", json={})
    assert r.status_code == 422 and "charge" in r.json()["detail"]
    owner.patch(f"{base}/incidents/{inc['id']}", json={"carried_by": "vendor"})
    assert owner.post(f"{base}/incidents/{inc['id']}/approve", json={}).status_code == 422
    assert owner.post(f"{base}/tours/{t['id']}/incidents", json={"title": "x", "day": 9}).status_code == 422
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    other_vendor = mk(b, f"{base_b}/vendors", {"name": "Theirs", "type": "hotel"})
    assert owner.patch(f"{base}/incidents/{inc['id']}", json={"vendor_id": other_vendor["id"]}).status_code == 422
    assert b.post(f"{base_b}/incidents/{inc['id']}/reject", json={}).status_code == 404
    assert b.post(f"{base_b}/tours/{t['id']}/incidents", json={"title": "x"}).status_code == 404
    rej = owner.post(f"{base}/incidents/{inc['id']}/reject", json={"note": "not our problem"}).json()
    assert rej["status"] == "rejected"
    assert owner.patch(f"{base}/incidents/{inc['id']}", json={"title": "y"}).status_code == 409
    assert owner.delete(f"{base}/incidents/{inc['id']}").status_code == 204
