"""The people who travel free with a group (19+1): the tour leader and the driver/guide. Their rooms and
meals are part of the group cost, split over the paying tourists - wherever and however they sleep and eat."""
from decimal import Decimal as D

import pytest

from app.budget import snapshot
from app.quote_engine import breakdown, compute
from app.quote_schemas import QuoteIn, QuoteItemIn, QuoteNightIn


def calc(**kw) -> QuoteIn:
    base = dict(name="T", currency="USD", days=2, pax_min=10, pax_max=40, leaders=1, staff=2, rounding_step=0,
                nights=[QuoteNightIn(city="Tbilisi", hotel_name="Group Hotel", currency="USD", price_dbl=D(100), price_sgl=D(80))],
                items=[])
    base.update(kw)
    return QuoteIn(**base)


def steps(q, n=19):
    return breakdown(q, n).steps


def test_leader_room_single_shared_or_free():
    assert steps(calc(leader_room="single")).leader_room == 80
    assert steps(calc(leader_room="shared")).leader_room == 50       # half a double, sharing with a tourist
    assert steps(calc(leader_room="free")).leader_room == 0          # the hotel gives it
    # Older calculations: leader_single still decides.
    assert steps(calc(leader_single=False)).leader_room == 50


def test_free_leader_per_x_tourists():
    q = calc(leaders=1, leaders_per=15)
    tiers = {t.tourists: t for t in compute(q).tiers}
    assert tiers[19].label == "19+1" and tiers[30].label == "30+2" and tiers[10].label == "10+1"
    assert q.tourists_in(32) == 30 and q.tourists_in(20) == 19


def test_staff_hotel_per_night():
    same = calc(nights=[QuoteNightIn(city="Kazbegi", hotel_name="Rooms", currency="USD", price_dbl=D(100), price_sgl=D(80), staff_stay="same")])
    assert steps(same).staff_room == 160                        # 2 singles in the group's hotel
    twin = calc(nights=[QuoteNightIn(city="Kazbegi", currency="USD", price_dbl=D(100), price_sgl=D(80), staff_stay="same", staff_twin=True)])
    assert steps(twin).staff_room == 100                        # one double for both
    own = calc(nights=[QuoteNightIn(city="Kazbegi", currency="USD", price_dbl=D(100), price_sgl=D(80),
                                    staff_stay="own", staff_hotel="Guest house", staff_price=D(30))])
    assert steps(own).staff_room == 60                          # another hotel / staff price, per room
    free = calc(nights=[QuoteNightIn(city="Kazbegi", currency="USD", price_dbl=D(100), price_sgl=D(80), staff_stay="free")])
    assert steps(free).staff_room == 0
    # It's in the price: split over the paying tourists.
    plain = compute(calc()).tiers[9].cost_dbl
    assert abs(compute(own).tiers[9].cost_dbl - plain - 60 / 19) < 0.01
    # Missing staff price is an error, not a silent 0.
    broken = calc(nights=[QuoteNightIn(city="K", currency="USD", price_dbl=D(100), staff_stay="own")])
    assert compute(broken).errors and not compute(broken).tiers


def test_staff_table():
    # 19 tourists at the group table (25), leader + driver + guide at the staff table (15).
    q = calc(items=[
        QuoteItemIn(name="Dinner · group", category="meal", currency="USD", unit_price=D(25), basis="per_person", who="tourists"),
        QuoteItemIn(name="Dinner · staff table", category="meal", currency="USD", unit_price=D(15), basis="per_person", who="crew"),
    ])
    b = breakdown(q, 19)
    assert [i.amount for i in b.items] == [D(475), D(45)]


def test_budget_has_staff_rooms_and_leader_count():
    q = calc(leaders_per=15, leader_room="free",
             nights=[QuoteNightIn(city="K", hotel_name="Rooms", currency="USD", price_dbl=D(100), price_sgl=D(80),
                                  staff_stay="own", staff_hotel="Guest house", staff_price=D(30))])
    snap = snapshot(q, 30, {"USD": D(1)})
    hotel, staff = snap.lines[0], snap.lines[1]
    assert hotel.unit_price == 1500 and "2 Tour leader free room" in hotel.notes
    assert staff.name == "Staff · Guest house · night 1" and staff.quantity == 2 and staff.unit_price == 30


def test_staff_allowance_per_person_and_home_city_nights():
    # 40 per person per night: they find their own hotel; nothing at home (Tbilisi).
    q = calc(nights=[QuoteNightIn(city="Tbilisi", currency="USD", price_dbl=D(100), price_sgl=D(80), staff_stay="none"),
                     QuoteNightIn(city="Kazbegi", currency="USD", price_dbl=D(100), price_sgl=D(80), staff_stay="allowance", staff_price=D(40))])
    assert steps(q).staff_room == 80                      # 2 staff × 40, one night
    snap = snapshot(q, 19, {"USD": D(1)})
    line = next(x for x in snap.lines if x.name.startswith("Staff allowance"))
    assert line.quantity == 2 and line.unit_price == 40
    broken = calc(nights=[QuoteNightIn(city="K", currency="USD", price_dbl=D(100), staff_stay="allowance")])
    assert "allowance" in compute(broken).errors[0]


def test_an_allowance_in_another_currency():
    q = calc(currency="GEL", fx={"USD": D("0.37")},
             nights=[QuoteNightIn(city="K", currency="GEL", price_dbl=D(200), price_sgl=D(150), staff_stay="allowance",
                                  staff_price=D(40), staff_currency="USD")])
    assert steps(q).staff_room == pytest.approx(2 * 40 / 0.37)
