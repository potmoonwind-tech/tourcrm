"""A tour copied as a draft; a change taken back from the tour's history."""
from .test_tours import agency


def _tour_with_a_plan(c, base):
    hotel = c.post(f"{base}/vendors", json={"name": "Old Town Hotel", "type": "hotel", "city": "Tbilisi"}).json()
    guide = c.post(f"{base}/vendors", json={"name": "Nino", "type": "guide"}).json()
    t = c.post(f"{base}/tours", json={"code": "GC-1102", "start_date": "2026-11-02", "end_date": "2026-11-04", "pax": 12,
                                      "notes": "Group from Shanghai"}).json()
    days = [{"city": "Tbilisi", "hotel_id": hotel["id"], "stops": ["Mtskheta"],
             "flights": [{"direction": "arrival", "number": "CA123", "time": "09:15", "airport": "TBS"}]},
            {"city": "Tbilisi", "hotel_id": hotel["id"]}, {"city": "Tbilisi"}]
    c.put(f"{base}/tours/{t['id']}/itinerary", json={"days": days}).raise_for_status()
    c.post(f"{base}/tours/{t['id']}/staff", json={"vendor_id": guide["id"], "role": "guide"}).raise_for_status()
    c.post(f"{base}/tours/{t['id']}/participants", json={"full_name": "Test Traveller"}).raise_for_status()
    return t, hotel


def test_a_copy_is_a_draft_on_new_dates_with_the_plan_and_nothing_booked(make_client):
    c, base, _ = agency(make_client)
    t, hotel = _tour_with_a_plan(c, base)
    r = c.post(f"{base}/tours/{t['id']}/duplicate", json={"start_date": "2026-12-07", "pax": 20})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["status"] == "draft" and d["code"] != "GC-1102" and (d["start_date"], d["end_date"]) == ("2026-12-07", "2026-12-09")
    assert d["pax"] == 20 and d["notes"] == "Group from Shanghai"
    day1 = d["days"][0]
    assert day1["date"] == "2026-12-07" and day1["hotel"]["id"] == hotel["id"] and day1["stops"] == ["Mtskheta"]
    assert (day1["flights"][0]["number"], day1["flights"][0]["time"]) == ("CA123", "09:15")    # the same weekly flight
    assert d["staff"] == [] and c.get(f"{base}/tours/{d['id']}/participants").json() == []
    # A draft books nothing, and isn't on the timeline
    assert c.get(f"{base}/tours/{d['id']}/bookings").json()["bookings"] == []
    rows = c.get(f"{base}/timeline", params={"date_from": "2026-12-01", "date_to": "2026-12-31"}).json()
    assert rows == []
    # Sent as an inquiry: now it's a real tour (bookings to make, on the timeline)
    assert c.patch(f"{base}/tours/{d['id']}", json={"status": "inquiry"}).status_code == 200
    assert c.get(f"{base}/tours/{d['id']}/bookings").json()["bookings"]
    assert len(c.get(f"{base}/timeline", params={"date_from": "2026-12-01", "date_to": "2026-12-31"}).json()) == 1
    assert c.patch(f"{base}/tours/{d['id']}", json={"status": "draft"}).status_code == 422       # no way back


def test_a_copy_can_keep_the_team_and_the_travellers(make_client):
    c, base, _ = agency(make_client)
    t, _ = _tour_with_a_plan(c, base)
    d = c.post(f"{base}/tours/{t['id']}/duplicate", json={"start_date": "2027-01-04", "code": "GC-0104", "staff": True, "people": True}).json()
    assert d["code"] == "GC-0104" and [s["vendor"]["name"] for s in d["staff"]] == ["Nino"]
    assert [p["full_name"] for p in c.get(f"{base}/tours/{d['id']}/participants").json()] == ["Test Traveller"]
    assert c.post(f"{base}/tours/{t['id']}/duplicate", json={"start_date": "2027-01-04", "code": "GC-0104"}).status_code == 409


def test_a_hotel_removed_by_mistake_comes_back_from_the_history(make_client):
    c, base, _ = agency(make_client)
    t, hotel = _tour_with_a_plan(c, base)
    full = c.get(f"{base}/tours/{t['id']}").json()
    day2 = full["days"][1]
    c.patch(f"{base}/tours/{t['id']}/days/{day2['id']}", json={"hotel_id": None}).raise_for_status()
    log = c.get(f"{base}/tours/{t['id']}/changes").json()["changes"]
    gone = next(x for x in log if x["kind"] == "hotel" and x["day"] == 2)
    assert "Old Town Hotel → —" in gone["text"] and gone["can_undo"] and gone["by"]
    back = c.post(f"{base}/tours/{t['id']}/changes/{gone['id']}/undo")
    assert back.status_code == 200 and back.json()["days"][1]["hotel"]["id"] == hotel["id"]
    # Taken back once: the old line can't be taken back again (the day isn't as it left it any more)
    log = c.get(f"{base}/tours/{t['id']}/changes").json()["changes"]
    assert not next(x for x in log if x["id"] == gone["id"])["can_undo"]
    assert c.post(f"{base}/tours/{t['id']}/changes/{gone['id']}/undo").status_code == 409
    assert log[0]["kind"] == "hotel" and "— → Old Town Hotel" in log[0]["text"]
