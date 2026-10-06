"""Phone pages for guides and drivers: a private link per person per tour."""
from datetime import date, timedelta

from .test_tours import agency, mk, seed_route


def tour_with_staff(c, base, start=None):
    hotel, resto, kaz, series = seed_route(c, base)
    c.patch(f"{base}/vendors/{hotel['id']}", json={"address": "Rustaveli Ave 37"})
    start = start or (date.today() + timedelta(days=10)).isoformat()
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": start, "pax": 2})
    url = f"{base}/tours/{t['id']}"
    mk(c, f"{url}/participants", {"full_name": "Anna Berg", "room_type": "DBL", "phone": "+46 1", "passport_number": "X123"})
    guide = mk(c, f"{base}/vendors", {"name": "Nino", "type": "guide", "phone": "+995 555"})
    c.patch(base, json={"phone": "+995 32 200"})
    driver = mk(c, f"{base}/vendors", {"name": "Gia", "type": "driver"})
    g = mk(c, f"{url}/staff", {"vendor_id": guide["id"], "role": "guide"})
    d = mk(c, f"{url}/staff", {"vendor_id": driver["id"], "role": "driver", "start_day": 2})
    return t, url, g, d


def test_driver_and_guide_pages(make_client):
    c, base, _ = agency(make_client)
    t, url, g, d = tour_with_staff(c, base)
    link = mk(c, f"{url}/staff/{d['id']}/field-link", {})
    page = c.get(f"/api/field/{link['token']}").json()
    # The driver: only his days, addresses for the map, no people.
    assert page["person"] == "Gia" and page["role"] == "driver" and page["tour_code"] == t["code"]
    assert [x["number"] for x in page["days"]] == [2, 3]
    assert page["days"][0]["hotel"]["address"] == "Rustaveli Ave 37" and page["days"][1]["border"] == "Upper Lars"
    assert page["group"] is None and page["pax"] is None
    # Who to call: the office, and the guide working the same days.
    assert page["team"] == [{"role": "guide", "name": "Nino", "phone": "+995 555", "days": "2–3"}]
    assert page["office_phone"] == "+995 32 200"


    gl = mk(c, f"{url}/staff/{g['id']}/field-link", {})
    gp = c.get(f"/api/field/{gl['token']}").json()
    assert [x["number"] for x in gp["days"]] == [1, 2, 3] and gp["pax"] == 1
    assert gp["group"] == [{"name": "Anna Berg", "room": "DBL", "phone": "+46 1", "notes": ""}]
    assert "X123" not in str(gp)
    assert [(x["name"], x["days"]) for x in gp["team"]] == [("Gia", "2–3")]                                         # never passports

    # The office sees live links (not the token); a new link replaces the old one; switching off works.
    listed = c.get(f"{url}/field-links").json()
    assert {x["staff_id"] for x in listed} == {g["id"], d["id"]} and all(x["token"] is None for x in listed)
    assert next(x for x in listed if x["staff_id"] == d["id"])["last_seen_at"]
    again = mk(c, f"{url}/staff/{d['id']}/field-link", {})
    assert c.get(f"/api/field/{link['token']}").status_code == 404
    assert c.get(f"/api/field/{again['token']}").status_code == 200
    assert c.delete(f"{url}/field-links/{again['id']}").status_code == 204
    assert c.get(f"/api/field/{again['token']}").status_code == 404
    assert c.get("/api/field/made-up-token").status_code == 404


def test_links_end_after_the_tour_and_stay_in_their_agency(make_client):
    c, base, _ = agency(make_client)
    past = (date.today() - timedelta(days=20)).isoformat()
    t, url, g, d = tour_with_staff(c, base, start=past)
    link = mk(c, f"{url}/staff/{g['id']}/field-link", {})
    assert c.get(f"/api/field/{link['token']}").status_code == 404          # ended more than 3 days ago

    other, base2, _ = agency(make_client, "o@o.com", "O")
    assert other.post(f"{base2}/tours/{t['id']}/staff/{g['id']}/field-link").status_code == 404
    assert other.get(f"{base2}/tours/{t['id']}/field-links").status_code == 404


def test_changes_reach_the_team_until_they_say_got_it(make_client):
    c, base, _ = agency(make_client)
    t, url, g, d = tour_with_staff(c, base)
    gl = mk(c, f"{url}/staff/{g['id']}/field-link", {})["token"]
    dl = mk(c, f"{url}/staff/{d['id']}/field-link", {})["token"]
    other = mk(c, f"{base}/vendors", {"name": "Rioni Palace", "type": "hotel", "city": "Tbilisi"})
    tour = c.get(url).json()
    day1 = tour["days"][0]
    c.patch(f"{url}/days/{day1['id']}", json={"hotel_id": other["id"], "schedule": [
        {"id": "x", "kind": "visit", "time": "10:00", "title": "Narikala"}]})
    c.patch(f"{url}/days/{day1['id']}", json={"schedule": [{"id": "x", "kind": "visit", "time": "10:30", "title": "Narikala"}]})
    log = c.get(f"{url}/changes").json()
    texts = [x["text"] for x in log["changes"]]
    assert "Day 1: hotel Pullman Tbilisi → Rioni Palace" in texts and "Day 1: Narikala 10:00 → 10:30" in texts
    # The guide works day 1: sees it; the driver starts on day 2: doesn't.
    assert len(c.get(f"/api/field/{gl}").json()["changes"]) >= 2
    assert c.get(f"/api/field/{dl}").json()["changes"] == []
    team = {x["role"]: x for x in log["team"]}
    assert team["guide"]["unseen"] >= 2 and team["driver"]["unseen"] == 0
    assert c.post(f"/api/field/{gl}/ack").status_code == 200
    assert c.get(f"/api/field/{gl}").json()["changes"] == []
    assert {x["role"]: x for x in c.get(f"{url}/changes").json()["team"]}["guide"]["unseen"] == 0
