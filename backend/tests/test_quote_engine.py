"""The engine against the agency's own spreadsheet.

EXCEL holds, per group size, what HM-2026行程0803_KA_CALC.xlsx computes:
(cost per person DBL = N48, cost per person SGL = O48, sale DBL = N52, group cost
without hotels = M44, price list = ROUNDDOWN(N52) = SETUP!J27…J43).
"""
from decimal import Decimal

import pytest

from app.formula import FormulaError, evaluate
from app.quote_engine import breakdown, compute
from app.quote_presets import hm_preset
from app.quote_schemas import QuoteIn

EXCEL = {
    9: (1396.5002, 1753.0002, 1468.7224, 9135.002, 1468), 10: (1329.7429, 1686.2429, 1394.7429, 9482.429, 1394),
    11: (1275.1233, 1631.6233, 1334.2142, 9829.856, 1334), 12: (1229.6069, 1586.1069, 1283.7736, 10177.283, 1283),
    13: (1330.4327, 1686.9327, 1380.4327, 12336.1251, 1380), 14: (1287.468, 1643.968, 1333.8966, 12683.5521, 1333),
    15: (1250.2319, 1606.7319, 1293.5653, 13030.9791, 1293), 16: (1217.6504, 1574.1504, 1258.2754, 13378.4061, 1258),
    17: (1188.9019, 1545.4019, 1227.1372, 13725.8331, 1227), 18: (1163.3478, 1519.8478, 1199.4589, 14073.2601, 1199),
    19: (1140.4835, 1496.9835, 1174.6941, 14420.6871, 1174), 20: (1125.8727, 1482.3727, 1159.8727, 14887.4537, 1159),
    21: (1106.9705, 1463.4705, 1140.9705, 15234.8807, 1140), 22: (1089.7867, 1446.2867, 1123.7867, 15582.3077, 1123),
    23: (1074.0972, 1430.5972, 1108.0972, 15929.7347, 1108), 24: (1059.7151, 1416.2151, 1093.7151, 16277.1617, 1093),
    25: (1046.4835, 1402.9835, 1080.4835, 16624.5887, 1080),
}


def excel_variant() -> QuoteIn:
    """The preset exactly as the file has it: Martvili typed as 50/2.6 USD, and no profit on single rooms."""
    q = hm_preset()
    martvili = next(i for i in q.items if i.name == "Martvili Canyon")
    martvili.currency, martvili.unit_price = "USD", Decimal(50) / Decimal("2.6")
    q.single_profit = False
    return q


def test_hm_preset_reproduces_the_spreadsheet_for_every_group_size():
    result = compute(excel_variant())
    assert result.errors == []
    assert [t.tourists for t in result.tiers] == list(range(9, 26))
    for t in result.tiers:
        cost_dbl, cost_sgl, sale_dbl, without_hotels, price_list = EXCEL[t.tourists]
        assert t.cost_dbl == pytest.approx(cost_dbl, abs=0.001), t.label
        assert t.cost_sgl == pytest.approx(cost_sgl, abs=0.001), t.label
        assert t.price_dbl == price_list, t.label
        assert t.cost_dbl + t.profit_pp == pytest.approx(sale_dbl, abs=0.001), t.label
        assert t.price_sgl == int(cost_sgl)  # file: single = cost only, rounded down by the price list
    by_n = {t.tourists: t for t in result.tiers}
    assert by_n[12].vehicle == "17-seater minibus" and by_n[13].vehicle == "45-seater bus"
    assert by_n[19].label == "19+1"


def test_group_cost_without_hotels_matches_sheet():
    for n in (9, 13, 19, 25):
        b = breakdown(excel_variant(), n)
        assert float(sum(i.amount for i in b.items)) + b.leader_room == pytest.approx(EXCEL[n][3], abs=0.001)


def test_breakdown_shows_each_line_like_the_19_plus_1_sheet():
    b = breakdown(excel_variant(), 19)
    amounts = {i.name: i.amount for i in b.items}
    assert amounts["Guide"] == pytest.approx(1350)                      # M12
    assert amounts["Bus"] == pytest.approx(1867.9245, abs=1e-3)          # M13
    assert amounts["Meals in Georgia"] == pytest.approx(3757.6)          # M15
    assert amounts["Meals in Armenia"] == pytest.approx(1320)            # M17
    assert amounts["Fuel"] == pytest.approx(1630.1887, abs=1e-3)         # M23
    assert amounts["Delica Kazbegi"] == pytest.approx(75)                # M36: 3 cars
    assert amounts["Delica Svaneti"] == pytest.approx(283.0189, abs=1e-3)
    assert amounts["Tips: driver"] + amounts["Tips: guide"] == pytest.approx(684)  # M42
    assert amounts["Wine / chacha tasting"] == 0                         # not included
    assert b.leader_room == pytest.approx(738)                           # M25 = Σ single rooms


def test_preset_defaults_add_profit_to_single_rooms():
    by_n = {t.tourists: t for t in compute(hm_preset()).tiers}
    t = by_n[19]
    assert t.price_sgl == int(t.cost_sgl + t.profit_pp)
    assert t.single_supplement == t.price_sgl - t.price_dbl


def test_variables_flow_through_formulas():
    q = hm_preset()
    base = {t.tourists: t.cost_dbl for t in compute(q).tiers}
    q.variables["armenia_meals"] = Decimal(0)  # no Armenian meals: all meals at the Georgian price
    cheaper = {t.tourists: t.cost_dbl for t in compute(q).tiers}
    assert all(cheaper[n] < base[n] for n in base)
    q.days = 10  # one more day: guide, bus, meals, water and tips all follow
    longer = {t.tourists: t.cost_dbl for t in compute(q).tiers}
    assert all(longer[n] > cheaper[n] for n in base)


def test_no_leader_and_shared_leader_room():
    q = hm_preset()
    q.leaders = 0
    r = compute(q)
    assert r.tiers[0].label == "9"
    q.leaders, q.leader_single = 1, False
    shared = {t.tourists: t for t in compute(q).tiers}
    q.leader_single = True
    single = {t.tourists: t for t in compute(q).tiers}
    assert shared[19].cost_dbl < single[19].cost_dbl


def test_broken_lines_are_reported_not_priced():
    q = hm_preset()
    q.items[0].quantity = "days * unknown_thing"
    q.fx = {}
    r = compute(q)
    assert r.tiers == []
    assert any("unknown_thing" in e for e in r.errors)
    assert any("no exchange rate for GEL" in e for e in r.errors)


def test_rounding_modes():
    q = hm_preset()
    q.rounding_step, q.rounding_mode = Decimal(5), "ceil"
    assert all(t.price_dbl % 5 == 0 for t in compute(q).tiers)
    q.rounding_step = Decimal(0)
    t = compute(q).tiers[0]
    assert t.price_dbl == pytest.approx(t.cost_dbl + t.profit_pp, abs=0.006)


@pytest.mark.parametrize("expr,expected", [
    ("days * 2 - 4", 14), ("ceil(20 / 7)", 3), ("max(650 / 19, 34)", Decimal(650) / 19),
    ("558 if crossings == 2 else 316", 316), ("1.5 * 2", 3), ("min(1,2)", 1), ("", 0),
])
def test_formula_language(expr, expected):
    assert evaluate(expr, {"days": Decimal(9), "crossings": Decimal(1)}) == pytest.approx(expected)


@pytest.mark.parametrize("expr", ["__import__('os')", "days ** 99999", "().__class__", "open('x')", "x" * 400])
def test_formula_rejects_anything_else(expr):
    with pytest.raises(FormulaError):
        evaluate(expr, {"days": Decimal(9)})


@pytest.mark.parametrize("expr,code,param", [
    ("days * 2 - armenia_meal", "unknown_name", ("suggestion", "armenia_meals")),
    ("sqrt(days)", "unknown_function", ("name", "sqrt")),
    ("(days * 2", "brackets", ("opened", 1)),
    ("days *", "ends_early", None),
    ("1,5", "comma_decimal", None),
    ("days ** 2", "power", None),
    ("ceil(1, 2)", "bad_arguments", None),
    ("days / 0", "div_zero", None),
])
def test_formula_errors_say_what_to_fix(expr, code, param):
    with pytest.raises(FormulaError) as e:
        evaluate(expr, {"days": Decimal(9), "armenia_meals": Decimal(4)})
    assert e.value.code == code
    if param:
        assert e.value.params[param[0]] == param[1]


def test_price_steps_explain_the_price():
    from app.quote_engine import check_formula
    b = breakdown(excel_variant(), 19)
    s = b.steps
    assert s.leader_room == pytest.approx(738)
    assert s.shared_pp == pytest.approx((s.lines_total + s.leader_room) / 19)
    assert s.shared_pp + s.hotel_dbl_pp == pytest.approx(b.tier.cost_dbl)
    assert s.profit_rule == "group" and s.profit_group_pp == pytest.approx(650 / 19)   # 34.21 beats the 34 minimum
    assert breakdown(excel_variant(), 25).steps.profit_rule == "minimum"               # 26 < 34
    assert int(s.unrounded_dbl) == b.tier.price_dbl

    q = hm_preset()
    ok = check_formula(q, "days * 2 - armenia_meals", 19)
    assert ok.ok and [v.value for v in ok.values] == [14, 14, 14] and [v.tourists for v in ok.values] == [9, 19, 25]
    per_size = check_formula(q, "ceil(persons / 7)", 19)
    assert [v.value for v in per_size.values] == [2, 3, 4]
    names = {n.name: n for n in ok.names}
    assert names["armenia_meals"].note == "meals eaten in Armenia" and names["everyone"].builtin
    bad = check_formula(q, "days * 2 - armenia_meal", 19)
    assert not bad.ok and bad.error_code == "unknown_name" and bad.error_params["suggestion"] == "armenia_meals"
