"""A guide for part of a tour: Nino guides days 1–3, Aram takes days 2–3 (Armenia), each at their own price."""
from .test_tours import agency, mk, seed_route


def guide(c, base, name, price):
    g = mk(c, f"{base}/vendors", {"name": name, "type": "guide"})
    c.put(f"{base}/vendors/{g['id']}/services", json=[{"code": "day", "name": "Guiding", "rates": [{"price": price, "currency": "USD"}]}])
    return g


def test_hand_over_days_to_another_guide(make_client):
    c, base, _ = agency(make_client)
    _, _, _, series = seed_route(c, base)
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 4})
    nino, aram = guide(c, base, "Nino", "100"), guide(c, base, "Aram", "80")
    a = mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": nino["id"], "role": "guide"})
    n = len(c.get(f"{base}/tours/{t['id']}").json()["days"])
    url = f"{base}/tours/{t['id']}/staff/{a['id']}/hand-over"
    p = c.post(url, json={"vendor_id": aram["id"], "from_day": 2, "preview": True}).json()
    days = n - 1
    assert (p["days"], p["old_cost"], p["new_cost"], p["difference"]) == (days, 100 * days, 80 * days, -20 * days)

    r = c.post(url, json={"vendor_id": aram["id"], "from_day": 2}).json()
    assert r["changes"] == [f"Days 2–{n}: guide Nino → Aram"] if n > 2 else r["changes"]
    staff = sorted((s["vendor"]["name"], s["start_day"], s["end_day"]) for s in c.get(f"{base}/tours/{t['id']}/staff").json())
    assert staff == [("Aram", 2, None), ("Nino", 1, 1)]
    lines = {x["vendor"]["name"]: x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "guide"}
    assert lines["Nino"]["quantity"] == 1 and lines["Aram"]["quantity"] == days and lines["Aram"]["unit_price"] == 80
    texts = [x["text"] for x in c.get(f"{base}/tours/{t['id']}/changes").json()["changes"]]
    assert any("Nino → Aram" in x for x in texts) and any("Nino added" in x for x in texts)


def test_hand_over_the_middle_brings_the_first_back(make_client):
    c, base, _ = agency(make_client)
    _, _, _, series = seed_route(c, base)
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 4})
    n = len(c.get(f"{base}/tours/{t['id']}").json()["days"])
    if n < 3:
        return
    nino, aram = guide(c, base, "Nino", "100"), guide(c, base, "Aram", "80")
    a = mk(c, f"{base}/tours/{t['id']}/staff", {"vendor_id": nino["id"], "role": "guide"})
    c.post(f"{base}/tours/{t['id']}/staff/{a['id']}/hand-over", json={"vendor_id": aram["id"], "from_day": 2, "to_day": 2})
    staff = sorted((s["vendor"]["name"], s["start_day"], s["end_day"]) for s in c.get(f"{base}/tours/{t['id']}/staff").json())
    assert staff == [("Aram", 2, 2), ("Nino", 1, 1), ("Nino", 3, None)]


def test_route_guide_plan_prices_the_calculation_and_staffs_departures(make_client):
    c, base, _ = agency(make_client)
    _, _, _, series = seed_route(c, base)
    nino, aram = guide(c, base, "Nino", "100"), guide(c, base, "Aram", "80")
    s = c.get(f"{base}/series/{series['id']}").json()
    plan = [{"role": "guide", "from_day": 1, "to_day": 2, "vendor_id": nino["id"]},
            {"role": "guide", "from_day": 3, "vendor_id": aram["id"], "label": "Armenian guide"}]
    r = c.put(f"{base}/series/{series['id']}", json={**s, "staff_plan": plan})
    assert r.status_code == 200 and len(r.json()["staff_plan"]) == 2

    fill = c.post(f"{base}/quotes/route-fill", json={"series_id": series["id"], "meals": False, "extras": False}).json()
    guides = {i["name"]: (float(i["unit_price"]), i["quantity"]) for i in fill["items"] if i["category"] == "guide"}
    assert guides == {"Guide: Nino · days 1–2": (100, "2"), "Armenian guide: Aram · day 3": (80, "1")}

    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 4})
    staff = sorted((x["vendor"]["name"], x["start_day"], x["end_day"]) for x in c.get(f"{base}/tours/{t['id']}/staff").json())
    assert staff == [("Aram", 3, None), ("Nino", 1, 2)]
    # Pushing the route again doesn't add them twice.
    c.post(f"{base}/series/{series['id']}/push", json={"tour_ids": [t["id"]]})
    assert len(c.get(f"{base}/tours/{t['id']}/staff").json()) == 2


def test_a_second_guide_on_the_same_days_is_added(make_client):
    """ZK: the Chinese-speaking guide all days, an Armenian guide joins for days 2–3. A guide changed
    on one departure isn't added back."""
    c, base, _ = agency(make_client)
    _, _, _, series = seed_route(c, base)
    nino, aram, levan = guide(c, base, "Nino", "100"), guide(c, base, "Aram", "80"), guide(c, base, "Levan", "90")
    s = c.get(f"{base}/series/{series['id']}").json()
    plan = [{"role": "guide", "from_day": 1, "vendor_id": nino["id"], "label": "Chinese-speaking guide"},
            {"role": "guide", "from_day": 2, "to_day": 3, "vendor_id": aram["id"], "label": "Armenian guide"}]
    c.put(f"{base}/series/{series['id']}", json={**s, "staff_plan": plan})
    t = mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": "2027-05-10", "pax": 4})
    staff = c.get(f"{base}/tours/{t['id']}/staff").json()
    assert sorted((x["vendor"]["name"], x["start_day"]) for x in staff) == [("Aram", 2), ("Nino", 1)]
    # On this departure Levan replaces Aram; giving the plan again keeps Levan.
    arm = next(x for x in staff if x["vendor"]["name"] == "Aram")
    c.post(f"{base}/tours/{t['id']}/staff/{arm['id']}/hand-over", json={"vendor_id": levan["id"], "from_day": 2})
    c.post(f"{base}/series/{series['id']}/staff-plan/apply", json={"tour_ids": [t["id"]]})
    assert sorted(x["vendor"]["name"] for x in c.get(f"{base}/tours/{t['id']}/staff").json()) == ["Levan", "Nino"]


def test_overlapping_departures_take_turns(make_client):
    """A weekly series longer than a week overlaps: one guide can't do every departure. Two plan
    lines with the same name are alternatives; with only one guide, the busy departure is reported."""
    c, base, _ = agency(make_client)
    _, _, _, series = seed_route(c, base)          # 3 days
    nino, levan = guide(c, base, "Nino", "100"), guide(c, base, "Levan", "100")
    s = c.get(f"{base}/series/{series['id']}").json()
    # Only Nino first: the second departure (1 day overlap) can't have her.
    c.put(f"{base}/series/{series['id']}", json={**s, "staff_plan": [{"role": "guide", "from_day": 1, "vendor_id": nino["id"], "label": "Chinese-speaking guide"}]})
    tours = [mk(c, f"{base}/tours", {"series_id": series["id"], "start_date": d, "pax": 4}) for d in ("2027-05-10", "2027-05-12", "2027-05-14")]
    names = lambda t: [x["vendor"]["name"] for x in c.get(f"{base}/tours/{t['id']}/staff").json()]
    assert [names(t) for t in tours] == [["Nino"], [], ["Nino"]]
    r = c.post(f"{base}/series/{series['id']}/staff-plan/apply", json={"tour_ids": [t["id"] for t in tours]}).json()
    assert [x["busy"] for x in r] == [[], ["Days 1–3: Nino is busy on HM-0510"], []]
    # Levan as the alternative (same name): he takes the free departure.
    s = c.get(f"{base}/series/{series['id']}").json()
    c.put(f"{base}/series/{series['id']}", json={**s, "staff_plan": s["staff_plan"] + [{"role": "guide", "from_day": 1, "vendor_id": levan["id"], "label": "Chinese-speaking guide"}]})
    r = c.post(f"{base}/series/{series['id']}/staff-plan/apply", json={"tour_ids": [t["id"] for t in tours]}).json()
    assert [names(t) for t in tours] == [["Nino"], ["Levan"], ["Nino"]] and all(not x["busy"] for x in r)
    # The calculation prices one of the alternatives, not both.
    fill = c.post(f"{base}/quotes/route-fill", json={"series_id": series["id"], "meals": False, "extras": False}).json()
    assert len([i for i in fill["items"] if i["category"] == "guide"]) == 1

