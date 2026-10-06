"""Jobs: a tour operator manages suppliers and all their prices, finance the money, sales calculations
and clients. Owners and admins do everything; members from before jobs keep what their role gave."""
from .conftest import invite_and_join, signup
from .test_tours import agency, mk


def member(make_client, owner, ws, email, role="staff", jobs=None):
    c = make_client()
    signup(c, email)
    if jobs is None:
        invite_and_join(owner, ws, c, email, role)
    else:
        r = owner.post(f"/api/workspaces/{ws}/invites", json={"email": email, "role": role, "jobs": jobs})
        assert r.status_code == 201, r.text
        token = r.json()["link"].rsplit("/", 1)[1]
        joined = c.post(f"/api/invites/{token}/accept").json()
        assert sorted(joined["jobs"]) == sorted(jobs)
    return c


def test_each_job_does_its_own_work(make_client):
    owner, base, ws = agency(make_client)
    hotel = mk(owner, f"{base}/vendors", {"name": "Hotel", "type": "hotel"})
    t = mk(owner, f"{base}/tours", {"code": "J", "start_date": "2026-11-01", "end_date": "2026-11-03"})
    prices = [{"name": "DBL", "code": "room_DBL", "category": "hotel", "unit": "room_night", "rates": [{"price": "80", "currency": "USD"}]}]
    pay = {"vendor_id": hotel["id"], "currency": "USD", "amount": "10", "paid_on": "2026-11-01"}

    op = member(make_client, owner, ws, "op@a.com", jobs=["operations"])
    assert op.put(f"{base}/vendors/{hotel['id']}/services", json=prices).status_code == 200      # all supplier prices
    assert op.post(f"{base}/vendors", json={"name": "Bus Co", "type": "transport"}).status_code == 201
    assert op.get(f"{base}/tours/{t['id']}/costs").status_code == 200
    assert op.post(f"{base}/tours/{t['id']}/payments", json=pay).status_code == 403             # paying: finance
    assert op.get(f"{base}/tours/{t['id']}/profit").status_code == 403
    me = next(w for w in op.get("/api/auth/me").json()["workspaces"] if w["id"] == ws)
    assert me["jobs"] == ["operations"] and me.get("payment_terms") is None                          # money settings hidden

    fin = member(make_client, owner, ws, "fin@a.com", jobs=["finance"])
    assert fin.post(f"{base}/tours/{t['id']}/payments", json=pay).status_code == 201
    assert fin.get(f"{base}/tours/{t['id']}/profit").status_code == 200
    assert fin.get(f"{base}/vendors/{hotel['id']}/services").status_code == 200                 # reads prices
    assert fin.put(f"{base}/vendors/{hotel['id']}/services", json=prices).status_code == 403     # doesn't set them
    assert fin.post(f"{base}/vendors", json={"name": "X", "type": "hotel"}).status_code == 403

    sales = member(make_client, owner, ws, "sales@a.com", jobs=["sales"])
    assert sales.post(f"{base}/clients", json={"name": "Partner"}).status_code == 201
    assert sales.get(f"{base}/quotes").status_code == 200
    assert sales.get(f"{base}/tours/{t['id']}/costs").status_code == 403
    assert sales.post(f"{base}/vendors", json={"name": "Y", "type": "hotel"}).status_code == 403

    nobody = member(make_client, owner, ws, "staff@a.com")                                       # staff, no job
    assert nobody.get(f"{base}/tours").status_code == 200
    assert nobody.get(f"{base}/vendors/{hotel['id']}/services").status_code == 403


def test_jobs_are_given_and_changed_by_admins(make_client):
    owner, base, ws = agency(make_client)
    old_manager = member(make_client, owner, ws, "m@a.com", role="manager")
    rows = {m["email"]: m for m in owner.get(f"/api/workspaces/{ws}/members").json()}
    # From before jobs: a manager does all three, nothing is stored.
    assert rows["m@a.com"]["jobs"] == ["finance", "operations", "sales"] and not rows["m@a.com"]["jobs_set"]
    mid = rows["m@a.com"]["id"]
    r = owner.patch(f"/api/workspaces/{ws}/members/{mid}", json={"jobs": ["finance"]})
    assert r.json()["jobs"] == ["finance"] and r.json()["jobs_set"] and r.json()["role"] == "manager"
    assert old_manager.put(f"{base}/vendors/x/services", json=[]).status_code == 403
    assert old_manager.patch(f"/api/workspaces/{ws}/members/{mid}", json={"jobs": ["operations"]}).status_code == 403
    assert rows[owner.get("/api/auth/me").json()["user"]["email"]]["jobs"] == ["finance", "operations", "sales"]
