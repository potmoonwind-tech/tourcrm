"""Any agency's own way of pricing: its own types of person, who uses what, and its own recipe
from cost to price - without formulas, unless it wants one."""
from decimal import Decimal as D

import pytest

from app.quote_engine import breakdown, compute
from app.quote_schemas import PersonType, PriceStep, QuoteIn, QuoteItemIn, QuoteNightIn, Usage

ADULTS, KIDS, LEADER, GUIDE = "adults", "kids", "leader", "guide"


def trip(**kw) -> QuoteIn:
    base = dict(
        name="Flex", currency="GEL", days=2, pax_min=10, pax_max=30,
        people=[PersonType(id=ADULTS, name="Adults"),
                PersonType(id=KIDS, name="Children 2-11", count=4, room="none"),
                PersonType(id=LEADER, name="Tour leader", role="free", count=1, room="sgl"),
                PersonType(id=GUIDE, name="Guide", role="staff", count=1, room="staff")],
        nights=[QuoteNightIn(currency="GEL", price_dbl=D(200), price_sgl=D(150), staff_stay="own", staff_price=D(40))],
        items=[
            QuoteItemIn(name="Dinner", category="meal", currency="GEL", unit_price=D(50), basis="per_person", who="everyone",
                        uses={KIDS: Usage(mode="half"), GUIDE: Usage(mode="own", price=D(20))}),
            QuoteItemIn(name="Bus", category="transport", currency="GEL", unit_price=D(600), basis="group"),
        ],
        recipe=[PriceStep(kind="markup", value=D(10))],
    )
    base.update(kw)
    return QuoteIn(**base)


def tier(q, n=20):
    return next(t for t in compute(q).tiers if t.tourists == n)


def test_each_type_pays_its_own_and_a_share_of_the_rest():
    t = tier(trip())
    adults, kids = t.types
    # Shared: bus 600 + leader's dinner 50 + single 150 + guide's dinner 20 + room 40 = 860 over 24 payers.
    shared = D(860) / 24
    assert adults.cost == pytest.approx(float(50 + 100 + shared))       # dinner + half a double
    assert kids.cost == pytest.approx(float(25 + shared))               # half a dinner, no bed
    assert adults.price == pytest.approx(round(adults.cost * 1.1, 2))
    assert t.label == "20+1" and t.group_revenue == pytest.approx(adults.price * 20 + kids.price * 4)
    # Every lari the agency pays is in the group cost.
    assert t.group_cost == pytest.approx(50 * 20 + 25 * 4 + 50 + 20 + 600 + 100 * 20 + 150 + 40)


def test_breakdown_says_what_free_people_and_staff_cost():
    b = breakdown(trip(), 20)
    who = {p.id: p for p in b.people}
    assert who[LEADER].for_others == pytest.approx(200) and who[GUIDE].for_others == pytest.approx(60)
    assert b.steps.recipe[0].label == "Markup"


def test_children_at_a_share_of_the_adult_price():
    q = trip(recipe=[PriceStep(kind="markup", value=D(10), only=[ADULTS]),
                     PriceStep(kind="relative", value=D(70), ref=ADULTS, only=[KIDS]),
                     PriceStep(kind="round", value=D(5))])
    adults, kids = tier(q).types
    assert adults.price % 5 == 0 and kids.price == pytest.approx(round(adults.price * 0.7 / 5 + 0.4999) * 5, abs=5)


def test_agent_commission_vat_and_group_size_windows():
    q = trip(recipe=[PriceStep(kind="add_group", value=D(1200)),
                     PriceStep(kind="commission", value=D(10)),
                     PriceStep(kind="add_pp", value=D(25), max_pax=15, label="Small group supplement")])
    small, big = tier(q, 12).types[0], tier(q, 25).types[0]
    assert small.price == pytest.approx(round((small.cost + 1200 / 16) / 0.9 + 25, 2))
    assert big.price == pytest.approx(round((big.cost + 1200 / 29) / 0.9, 2))
    vat = trip(recipe=[PriceStep(kind="markup", value=D(20)), PriceStep(kind="vat_margin", value=D(18))])
    a = tier(vat).types[0]
    assert a.price == pytest.approx(round(a.cost * 1.2 + a.cost * 0.2 * 0.18, 2))


def test_anything_else_is_a_formula():
    q = trip(recipe=[PriceStep(kind="formula", formula="max(cost * 1.15, cost + 120)", label="Our rule")])
    a = tier(q).types[0]
    assert a.price == pytest.approx(round(max(a.cost * 1.15, a.cost + 120), 2))
    bad = trip(recipe=[PriceStep(kind="formula", formula="cost * margn")])
    assert not compute(bad).tiers and "margn" in compute(bad).errors[0]


def test_free_places_grow_with_the_group():
    q = trip(people=[PersonType(id=ADULTS, name="Adults"), PersonType(id=LEADER, name="Leader", role="free", count=1, per=15)])
    assert tier(q, 20).label == "20+1" and tier(q, 30).label == "30+2"


def test_people_must_have_one_group():
    with pytest.raises(ValueError):
        trip(people=[PersonType(id=ADULTS, name="Adults", count=10)])


def test_the_tour_budget_adds_up_to_the_group_cost():
    from app.budget import snapshot
    q = trip()
    snap = snapshot(q, 20, {"GEL": D(1)})
    assert float(sum(b.unit_price * b.quantity for b in snap.lines)) == pytest.approx(tier(q).group_cost)
    assert "4 Children 2-11 no bed" in snap.lines[0].notes


def test_history_names_people_and_steps():
    from app.quote_diff import diff_docs
    a = trip()
    b = trip(recipe=[PriceStep(kind="markup", value=D(12), label="Our markup")])
    b.people[1].count = 6
    text = " ".join(f"{c.field} {c.before} {c.after}" for c in diff_docs(a, b))
    assert "Children 2-11 × 6" in text and "Our markup 12" in text


def test_a_share_of_the_group_price_leaves_the_group_alone():
    q = trip(recipe=[PriceStep(kind="markup", value=D(10)), PriceStep(kind="relative", value=D(70), ref=ADULTS)])
    t = tier(q)
    assert t.price_sgl > t.price_dbl and t.types[1].price == pytest.approx(t.price_dbl * 0.7, abs=0.01)


def test_markup_by_kind_of_cost():
    # 10% on hotels, 25% on everything else (meals, bus): each on its own share of the cost.
    q = trip(recipe=[PriceStep(kind="markup", value=D(10), cats=["hotel"]),
                     PriceStep(kind="markup", value=D(25), cats=["meal", "transport"])])
    b = breakdown(q, 20)
    a = b.tier.types[0]
    hotel = 100 + (150 + 40) / 24            # half a double + share of the leader's and guide's rooms
    rest = a.cost - hotel
    assert a.price == pytest.approx(round(a.cost + hotel * 0.10 + rest * 0.25, 2), abs=0.01)
    # Children have no bed: only the shared hotel costs get the 10%.
    kid = b.tier.types[1]
    assert kid.price == pytest.approx(round(kid.cost + (190 / 24) * 0.10 + (kid.cost - 190 / 24) * 0.25, 2), abs=0.01)


def test_our_way_is_where_new_calculations_start(make_client):
    from .test_tours import agency
    c, base, _ = agency(make_client)
    assert c.get(f"{base}/calc-style").json()["people"] == []
    style = {"people": [{"id": "a", "name": "Adults", "role": "pay", "count": None, "room": "dbl"},
                        {"id": "k", "name": "Kids", "role": "pay", "count": 2, "room": "none", "weight": "0.5"}],
             "recipe": [{"kind": "markup", "value": "12", "cats": ["hotel"]}, {"kind": "round", "value": "5"}]}
    assert c.put(f"{base}/calc-style", json=style).status_code == 200
    q = c.post(f"{base}/quotes", json={"preset": "blank"}).json()
    assert [p["name"] for p in q["people"]] == ["Adults", "Kids"] and q["recipe"][0]["cats"] == ["hotel"]
    copy = c.post(f"{base}/quotes", json={"copy_of": q["id"]}).json()
    assert copy["people"] == q["people"]
    bad = {"people": [{"id": "a", "name": "Adults", "role": "pay", "count": 5, "room": "dbl"}]}
    assert c.put(f"{base}/calc-style", json=bad).status_code == 422
    assert c.put(f"{base}/calc-style", json={}).status_code == 200            # back to the app's defaults
    assert c.post(f"{base}/quotes", json={"preset": "blank"}).json()["people"] == []


def test_optional_extras_are_priced_on_their_own():
    wine = QuoteItemIn(name="Wine tasting", category="activity", currency="GEL", unit_price=D(40), basis="per_person",
                       who="tourists", included=False, optional=True)
    jeep = QuoteItemIn(name="Jeep to Gergeti", category="transport", currency="GEL", unit_price=D(120), basis="per_vehicle",
                       capacity=6, who="tourists", included=False, optional=True)
    base = tier(trip())
    q = trip(items=[*trip().items, wine, jeep], extra_markup=D(20),
             recipe=[PriceStep(kind="markup", value=D(10)), PriceStep(kind="round", value=D(5))])
    t = tier(q)
    assert t.cost_dbl == pytest.approx(base.cost_dbl)                       # not in the tour price
    w, j = t.extras
    assert w.name == "Wine tasting" and w.cost == pytest.approx(40) and w.price == 55      # 40 × 1.2 × 1.1 = 52.8 → 55
    assert j.cost == pytest.approx(120 * 4 / 24) and j.price % 5 == 0                       # 4 jeeps for 24, per payer


def test_seasons_in_one_calculation():
    from app.quote_schemas import Season, SeasonRoom
    q = trip(seasons=[Season(id="high", name="High season")])
    q.nights[0].season_prices = {"high": SeasonRoom(price_dbl=D(300))}     # single stays 150
    q.items[1].season_prices = {"high": D(900)}                            # a bigger bus
    r = compute(q)
    base = next(t for t in r.tiers if t.tourists == 20)
    high = next(t for t in r.seasons[0].tiers if t.tourists == 20)
    assert r.seasons[0].name == "High season"
    assert high.cost_dbl == pytest.approx(base.cost_dbl + 50 + 300 / 24)    # +half of 100 more for the room, +300 bus
    assert high.cost_sgl - base.cost_sgl == pytest.approx(300 / 24)        # the single price didn't change


def test_selling_in_other_currencies_and_per_room():
    from app.quote_schemas import SellCurrency
    q = trip(fx={"EUR": D("0.34")}, sell_in=[SellCurrency(currency="EUR", step=D(5)), SellCurrency(currency="USD", rate=D("0.37"))])
    q.nights[0].price_quad = D(320)
    t = tier(q)
    eur, usd = t.other
    assert eur.currency == "EUR" and eur.price_dbl % 5 == 0 and eur.price_dbl == pytest.approx(t.price_dbl * 0.34, abs=5)
    assert usd.price_dbl == pytest.approx(t.price_dbl * 0.37, abs=1)
    assert t.price_quad is not None and t.price_quad < t.price_dbl          # a quarter of 320 < half of 200
    bad = trip(sell_in=[SellCurrency(currency="CNY")])
    assert "CNY" in compute(bad).errors[0]


def test_price_list_shows_seasons_currencies_kinds_of_person_and_extras(make_client):
    from .test_tours import agency
    c, base, _ = agency(make_client)
    q = c.post(f"{base}/quotes", json={"preset": "blank"}).json()
    doc = trip(fx={"EUR": D("0.34")}).model_dump(mode="json")
    doc["seasons"] = [{"id": "hi", "name": "High season", "from_date": "2026-06-01", "to_date": "2026-08-31"}]
    doc["nights"][0]["season_prices"] = {"hi": {"price_dbl": "300"}}
    doc["sell_in"] = [{"currency": "EUR", "step": "5"}]
    doc["items"].append({"name": "Wine tasting", "category": "activity", "currency": "GEL", "unit_price": "40",
                         "basis": "per_person", "who": "tourists", "included": False, "optional": True})
    assert c.put(f"{base}/quotes/{q['id']}", json=doc).status_code == 200
    pl = c.get(f"{base}/quotes/{q['id']}/price-list?lang=en").json()
    base_t, high = pl["sections"]
    assert high["title"].startswith("High season · 2026-06-01")
    assert "Double / Twin, per person · EUR" in base_t["columns"] and "Children 2-11, per person · GEL" in base_t["columns"]
    assert len(base_t["rows"]) == 21 and len(base_t["rows"][0]) == len(base_t["columns"])
    assert pl["extras"][0]["name"] == "Wine tasting"
    doc["per_room"] = True
    c.put(f"{base}/quotes/{q['id']}", json=doc)
    pl = c.get(f"{base}/quotes/{q['id']}/price-list?lang=en").json()
    room = pl["sections"][0]
    assert room["columns"][1] == "Double room · GEL" and room["rows"][0][1] == pytest.approx(2 * compute(QuoteIn.model_validate(doc)).tiers[0].price_dbl)
    assert c.get(f"{base}/quotes/{q['id']}/price-list.xlsx?lang=en").status_code == 200


def test_nights_in_another_currency_without_a_quad_price():
    q = trip(fx={"USD": D("0.37")})
    q.nights.append(QuoteNightIn(currency="USD", price_dbl=D(120), price_sgl=D(105)))
    t = tier(q)
    assert t.price_quad is None and t.cost_dbl > tier(trip()).cost_dbl


def test_a_tour_from_a_flexible_calculation_charges_everyone_in_its_season(make_client):
    from .test_tours import agency, mk
    c, base, _ = agency(make_client)
    cl = mk(c, f"{base}/clients", {"name": "Orient"})
    q = c.post(f"{base}/quotes", json={"preset": "blank"}).json()
    doc = trip(client_id=cl["id"]).model_dump(mode="json")
    doc["seasons"] = [{"id": "hi", "name": "High", "from_date": "2026-07-01", "to_date": "2026-08-31"}]
    doc["nights"][0]["season_prices"] = {"hi": {"price_dbl": "400"}}
    c.put(f"{base}/quotes/{q['id']}", json=doc)
    res = compute(QuoteIn.model_validate(doc))
    low = next(t for t in res.tiers if t.tourists == 20)
    high = next(t for t in res.seasons[0].tiers if t.tourists == 20)
    winter = mk(c, f"{base}/quotes/{q['id']}/create-tour", {"tourists": 20, "start_date": "2026-11-01", "singles": 0})
    summer = mk(c, f"{base}/quotes/{q['id']}/create-tour", {"tourists": 20, "start_date": "2026-07-15", "singles": 0, "code": "SUMMER"})
    tw = c.get(f"{base}/tours/{winter['tour_id']}").json()
    assert (tw["pax"], tw["leaders"]) == (24, 1) and tw["rooms"] == "10 DBL + 1 SGL"   # 20 + 4 children (no bed); the leader on top, in a single
    inv = c.get(f"{base}/invoices/{winter['invoice_id']}").json()
    assert [(x["quantity"], x["unit_price"]) for x in inv["lines"]] == [(20, low.types[0].price), (4, low.types[1].price)]
    assert c.get(f"{base}/tours/{summer['tour_id']}").json()["price_pp"] == high.price_dbl > low.price_dbl
    bud = c.get(f"{base}/tours/{summer['tour_id']}/budget").json()
    hotel = next(x for x in bud["lines"] if x["kind"] == "hotel" and not x["name"].startswith("Staff"))
    assert hotel["unit_price"] == 400 / 2 * 20 + 150                  # the high-season double, plus the leader's single


def test_a_scenario_price_wins_over_group_size_prices():
    from app.quote_diff import apply_patch
    from app.quote_schemas import QuoteTier, ScenarioPatch
    q = trip()
    q.items[1].tiers = [QuoteTier(max_pax=15, unit_price=D(400)), QuoteTier(max_pax=30, unit_price=D(600))]
    patched, _ = apply_patch(q, ScenarioPatch.model_validate({"items": {q.items[1].id: {"unit_price": "900"}}}))
    assert tier(patched).cost_dbl - tier(q).cost_dbl == pytest.approx(300 / 24)
