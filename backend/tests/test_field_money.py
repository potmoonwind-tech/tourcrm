"""Guide money from the phone page: cash advance, expenses with a receipt photo, extra pay; the
office approves, and the guide's balance says who owes whom."""
import pytest

from .test_field import tour_with_staff
from .test_tours import agency, mk

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 200


@pytest.fixture(autouse=True)
def _uploads(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "upload_dir", str(tmp_path))


def test_guide_reports_and_office_approves(make_client):
    c, base, _ = agency(make_client)
    t, url, g, d = tour_with_staff(c, base)
    token = mk(c, f"{url}/staff/{g['id']}/field-link", {})["token"]
    f = f"/api/field/{token}"

    # The office gives 300 GEL in cash before the tour.
    assert c.post(f"{url}/staff/{g['id']}/advance", json={"amount": "300", "currency": "GEL"}).status_code == 201
    m = c.get(f"{f}/money").json()
    assert m["can_report"] and m["cash"][0]["given"] == "300.00" and m["cash"][0]["in_hand"] == "300.00"

    # The guide pays parking with a receipt photo, and claims extra pay for an extra excursion.
    r = c.post(f"{f}/expenses", data={"kind": "expense", "description": "Parking", "amount": "20", "currency": "gel",
                                      "category": "transport", "day": "2"}, files={"photo": ("r.jpg", JPEG, "image/jpeg")})
    assert r.status_code == 201, r.text
    park = r.json()["entries"][0]
    assert park["has_receipt"] and park["status"] == "pending" and r.json()["cash"][0]["in_hand"] == "280.00"
    assert c.get(f"{f}/expenses/{park['id']}/receipt").content == JPEG
    extra = c.post(f"{f}/expenses", data={"kind": "extra", "description": "Ananuri extra stop", "amount": "50",
                                          "currency": "GEL"}).json()["entries"][0]
    # Not a photo, not a kind, nothing to say: refused.
    assert c.post(f"{f}/expenses", data={"kind": "expense", "description": "x", "amount": "5", "currency": "GEL"},
                  files={"photo": ("a.jpg", b"<html>", "image/jpeg")}).status_code == 422
    assert c.post(f"{f}/expenses", data={"kind": "bonus", "description": "x", "amount": "5", "currency": "GEL"}).status_code == 422

    # Office: sees both, approves parking (a locked cost line for the guide), rejects nothing yet.
    rows = c.get(f"{url}/field-expenses").json()
    assert {x["description"] for x in rows} == {"Parking", "Ananuri extra stop"} and rows[0]["person"] == "Nino"
    assert c.get(f"{url}/field-expenses/{park['id']}/receipt").content == JPEG
    assert c.post(f"{url}/field-expenses/{park['id']}/decide", json={"approve": True}).json()["status"] == "approved"
    c.post(f"{url}/field-expenses/{extra['id']}/decide", json={"approve": True})
    lines = [x for x in c.get(f"{url}/costs").json()["lines"] if x["vendor"] and x["vendor"]["name"] == "Nino"]
    assert {(x["description"], x["unit_price"]) for x in lines} >= {("Paid by guide: Parking", 20.0), ("Extra pay: Ananuri extra stop", 50.0)}
    cash = c.get(f"{f}/money").json()["cash"][0]
    assert (cash["spent"], cash["in_hand"], cash["extra_pay"]) == ("20.00", "280.00", "50.00")
    # Decided: the guide can't delete it any more; the office can reopen (the cost line goes).
    assert c.delete(f"{f}/expenses/{park['id']}").status_code == 409
    assert c.post(f"{url}/field-expenses/{park['id']}/reopen").json()["status"] == "pending"
    assert not any(x["description"] == "Paid by guide: Parking" for x in c.get(f"{url}/costs").json()["lines"])
    assert c.delete(f"{f}/expenses/{park['id']}").status_code == 200


def test_drivers_and_others_cannot(make_client):
    c, base, ws = agency(make_client)
    t, url, g, d = tour_with_staff(c, base)
    driver = mk(c, f"{url}/staff/{d['id']}/field-link", {})["token"]
    assert c.post(f"/api/field/{driver}/expenses", data={"kind": "expense", "description": "Fuel", "amount": "50",
                                                         "currency": "GEL"}).status_code == 403
    assert c.get(f"/api/field/{driver}/money").json()["can_report"] is False
    # Another agency can't read or approve this tour's reports.
    other, base2, _ = agency(make_client, "o@o.com", "O")
    assert other.get(f"{base2}/tours/{t['id']}/field-expenses").status_code == 404
    assert other.post(f"{base2}/tours/{t['id']}/staff/{g['id']}/advance", json={"amount": "1", "currency": "GEL"}).status_code == 404
