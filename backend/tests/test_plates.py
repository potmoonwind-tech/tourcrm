"""Family-style meals: one plate shared by 2, 3, 4… people. A dish price is one plate; the plates follow
the group (12 people, a plate per 4 → 3 plates), from the agency, the tour, or the dish itself."""
from .test_tours import agency, mk


def setup(c, base, pax=12):
    r = mk(c, f"{base}/vendors", {"name": "Sachashniko", "type": "restaurant"})
    svc = c.put(f"{base}/vendors/{r['id']}/services", json=[{
        "name": "Supra menu", "category": "meal", "unit": "person",
        "rates": [{"price": "40", "currency": "GEL"}],
        "dishes": [{"name": "Khachapuri", "price": 25}, {"name": "Mtsvadi", "price": 30},
                   {"name": "Soup", "price": 8, "per_plate": 1}]}]).json()
    menu = svc[0]["id"]
    route = mk(c, f"{base}/series", {"code": "P", "days": [{"city": "Tbilisi", "lunch_id": r["id"], "lunch_menu_id": menu}, {"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"code": "P-1", "series_id": route["id"], "start_date": "2026-11-10", "pax": pax})
    return t


def lunch_cost(c, base, t):
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    return next(x for x in c.get(f"{base}/tours/{t['id']}/costs").json()["lines"] if x["category"] == "meal")


def test_own_portions_keep_the_menu_price(make_client):
    c, base, _ = agency(make_client)
    t = setup(c, base)
    line = lunch_cost(c, base, t)
    assert line["quantity"] == 12 and line["unit_price"] == 40          # 12 × the menu's price per person, as before


def test_shared_plates_from_the_agency_the_tour_and_the_dish(make_client):
    c, base, _ = agency(make_client)
    c.patch(base, json={"plate_share": 4})
    t = setup(c, base)
    line = lunch_cost(c, base, t)
    # Khachapuri and Mtsvadi: 3 plates each (12 ÷ 4); soup is one bowl each (12).
    assert line["quantity"] == 1 and line["amount"] == 25 * 3 + 30 * 3 + 8 * 12
    assert "3 plates of each dish (1 per 4)" in line["description"]
    meals = c.get(f"{base}/tours/{t['id']}/meals").json()
    row = meals["rows"][0]
    assert row["shared"] and {d["name"]: d["plates"] for d in row["dishes"]} == {"Khachapuri": 3, "Mtsvadi": 3, "Soup": 12}
    assert row["total"] == 25 * 3 + 30 * 3 + 8 * 12 and meals["agency_plate_share"] == 4

    # This group shares one plate per 3 → 4 plates.
    c.patch(f"{base}/tours/{t['id']}", json={"plate_share": 3})
    assert lunch_cost(c, base, t)["amount"] == 25 * 4 + 30 * 4 + 8 * 12
    assert c.get(f"{base}/tours/{t['id']}").json()["plate_share"] == 3
    # Back to the agency's usual.
    c.patch(f"{base}/tours/{t['id']}", json={"plate_share": 0})
    assert c.get(f"{base}/tours/{t['id']}").json()["plate_share"] is None


def test_an_odd_group_rounds_plates_up_and_the_email_says_so(make_client):
    c, base, _ = agency(make_client)
    c.patch(base, json={"plate_share": 4})
    t = setup(c, base, pax=13)
    assert lunch_cost(c, base, t)["amount"] == 25 * 4 + 30 * 4 + 8 * 13     # 13 people → 4 plates
    b = next(x for x in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if x["vendor"]["name"] == "Sachashniko")
    body = c.post(f"{base}/tours/{t['id']}/bookings/{b['id']}/email-draft", json={"language": "en"}).json()["body"]
    assert "one plate per 4 people (4 plates of each dish)" in body and "– Khachapuri: 4 plates" in body and "– Soup: 13 plates" in body
