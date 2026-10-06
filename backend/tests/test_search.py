"""Search everywhere: one box finds tours, tourists, clients, suppliers, routes; money only for managers."""
from .conftest import invite_and_join, signup
from .test_tours import agency, mk


def test_search_finds_everything_and_hides_money_from_staff(make_client):
    c, base, ws = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "Baltic Travel"})
    mk(c, f"{base}/vendors", {"name": "Rustaveli Hotel", "type": "hotel", "city": "Tbilisi"})
    route = mk(c, f"{base}/series", {"code": "TBS", "name": "Tbilisi weekend", "days": [{"city": "Tbilisi"}]})
    t = mk(c, f"{base}/tours", {"series_id": route["id"], "start_date": "2026-11-02", "client_id": cl["id"], "pax": 5})
    mk(c, f"{base}/tours/{t['id']}/participants", {"full_name": "Anna Berzina", "passport_number": "LV123456"})
    inv = mk(c, f"{base}/invoices", {"client_id": cl["id"], "tour_id": t["id"], "issue_date": "2026-10-01", "due_date": "2026-10-20",
                                     "currency": "USD", "lines": [{"description": "Tour", "quantity": "5", "unit_price": "100"}]})
    c.post(f"{base}/invoices/{inv['id']}/issue")

    def kinds(client, q):
        return {(h["kind"], h["title"]) for h in client.get(f"{base}/search", params={"q": q}).json()}
    assert ("tour", t["code"]) in kinds(c, "tbs") and ("route", "TBS — Tbilisi weekend") in kinds(c, "tbs")
    assert ("vendor", "Rustaveli Hotel") in kinds(c, "tbilisi")
    assert ("participant", "Anna Berzina") in kinds(c, "LV1234")                 # by passport
    hits = kinds(c, "baltic")
    assert ("client", "Baltic Travel") in hits and ("tour", t["code"]) in hits and any(k == "invoice" for k, _ in hits)
    assert c.get(f"{base}/search", params={"q": "100%_"}).json() == []          # wildcards are literal
    staff = make_client()
    signup(staff, "s@a.com")
    invite_and_join(c, ws, staff, "s@a.com", "staff")
    assert not any(k == "invoice" for k, _ in kinds(staff, "baltic"))


def test_search_finds_menus_by_name_and_by_dish(make_client):
    c, base, _ = agency(make_client)
    r = mk(c, f"{base}/vendors", {"name": "Shavi Lomi", "type": "restaurant"})
    c.put(f"{base}/vendors/{r['id']}/services", json=[
        {"name": "Georgian supra", "category": "meal", "unit": "person", "dishes": [{"name": "Khinkali", "price": 9}],
         "rates": [{"price": "55", "currency": "GEL"}]},
        {"code": "lunch", "name": "Lunch / person", "category": "meal", "unit": "person", "rates": [{"price": "30", "currency": "GEL"}]}])
    hits = c.get(f"{base}/search", params={"q": "supra"}).json()
    assert [(h["kind"], h["title"]) for h in hits if h["kind"] in ("menu", "service")] == [("menu", "Georgian supra")]
    dish = c.get(f"{base}/search", params={"q": "khink"}).json()
    menu = next(h for h in dish if h["kind"] == "menu")
    assert menu["title"] == "Georgian supra" and "Khinkali" in menu["subtitle"] and menu["link"] == f"vendors?open={r['id']}"
    assert any(h["kind"] == "service" and h["title"] == "Lunch / person" for h in c.get(f"{base}/search", params={"q": "lunch"}).json())
