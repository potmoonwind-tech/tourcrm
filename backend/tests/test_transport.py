"""The transport block: vehicles chosen by group size (or fixed), rent per day, fuel by distance -
checked against the HM spreadsheet, which does it with formulas."""
from datetime import date
from decimal import Decimal as D

import pytest

from app.quote_engine import breakdown, compute, vehicles_for, with_transport
from app.quote_presets import hm_preset
from app.quote_schemas import TransportPlan, Vehicle, VehicleCount

MINI = Vehicle(id="mini", name="17-seater minibus", seats=17, day_price=D(350), currency="GEL", fuel_l_100km=D(17), max_pax=12)
BUS = Vehicle(id="bus", name="45-seater bus", seats=45, day_price=D(550), currency="GEL", fuel_l_100km=D(40), max_pax=25)


def hm_with_block():
    """The HM preset with its bus, fuel and extra-day lines replaced by the transport block."""
    q = hm_preset()
    q.items = [i for i in q.items if i.name not in ("Bus", "Fuel", "Bus extra day (empty return)", "Bus half day off")]
    q.transport = TransportPlan(vehicles=[MINI, BUS], km=D(2800), extra_km=D(200), extra_days=D(1),
                                fuel_price=D("3.6"), fuel_currency="GEL", fuel_date=date(2026, 9, 15))
    return q


def test_same_prices_as_the_spreadsheet_for_every_group_size():
    old = {t.tourists: t for t in compute(hm_preset()).tiers}
    new = {t.tourists: t for t in compute(hm_with_block()).tiers}
    for n in range(9, 26):
        assert new[n].cost_dbl == pytest.approx(old[n].cost_dbl, abs=0.01), n
        assert new[n].price_dbl == old[n].price_dbl, n
    assert new[12].vehicle == "17-seater minibus" and new[13].vehicle == "45-seater bus"


def test_lines_say_what_they_are():
    b = breakdown(hm_with_block(), 19)
    names = {i.name: i.amount for i in b.items if i.name.startswith(("45-seater", "Fuel", "17-seater"))}
    assert names["45-seater bus · 10 days"] == pytest.approx(5500 / 2.65, abs=0.01)
    assert names["Fuel · 45-seater bus · 3000 km"] == pytest.approx(3000 / 100 * 40 * 3.6 / 2.65, abs=0.01)
    assert names["17-seater minibus · 10 days"] == 0          # not used at 19


def test_two_buses_or_a_car_and_a_minibus():
    q = hm_with_block()
    car = Vehicle(id="car", name="Sedan", seats=3, day_price=D(150), currency="GEL", fuel_l_100km=D(8))
    q.transport.vehicles.append(car)
    q.transport.mode, q.transport.fixed = "fixed", [VehicleCount(vehicle_id="bus", count=2)]
    assert vehicles_for(q, 19) == [(BUS, 2)]
    two = {t.tourists: t for t in compute(q).tiers}
    q.transport.fixed = [VehicleCount(vehicle_id="car"), VehicleCount(vehicle_id="mini")]
    mixed = {t.tourists: t for t in compute(q).tiers}
    assert two[19].vehicle == "2 × 45-seater bus" and mixed[19].vehicle == "Sedan + 17-seater minibus"
    assert two[19].cost_dbl > mixed[19].cost_dbl


def test_without_size_ranges_the_smallest_vehicle_that_fits():
    q = hm_with_block()
    q.transport.vehicles = [MINI.model_copy(update={"max_pax": None}), BUS.model_copy(update={"max_pax": None})]
    assert vehicles_for(q, 12)[0][0].id == "mini"           # 12 + leader + guide = 14 seats
    assert vehicles_for(q, 16)[0][0].id == "bus"            # 18 seats
    q.transport.vehicles = [MINI.model_copy(update={"max_pax": None})]
    assert vehicles_for(q, 25)[0][1] == 2                    # 27 seats: two minibuses


def test_no_plan_no_change():
    q = hm_preset()
    assert with_transport(q) is q


def test_our_way_brings_the_vehicles_and_the_route_its_km(make_client):
    from .test_tours import agency, mk
    c, base, _ = agency(make_client)
    coach = mk(c, f"{base}/vendors", {"name": "Coach Co", "type": "transport"})
    svc = c.put(f"{base}/vendors/{coach['id']}/services", json=[{"name": "Coach", "category": "transport", "unit": "vehicle_day",
                                                                "rates": [{"price": "550", "currency": "GEL"}]}]).json()
    bus = [{"service_id": svc[0]["id"]}]         # the coach every day: the trip's main vehicle
    route = mk(c, f"{base}/series", {"code": "R", "days": [{"city": "Tbilisi", "km": 40, "extras": bus},
                                                          {"city": "Kutaisi", "km": 230, "extras": bus}, {"city": "Tbilisi", "km": 230, "extras": bus}]})
    style = {"transport": {"vehicles": [m.model_dump(mode="json") for m in (MINI, BUS)], "fuel_price": "3.6", "fuel_currency": "GEL",
                           "fuel_date": "2026-09-15", "extra_km": "100"}}
    assert c.put(f"{base}/calc-style", json=style).status_code == 200
    q = c.post(f"{base}/quotes", json={"preset": "blank", "series_id": route["id"], "on_date": "2026-11-01"}).json()
    assert float(q["transport"]["km"]) == 500 and len(q["transport"]["vehicles"]) == 2
    assert not [i for i in q["items"] if i["category"] == "transport"]        # no double bus
    from app.quote_schemas import QuoteIn
    doc = QuoteIn.model_validate({k: v for k, v in q.items() if k not in ("id", "updated_at", "version", "result", "notices")})
    if doc.currency != "GEL":
        doc.fx["GEL"] = D("2.65")       # the agency prices in another currency; the bus company in GEL
    t = next(x for x in compute(doc).tiers if x.tourists == 19)
    assert t.vehicle == "45-seater bus"


def test_the_plan_names_the_vehicle_even_next_to_an_old_bus_line():
    q = hm_with_block()
    old = hm_preset().items[1]          # the preset's "Bus" line, marked as the vehicle
    q.items.insert(0, old)
    assert {t.tourists: t for t in compute(q).tiers}[19].vehicle == "45-seater bus"
