"""Ready-made calculations agencies can start from.

"hm" reproduces GTC 360's HM Georgia–Armenia sheet (HM-2026行程0803_KA_CALC.xlsx,
SETUP + the 9+1 … 25+1 tabs) item by item. tests/test_quote_engine.py pins it to
the sheet's results for every group size.
"""
from decimal import Decimal as D

from .quote_schemas import QuoteIn

# Column headers / fixed phrases of the partner price list, per language.
# Agencies can override any of them per calculation, or add other languages.
PRICE_LIST_LABELS = {
    "en": {"col_group": "Number of adults", "col_dbl": "Double / Twin, per person", "col_sgl": "Single, per person",
           "col_supplement": "Single supplement", "col_vehicle": "Vehicle", "col_city": "City", "col_hotel": "Hotel",
           "adults_plus": "adults + {leaders}", "valid": "Valid", "currency": "Prices in {currency}",
           "included": "Included", "not_included": "Not included", "meals": "Meals",
           "col_trp": "Triple, per person", "col_quad": "Quad, per person", "col_room_dbl": "Double room", "col_room_sgl": "Single room",
           "col_room_trp": "Triple room", "col_room_quad": "Quad room", "per_person": "per person", "extras": "Optional extras, per person",
           "season_base": "Prices"},
    "zh": {"col_group": "成人人数", "col_dbl": "双人间/标间 每人", "col_sgl": "单人间 每人", "col_supplement": "单房差",
           "col_vehicle": "车型", "col_city": "城市", "col_hotel": "酒店", "adults_plus": "成人 + {leaders}",
           "valid": "有效期", "currency": "价格单位：{currency}", "included": "包含", "not_included": "不包含", "meals": "餐食",
           "col_trp": "三人间 每人", "col_quad": "四人间 每人", "col_room_dbl": "双人间 每间", "col_room_sgl": "单人间 每间",
           "col_room_trp": "三人间 每间", "col_room_quad": "四人间 每间", "per_person": "每人", "extras": "自费项目 每人", "season_base": "价格"},
    "ka": {"col_group": "ზრდასრულების რაოდენობა", "col_dbl": "ორადგილიანი, 1 ადამიანზე", "col_sgl": "ერთადგილიანი, 1 ადამიანზე",
           "col_supplement": "ერთადგილიანის დანამატი", "col_vehicle": "ტრანსპორტი", "col_city": "ქალაქი", "col_hotel": "სასტუმრო",
           "adults_plus": "ზრდასრული + {leaders}", "valid": "მოქმედებს", "currency": "ფასები {currency}-ში",
           "included": "შედის", "not_included": "არ შედის", "meals": "კვება",
           "col_trp": "სამადგილიანი, 1 ადამიანზე", "col_quad": "ოთხადგილიანი, 1 ადამიანზე", "col_room_dbl": "ორადგილიანი ნომერი",
           "col_room_sgl": "ერთადგილიანი ნომერი", "col_room_trp": "სამადგილიანი ნომერი", "col_room_quad": "ოთხადგილიანი ნომერი",
           "per_person": "1 ადამიანზე", "extras": "დამატებით, 1 ადამიანზე", "season_base": "ფასები"},
}


def _i(name, category, currency, price, quantity="1", basis="group", who="persons", **kw):
    return {"name": name, "category": category, "currency": currency, "unit_price": D(str(price)),
            "quantity": str(quantity), "basis": basis, "who": who, **kw}


BUS_TIERS = [{"max_pax": 12, "unit_price": D(350), "label": "17-seater minibus"},
             {"max_pax": 25, "unit_price": D(550), "label": "45-seater bus"}]
KM = "(km_route + km_reserve) / 100"


def hm_preset() -> QuoteIn:
    hotels = [("Tbilisi", "Hualing 5*", 75, 75), ("Kazbegi", "Suatis 5*", 103, 103), ("Kutaisi", "Kutaisi Inn 5*", 85, 85),
              ("Mestia", "Lilat 5*", 95, 95), ("Mestia", "Lilat 5*", 95, 95), ("Batumi", "GreenWood 5*", 85, 75),
              ("Borjomi", "Borjomi Likani 5*", 90, 90), ("Yerevan", "Radisson Blu Yerevan 5*", 135, 120)]
    tickets = [(4, "Tbilisi cable car", 6, "USD"), (5, "Gori Stalin Museum", 6, "USD"),
               (6, "Mestia History & Ethnography Museum", 6, "USD"), (8, "Black Sea boat (our gift)", 6, "USD"),
               (9, "Martvili Canyon", 50, "GEL"), (9, "Borjomi Central Park", 6, "USD"),
               (10, "Etchmiadzin Museum (our gift)", 6, "USD"), (10, "Zvartnots", 6, "USD"), (11, "Garni Temple", 6, "USD")]
    items = [
        _i("Guide", "guide", "USD", 150, "days"),
        _i("Bus", "transport", "GEL", 550, "days", tiers=BUS_TIERS, vehicle=True),
        _i("Fuel", "transport", "GEL", "3.6",
           tiers=[{"max_pax": 12, "quantity": f"{KM} * 17"}, {"max_pax": 25, "quantity": f"{KM} * 40"}],
           notes="Litres = km / 100 × consumption (17 L minibus, 40 L bus) at the fuel price"),
        _i("Meals in Georgia", "meal", "USD", "12.2", "days * 2 - armenia_meals - minus_meals", "per_person", "everyone",
           notes="Lunch and dinner, everyone incl. tour leader, driver and guide"),
        _i("Meals in Armenia", "meal", "USD", 15, "armenia_meals", "per_person", "everyone"),
        _i("Armenian border (1 crossing)", "border", "USD", 316, "1", included=True),
        _i("Armenian border (2 crossings)", "border", "USD", 558, "1", included=False),
        _i("Driver & guide overnights outside Tbilisi", "guide", "USD", 80, "staff_nights_outside_tbilisi"),
        _i("Driver & guide meals on free-meal days", "meal", "USD", 20, "free_meals", "per_person", "staff"),
        _i("Guide half day off", "guide", "USD", 150, "-0.5 * guide_half_days_off"),
        _i("Bus half day off", "transport", "GEL", 550, "-0.5 * bus_half_days_off", tiers=BUS_TIERS),
        _i("Bus extra day (empty return)", "transport", "GEL", 550, "bus_extra_days", tiers=BUS_TIERS),
        _i("Wi-Fi", "other", "GEL", 32),
        _i("Water", "other", "GEL", 1, "days", "per_person", "everyone"),
        _i("Delica Kazbegi", "transport", "USD", 25, "1", "per_vehicle", "persons", capacity=7, extra=1),
        _i("Delica Svaneti", "transport", "GEL", 250, "1", "per_vehicle", "persons", capacity=7, extra=1),
        *[_i(name, "ticket", cur, price, "1", "per_person", "persons", day=day) for day, name, price, cur in tickets],
        _i("Wine / chacha tasting", "activity", "USD", 12, "1", "per_person", "persons", included=False),
        _i("Dance show (always with a KTW visit)", "activity", "USD", 10, "1", "per_person", "persons"),
        _i("Tips: driver", "tips", "USD", 2, "days", "per_person", "tourists"),
        _i("Tips: guide", "tips", "USD", 2, "days", "per_person", "tourists"),
        _i("Azerbaijan part", "other", "USD", 354, "azerbaijan_days", "per_person", "tourists", included=False),
    ]
    return QuoteIn(
        name="HM Georgia–Armenia 2026", currency="USD", days=9, pax_min=9, pax_max=25,
        leaders=1, leader_single=True, staff=2,
        profit_group=D(650), profit_min_pp=D(34), margin_floor_pct=D(0), single_profit=True,
        rounding_mode="floor", rounding_step=D(1), fx={"GEL": D("2.65")},
        variables={"km_route": D(2800), "km_reserve": D(200), "armenia_meals": D(4), "minus_meals": D(0),
                   "staff_nights_outside_tbilisi": D(7), "free_meals": D(0), "guide_half_days_off": D(0),
                   "bus_half_days_off": D(0), "bus_extra_days": D(1), "azerbaijan_days": D(0)},
        variable_notes={
            "km_route": "km driven on the route", "km_reserve": "spare km for detours",
            "armenia_meals": "meals eaten in Armenia", "minus_meals": "meals the client skips",
            "staff_nights_outside_tbilisi": "driver and guide nights outside Tbilisi",
            "free_meals": "free-meal days (staff still eat)", "guide_half_days_off": "half days without the guide",
            "bus_half_days_off": "half days without the bus", "bus_extra_days": "empty bus days (return trips)",
            "azerbaijan_days": "days in Azerbaijan",
        },
        languages=["en", "zh", "ka"],
        texts={
            "en": {"title": "HM TOURS Georgia–Armenia 8 Nights", "meals": "Lunch & dinner included · breakfast always included",
                   "included": "Hotels, all meals as listed, bus, guide, entrance tickets, tips", "not_included": "Flights, visas, personal expenses"},
            "zh": {"title": "格鲁吉亚—亚美尼亚 8晚 HM 行程", "meals": "含午餐和晚餐 · 均含早餐",
                   "included": "酒店、所列餐食、旅游巴士、导游、景点门票、小费", "not_included": "机票、签证、个人消费"},
            "ka": {"title": "HM ტური საქართველო–სომხეთი 8 ღამე", "meals": "სადილი და ვახშამი შედის · საუზმე ყოველთვის შედის",
                   "included": "სასტუმროები, კვება, ავტობუსი, გიდი, ბილეთები, ჩაი", "not_included": "ავიაბილეთები, ვიზა, პირადი ხარჯები"},
        },
        nights=[{"city": c, "hotel_name": h, "currency": "USD", "price_dbl": D(dbl), "price_sgl": D(sgl)} for c, h, dbl, sgl in hotels],
        items=items,
    )


def zk_preset() -> QuoteIn:
    """ZK-1025 Georgia–Armenia, variant A (mountain road open), 8 nights: the agency's "260829 Finale"
    sheet (ZK-1025_8Nights_CALC.xlsx, SETUP + the 8+1 … 25+1 tabs). Its pins are in tests/test_quote_zk.py."""
    hotels = [("Tbilisi", "Hualing 5*", 75, 75), ("Gudauri", "Marco Polo 5*", 70, 65), ("Kutaisi", "Kutaisi Inn 5*", 85, 85),
              ("Batumi", "GreenWood 5*", 85, 75), ("Borjomi", "Borjomi Likani 5*", 97, 97),
              ("Yerevan", "Radisson Blu Yerevan 5*", 135, 120), ("Yerevan", "Radisson Blu Yerevan 5*", 135, 120),
              ("Tbilisi", "Hualing 5*", 75, 75)]
    tickets = [(5, "Gori Stalin Museum"), (7, "Borjomi mineral water park"), (8, "Vardzia"), (9, "Zvartnots"),
               (9, "Etchmiadzin Museum (our gift)"), (10, "Garni Temple"), (11, "Chronicle of Georgia"),
               (11, "Tbilisi cable car")]
    items = [
        _i("Guide", "guide", "USD", 170, "days"),
        _i("Bus", "transport", "GEL", 550, "days", tiers=BUS_TIERS, vehicle=True),
        _i("Fuel", "transport", "GEL", 5,
           tiers=[{"max_pax": 12, "quantity": f"{KM} * 17"}, {"max_pax": 25, "quantity": f"{KM} * 40"}],
           notes="Litres = km / 100 × consumption (17 L minibus, 40 L bus) at the diesel price"),
        _i("Meals in Georgia", "meal", "USD", "12.5", "days * 2 - armenia_meals - minus_meals", "per_person", "everyone",
           notes="Lunch and dinner, everyone incl. tour leader, driver and guide"),
        _i("Meals in Armenia", "meal", "USD", 15, "armenia_meals", "per_person", "everyone"),
        _i("Armenian border (2 crossings)", "border", "USD", 650, "1"),
        _i("Armenian border (1 crossing, flying out of Yerevan)", "border", "USD", 370, "1", included=False),
        _i("Driver & guide overnights outside Tbilisi", "guide", "USD", 80, "staff_nights_outside_tbilisi"),
        _i("Driver & guide meals on free-meal days", "meal", "USD", 20, "free_meals", "per_person", "staff"),
        _i("Guide half day off", "guide", "USD", 170, "-0.5 * guide_half_days_off"),
        _i("Bus half day off", "transport", "GEL", 550, "-0.5 * bus_half_days_off", tiers=BUS_TIERS),
        _i("Bus extra day (empty return)", "transport", "GEL", 550, "bus_extra_days", tiers=BUS_TIERS),
        _i("Wi-Fi", "other", "GEL", 32),
        _i("Water", "other", "GEL", 1, "days", "per_person", "everyone"),
        _i("Delica Kazbegi", "transport", "USD", 25, "1", "per_vehicle", "persons", capacity=7, extra=1),
        _i("Delica Svaneti", "transport", "GEL", 250, "1", "per_vehicle", "persons", capacity=7, extra=1, included=False),
        *[_i(name, "ticket", "USD", 6, "1", "per_person", "persons", day=day) for day, name in tickets],
        _i("Wine / chacha tasting", "activity", "USD", 12, "1", "per_person", "persons", included=False),
        _i("Dance show (always with a KTW visit)", "activity", "USD", 10, "1", "per_person", "persons"),
        _i("Tips: driver", "tips", "USD", 2, "days", "per_person", "tourists"),
        _i("Tips: guide", "tips", "USD", 2, "days", "per_person", "tourists"),
        _i("Azerbaijan part", "other", "USD", 354, "azerbaijan_days", "per_person", "tourists", included=False),
    ]
    return QuoteIn(
        name="ZK-1025 Georgia–Armenia, 8 nights (A)", currency="USD", days=9, pax_min=8, pax_max=25,
        leaders=1, leader_single=True, staff=2,
        profit_group=D(950), profit_min_pp=D(50), margin_floor_pct=D(7), single_profit=False,
        rounding_mode="floor", rounding_step=D(1), fx={"GEL": D("2.55")},
        variables={"km_route": D(2493), "km_reserve": D(200), "armenia_meals": D(4), "minus_meals": D(3),
                   "staff_nights_outside_tbilisi": D(6), "free_meals": D(3), "guide_half_days_off": D(0),
                   "bus_half_days_off": D(0), "bus_extra_days": D(0), "azerbaijan_days": D(0)},
        variable_notes={
            "km_route": "km driven on the route", "km_reserve": "spare km for detours",
            "armenia_meals": "meals eaten in Armenia", "minus_meals": "meals the client pays for himself",
            "staff_nights_outside_tbilisi": "driver and guide nights outside Tbilisi",
            "free_meals": "meals the client pays for himself (driver and guide still eat)",
            "guide_half_days_off": "half days without the guide", "bus_half_days_off": "half days without the bus",
            "bus_extra_days": "empty bus days (return trips)", "azerbaijan_days": "days in Azerbaijan",
        },
        languages=["en", "zh", "ka"],
        texts={
            "en": {"title": "ZK TOURS Georgia–Armenia 8 Nights", "meals": "Lunch & dinner included · breakfast always included",
                   "included": "Hotels, all meals as listed, bus, guide, entrance tickets, tips", "not_included": "Flights, visas, personal expenses"},
            "zh": {"title": "格鲁吉亚—亚美尼亚 8晚 ZK 行程", "meals": "含午餐和晚餐 · 均含早餐",
                   "included": "酒店、所列餐食、旅游巴士、导游、景点门票、小费", "not_included": "机票、签证、个人消费"},
            "ka": {"title": "ZK ტური საქართველო–სომხეთი 8 ღამე", "meals": "სადილი და ვახშამი შედის · საუზმე ყოველთვის შედის",
                   "included": "სასტუმროები, კვება, ავტობუსი, გიდი, ბილეთები, ჩაი", "not_included": "ავიაბილეთები, ვიზა, პირადი ხარჯები"},
        },
        nights=[{"city": c, "hotel_name": h, "currency": "USD", "price_dbl": D(dbl), "price_sgl": D(sgl)} for c, h, dbl, sgl in hotels],
        items=items,
    )


def blank_preset() -> QuoteIn:
    return QuoteIn(name="New calculation", currency="USD", days=8, pax_min=10, pax_max=25, leaders=1, staff=2,
                   profit_min_pp=D(30), languages=["en"], texts={"en": {"title": ""}},
                   items=[_i("Guide", "guide", "USD", 0, "days"), _i("Bus", "transport", "USD", 0, "days", vehicle=True),
                          _i("Meals", "meal", "USD", 0, "days * 2", "per_person", "everyone")])


PRESETS = {"hm": hm_preset, "zk": zk_preset, "blank": blank_preset}
