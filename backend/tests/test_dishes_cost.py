"""What a meal costs: shared priced dishes by their plates (table by table); else the price per person."""
from decimal import Decimal

from app import dishes


def test_a_set_menu_with_unpriced_dishes_costs_its_price_per_person():
    ds = [{"name": "Mtsvadi", "price": None, "per_plate": 5}, {"name": "Lavash", "price": None, "per_plate": 2}]
    total, pp, by_plates = dishes.meal_cost(Decimal("45"), None, 19, 3, [19, 3], ds, None, 1)
    assert (total, pp, by_plates) == (Decimal("990.00"), Decimal("45"), False)
    total, _, _ = dishes.meal_cost(Decimal("45"), Decimal("30"), 19, 3, [19, 3], ds, None, 1)      # the staff price
    assert total == Decimal("945.00")


def test_shared_plates_are_counted_table_by_table_so_both_tables_eat():
    ds = [{"name": "Khinkali", "price": 20, "per_plate": 2}, {"name": "Wine", "price": 10, "per_plate": 1}]
    total, pp, by_plates = dishes.meal_cost(Decimal("40"), None, 19, 3, [19, 3], ds, None, 1)
    # Khinkali: 10 plates for the 19 + 2 for the 3 = 12 (not 11 for 22 together); wine one each: 22.
    assert by_plates and total == Decimal(20 * 12 + 10 * 22) and pp == (total / 22).quantize(Decimal("0.01"))


def test_one_portion_each_keeps_the_menu_price():
    ds = [{"name": "Soup", "price": 8}, {"name": "Mtsvadi", "price": 30}]
    assert dishes.meal_cost(Decimal("40"), None, 12, 0, [12], ds, None, 1) == (Decimal("480.00"), Decimal("40"), False)
    assert dishes.meal_cost(None, None, 12, 0, [12], ds, None, 1)[0] == Decimal(38 * 12)        # no menu price: the dishes


def test_unknown_when_nothing_is_priced():
    assert dishes.meal_cost(None, None, 10, 0, [10], [{"name": "Soup", "price": None}], None, 1) == (None, None, False)
