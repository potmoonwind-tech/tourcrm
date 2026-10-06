"""Older calculations (plain profit and people fields) written the new way, only when no price changes."""
from decimal import Decimal

from app.calc_convert import convert, explicit, is_legacy, same_prices
from app.quote_engine import compute
from app.quote_presets import hm_preset


def test_older_calculation_converts_with_the_same_prices():
    q = hm_preset()
    assert is_legacy(q)
    new = convert(q, "ka")
    assert new is not None and not is_legacy(new)
    assert [p.id for p in new.people] == ["tourists", "leaders", "staff"]
    assert new.people[0].name == "გადამხდელი ტურისტები"
    assert [s.kind for s in new.recipe] == ["profit", "round"]
    assert [t.price_dbl for t in compute(new).tiers] == [t.price_dbl for t in compute(q).tiers]


def test_no_profit_on_single_rooms_converts_too():
    q = hm_preset()
    q.single_profit = False
    new = convert(q)
    assert new is not None and same_prices(q, new)


def test_free_leaders_every_19_keep_their_count():
    q = hm_preset()
    q.leaders_per = 19
    new = convert(q)
    assert new is not None
    assert [t.label for t in compute(new).tiers] == [t.label for t in compute(q).tiers]


def test_new_calculation_is_left_alone():
    assert convert(explicit(hm_preset())) is None


def test_a_calculation_whose_price_would_change_stays_as_it_is():
    q = hm_preset()
    q.leaders_per, q.leaders = 1, 0          # older calculations stop at 10 free places, the new way does not
    q.pax_min, q.pax_max = 40, 40
    assert not same_prices(q, explicit(q))
    assert convert(q) is None


def test_margin_floor_and_minimum_carry_over():
    q = hm_preset()
    q.margin_floor_pct, q.profit_min_pp = Decimal(30), Decimal(500)
    new = convert(q)
    assert new is not None and new.recipe[0].value == Decimal(30) and new.recipe[0].min_pp == Decimal(500)


def test_a_scenario_changes_the_price_of_a_converted_calculation_the_same_way():
    from app.quote_diff import apply_patch
    from app.quote_schemas import ScenarioPatch
    q = hm_preset()
    patch = ScenarioPatch.model_validate({"settings": {"profit_group": 5000, "leaders": 2, "leader_single": False,
                                                       "rounding_step": 10, "staff": 3}})
    old, _ = apply_patch(q, patch)
    new, _ = apply_patch(convert(q), patch)
    assert same_prices(old, new)
    assert compute(new).tiers[0].price_dbl != compute(convert(q)).tiers[0].price_dbl
