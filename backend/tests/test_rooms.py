"""Rooms by night: the block each hotel needs across all departures."""
from datetime import date, timedelta

from .test_tours import agency, mk

TODAY = date.today()


def d(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


def test_rooms_add_up_across_groups(make_client):
    c, base, _ = agency(make_client)
    inn = mk(c, f"{base}/vendors", {"name": "Gudauri Inn", "type": "hotel", "city": "Gudauri"})
    other = mk(c, f"{base}/vendors", {"name": "Tbilisi Hotel", "type": "hotel", "city": "Tbilisi"})
    route = mk(c, f"{base}/series", {"code": "R", "days": [
        {"city": "Gudauri", "hotel_id": inn["id"]}, {"city": "Gudauri", "hotel_id": inn["id"]},
        {"city": "Tbilisi", "hotel_id": other["id"]}, {"city": "Tbilisi"}]})
    a = mk(c, f"{base}/tours", {"code": "A", "series_id": route["id"], "start_date": d(10), "pax": 20, "rooms": "9 DBL + 2 SGL"})
    mk(c, f"{base}/tours", {"code": "B", "series_id": route["id"], "start_date": d(11), "pax": 15})          # rooms unknown
    mk(c, f"{base}/tours", {"code": "C", "series_id": route["id"], "start_date": d(11), "pax": 4, "status": "inquiry",
                            "rooms": "2 TWN"})
    x = mk(c, f"{base}/tours", {"code": "X", "series_id": route["id"], "start_date": d(10), "pax": 30, "rooms": "15 DBL"})
    c.patch(f"{base}/tours/{x['id']}", json={"status": "cancelled"})

    r = c.get(f"{base}/rooms-by-night?date_from={d(0)}&date_to={d(30)}")
    assert r.status_code == 200, r.text
    hotels = {h["vendor"]["name"]: h for h in r.json()["hotels"]}
    inn_ = hotels["Gudauri Inn"]
    assert inn_["city"] == "Gudauri"
    nights = {n["date"]: n for n in inn_["nights"]}
    # Night 1: only A. Night 2: A + B (guessed 8 from 15 pax) + C maybe.
    assert nights[d(10)]["rooms"] == 11 and nights[d(10)]["groups"] == 1 and not nights[d(10)]["guessed"]
    assert nights[d(11)]["rooms"] == 19 and nights[d(11)]["maybe"] == 2 and nights[d(11)]["guessed"]
    assert nights[d(12)]["rooms"] == 8                      # B's second night
    groups = {g["code"]: g for g in inn_["groups"]}
    assert "X" not in groups
    assert groups["A"]["rooms"] == {"DBL": 9, "SGL": 2} and groups["A"]["check_out"] == d(12)
    assert groups["B"]["guessed"] and groups["B"]["rooms_total"] == 8 and groups["B"]["booking"] == "to_book"
    assert inn_["rooms"] == 11 + 19 + 8

    # A window that cuts a stay keeps the whole stay's dates.
    r = c.get(f"{base}/rooms-by-night?date_from={d(11)}&date_to={d(11)}").json()
    a_stay = next(g for h in r["hotels"] for g in h["groups"] if g["code"] == "A")
    assert a_stay["nights"] == [d(11)] and a_stay["check_in"] == d(10)
    assert c.get(f"{base}/rooms-by-night?date_from={d(0)}&date_to={d(400)}").status_code == 422
    assert a["id"]
