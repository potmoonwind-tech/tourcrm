"""Stage 2 of the Sachiku move: export.json → a new TourCRM agency "Sachiku".

    python import_sachiku.py            dry run: what would be created, what didn't match (nothing written)
    python import_sachiku.py --commit   create the agency and everything in it

Runs in TourCRM's backend environment (its models and database)."""
import datetime as dt
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
BACKEND = Path(r"C:\Users\potmoon\Desktop\crm\tourcrm\backend")
sys.path.insert(0, str(BACKEND))
import os  # noqa: E402

os.chdir(BACKEND)
from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import (Client, ClientPayment, ExchangeRate, Invoice, InvoiceLine, Series, SeriesDay, Service,  # noqa: E402
                        ServiceRate, StaffAssignment, Tour, TourCost, TourDay, User, Vendor, VendorBill,
                        VendorPayment)
from app.services import create_workspace  # noqa: E402

COMMIT = "--commit" in sys.argv
OWNER_EMAIL = "silkroad.owner@example.com"
X = json.loads((HERE / "export.json").read_text(encoding="utf-8"))
TODAY = dt.date(2026, 10, 4)
NOTES: list[str] = []
UNMATCHED = Counter()


def d(s):
    return dt.date.fromisoformat(s) if s else None


def low(s):
    return (s or "").lower().strip()


# ===== suppliers: one name per real supplier ===================================================

class Sup:
    def __init__(self, name, type_, city=""):
        self.name, self.type, self.city = name, type_, city
        self.phone = self.phone2 = ""
        self.aliases: set[str] = set()
        self.notes: list[str] = []
        self.prices: dict = {}       # code -> list of (price, currency)
        self.menu: list | None = None
        self.payment = None
        self.id = None


SUPS: dict[str, Sup] = {}
USES = Counter()
# Typos and variants seen in the sheets → one supplier.
ALIAS = {
    "მალრკო პოლო": "Marco Polo Gudauri", "მარლო პოლო": "Marco Polo Gudauri", "გუადური ლოჯი": "Gudauri Lodge", "გუდაური ლოდჯ": "Gudauri Lodge",
    "ბათუმი ბესთვესტერნი": "Best Western Batumi", "ქროუნ პლაზა ბორჯომი": "Crowne Plaza Borjomi", "რუმსი ყაზბეგი": "Rooms Hotel Kazbegi",
    "ასტორია": "Pine Astoria Tbilisi", "აღაბაბაინაი": "Aghababyan's Yerevan", "ქუთაისი ინნ": "Kutaisi Inn", "ქუთაიისი ინნ": "Kutaisi Inn",
    "დორმიტორი": "Hualing Tbilisi", "დორმითორი": "Hualing Tbilisi", "ახალია აზია": "ახალი აზია (ისანი)", "ახალი აზია ისანი": "ახალი აზია (ისანი)",
    "ფერაძეების მარანი": "ფერაძეები", "ქორნერი/ორი ტონა": "ორი ტონა", "2 ტონა": "ორი ტონა",
    "ჩინური ძინ ჩაო": "ძინ ჩაო", "ჩინური hot pot": "Hot pot (Chinese)", "ჩინური ჰოტ პოტი": "Hot pot (Chinese)", "ჩინური": "Chinese restaurant (not named)",
    "პროგრამა ქართული რესტორანი.": "პროგრამა ქართული რესტორანი", "მარნის ცეკვის შოუ": "Wine cellar + dance show",
    "მარნის დეგუსტაცია + ცეკვის შოუ": "Wine cellar + dance show",
    "ხინკალი": "Meals (other)", "ხაჭაპური + მწვადი": "Meals (other)", "ბათუმი": "Meals (other)", "ქუთაისი": "Meals (other)", "რიგი": "Meals (other)",
    "კვება": "Meals (other)", "კვება მარიამი": "Meals (other)", "1 სტუმრის კვება ჩინური": "Meals (other)", "საკუთარი ხარჯებით": "Meals (other)",
    "ფელინგერი": "Felinger", "FELINGER": "Felinger", "სტამბა": "Stalin Underground Printing House", "სვანეთის მუზეომი": "Svaneti Museum",
    "მუზეომები": "Museums (other)", "რაბათი": "Rabati Akhaltsikhe", "ახალციხის რაბათი": "Rabati Akhaltsikhe", "ტაქსი ბორჯომამდე": "Taxis",
    "ტრანსფერი": "Transfers", "ზეზვა ტრანსფერი": "Transfers", "ტრანსფერი ზეზვა": "Transfers", "სტუმრების ჩამოყვანა": "Transfers",
    "ტრანსპორტი": "Transfers", "სვანეთში ტრანსპორტირება": "Transfers", "ლილატში გიდის და აყვანა": "Transfers",
    "ბენზინი": "Fuel (other)", "დიმიტრი ბეზინი": "Fuel (other)", "იოსები გოგნიაშვილი": "იოსებ გოგნიაშვილი", "ლევანი სვიმონიშვილი": "ლევან სვიმონიშვილი",
    "თარჯიმანი გიორგი": "Interpreter Giorgi", "ბანკომატიდან გამოტანა": "Cash withdrawals", "ბანკომატიდან გამოტანები": "Cash withdrawals",
    "კურსთაშორის სხვაობა": "Exchange difference", "0.01": "Other", "ავანსი ჯონის ბილეთებისთვის": "Tickets (other)", "ბილეთების გადაცვლა": "Tickets (other)",
    "ბილეთი": "Tickets (other)", "სომხეთს ბილეთები": "Armenia partner (სომხეთი)", "wyndham Batumi": "Wyndham Batumi", "ამბასადორი": "Ambassadori Tbilisi",
    "გოგიტა თარალიშვილი": "გოგიტა თარალაშვილი", "გოგიტა": "გოგიტა თარალაშვილი", "როინ კიკაძე": "როინ კიკნაძე", "როინი კიკნაძე": "როინ კიკნაძე",
    "როინი": "როინ კიკნაძე", "ძმანაშვილი": "თამაზ ძმანაშვილი", "tifsebi": "Guide tips", "interneti": "Internet / SIM",
    "სომხეთში ბარათი+ინტერნეტი": "Internet / SIM",
}
TYPE_FIX = {"Wyndham Batumi": "hotel", "Ambassadori Tbilisi": "hotel", "Felinger": "transport", "Transfers": "transport", "Taxis": "transport",
            "Fuel (other)": "transport", "Tickets (other)": "activity", "Museums (other)": "activity", "Meals (other)": "restaurant",
            "Hot pot (Chinese)": "restaurant", "Chinese restaurant (not named)": "restaurant", "Wine cellar + dance show": "restaurant",
            "Novotel hotel": "hotel", "Tskaltubo": "hotel", "Stalin Underground Printing House": "activity", "Svaneti Museum": "activity",
            "Rabati Akhaltsikhe": "activity"}
MERGE: dict[str, str] = json.loads((HERE / "merge.json").read_text(encoding="utf-8")) if (HERE / "merge.json").exists() else {}


def sup(name, type_, city=""):
    name = re.sub(r"\s+\d{9,}$", "", (name or "").strip())          # a personal/bank number glued to a name
    name = ALIAS.get(name, name)
    name = MERGE.get(name, name)
    type_ = TYPE_FIX.get(name, type_)
    USES[name] += 1
    s = SUPS.get(name)
    if s is None:
        s = SUPS[name] = Sup(name, type_, city)
    elif city and not s.city:
        s.city = city
    return s


HOTEL_CITY = {
    "Hualing Tbilisi": "Tbilisi", "Hualing Preference 5★": "Tbilisi", "Pullman Tbilisi": "Tbilisi", "Pine Astoria Tbilisi": "Tbilisi",
    "Radisson Blu Tbilisi": "Tbilisi", "Jino Wellness": "Tbilisi", "Royal Tulip Tbilisi": "Tbilisi", "Biltmore Tbilisi": "Tbilisi",
    "Radisson Blu Yerevan": "Yerevan", "Aghababyan's Yerevan": "Yerevan", "Armenia Marriott Yerevan": "Yerevan",
    "Ani Grand Yerevan": "Yerevan", "Caucasus Hotel Yerevan": "Yerevan", "Marriott Tsaghkadzor": "Tsaghkadzor",
    "Ararat Resort Sevan": "Sevan", "Sevan Up": "Sevan",
    "Akhaltsikhe Inn 5★": "Akhaltsikhe", "Greenwood Batumi": "Batumi", "Best Western Batumi": "Batumi", "Radisson Blu Batumi": "Batumi",
    "Grander Batumi": "Batumi", "Gistola Resort 5★": "Mestia", "Lilati Mestia": "Mestia", "Ushba Mestia": "Mestia",
    "Gori Inn": "Gori", "Marco Polo Gudauri": "Gudauri", "Gudauri Inn": "Gudauri", "Gudauri Lodge": "Gudauri", "Gudauri Loft": "Gudauri",
    "Suatis Resort Kazbegi": "Kazbegi", "Rooms Hotel Kazbegi": "Kazbegi", "Mountain House Kazbegi": "Kazbegi",
    "Borjomi Likani": "Borjomi", "Crowne Plaza Borjomi": "Borjomi", "Kutaisi Inn": "Kutaisi", "Marriott Baku": "Baku",
}
# (words a name may contain, canonical hotel); order matters: specific first.
HOTEL_RULES = [
    (("hualing preference", "ჰუალინგ პრეფერენს"), "Hualing Preference 5★"),
    (("hualing", "ჰუალინგ"), "Hualing Tbilisi"),
    (("pullman", "პულმან"), "Pullman Tbilisi"),
    (("pine astoria", "პაინ", "pine"), "Pine Astoria Tbilisi"),
    (("tsakhadzor", "tsaghkadzor", "წახკაძორ"), "Marriott Tsaghkadzor"),
    (("marriott hotel boulevard", "marriott baku", "baku"), "Marriott Baku"),
    (("მარიოტ", "მერიოტ", "marriot", "marriott"), "Armenia Marriott Yerevan"),
    (("aghababyan", "aghababayan", "agababayan", "აღაბაბაია", "აღაბაბია"), "Aghababyan's Yerevan"),
    (("ani central", "ani grand"), "Ani Grand Yerevan"),
    (("caucasus hotel",), "Caucasus Hotel Yerevan"),
    (("ararat", "არარატ"), "Ararat Resort Sevan"),
    (("sevan up", "სევან", "sevan", "covasar"), "Sevan Up"),
    (("marco", "მარკო"), "Marco Polo Gudauri"),
    (("gudauri inn", "gudauri  inn", "გუდაური ინ"), "Gudauri Inn"),
    (("gudauri lodge", "გუდაური ლოჯ"), "Gudauri Lodge"),
    (("loft", "ლოფტ"), "Gudauri Loft"),
    (("gori inn", "გორი ინ"), "Gori Inn"),
    (("greenwood", "greendwood", "გრინვუდ"), "Greenwood Batumi"),
    (("best western", "ბესთ ვესტერნ", "ბესტ ვესტერნ"), "Best Western Batumi"),
    (("grander", "გრანდერ", "გრანდიერ"), "Grander Batumi"),
    (("akhaltsikhe inn", "ახალციხე ინ", "ახალციხე"), "Akhaltsikhe Inn 5★"),
    (("gistola", "გისტოლა"), "Gistola Resort 5★"),
    (("lilat", "ლილატ"), "Lilati Mestia"),
    (("ushba", "უშბა"), "Ushba Mestia"),
    (("jino", "ჯინო", "gino"), "Jino Wellness"),
    (("likani", "ლიკან"), "Borjomi Likani"),
    (("crown", "ქრაუნ"), "Crowne Plaza Borjomi"),
    (("kutaisi inn", "ქუთაისი ინ"), "Kutaisi Inn"),
    (("suatis", "სუატის"), "Suatis Resort Kazbegi"),
    (("rooms hotel",), "Rooms Hotel Kazbegi"),
    (("mountain house", "მაუნთაინ", "melodia"), "Mountain House Kazbegi"),
    (("royal tulip", "როიალ ტულიპ"), "Royal Tulip Tbilisi"),
    (("biltmore", "ბილტმორ"), "Biltmore Tbilisi"),
]


def hotel_of(text, context: list[str] = ()):
    """Canonical hotel for a name; 'radisson' alone is decided by the tour's own hotels."""
    t = low(text)
    if not t or t in ("—", "-") or "tbd" in t or t.startswith("?"):
        return None
    if any(k in t for k in ("radisson", "რადისონ", "რედისონ")):
        for city, h in (("yerevan", "Radisson Blu Yerevan"), ("ერევან", "Radisson Blu Yerevan"), ("tbilisi", "Radisson Blu Tbilisi"),
                        ("batumi", "Radisson Blu Batumi"), ("ბათუმ", "Radisson Blu Batumi")):
            if city in t:
                return h
        for h in context:
            if h.startswith("Radisson"):
                return h
        return "Radisson Blu Yerevan"
    for words, h in HOTEL_RULES:
        if any(w in t for w in words):
            if h == "Hualing Tbilisi" and "Hualing Preference 5★" in context and "Hualing Tbilisi" not in context:
                return "Hualing Preference 5★"
            if h == "Armenia Marriott Yerevan" and "Marriott Tsaghkadzor" in context:
                return "Marriott Tsaghkadzor"
            return h
    return None


# ----- restaurants -----
MEAL_PREFIX = re.compile(r"^\s*(ლანჩი|ვახშამი|ვაშამი|lunch|dinner)\s*[:：\-–]?\s*", re.I)
OWN_RE = re.compile(r"საკ[უ]?[თტ]|არ შედის", re.I)
HOTEL_DINNER = {"ახალციხე ინნ": "Akhaltsikhe Inn 5★", "გორი ინნ": "Gori Inn", "გუდაური ინნ": "Gudauri Inn", "გუდაური ლოჯი": "Gudauri Lodge",
                "მარკო პოლო": "Marco Polo Gudauri", "ჰუალინგ დორმიტორი": "Hualing Tbilisi"}
REST_RULES = [
    (("ახალი აზია (თავისუფლება)", "ახალი აზია თავისუფლება"), "ახალი აზია (თავისუფლება)"),
    (("ახალი აზია",), "ახალი აზია (ისანი)"),
    (("კტვ",), "კტვ"),
    (("ბალკონი",), "ბალკონი (სიღნაღი)"),
    (("ზღაპარი",), "ზღაპარი"),
    (("დიარონი",), "დიარონი"),
    (("ფასანაური",), "ფასანაური"),
    (("შოთა",), "შოთა (ვარძია)"),
    (("ცენტრალ პაბ",), "ცენტრალ პაბი (გორი)"),
    (("ოქროს საწმისი",), "ოქროს საწმისი (მცხეთა)"),
    (("ჟეზეფ", "ჟოზეფ"), "ჟოზეფი"),
    (("ბერიძეები",), "ბერიძეები (ბათუმი)"),
    (("ხარება",), "ხარება"),
    (("სალობიე",), "სალობიე"),
    (("დინ შენი",), "დინ შენი"),
    (("ლუიზასთან", "ლუიბასთან"), "ლუიზასთან (მესტია)"),
    (("ლუშნუ ქორი",), "ლუშნუ ქორი"),
    (("ენგური",), "ენგური"),
    (("მარტვილი",), "მარტვილი"),
    (("გურამიშვილის მარანი",), "გურამიშვილის მარანი"),
]


def meal_of(raw, night_hotel=None):
    """(mode, restaurant or hotel name, note) for a lunch/dinner entry."""
    t = MEAL_PREFIX.sub("", (raw or "").strip())
    tl = low(t)
    if not tl or tl in ("—", "-"):
        return "included", None, ""
    if OWN_RE.search(tl):
        return "own", None, "not included" if "არ შედის" in tl else ""
    if tl.startswith("tbd") or tl in ("ადგილობრივი",) or tl.startswith("ადგილობრივი"):
        return "included", None, f"to decide: {t}"
    if "სომხ" in tl or "სევანის თევზი" in tl or "დუდუკ" in tl or "სპეც. რესტორანი" in tl:
        return "included", None, f"Armenia (in the Armenian package): {t}"
    for k, h in HOTEL_DINNER.items():
        if k in tl:
            return "included", ("hotel", h), ""
    if "სასტუმრო" in tl:             # "ყაზბეგის სასტუმრო", "სასტუმროს ბუფეტი": the night's hotel
        return "included", ("hotel", night_hotel) if night_hotel else None, "" if night_hotel else f"at the hotel: {t}"
    for words, name in REST_RULES:
        if any(w in tl for w in words):
            return "included", ("restaurant", name), ("with dances" if "ცეკვ" in tl else "")
    name = re.sub(r"\s*\(.*?\)\s*", " ", t).strip() or t
    return "included", ("restaurant", name), ""


# ----- people -----
GUIDES = {g["name"].strip(): g for g in X["contacts"]["contacts_guides"]}
FIRST = defaultdict(list)
for full in GUIDES:
    FIRST[full.split()[0]].append(full)


def guide_of(text):
    t = re.sub(r"\(|\)|თიფსებით|ტიფსები|ტაქსები|გიდი", " ", text or "").strip()
    t = re.sub(r"\s+", " ", t)
    if not t:
        return None
    if t in GUIDES:
        return t
    first = t.split()[0]
    cands = [g for g in GUIDES if g.startswith(t)] or FIRST.get(first) or [g for g in GUIDES if g.split()[0].startswith(first[:-1]) and len(first) > 3]
    if len(cands) == 1:
        return cands[0]
    return f"Guide {t}"


DRIVER_WORDS = re.compile(r"მძღოლი?ს?|ტიფსები|თიფი|,?\s*GE\d{2}[A-Z]{2}\d+|\(ღვინო\)")


def driver_of(text):
    t = DRIVER_WORDS.sub(" ", text or "")
    t = re.sub(r"[,\s]+", " ", t).strip()
    return t or None


# ----- a balance line → supplier, category -----
ATTR_RULES = [
    (("სტამბა",), "Stalin Underground Printing House", "Tbilisi"),
    (("სტალინ",), "Stalin Museum Gori", "Gori"),
    (("ბათუმის საბაგირო",), "Cable car Batumi", "Batumi"),
    (("ნარიყალ", "საბაგირო"), "Cable car Narikala", "Tbilisi"),
    (("დელიკები სვანეთი", "დელიკები სვან"), "Delicas Svaneti", "Mestia"),
    (("დელიკ",), "Delicas Kazbegi", "Kazbegi"),
    (("გემზე",), "Boat trip Batumi", "Batumi"),
    (("ვარძი",), "Vardzia", "Vardzia"),
    (("უფლისციხ", "უფლიციხ"), "Uplistsikhe", "Gori"),
    (("ბორჯომ",), "Borjomi Park", "Borjomi"),
    (("სვანეთის მ",), "Svaneti Museum", "Mestia"),
    (("მარტვილ",), "Martvili Canyon", "Martvili"),
    (("რაბათ",), "Rabati Akhaltsikhe", "Akhaltsikhe"),
    (("ეროვნული მუზეუმი",), "Georgian National Museum", "Tbilisi"),
    (("ხარება", "დეგუსტაცია"), "ხარება", "Tbilisi"),
]


def line_supplier(l, tour_hotels):
    name, cat = l["name"], l.get("cat")
    n = low(name)
    if "საკომისიო" in n:
        return sup("Bank (transfer fees)", "other"), "other"
    if cat == "azerbaijan" or "ვაფა" in n:
        return sup("Azerbaijan partner (Vafa)", "other"), "other"
    if cat == "armenia":
        h = hotel_of(name, tour_hotels)
        if h and "გიდი" not in n:
            return sup(h, "hotel", HOTEL_CITY.get(h, "")), "hotel"
        return sup("Armenia partner (სომხეთი)", "other"), "other"
    if cat == "staff":
        return sup("Guide & driver expenses", "other"), "other"
    if cat == "bus":
        if "ფელინგერ" in n or "felinger" in n:
            return sup("Felinger", "transport"), "transport"
        if "vip bus" in n:
            return sup("VIP BUS", "transport"), "transport"
        if "სპრინტერ" in n:
            who = driver_of(n.replace("სპრინტერი", "").replace("სპრინტერ", ""))
            return sup(f"Sprinter {who}".strip() if who else "Sprinter", "transport"), "transport"
        if "ავტობუს" in n:
            return sup("Bus (own): fuel and water", "transport"), "transport"
        who = driver_of(name)
        return sup(who or "Driver (not named)", "driver"), "transport"
    if cat == "guide":
        g = guide_of(name)
        if not g:
            return sup("Guide (not named)", "guide"), "guide"
        return sup(g, "guide"), "guide"
    if cat == "attraction":
        for words, nm, city in ATTR_RULES:
            if any(w in n for w in words):
                return sup(nm, "activity" if nm != "ხარება" else "restaurant", city), "ticket"
        return sup(name, "activity"), "ticket"
    if cat == "restaurant" or (cat is None and MEAL_PREFIX.match(name)):
        mode, who, _ = meal_of(name)
        if who and who[0] == "hotel" and who[1]:
            return sup(who[1], "hotel", HOTEL_CITY.get(who[1], "")), "meal"
        if who and who[0] == "restaurant":
            return sup(who[1], "restaurant"), "meal"
        return sup("Armenia partner (სომხეთი)", "other") if "სომხ" in n else sup("Meals (other)", "restaurant"), "meal"
    h = hotel_of(name, tour_hotels)
    if h:
        return sup(h, "hotel", HOTEL_CITY.get(h, "")), "hotel"
    if cat == "hotel":
        UNMATCHED[("hotel", name)] += 1
        return sup(name, "hotel"), "hotel"
    if "ტაქს" in n:
        return sup("Taxis", "transport"), "transport"
    if "ტორტი" in n:
        return sup("Cakes (birthdays)", "other"), "other"
    UNMATCHED[("other", name)] += 1
    return sup(re.sub(r"\s*\d{1,2}\.\d{1,2}$", "", name).strip() or name, "other"), "other"


# ===== contacts: phones onto suppliers ==========================================================
def phones(r):
    return (str(r.get("phone") or "").strip(), str(r.get("phone2") or "").strip())


for g in X["contacts"]["contacts_guides"]:
    s = sup(g["name"].strip(), "guide")
    s.phone, s.phone2 = phones(g)
for h in X["contacts"]["contacts_hotels"]:
    en, _, ka = h["name"].partition("/")
    canon = hotel_of(en) or hotel_of(ka) or en.strip()
    s = sup(canon, "hotel", HOTEL_CITY.get(canon, ""))
    s.phone, s.phone2 = phones(h)
    s.aliases.add(h["name"].strip())
for r in X["contacts"]["contacts_restaurants"]:
    _, who, _ = meal_of(r["name"])
    if who and who[0] == "restaurant":
        s = sup(who[1], "restaurant")
    elif who and who[0] == "hotel" and who[1]:
        s = sup(who[1], "hotel")
    else:
        continue
    s.phone, s.phone2 = phones(r)
for r in X["contacts"]["contacts_stay"]:
    nm, _, city = r["name"].partition("/")
    s = sup(f"{nm.strip()} ({city.strip()}) — guide & driver stay", "hotel", city.strip())
    s.phone, s.phone2 = phones(r)
EXTRA = {"border_transport": "Border transport company", "kazbegi_delika": "Delicas Kazbegi", "mestia_delika": "Delicas Svaneti",
         "batumi_boat": "Boat trip Batumi"}
for r in X["contacts"]["contacts_extra"]:
    nm = EXTRA.get(r["key"], r["name"])
    s = sup(nm, "transport" if "transport" in r["key"] or "delika" in r["key"] else "activity")
    s.phone = str(r.get("phone") or "")
    s.contact = r["name"]
OFFICE = [f"{r['name']}: {r['phone']}" for r in X["contacts"]["contacts_company"]]

# ===== payment terms and explicit prices =========================================================
for p in X["payment_terms"]:
    n = p["vendor_name"]
    h = hotel_of(n)
    if p["vendor_type"] == "hotel" and h:
        s = sup(h, "hotel", HOTEL_CITY.get(h, ""))
    elif p["vendor_type"] == "restaurant":
        _, who, _ = meal_of(n)
        s = sup(who[1] if who else n, "restaurant")
    else:
        s = sup(n, "other")
    s.payment = (p["timing"], int(p["days_offset"] or 0))
    if p["unit_price"]:
        s.prices.setdefault("explicit", []).append((float(p["unit_price"]), p["currency"]))
    if p["series_prices"]:
        s.notes.append(f"Price per series (old program): {p['series_prices']} {p['currency']}")

# ===== menus ======================================================================================
for raw, dishes in X["menus"].items():
    mode, who, _ = meal_of(raw)
    if who and who[0] == "restaurant":
        s = sup(who[1], "restaurant")
        s.menu = dishes if isinstance(dishes, list) else list(dishes)


# ===== rooms ======================================================================================
def rooms_text(r):
    """'10T+1S+1SL' → '10 TWN + 2 SGL' (SL = the leader's single)."""
    out = Counter()
    for n, k in re.findall(r"(\d+)\s*(TG|SL|SG|T|S|D|K)", (r or "").upper()):
        out[{"T": "TWN", "TG": "TWN", "S": "SGL", "SG": "SGL", "SL": "SGL", "D": "DBL", "K": "DBL"}[k]] += int(n)
    return " + ".join(f"{v} {k}" for k, v in out.items())


def pax_of(p):
    m = re.match(r"(\d+)\s*\+\s*(\d+)", p or "")
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


# ===== tours ======================================================================================
tabs_current = {t["code"]: t for t in X["tabs"] if t["kind"] == "current"}
tabs_archive = [t for t in X["tabs"] if t["kind"] == "archive"]
cancelled = set(X["cancelled"])


class T:
    pass


TOURS: list[T] = []


def day_fields(day, prev_hotel=None):
    city = (day.get("city") or "").strip()
    flight = None
    if city.startswith("✈"):
        m = re.match(r"✈\s*(\w+)\s*→\s*(\w+)", city)
        frm, to = (m.group(1), m.group(2)) if m else ("", "")
        flight = {"direction": "departure" if frm in ("Tbilisi", "Yerevan", "Baku") else "arrival", "number": "", "time": "",
                  "airport": {"Tbilisi": "TBS", "Yerevan": "EVN", "Urumqi": "URC"}.get(frm if frm in ("Tbilisi", "Yerevan") else to, ""),
                  "other": to if frm in ("Tbilisi", "Yerevan") else frm}
        city = frm if frm in ("Tbilisi", "Yerevan", "Baku") else to
    hotel = hotel_of(day.get("hotel"))
    notes = []
    raw_h = (day.get("hotel") or "").strip()
    if raw_h and raw_h != "—" and not hotel:
        notes.append(f"Hotel: {raw_h}")
    out = {"city": city, "hotel": hotel, "border": (day.get("border_crossing") or day.get("border") or "").strip(), "flight": flight}
    for meal in ("lunch", "dinner"):
        mode, who, note = meal_of(day.get(meal), hotel)
        out[f"{meal}_mode"], out[meal] = mode, who
        if note:
            notes.append(f"{'Lunch' if meal == 'lunch' else 'Dinner'}: {note}")
        if who and who[0] == "restaurant":
            sup(who[1], "restaurant")
        if who and who[0] == "hotel" and who[1]:
            sup(who[1], "hotel", HOTEL_CITY.get(who[1], ""))
    if hotel:
        sup(hotel, "hotel", HOTEL_CITY.get(hotel, ""))
    if day.get("notes"):
        notes.append(day["notes"])
    out["notes"] = "; ".join(notes)
    return out


def make_tour(code, series, start, end, *, days=None, tab=None, status="confirmed", rooms="", note=""):
    t = T()
    t.code, t.series, t.start, t.end, t.status = code, series, start, end, status
    t.tab = tab
    t.rooms = rooms_text(rooms or (tab or {}).get("rooms") or "")
    t.pax_tourists, t.pax_leaders = pax_of((tab or {}).get("pax"))
    t.notes = [note] if note else []
    n = (end - start).days + 1
    by_date = {x["date"]: x for x in (days or [])}
    t.days = []
    for i in range(n):
        day = by_date.get((start + dt.timedelta(days=i)).isoformat())
        t.days.append(day_fields(day) if day else {"city": "", "hotel": None, "border": "", "flight": None, "lunch_mode": "included",
                                                     "lunch": None, "dinner_mode": "included", "dinner": None, "notes": ""})
    t.hotels = [x["hotel"] for x in t.days if x["hotel"]]
    t.costs = []
    if tab:
        for l in tab["lines"]:
            if l.get("info") or not (l.get("usd") or l.get("gel")):
                continue
            if l["name"].strip() == (tab.get("code") or "").strip():     # the tab's own header (a charter's client name)
                continue
            s, cat = line_supplier(l, t.hotels)
            t.costs.append((s, cat, l))
    TOURS.append(t)
    return t


# 2026 season: the schedule's tours, with their days
seen = set()
for r in X["tours_2026"]:
    tab = tabs_current.get(r["code"])
    st, en = d(r["bus_start"]), d(r["bus_end"])
    t = make_tour(r["code"], r["series"], st, en, days=r["days"], tab=tab, rooms=r.get("rooms") or "",
                  status="cancelled" if r["code"] in cancelled else "confirmed")
    if r.get("guide"):
        t.notes.append(f"Guide (old program): {r['guide']}")
    if r.get("driver"):
        t.notes.append(f"Driver (old program): {r['driver']}")
    t.guide_raw, t.driver_raw = r.get("guide") or "", r.get("driver") or ""
    seen.add(r["code"])
# balance tabs without a schedule row (spring MT/ST)
for code, tab in tabs_current.items():
    if code in seen or not tab.get("first_date"):
        continue
    series = re.match(r"[A-Z]+\d?", code).group(0)
    make_tour(code, series, d(tab["first_date"]), d(tab["last_date"]), tab=tab,
              note="Only in the balance workbook (no schedule row): dates from the tab's own lines.")
    seen.add(code)
# cancelled ones not in the schedule: from the code (group date)
for code in sorted(cancelled - seen):
    m = re.match(r"([A-Z]+\d?)-(\d{2})(\d{2})", code)
    if not m:
        continue
    series, mm, dd = m.group(1), int(m.group(2)), int(m.group(3))
    off = int(X["series_start_offset"].get(series, 0) or 0)
    try:
        st = dt.date(2026, mm, dd) + dt.timedelta(days=off)
    except ValueError:
        continue
    dur = int((X["series"].get(series) or {}).get("duration") or 1)
    make_tour(code, series, st, st + dt.timedelta(days=dur - 1), status="cancelled", note="Cancelled (old program's cancelled tab).")
# earlier seasons
for tab in tabs_archive:
    if not tab.get("first_date"):
        NOTES.append(f"Archive tab '{tab['title']}' has no dates — not imported")
        continue
    code = tab["code"]
    series = re.match(r"[A-Z]+", code).group(0) if re.match(r"[A-Z]+", code) else "Charter"
    yy = tab["first_date"][:4]
    make_tour(f"{code}" if not tab.get("charter") else f"{code} ({yy})", series, d(tab["first_date"]), d(tab["last_date"]), tab=tab,
              note=f"Season {tab.get('season')} (archive workbook {tab['workbook']})." + (" Charter titled by the client's name." if tab.get("charter") else ""))

# tour codes must be unique per agency: earlier seasons reuse MMDD codes
codes = Counter(t.code for t in TOURS)
for t in TOURS:
    if codes[t.code] > 1 and t.tab and t.tab.get("kind") == "archive":
        t.code = f"{t.code}-{t.start.year}"
codes = Counter(t.code for t in TOURS)
for t in TOURS:
    if codes[t.code] > 1:
        t.code = f"{t.code}-{t.start.isoformat()}"

# ===== derived prices (median per room-night / per person, from the 2026 lines) ===================
for t in TOURS:
    if not t.tab or t.tab["kind"] != "current" or t.status == "cancelled":
        continue
    rooms = sum(int(n) for n in re.findall(r"(\d+)", t.rooms)) or None
    persons = (t.pax_tourists or 0) + (t.pax_leaders or 0)
    for s, cat, l in t.costs:
        amount, cur = (l["gel"], "GEL") if l.get("gel") else (l.get("usd"), "USD")
        if not amount:
            continue
        if cat == "hotel" and s.type == "hotel" and rooms:
            nights = sum(1 for x in t.days[:-1] if x["hotel"] == s.name)
            if nights:
                s.prices.setdefault("room_night", []).append((amount / rooms / nights, cur))
        if cat == "meal" and s.type == "restaurant" and persons:
            kind = "lunch" if low(l["name"]).startswith("ლანჩ") else "dinner" if low(l["name"]).startswith("ვახშ") else None
            if kind:
                s.prices.setdefault(kind, []).append((amount / (persons + 2), cur))    # + guide and driver


def median_price(vals):
    by = defaultdict(list)
    for v, c in vals:
        by[c].append(v)
    cur, xs = max(by.items(), key=lambda kv: len(kv[1]))
    return round(statistics.median(xs), 2), cur, len(xs)


# ===== report ====================================================================================
lines_total = sum(len(t.costs) for t in TOURS)
by_type = Counter(s.type for s in SUPS.values())
print(f"Tours: {len(TOURS)} (2026 schedule {len(X['tours_2026'])}, archive {len(tabs_archive)}, "
      f"cancelled {sum(1 for t in TOURS if t.status == 'cancelled')}); cost lines {lines_total}")
print("Suppliers:", len(SUPS), dict(by_type))
print("Routes:", len(X["series"]))
print("Unmatched names (become their own supplier):", sum(UNMATCHED.values()), "lines,", len(UNMATCHED), "names")
for (k, n), c in UNMATCHED.most_common(40):
    print(f"   {c:4} {k}: {n}")
if "--suppliers" in sys.argv:
    for s in sorted(SUPS.values(), key=lambda s: (s.type, s.name)):
        print(f"  [{s.type}] {s.name} {s.city} {s.phone}")

import difflib  # noqa: E402

new_merge = dict(MERGE)
by_t = defaultdict(list)
for s_ in SUPS.values():
    by_t[s_.type].append(s_.name)
for typ, names in by_t.items():
    if typ in ("guide", "driver"):        # people: similar names are often different people (ლიანა ≠ ანა)
        continue
    names = sorted(names, key=lambda n: -USES[n])
    for i, a in enumerate(names):
        for b in names[:i]:
            if a in new_merge or b in new_merge:
                continue
            if difflib.SequenceMatcher(None, a, b).ratio() >= 0.9 and not re.search(r"\d", a + b):
                new_merge[a] = b
                break
if new_merge != MERGE:
    (HERE / "merge.json").write_text(json.dumps(new_merge, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Merged near-identical names: {len(new_merge) - len(MERGE)} more — run again to apply.")
    for a, b in list(new_merge.items())[len(MERGE):]:
        print(f"   {a}  →  {b}")

if not COMMIT:
    print("\nDry run — nothing written. Add --commit to create the agency.")
    sys.exit(0)

# ===================================================================================================
# COMMIT: the agency and everything in it (one transaction)
# ===================================================================================================
from app.deps import WorkspaceCtx  # noqa: E402
from app.models import Membership, Workspace  # noqa: E402
from app.routers import lifecycle  # noqa: E402

db = SessionLocal()
owner = db.scalar(select(User).where(User.email == OWNER_EMAIL))
old = db.scalar(select(Workspace).where(Workspace.slug == "sachiku"))
if old is not None:
    if "--replace" not in sys.argv:
        sys.exit("An agency 'sachiku' already exists — add --replace to build it again from the export.")
    db.delete(old)
    db.flush()
ws = create_workspace(db, owner.id, "Sachiku", "USD", "ka")
ws.slug = "sachiku"
ws.countries = ["ge", "am", "az"]
# The sheets' VAT column = 18/118 of the line: VAT inside the supplier's price, claimed back
# (profit after VAT = profit + it).
ws.vat_rate = Decimal(18)
# Old rule: 60% advance on the tour's first day, 40% within 14 days AFTER the end. TourCRM's terms count
# the balance before arrival only — the closest is 60% at once, the rest on arrival (see the notes).
ws.payment_terms = {"deposit_percent": 60, "deposit_days": 0, "balance_days_before": 0}
ws.phone = ""
db.flush()

# GEL in USD: the median rate the balance lines used in 2026
rates_26 = [l["rate"] for t in X["tabs"] if t["kind"] == "current" for l in t["lines"] if l.get("rate")]
gel_per_usd = Decimal(str(round(statistics.median(rates_26), 4))) if rates_26 else Decimal("2.70")
db.add(ExchangeRate(workspace_id=ws.id, currency="GEL", rate=(Decimal(1) / gel_per_usd).quantize(Decimal("0.000001"))))

client = Client(workspace_id=ws.id, name="Chinese partner (from the old program)", type="agency", country="China",
                notes="The old program doesn't name the partner(s): every tour was billed to one client here. "
                      "Split per partner if there are several. Office contacts: " + "; ".join(OFFICE))
db.add(client)
db.flush()

# ----- suppliers, prices, menus -----
# A supplier "gives VAT invoices" when most of its lines in the sheets carry VAT; lines that differ
# get their own VAT rate (18 or 0), so every line's VAT is what the sheet says.
VAT_LINES: dict[str, Counter] = defaultdict(Counter)
for t_ in TOURS:
    for s_, _, l_ in t_.costs:
        VAT_LINES[s_.name][bool(l_.get("vat"))] += 1
for s in sorted(SUPS.values(), key=lambda s: s.name):
    notes = list(s.notes)
    if s.aliases:
        notes.append("Also written as: " + ", ".join(sorted(s.aliases)))
    v = Vendor(workspace_id=ws.id, name=s.name[:200], type=s.type, city=s.city or "", phone=s.phone[:50], phone2=s.phone2[:50],
               notes="\n".join(notes)[:4000], currency="GEL" if s.type in ("restaurant", "activity", "driver", "transport") else "")
    if s.payment:
        v.payment_timing, v.payment_days = s.payment[0] if s.payment[0] in ("before", "after") else "after", s.payment[1]
    v.vat_invoice = VAT_LINES[s.name][True] > VAT_LINES[s.name][False]
    s.vat_invoice = v.vat_invoice
    db.add(v)
    db.flush()
    s.id = v.id
    services = []
    if s.type == "hotel":
        if s.prices.get("explicit"):
            p, cur = s.prices["explicit"][0]
            services.append(("room_TWN", "Twin room · per night", "hotel", "room_night", p, cur, "Price from the old program's payment terms"))
        elif s.prices.get("room_night"):
            p, cur, n = median_price(s.prices["room_night"])
            services.append(("room_TWN", "Room · per night", "hotel", "room_night", p, cur,
                             f"Derived: median of {n} lines in the 2026 balances (amount ÷ rooms ÷ nights) — check"))
    if s.type == "restaurant":
        for kind in ("lunch", "dinner"):
            if s.prices.get(kind):
                p, cur, n = median_price(s.prices[kind])
                services.append((kind, "Lunch / person" if kind == "lunch" else "Dinner / person", "meal", "person", p, cur,
                                 f"Derived: median of {n} lines in the 2026 balances (amount ÷ group + guide + driver) — check"))
        if s.prices.get("explicit"):
            p, cur = s.prices["explicit"][0]
            v.notes = (v.notes + f"\nOld program's price: {p} {cur} (per group? — check)").strip()
    for code, name, cat, unit, price, cur, note in services:
        svc = Service(vendor_id=v.id, code=code, name=name, category=cat, unit=unit, notes="")
        svc.rates = [ServiceRate(price=Decimal(str(round(price, 2))), currency=cur, notes=note[:300])]
        db.add(svc)
    if s.menu:
        db.add(Service(vendor_id=v.id, code=None, name="Set menu (old program)", category="meal", unit="person",
                       notes="Dishes from the old program's menu workbook; price per person not in it.",
                       dishes=[{"name": str(x)[:80], "price": None} for x in s.menu][:40]))
db.flush()


def vid(kind_name):
    if not kind_name:
        return None
    s = SUPS.get(MERGE.get(ALIAS.get(kind_name, kind_name), ALIAS.get(kind_name, kind_name)))
    return s.id if s else None


def apply_day(day_obj, f):
    day_obj.city = f["city"][:100]
    day_obj.hotel_id = vid(f["hotel"])
    for meal in ("lunch", "dinner"):
        who = f[meal]
        setattr(day_obj, f"{meal}_mode", f[f"{meal}_mode"])
        setattr(day_obj, f"{meal}_id", vid(who[1]) if who and who[1] else None)
    day_obj.border_crossing = f["border"][:100]
    day_obj.notes = f["notes"][:2000]
    # The old program writes "✈ Tbilisi→Urumqi" with no flight number; a TourCRM flight needs one,
    # so the flight goes into the day's note until someone adds the number.
    day_obj.flights = []
    if f["flight"]:
        fl = f["flight"]
        word = f"Flight {fl['airport'] or ''} → {fl['other']}" if fl["direction"] == "departure" else f"Flight from {fl['other']} → {fl['airport']}"
        day_obj.notes = (f"{word} (number not in the old program). " + day_obj.notes)[:2000]
    day_obj.extras, day_obj.stops, day_obj.schedule, day_obj.drive_minutes = [], [], [], []


# ----- routes -----
COLORS = ["indigo", "emerald", "amber", "rose", "sky", "violet", "teal", "orange", "slate", "lime"]
series_ids = {}
for i, (code, sr) in enumerate(X["series"].items()):
    s_obj = Series(workspace_id=ws.id, code=code[:20], name=(sr["name"] or code)[:200], color=COLORS[i % len(COLORS)],
                   notes="From the old program (seed_data.py).")
    db.add(s_obj)
    db.flush()
    nights = sorted(sr["nights"].items(), key=lambda kv: int(kv[0]))
    for n, night in nights:
        sd = SeriesDay(series_id=s_obj.id, day_number=int(n) + 1)
        apply_day(sd, day_fields({**night, "border_crossing": night.get("border") or ""}))
        db.add(sd)
    series_ids[code] = s_obj.id
db.flush()

# ----- guides by their Latin names -----
# The sheets name a tour's guide in Latin in the tab header ("xatia mchedlishvili") and who paid in the
# status ("ok natia"); suppliers are in Georgian. Compare both in one plain Latin spelling.
GEO_LAT = dict(zip("აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ",
                   ["a", "b", "g", "d", "e", "v", "z", "t", "i", "k", "l", "m", "n", "o", "p", "zh", "r", "s", "t", "u",
                    "p", "k", "gh", "k", "sh", "ch", "ts", "dz", "ts", "ch", "x", "j", "h"]))


def plain(text):
    w = "".join(GEO_LAT.get(ch, ch) for ch in (text or "").lower())
    for a, b in (("kh", "x"), ("ph", "p"), ("th", "t"), ("q", "k"), ("f", "p"), ("w", "ts"), ("c", "ts"), ("y", "i")):
        w = w.replace(a, b)
    return [re.sub(r"i$", "", x) for x in re.findall(r"[a-z]+", w)]   # "mariami" = "mariam"


GUIDE_PLAIN = [(SUPS[n].id, plain(n)) for n in SUPS if SUPS[n].type == "guide"]


def guide_by_latin(full):
    """The guide whose name matches a Latin full name (first + last), else first name when only one has it."""
    words = plain(full)
    if not words:
        return None
    full_hits = [gid for gid, w in GUIDE_PLAIN if len(words) > 1 and w[:1] == words[:1] and words[-1] in w]
    if len(full_hits) == 1:
        return full_hits[0]
    first_hits = [gid for gid, w in GUIDE_PLAIN if w[:1] == words[:1]]
    return first_hits[0] if len(first_hits) == 1 else None


# ----- tours, days, staff, costs, bills, payments, revenue -----
inv_seq = Counter()
check_rows = []
PAID_BY = Counter()
GUIDE_FROM_HEADER = Counter()
for t in TOURS:
    tab = t.tab or {}
    summ = tab.get("summary", {})
    tourists, leaders = t.pax_tourists, t.pax_leaders
    revenue = Decimal(str(round(summ["revenue"], 2))) if summ.get("revenue") else None
    notes = list(t.notes)
    if summ.get("vat"):
        notes.append(f"VAT to be refunded (estimate, old program): {summ['vat']:.2f} USD")
    if summ.get("profit") is not None:
        notes.append(f"Old program: spent {summ.get('spent') or 0:.2f}, tour price {summ.get('revenue') or 0:.2f}, "
                     f"profit {summ['profit']:.2f}" + (f", after VAT {summ['profit_after_vat']:.2f}" if summ.get("profit_after_vat") else "") + " USD")
    if tab.get("phase"):
        notes.append(f"Phase in the old program: {tab['phase']} (1 invoices missing · 2 all invoices in · 3 all paid)")
    if tab.get("header"):
        notes.append("Header: " + " · ".join(str(h) for h in tab["header"][:4]))
    tour = Tour(workspace_id=ws.id, code=t.code[:40], name="", series_id=series_ids.get(t.series), client_id=client.id,
                start_date=t.start, end_date=t.end, status=t.status, pax=(tourists or 0) + (leaders or 0),
                pax_estimated=tourists is None, rooms=t.rooms[:200], notes="\n".join(notes)[:5000],
                price_pp=(revenue / tourists).quantize(Decimal("0.01")) if revenue and tourists else None,
                price_currency="USD" if revenue else None, quote_tourists=tourists,
                cancelled_on=TODAY if t.status == "cancelled" else None,
                route_synced_at=None)
    db.add(tour)
    db.flush()
    for i, f in enumerate(t.days):
        td = TourDay(tour_id=tour.id, day_number=i + 1, date=t.start + dt.timedelta(days=i))
        apply_day(td, f)
        db.add(td)
    tour_guide = None
    if getattr(t, "guide_raw", ""):
        cleaned = re.sub(r"\b(IM|U)\b|\d+\s*(-\s*\d+)?\s*(დან)?|\d+", " ", t.guide_raw).strip()
        g = guide_of(cleaned) if cleaned else None
        if g and g in GUIDES and SUPS.get(g):
            tour_guide = SUPS[g].id
            db.add(StaffAssignment(tour_id=tour.id, vendor_id=tour_guide, role="guide", start_day=1, end_day=None,
                                   notes=f"Old program: {t.guide_raw}"))
    header = [h for h in (tab.get("header") or [])[1:] if not re.search(r"\d", str(h))]
    if tour_guide is None and header and t.status != "cancelled":
        tour_guide = guide_by_latin(str(header[0]))
        if tour_guide:
            GUIDE_FROM_HEADER[True] += 1
            db.add(StaffAssignment(tour_id=tour.id, vendor_id=tour_guide, role="guide", start_day=1, end_day=None,
                                   notes=f"Old program (balance tab): {header[0]}"))
        else:
            GUIDE_FROM_HEADER[False] += 1
    total_usd = Decimal(0)
    guide_spent: dict[str, Decimal] = defaultdict(Decimal)   # currency → what the tour's guide paid for us
    for n, (s, cat, l) in enumerate(t.costs):
        on = d(l.get("date")) or t.start
        if l.get("gel"):
            cur, amount = "GEL", Decimal(str(round(l["gel"], 2)))
            # The sheet's own USD for this line (E) decides the rate, so totals match the sheet exactly;
            # else the rate written on the line (C); else the season's usual one.
            rate = (Decimal(str(l["usd"])) / amount) if l.get("usd") and amount else (
                Decimal(1) / Decimal(str(l["rate"])) if l.get("rate") else Decimal(1) / gel_per_usd)
        else:
            cur, amount, rate = "USD", Decimal(str(round(l["usd"], 2))), Decimal(1)
        if amount == 0:
            continue
        negative = amount < 0          # money back (a guide returning cash): negative cost, bill and payment, settled
        extra = [x for x in (f"Old program: {l['status']}" if l.get("status") else "", l.get("note") or "",
                             f"VAT {l['vat']:.2f} USD" if l.get("vat") else "") if x]
        has_vat = bool(l.get("vat"))
        db.add(TourCost(tour_id=tour.id, vendor_id=s.id, category={"meal": "meal", "hotel": "hotel", "transport": "transport",
                                                                 "guide": "guide", "ticket": "ticket"}.get(cat, "other"),
                        description=l["name"][:300], service_date=on, quantity=Decimal(1), unit_price=amount, currency=cur,
                        rate_to_base=rate.quantize(Decimal("0.00000001")), notes="; ".join(extra)[:2000], locked=True,
                        vat_rate=None if has_vat == s.vat_invoice else (Decimal(18) if has_vat else Decimal(0))))
        total_usd += amount * rate
        if l.get("received"):
            db.add(VendorBill(tour_id=tour.id, vendor_id=s.id, number=f"old-{n + 1}", bill_date=on if on <= TODAY else TODAY,
                              currency=cur, amount=amount, notes="Invoice in hand (old program: green amount or phase 2/3)"))
        if l.get("paid"):
            paid_on = d(l.get("paid_on")) or (t.end if t.end <= TODAY else TODAY)
            st = l.get("status") or ""
            # "ok daniel" / "ok rati cash": who paid. A guide → paid from the cash they hold (counts against
            # their advance); office people have no login here, so they stay in the note.
            who = plain(re.sub(r"(?i)\b(ok|cash|card|ქეში)\b", " ", st))
            # The tour's own guide paid when the status names them; office people stay in the note.
            guide_words = next((w for gid, w in GUIDE_PLAIN if gid == tour_guide), [])
            by = tour_guide if (who and guide_words and who[0] == guide_words[0] and tour_guide != s.id) else None
            PAID_BY[bool(by)] += 1
            if by:
                guide_spent[cur] += amount
            db.add(VendorPayment(tour_id=tour.id, vendor_id=s.id, currency=cur, amount=amount, paid_on=paid_on,
                                 method="cash" if (by or "cash" in st.lower()) else "bank", reference="", paid_by_vendor_id=by,
                                 notes=(f"Returned to us — old program: {st}" if negative else f"Old program: {st}")[:500]))
    # The sheets never list the cash handed to the guide, only what they paid with it: one cash payment to
    # the guide per currency keeps their balance where the sheet has it (settled).
    for cur_, amt in guide_spent.items():
        if amt:
            db.add(VendorPayment(tour_id=tour.id, vendor_id=tour_guide, currency=cur_, amount=amt, paid_on=t.start, method="cash",
                                 reference="Cash for the tour",
                                 notes="Old program: cash given to the guide is not itemised; this equals what the guide paid "
                                       "suppliers with it (marked \"paid by\" on those payments)."))
    if revenue and t.status != "cancelled":
        y = t.start.year
        inv_seq[y] += 1
        inv = Invoice(workspace_id=ws.id, number=f"{y}-{inv_seq[y]:04d}", client_id=client.id, tour_id=tour.id, status="issued",
                      kind="invoice", issue_date=t.start, due_date=t.end + dt.timedelta(days=14), currency="USD", rate_to_base=Decimal(1),
                      notes="Tour price from the old program's balance tab.")
        inv.lines = [InvoiceLine(position=0, description=f"{t.code} · {tab.get('pax') or ''}".strip(" ·"), quantity=Decimal(1), unit_price=revenue)]
        db.add(inv)
        db.flush()
        got = Decimal(str(round(summ.get("received") or 0, 2)))
        if got > 0:
            db.add(ClientPayment(invoice_id=inv.id, amount=got, received_on=t.end if t.end <= TODAY else TODAY, method="bank",
                                 notes="Received (old program: ჩარიცხული)"))
    if summ.get("spent") is not None:
        check_rows.append((t.code, float(total_usd), float(summ["spent"])))
    t.db = tour
db.flush()

# ----- close what TourCRM's own check says is finished -----
member = db.scalar(select(Membership).where(Membership.workspace_id == ws.id, Membership.user_id == owner.id))
ctx = WorkspaceCtx(user=owner, workspace=ws, membership=member)
closed = 0
open_reasons = Counter()
for t in TOURS:
    if t.status == "cancelled" or t.end >= TODAY:
        continue
    db.refresh(t.db)
    c = lifecycle.check(db, ctx, t.db)
    if c.ready:
        t.db.closed_at, t.db.closed_by_id = dt.datetime.combine(min(t.end + dt.timedelta(days=15), TODAY), dt.time(12)), owner.id
        t.db.close_note = "Closed on import: everything invoiced, received and paid in the old program."
        t.db.final_revenue, t.db.final_cost = Decimal(str(c.revenue)), Decimal(str(c.cost))
        closed += 1
    else:
        for i in c.items:
            if i.blocking and not i.ok:
                open_reasons[i.key] += 1

db.commit()

# ----- report -----
off = [(c, a, b) for c, a, b in check_rows if abs(a - b) > max(1.0, b * 0.005)]
print(f"\nAgency 'Sachiku' created: {ws.id}")
print(f"Paid by the tour's guide: {PAID_BY[True]}, other: {PAID_BY[False]}; guides found from tab headers: {GUIDE_FROM_HEADER[True]}, not found: {GUIDE_FROM_HEADER[False]}")
print(f"Suppliers {len(SUPS)}, routes {len(series_ids)}, tours {len(TOURS)} ({closed} closed), cost lines {sum(len(t.costs) for t in TOURS)}")
print(f"Totals: {len(check_rows) - len(off)} of {len(check_rows)} tours match the sheet's 'spent' (±0.5%)")
for c, a, b in sorted(off, key=lambda x: -abs(x[1] - x[2]))[:15]:
    print(f"   {c}: imported {a:,.2f} vs sheet {b:,.2f} USD")
print("Ended tours left open, why:", dict(open_reasons))
(HERE / "import_result.json").write_text(json.dumps({"workspace_id": ws.id, "closed": closed, "open_reasons": open_reasons,
                                                     "mismatch": off, "gel_per_usd": str(gel_per_usd)}, ensure_ascii=False, indent=1, default=str),
                                         encoding="utf-8")
