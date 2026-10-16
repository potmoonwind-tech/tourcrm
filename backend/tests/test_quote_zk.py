"""The "zk" preset against the agency's own "260829 Finale" sheets.

ZK holds, per group size, what ZK-1025_8Nights_CALC.xlsx computes, and ZS what
ZS-1028_9Nights_CALC.xlsx does (same template, another tour): cost per person DBL = N48,
cost per person SGL = O48, sale DBL = N52, group cost without hotels = M44, price list =
ROUNDDOWN(N52) = SETUP!J27…J44. The sheets put no profit on single rooms.
"""
from decimal import Decimal

import pytest

from app.quote_engine import breakdown, compute
from app.quote_presets import PRESETS, zk_preset
from app.quote_schemas import QuoteIn

ZK = {
    8: (1467.1042, 1800.6042, 1585.8542, 8708.8333, 1585), 9: (1378.9292, 1712.4292, 1484.4847, 9003.8627, 1484), 10: (1308.3892, 1641.8892, 1403.3892, 9298.8922, 1403),
    11: (1250.6747, 1584.1747, 1338.2219, 9593.9216, 1338), 12: (1202.5792, 1536.0792, 1286.7598, 9888.9510, 1286), 13: (1311.5271, 1645.0271, 1403.3340, 12129.3529, 1403),
    14: (1265.9559, 1599.4559, 1354.5728, 12424.3824, 1354), 15: (1226.4608, 1559.9608, 1312.3130, 12719.4118, 1312), 16: (1191.9026, 1525.4026, 1275.3358, 13014.4412, 1275),
    17: (1161.4100, 1494.9100, 1242.7087, 13309.4706, 1242), 18: (1134.3056, 1467.8056, 1213.7069, 13604.5000, 1213), 19: (1110.0542, 1443.5542, 1187.7580, 13899.5294, 1187),
    20: (1089.4779, 1422.9779, 1165.7414, 14219.5588, 1165), 21: (1069.6709, 1403.1709, 1144.5478, 14514.5882, 1144), 22: (1051.6644, 1385.1644, 1125.2809, 14809.6176, 1125),
    23: (1035.2238, 1368.7238, 1107.6895, 15104.6471, 1107), 24: (1020.1532, 1353.6532, 1091.5639, 15399.6765, 1091), 25: (1006.2882, 1339.7882, 1076.7284, 15694.7059, 1076),
}
ZS = {
    8: (1561.8211, 1932.8211, 1680.5711, 9166.5686, 1680), 9: (1468.4989, 1839.4989, 1574.0545, 9472.4902, 1574), 10: (1393.8412, 1764.8412, 1491.4101, 9778.4118, 1491),
    11: (1332.7576, 1703.7576, 1426.0506, 10084.3333, 1426), 12: (1281.8546, 1652.8546, 1371.5844, 10390.2549, 1371), 13: (1394.0090, 1765.0090, 1491.5897, 12714.1176, 1491),
    14: (1346.0028, 1717.0028, 1440.2230, 13020.0392, 1440), 15: (1304.3974, 1675.3974, 1395.7052, 13325.9608, 1395), 16: (1267.9926, 1638.9926, 1356.7521, 13631.8824, 1356),
    17: (1235.8708, 1606.8708, 1322.3818, 13937.8039, 1322), 18: (1207.3181, 1578.3181, 1291.8303, 14243.7255, 1291), 19: (1181.7709, 1552.7709, 1264.4949, 14549.6471, 1264),
    20: (1160.0284, 1531.0284, 1241.2304, 14880.5686, 1241), 21: (1139.1662, 1510.1662, 1218.9078, 15186.4902, 1218), 22: (1120.2005, 1491.2005, 1198.6146, 15492.4118, 1198),
    23: (1102.8841, 1473.8841, 1180.0859, 15798.3333, 1180), 24: (1087.0106, 1458.0106, 1163.1014, 16104.2549, 1163), 25: (1072.4071, 1443.4071, 1147.4756, 16410.1765, 1147),
}


def zs_variant() -> QuoteIn:
    """ZS-1028, 9 nights: one more day and a last night in Tbilisi, a different route, no Chronicle of Georgia."""
    q = zk_preset()
    q.days = 10
    q.variables.update(km_route=Decimal(2480), minus_meals=Decimal(4), free_meals=Decimal(2))
    q.nights.append(q.nights[0].model_copy())
    q.items = [i for i in q.items if i.name != "Chronicle of Georgia"]
    return q


@pytest.mark.parametrize("quote, sheet", [(zk_preset, ZK), (zs_variant, ZS)], ids=["ZK-1025", "ZS-1028"])
def test_reproduces_the_spreadsheet_for_every_group_size(quote, sheet):
    result = compute(quote())
    assert result.errors == []
    assert [t.tourists for t in result.tiers] == list(range(8, 26))
    for t in result.tiers:
        cost_dbl, cost_sgl, sale_dbl, _, price_list = sheet[t.tourists]
        assert t.cost_dbl == pytest.approx(cost_dbl, abs=0.001), t.label
        assert t.cost_sgl == pytest.approx(cost_sgl, abs=0.001), t.label
        assert t.cost_dbl + t.profit_pp == pytest.approx(sale_dbl, abs=0.001), t.label
        assert t.price_dbl == price_list, t.label
        assert t.price_sgl == int(cost_sgl), t.label   # single = cost only, rounded down
    by_n = {t.tourists: t for t in result.tiers}
    assert by_n[12].vehicle == "17-seater minibus" and by_n[13].vehicle == "45-seater bus"
    assert by_n[19].label == "19+1"


@pytest.mark.parametrize("quote, sheet", [(zk_preset, ZK), (zs_variant, ZS)], ids=["ZK-1025", "ZS-1028"])
def test_group_cost_without_hotels_matches_sheet(quote, sheet):
    for n in (8, 12, 13, 19, 25):
        b = breakdown(quote(), n)
        assert float(sum(i.amount for i in b.items)) + b.leader_room == pytest.approx(sheet[n][3], abs=0.001)


def test_breakdown_shows_each_line_like_the_19_plus_1_sheet():
    amounts = {i.name: i.amount for i in breakdown(zk_preset(), 19).items}
    assert amounts["Guide"] == pytest.approx(1530)                                     # M12
    assert amounts["Bus"] == pytest.approx(1941.1765, abs=1e-3)                         # M13
    assert amounts["Meals in Georgia"] == pytest.approx(3850 - 825)                     # M15 + M29 (minus meals)
    assert amounts["Meals in Armenia"] == pytest.approx(1320)                           # M17
    assert amounts["Armenian border (2 crossings)"] == pytest.approx(650)               # M19
    assert amounts["Driver & guide overnights outside Tbilisi"] == pytest.approx(480)  # M21
    assert amounts["Fuel"] == pytest.approx(2112.1569, abs=1e-3)                        # M23
    assert amounts["Driver & guide meals on free-meal days"] == pytest.approx(120)     # M27
    assert amounts["Delica Kazbegi"] == pytest.approx(75)                               # M36: 3 cars
    assert amounts["Dance show (always with a KTW visit)"] == pytest.approx(200)       # M41
    assert amounts["Tips: driver"] + amounts["Tips: guide"] == pytest.approx(684)      # M42
    tickets = sum(v for k, v in amounts.items() if k in {i.name for i in zk_preset().items if i.category == "ticket"})
    assert tickets == pytest.approx(960)                                                # M38
    assert breakdown(zk_preset(), 19).leader_room == pytest.approx(712)                 # M25 = Σ single rooms


def test_profit_is_the_best_of_group_minimum_and_seven_percent():
    by_n = {t.tourists: t for t in compute(zk_preset()).tiers}
    assert by_n[8].profit_pp == pytest.approx(950 / 8)                  # group profit wins on small groups
    assert by_n[19].profit_pp == pytest.approx(ZK[19][0] * 0.07)        # the 7% floor wins from 11 up


def test_offered_as_a_preset():
    assert PRESETS["zk"]().name.startswith("ZK-1025")
