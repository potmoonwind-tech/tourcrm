"""Workspace isolation and role rules. These are the guarantees every later
feature (tours, payments, finance) relies on."""
from .conftest import invite_and_join, signup


def two_agencies(make_client):
    a, b = make_client(), make_client()
    ws_a = signup(a, "a@agency-a.com", "Agency A")["workspaces"][0]["id"]
    ws_b = signup(b, "b@agency-b.com", "Agency B")["workspaces"][0]["id"]
    return a, ws_a, b, ws_b


def test_cannot_see_or_touch_other_workspace(make_client):
    a, ws_a, b, ws_b = two_agencies(make_client)
    # Every workspace route answers 404 to outsiders, exactly as for a missing id.
    assert b.get(f"/api/workspaces/{ws_a}").status_code == 404
    assert b.get(f"/api/workspaces/{ws_a}/members").status_code == 404
    assert b.get(f"/api/workspaces/{ws_a}/invites").status_code == 404
    assert b.patch(f"/api/workspaces/{ws_a}", json={"name": "pwned"}).status_code == 404
    assert b.delete(f"/api/workspaces/{ws_a}").status_code == 404
    assert b.post(f"/api/workspaces/{ws_a}/invites", json={"email": "x@x.com"}).status_code == 404
    assert a.get(f"/api/workspaces/{ws_a}").json()["name"] == "Agency A"


def test_cannot_act_on_member_of_other_workspace_via_own(make_client):
    a, ws_a, b, ws_b = two_agencies(make_client)
    member_a = a.get(f"/api/workspaces/{ws_a}/members").json()[0]["id"]
    # B is owner of B, but A's membership id must not resolve inside B.
    assert b.patch(f"/api/workspaces/{ws_b}/members/{member_a}", json={"role": "guide"}).status_code == 404
    assert b.delete(f"/api/workspaces/{ws_b}/members/{member_a}").status_code == 404


def test_unauthenticated_gets_401(make_client):
    _, ws_a, _, _ = two_agencies(make_client)
    assert make_client().get(f"/api/workspaces/{ws_a}").status_code == 401


def test_invite_flow_and_roles(make_client):
    owner = make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    staff = make_client()
    signup(staff, "staff@a.com")
    joined = invite_and_join(owner, ws, staff, "staff@a.com", "staff")
    assert joined["role"] == "staff"
    assert [w["id"] for w in staff.get("/api/auth/me").json()["workspaces"]] == [ws]

    # staff can see the team but not manage it
    assert staff.get(f"/api/workspaces/{ws}/members").status_code == 200
    assert staff.get(f"/api/workspaces/{ws}/invites").status_code == 403
    assert staff.post(f"/api/workspaces/{ws}/invites", json={"email": "q@a.com"}).status_code == 403
    assert staff.patch(f"/api/workspaces/{ws}", json={"name": "x"}).status_code == 403


def test_guide_cannot_list_team(make_client):
    owner, guide = make_client(), make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    signup(guide, "g@a.com")
    invite_and_join(owner, ws, guide, "g@a.com", "guide")
    assert guide.get(f"/api/workspaces/{ws}/members").status_code == 403


def test_invite_must_be_accepted_by_invited_email(make_client):
    owner, other = make_client(), make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    signup(other, "intruder@b.com")
    link = owner.post(f"/api/workspaces/{ws}/invites", json={"email": "friend@a.com"}).json()["link"]
    token = link.rsplit("/", 1)[1]
    assert other.post(f"/api/invites/{token}/accept").status_code == 403
    assert make_client().get(f"/api/invites/{token}").json()["status"] == "pending"


def test_invite_single_use(make_client):
    owner, m = make_client(), make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    signup(m, "m@a.com")
    link = owner.post(f"/api/workspaces/{ws}/invites", json={"email": "m@a.com"}).json()["link"]
    token = link.rsplit("/", 1)[1]
    assert m.post(f"/api/invites/{token}/accept").status_code == 200
    assert m.post(f"/api/invites/{token}/accept").status_code == 410


def test_admin_cannot_create_or_demote_owners(make_client):
    owner, admin = make_client(), make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    signup(admin, "admin@a.com")
    invite_and_join(owner, ws, admin, "admin@a.com", "admin")
    members = {m["email"]: m["id"] for m in owner.get(f"/api/workspaces/{ws}/members").json()}

    assert admin.post(f"/api/workspaces/{ws}/invites", json={"email": "o@a.com", "role": "owner"}).status_code == 403
    assert admin.patch(f"/api/workspaces/{ws}/members/{members['admin@a.com']}", json={"role": "owner"}).status_code == 403
    assert admin.patch(f"/api/workspaces/{ws}/members/{members['boss@a.com']}", json={"role": "staff"}).status_code == 403
    assert admin.delete(f"/api/workspaces/{ws}/members/{members['boss@a.com']}").status_code == 403
    assert admin.delete(f"/api/workspaces/{ws}").status_code == 403


def test_last_owner_is_protected(make_client):
    owner = make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    me = owner.get(f"/api/workspaces/{ws}/members").json()[0]["id"]
    assert owner.patch(f"/api/workspaces/{ws}/members/{me}", json={"role": "admin"}).status_code == 400
    assert owner.delete(f"/api/workspaces/{ws}/members/{me}").status_code == 400


def test_member_can_leave_and_owner_can_delete(make_client):
    owner, staff = make_client(), make_client()
    ws = signup(owner, "boss@a.com", "A")["workspaces"][0]["id"]
    signup(staff, "s@a.com")
    invite_and_join(owner, ws, staff, "s@a.com", "staff")
    my_id = next(m["id"] for m in staff.get(f"/api/workspaces/{ws}/members").json() if m["email"] == "s@a.com")
    assert staff.delete(f"/api/workspaces/{ws}/members/{my_id}").status_code == 204
    assert staff.get(f"/api/workspaces/{ws}").status_code == 404

    assert owner.delete(f"/api/workspaces/{ws}").status_code == 204
    assert owner.get("/api/auth/me").json()["workspaces"] == []


def test_user_in_two_workspaces_sees_both(make_client):
    a, ws_a, b, ws_b = two_agencies(make_client)
    guide = make_client()
    signup(guide, "guide@free.com")
    invite_and_join(a, ws_a, guide, "guide@free.com", "guide")
    invite_and_join(b, ws_b, guide, "guide@free.com", "guide")
    assert {w["id"] for w in guide.get("/api/auth/me").json()["workspaces"]} == {ws_a, ws_b}
