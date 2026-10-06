"""Security fixes from the review: login limits, real logout, staff limits, closed-tour locks,
supplier history, spreadsheet formulas, money settings hidden from staff, upload size."""
from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_tours import agency, mk


def test_login_guessing_is_limited_and_logout_ends_the_session(make_client):
    c = make_client()
    signup(c, "owner@a.com", "A")
    bad = make_client()
    codes = [bad.post("/api/auth/login", json={"email": "owner@a.com", "password": f"wrong{i}"}).status_code for i in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429
    assert c.get("/api/auth/me").status_code == 200
    cookie = c.cookies.get("tc_session")
    c.post("/api/auth/logout")
    thief = make_client()
    thief.cookies.set("tc_session", cookie)
    assert thief.get("/api/auth/me").status_code == 401          # a copied cookie stops working


def test_staff_limits(make_client):
    c, base, ws = agency(make_client)
    t, hotel, *_ = setup_tour(c, base)
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    assert staff.patch(f"{base}/tours/{t['id']}", json={"status": "cancelled"}).status_code == 403
    assert staff.patch(f"{base}/tours/{t['id']}", json={"pax": 6}).status_code == 200
    inc = mk(c, f"{base}/tours/{t["id"]}/incidents", {"kind": "other", "title": "Extra dinner", "carried_by": "client",
                                                    "client_charge": "100"})
    assert staff.patch(f"{base}/incidents/{inc['id']}", json={"costs": []}).status_code == 403
    assert staff.patch(f"{base}/incidents/{inc['id']}", json={"carried_by": "client"}).status_code == 403
    me = staff.get(f"{base}").json()
    assert me["payment_terms"] is None and me["cancellation_scale"] is None and me["bill_tolerance_pct"] is None
    assert c.get(f"{base}").json()["payment_terms"] is not None          # the owner sees them


def test_suppliers_with_history_are_archived_not_deleted(make_client):
    c, base, ws = agency(make_client)
    t, hotel, *_ = setup_tour(c, base)
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    assert c.delete(f"{base}/vendors/{hotel['id']}").status_code == 409
    fresh = mk(c, f"{base}/vendors", {"name": "Unused", "type": "hotel"})
    assert c.delete(f"{base}/vendors/{fresh['id']}").status_code == 204


def test_spreadsheet_cells_never_become_formulas():
    from openpyxl import Workbook
    from app.xlsx_safe import defuse
    wb = Workbook()
    wb.active.append(['=HYPERLINK("http://x","y")', "-", "Anna", "+995 555", 5])
    defuse(wb)
    row = [c.value for c in wb.active[1]]
    assert row == ["'=HYPERLINK(\"http://x\",\"y\")", "-", "Anna", "'+995 555", 5]


def test_big_uploads_are_refused_before_reading(make_client):
    c, base, ws = agency(make_client)
    r = c.post(f"{base}/import/participants", content=b"x" * 10, headers={"content-length": str(7 * 1024 * 1024),
                                                                        "content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 413
