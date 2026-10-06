"""Home: a layout per person and agency, the staff week and the 30-day cash forecast."""
from datetime import date, timedelta

from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_invoices import invoice_body
from .test_tours import agency, mk


def iso(n: int) -> str:
    return (date.today() + timedelta(days=n)).isoformat()


def test_layout_is_per_person_and_resets_to_default(make_client):
    c, base, ws = agency(make_client)
    assert c.get(f"{base}/dashboard/layout").json() == {"widgets": None}
    body = {"widgets": [{"id": "today", "size": "full"}, {"id": "cash"}, {"id": "today", "size": "half"}]}
    saved = c.put(f"{base}/dashboard/layout", json=body).json()
    assert saved["widgets"] == [{"id": "today", "size": "full"}, {"id": "cash", "size": "half"}]   # duplicates dropped
    assert c.put(f"{base}/dashboard/layout", json={"widgets": [{"id": "Bad id!"}]}).status_code == 422
    # A colleague still has the default.
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    assert staff.get(f"{base}/dashboard/layout").json() == {"widgets": None}
    # An empty Home is allowed and different from "default".
    assert c.put(f"{base}/dashboard/layout", json={"widgets": []}).json() == {"widgets": []}
    assert c.delete(f"{base}/dashboard/layout").status_code == 204
    assert c.get(f"{base}/dashboard/layout").json() == {"widgets": None}


def test_staff_week_and_cash_forecast(make_client):
    c, base, ws = agency(make_client)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    t, hotel, resto, guide = setup_tour(c, base, start=iso(2))
    week = c.get(f"{base}/dashboard/staff-week").json()
    assert len(week) == 1 and week[0]["vendor"]["name"] == "Guide" and week[0]["busy"] == 3
    assert [s["tour_code"] is not None for s in week[0]["days"]] == [False, False, True, True, True, False, False]
    # A second tour the same days: shown as a clash. A coach company is not listed.
    t2 = mk(c, f"{base}/tours", {"start_date": iso(3), "end_date": iso(4), "pax": 3})
    mk(c, f"{base}/tours/{t2['id']}/staff", {"vendor_id": guide["id"], "role": "guide"})
    bus = mk(c, f"{base}/vendors", {"name": "Coaches", "type": "transport"})
    mk(c, f"{base}/tours/{t2['id']}/staff", {"vendor_id": bus["id"], "role": "transport"})
    week = c.get(f"{base}/dashboard/staff-week").json()
    assert [r["vendor"]["name"] for r in week] == ["Guide"]
    assert [len(s["also"]) for s in week[0]["days"]] == [0, 0, 0, 1, 1, 0, 0]

    c.post(f"{base}/tours/{t['id']}/costs/generate")
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    inv = mk(c, f"{base}/invoices", invoice_body(cl["id"], t["id"], issue_date=iso(0), due_date=iso(10)))
    c.post(f"{base}/invoices/{inv['id']}/issue")
    cash = c.get(f"{base}/dashboard/cash").json()
    weeks = {w["label"]: w for w in cash["weeks"]}
    assert weeks["week2"]["money_in"] == 2120.5 and cash["total_in"] == 2120.5
    assert weeks["overdue"]["money_out"] == 300          # the guide is paid 3 days before: already due
    assert cash["total_out"] > 300 and cash["missing_rates"] == []

    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    assert staff.get(f"{base}/dashboard/cash").status_code == 403
    assert staff.get(f"{base}/dashboard/staff-week").status_code == 200
