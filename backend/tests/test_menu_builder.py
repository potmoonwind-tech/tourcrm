"""A restaurant's dish list and its set menus: by hand, from Excel, from a photo; prices with their history."""
import io
from types import SimpleNamespace

from openpyxl import Workbook

from .test_tours import agency, mk


def restaurant(c, base):
    return mk(c, f"{base}/vendors", {"name": "Barbarestan", "type": "restaurant", "city": "Tbilisi", "currency": "GEL"})


def test_dishes_a_price_change_with_its_history_reaches_the_set_menus(make_client):
    c, base, _ = agency(make_client)
    r = restaurant(c, base)
    url = f"{base}/vendors/{r['id']}"
    dishes = c.post(f"{url}/dishes", json=[{"name": "Khinkali", "category": "Mains", "price": "10"},
                                           {"name": "Georgian salad", "category": "Salads", "price": "12", "per_plate": 4}]).json()
    kh = next(d for d in dishes if d["name"] == "Khinkali")
    assert kh["currency"] == "GEL" and len(kh["history"]) == 1
    menu = c.post(f"{url}/menu", json={"meal": "lunch", "dishes": [{"name": "Khinkali", "price": 10}]}).json()
    assert c.put(f"{url}/menus/{menu['id']}", json={"dishes": [{"name": "Khinkali", "price": 10, "dish_id": kh["id"]},
                                                                {"name": "Georgian salad", "price": 12, "per_plate": 4}],
                                                     "price": "25"}).status_code == 204
    # The restaurant raises khinkali to 11: the history keeps both, the set menu follows.
    upd = c.patch(f"{url}/dishes/{kh['id']}", json={"price": "11"}).json()
    assert [h["price"] for h in upd["history"]] == ["11.00", "10.00"]
    svc = next(s for s in c.get(f"{url}/services").json() if s["id"] == menu["id"])
    assert [(d["name"], d["price"]) for d in svc["dishes"]] == [("Khinkali", 11.0), ("Georgian salad", 12.0)]
    assert float(svc["rates"][0]["price"]) == 25
    # A menu linked to a dish that was deleted and added again: found by its name.
    c.delete(f"{url}/dishes/{kh['id']}")
    kh2 = next(d for d in c.post(f"{url}/dishes", json=[{"name": "Khinkali", "price": "11"}]).json() if d["name"] == "Khinkali")
    c.patch(f"{url}/dishes/{kh2['id']}", json={"price": "12"})
    svc = next(s for s in c.get(f"{url}/services").json() if s["id"] == menu["id"])
    assert svc["dishes"][0]["price"] == 12.0 and svc["dishes"][0]["dish_id"] == kh2["id"]
    # Adding a dish already listed updates it instead of doubling it.
    again = c.post(f"{url}/dishes", json=[{"name": "khinkali", "price": "11.5"}]).json()
    assert sum(1 for d in again if d["name"].lower() == "khinkali") == 1


def test_a_menu_from_excel_with_sections(make_client):
    c, base, _ = agency(make_client)
    r = restaurant(c, base)
    wb = Workbook()
    ws = wb.active
    for row in (["Menu"], ["Salads"], ["Georgian salad", "12 ₾"], ["Pkhali", 15], ["Mains"], ["Khinkali (5)", "10,50"], ["Mtsvadi", 22]):
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    got = c.post(f"{base}/vendors/{r['id']}/dishes/read", files={"file": ("menu.xlsx", buf.getvalue())}).json()
    assert [(d["name"], d["category"], d["price"]) for d in got["dishes"]] == [
        ("Georgian salad", "Salads", "12.00"), ("Pkhali", "Salads", "15.00"), ("Khinkali (5)", "Mains", "10.50"), ("Mtsvadi", "Mains", "22.00")]
    assert c.get(f"{base}/vendors/{r['id']}/dishes").json() == []            # nothing saved before checking


def test_a_photo_of_the_menu_read_by_ai(make_client, monkeypatch):
    class Fake:
        def __init__(self):
            self.messages = self

        def create(self, model, max_tokens, messages):
            assert messages[0]["content"][0]["type"] == "image"
            text = '[{"name": "Kharcho", "category": "Soups", "price": 14}, {"name": "Lobio", "category": "Mains", "price": null}]'
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])

    monkeypatch.setattr("app.routers.menu_builder.make_client", lambda ws: Fake())
    monkeypatch.setattr("app.ai.keys.key_for", lambda ws: "sk-test")
    c, base, _ = agency(make_client)
    r = restaurant(c, base)
    got = c.post(f"{base}/vendors/{r['id']}/dishes/read", files={"file": ("menu.jpg", b"\xff\xd8fake", "image/jpeg")}).json()
    assert got["by_ai"] and [(d["name"], d["price"]) for d in got["dishes"]] == [("Kharcho", "14.00"), ("Lobio", None)]
