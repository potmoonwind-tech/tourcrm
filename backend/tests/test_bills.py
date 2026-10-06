"""Vendor bills matched against expected costs: tolerance, accept, dispute, close."""
from .test_finance import setup_tour
from .test_tours import agency, mk


def tour_with_costs(c, base):
    t, hotel, resto, guide = setup_tour(c, base)          # hotel 2 nights: 2 DBL x 80 + 1 SGL x 60 = 440 USD
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    return t, hotel, guide


def group(out, vendor_id, cur="USD"):
    return next(p for p in out["payables"] if p["vendor"]["id"] == vendor_id and p["currency"] == cur)


def test_bills_match_within_tolerance(make_client):
    c, base, ws = agency(make_client)
    t, hotel, guide = tour_with_costs(c, base)
    url = f"{base}/tours/{t['id']}/bills"
    out = c.get(url).json()
    assert group(out, hotel["id"])["bill_state"] == "no_bill" and out["tolerance_pct"] == 1
    out = mk(c, url, {"vendor_id": hotel["id"], "number": "H-77", "bill_date": "2026-09-08", "due_date": "2026-09-30",
                      "currency": "USD", "amount": "443.50"})
    g = group(out, hotel["id"])
    assert (g["billed"], g["bill_state"], g["bill_difference"]) == (443.5, "matched", 3.5)   # within 1% (4.40)
    assert g["due_date"] == "2026-09-30"                                                    # the bill's due date wins
    # Split bills add up.
    second = mk(c, url, {"vendor_id": hotel["id"], "number": "H-78", "bill_date": "2026-09-09", "currency": "USD", "amount": "50"})
    assert group(second, hotel["id"])["bill_state"] == "difference"


def test_accept_difference_adds_an_adjustment(make_client):
    c, base, ws = agency(make_client)
    t, hotel, guide = tour_with_costs(c, base)
    url = f"{base}/tours/{t['id']}/bills"
    mk(c, url, {"vendor_id": hotel["id"], "number": "H-90", "bill_date": "2026-09-08", "currency": "USD", "amount": "500"})
    out = c.post(f"{url}/accept", json={"vendor_id": hotel["id"], "currency": "USD", "note": "city tax"}).json()
    g = group(out, hotel["id"])
    assert g["total"] == 500 and g["bill_state"] == "matched" and g["bill_difference"] == 0
    adj = [x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["reason"] == "bill_adjustment"]
    assert [(x["description"], x["amount"], x["notes"]) for x in adj] == [("Vendor invoice H-90: difference", 60, "city tax")]
    assert c.post(f"{url}/accept", json={"vendor_id": hotel["id"], "currency": "USD"}).status_code == 409   # nothing left
    # A bill lower than expected gives a negative adjustment.
    mk(c, url, {"vendor_id": guide["id"], "bill_date": "2026-09-09", "currency": "USD", "amount": "250"})
    out = c.post(f"{url}/accept", json={"vendor_id": guide["id"], "currency": "USD"}).json()
    assert group(out, guide["id"])["total"] == 250


def test_dispute_blocks_closing(make_client):
    c, base, ws = agency(make_client)
    t, hotel, guide = tour_with_costs(c, base)
    url = f"{base}/tours/{t['id']}/bills"
    bill = mk(c, url, {"vendor_id": hotel["id"], "number": "H-1", "bill_date": "2026-09-08", "currency": "USD",
                       "amount": "900"})["bills"][0]
    assert c.post(f"{base}/bills/{bill['id']}/dispute", json={"note": ""}).status_code == 422
    out = c.post(f"{base}/bills/{bill['id']}/dispute", json={"note": "billed 4 nights, we stayed 2"}).json()
    assert group(out, hotel["id"])["bill_state"] == "disputed" and out["bills"][0]["dispute_note"].startswith("billed 4")
    assert c.post(f"{url}/accept", json={"vendor_id": hotel["id"], "currency": "USD"}).status_code == 409
    chk = {i["key"]: i for i in c.get(f"{base}/tours/{t['id']}/close-check").json()["items"]}
    assert not chk["bills_disputed"]["ok"] and chk["bills_disputed"]["blocking"]
    flagged = c.get(f"{base}/payments/schedule", params={"status": "bills"}).json()["items"]
    assert [(x["vendor"]["name"], x["bill_state"]) for x in flagged] == [("Hotel", "disputed")]
    # The vendor sends a corrected amount: enter it, resolve.
    c.patch(f"{base}/bills/{bill['id']}", json={"amount": "440"})
    out = c.post(f"{base}/bills/{bill['id']}/resolve").json()
    assert group(out, hotel["id"])["bill_state"] == "matched"


def test_tolerance_setting_and_scoping(make_client):
    c, base, ws = agency(make_client)
    t, hotel, guide = tour_with_costs(c, base)
    url = f"{base}/tours/{t['id']}/bills"
    mk(c, url, {"vendor_id": hotel["id"], "bill_date": "2026-09-08", "currency": "USD", "amount": "460"})
    assert group(c.get(url).json(), hotel["id"])["bill_state"] == "difference"
    assert c.patch(f"/api/workspaces/{ws}", json={"bill_tolerance_pct": "5"}).json()["bill_tolerance_pct"] == 5
    assert group(c.get(url).json(), hotel["id"])["bill_state"] == "matched"        # 20 ≤ 5% of 440
    b, base_b, _ = agency(make_client, "b@b.com", "B")
    assert b.get(f"{base_b}/tours/{t['id']}/bills").status_code == 404
    theirs = mk(b, f"{base_b}/vendors", {"name": "Theirs", "type": "hotel"})
    assert c.post(url, json={"vendor_id": theirs["id"], "bill_date": "2026-09-08", "currency": "USD",
                             "amount": "1"}).status_code == 422
