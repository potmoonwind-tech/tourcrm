"""An agency's own rules without spreadsheets: a price can be a formula of its own inputs, and its
standard lines (tips, water, the border…) come into every new calculation by themselves."""
from decimal import Decimal as D

import pytest

from app.quote_engine import breakdown, compute
from app.quote_presets import hm_preset
from app.quote_schemas import QuoteItemIn


def test_a_price_can_be_a_formula():
    q = hm_preset()
    q.items = [i for i in q.items if not i.name.startswith("Armenian border")]
    q.items.append(QuoteItemIn(name="Armenian border", category="border", currency="USD", unit_price=D(0),
                               price_formula="558 if crossings == 2 else 316"))
    q.variables["crossings"] = D(1)
    one = {i.name: i.amount for i in breakdown(q, 19).items}["Armenian border"]
    q.variables["crossings"] = D(2)
    two = {i.name: i.amount for i in breakdown(q, 19).items}["Armenian border"]
    assert (one, two) == (316, 558)
    # Same price as the spreadsheet's two lines (1 crossing included, 2 not).
    assert {t.tourists: t.price_dbl for t in compute(hm_preset()).tiers}[19] == \
        {t.tourists: t.price_dbl for t in compute(q.model_copy(update={"variables": {**q.variables, "crossings": D(1)}})).tiers}[19]
    q.items[-1].price_formula = "558 if crosings == 2 else 316"
    assert "crosings" in compute(q).errors[0]


def test_standard_lines_and_their_inputs_come_into_every_new_calculation(make_client):
    from .test_tours import agency
    c, base, _ = agency(make_client)
    tips = {"name": "Tips: driver and guide", "category": "tips", "currency": "USD", "unit_price": "4", "quantity": "days",
            "basis": "per_person", "who": "tourists", "standard": True}
    border = {"name": "Armenian border", "category": "border", "currency": "USD", "unit_price": "0",
              "price_formula": "558 if crossings == 2 else 316", "standard": True}
    style = {"items": [tips, border], "variables": {"crossings": "1"}, "variable_notes": {"crossings": "Armenian border crossings"}}
    assert c.put(f"{base}/calc-style", json=style).status_code == 200
    q1 = c.post(f"{base}/quotes", json={"preset": "blank"}).json()
    q2 = c.post(f"{base}/quotes", json={"preset": "blank"}).json()
    names = [i["name"] for i in q1["items"]]
    assert "Tips: driver and guide" in names and "Armenian border" in names
    assert q1["variables"]["crossings"] == "1" and q1["variable_notes"]["crossings"] == "Armenian border crossings"
    assert {i["id"] for i in q1["items"]}.isdisjoint({i["id"] for i in q2["items"]})   # each its own lines
