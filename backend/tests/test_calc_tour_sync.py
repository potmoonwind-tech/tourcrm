"""What a sold calculation passes to its tour, and what the catalog and route may change later."""
from .test_route_build import catalog_route
from .test_tours import agency, mk


def doc_of(q):
    doc = {k: v for k, v in q.items() if k not in ("id", "updated_at", "version", "result", "notices")}
    for item in doc["items"]:
        if item["name"] == "Guide":
            item["unit_price"] = "100"      # typed by hand: a calculation with a 0 price can't be sold
    return doc


def test_tour_takes_hotels_from_the_calculation_and_keeps_confirmed_prices(make_client):
    c, base, _ = agency(make_client)
    route, _ = catalog_route(c, base)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    other = mk(c, f"{base}/vendors", {"name": "Bagrati Hotel", "type": "hotel"})
    c.put(f"{base}/vendors/{other['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "rates": [{"price": "90", "currency": "USD"}]}])
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-09-30"}).json()
    doc = doc_of(q)
    doc["nights"][1].update(vendor_id=other["id"], hotel_name="Bagrati Hotel")    # sold with another hotel on night 2
    assert c.put(f"{base}/quotes/{q['id']}", json=doc).status_code == 200

    r = mk(c, f"{base}/quotes/{q['id']}/create-tour", {"tourists": 12, "start_date": "2026-09-30", "with_invoice": False})
    assert r["hotel_changes"] == ["Day 2: Bagrati Hotel instead of Rioni Hotel"]
    url = f"{base}/tours/{r['tour_id']}"
    tour = c.get(url).json()
    assert [d["hotel"]["name"] for d in tour["days"][:2]] == ["Rioni Hotel", "Bagrati Hotel"]
    assert tour["route_changed"] is False

    # The supplier confirms; a later catalog price doesn't overwrite the agreed one.
    c.post(f"{url}/costs/generate")
    bagrati = next(b for b in c.get(f"{url}/bookings").json()["bookings"] if b["vendor"]["name"] == "Bagrati Hotel")
    c.patch(f"{url}/bookings/{bagrati['id']}", json={"status": "confirmed"})
    c.put(f"{base}/vendors/{other['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "rates": [{"price": "120", "currency": "USD"}]}])
    g = c.post(f"{url}/costs/generate").json()
    assert any("Bagrati Hotel: confirmed at 90" in w for w in g["warnings"])
    prices = {float(x["unit_price"]) for x in c.get(f"{url}/costs").json()["lines"] if x["vendor"] and x["vendor"]["id"] == other["id"]}
    assert 90 in prices and 120 not in prices          # (its single room has no price: 0)

    # Editing the route's days later is flagged on tours copied before; a rename isn't.
    s = c.get(f"{base}/series").json()[0]
    keep = {"code": s["code"], "name": "Renamed", "color": s["color"], "notes": s["notes"],
            "days": [{k: v for k, v in d.items() if k not in ("day_number", "id")} for d in s["days"]]}
    assert c.put(f"{base}/series/{s['id']}", json=keep).status_code == 200
    assert c.get(url).json()["route_changed"] is False
    keep["days"][2]["city"] = "Batumi"
    assert c.put(f"{base}/series/{s['id']}", json=keep).status_code == 200
    assert c.get(url).json()["route_changed"] is True


def test_different_night_count_is_not_guessed(make_client):
    c, base, _ = agency(make_client)
    route, _ = catalog_route(c, base)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-09-30"}).json()
    doc = doc_of(q)
    doc["nights"] = doc["nights"][:1]
    assert c.put(f"{base}/quotes/{q['id']}", json=doc).status_code == 200
    r = mk(c, f"{base}/quotes/{q['id']}/create-tour", {"tourists": 12, "start_date": "2026-09-30", "with_invoice": False})
    assert "check the tour's hotels" in r["hotel_changes"][0]


def test_a_calculation_for_a_whole_series_both_ways(make_client):
    c, base, _ = agency(make_client)
    route, _ = catalog_route(c, base)
    c.put(f"{base}/exchange-rates", json=[{"currency": "GEL", "rate": "0.37"}])
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-09-30"}).json()
    assert c.put(f"{base}/quotes/{q['id']}", json=doc_of(q)).status_code == 200
    leaders = q["leaders"]

    # Calculation first: two departures made from it.
    made = c.post(f"{base}/quotes/{q['id']}/departures", json={"tourists": 12, "departures": [
        {"code": "KU-1001", "start_date": "2026-10-01"}, {"code": "KU-1008", "start_date": "2026-10-08"}]}).json()
    assert [m["code"] for m in made] == ["KU-1001", "KU-1008"] and all(m["tour_id"] and not m["error"] for m in made)
    t = c.get(f"{base}/tours/{made[0]['tour_id']}").json()
    assert t["status"] == "inquiry" and t["quote_id"] == q["id"] and t["price_pp"] > 0
    assert c.get(f"{base}/tours/{made[0]['tour_id']}/budget").json()["set"] is True

    # Tours first: departures from the route, then the calculation given to them.
    deps = c.post(f"{base}/tours/departures", json={"series_id": route["id"], "pax": 12 + leaders, "departures": [
        {"code": "KU-1015", "start_date": "2026-10-15"}]}).json()
    unknown = c.post(f"{base}/tours/departures", json={"series_id": route["id"], "departures": [
        {"code": "KU-1022", "start_date": "2026-10-22"}]}).json()
    res = c.post(f"{base}/quotes/{q['id']}/apply", json={"tour_ids": [deps[0]["tour_id"], unknown[0]["tour_id"]]}).json()
    assert res[0]["error"] == "" and "Group size unknown" in res[1]["error"]
    t = c.get(f"{base}/tours/{deps[0]['tour_id']}").json()
    assert t["quote_id"] == q["id"] and t["price_pp"] == c.get(f"{base}/tours/{made[0]['tour_id']}").json()["price_pp"]
    # One size for all: the unknown one gets it too.
    assert c.post(f"{base}/quotes/{q['id']}/apply", json={"tour_ids": [unknown[0]["tour_id"]], "tourists": 15}).json()[0]["error"] == ""



def test_a_missing_price_is_not_an_agreed_price(make_client):
    """Costs made before the hotel had a price (0), then the booking confirmed: the price still comes in."""
    from .test_tours import seed_route
    c, base, _ = agency(make_client)
    hotel, resto, kaz, series = seed_route(c, base)
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 2, "rooms": "1 DBL"})
    url = f"{base}/tours/{t['id']}"
    c.post(f"{url}/costs/generate")
    b = next(x for x in c.get(f"{url}/bookings").json()["bookings"] if x["vendor"]["id"] == hotel["id"])
    c.patch(f"{url}/bookings/{b['id']}", json={"status": "confirmed"})
    c.put(f"{base}/vendors/{hotel['id']}/services", json=[{"code": "room_DBL", "name": "DBL", "rates": [{"price": "150", "currency": "USD"}]}])
    c.post(f"{url}/costs/generate")
    prices = {x["unit_price"] for x in c.get(f"{url}/costs").json()["lines"] if x["vendor"] and x["vendor"]["id"] == hotel["id"]}
    assert prices == {150.0}
