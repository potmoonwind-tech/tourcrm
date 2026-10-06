"""Local-development demo data. Never run against production.

    .venv/Scripts/python seed_dev.py

Safe to re-run: existing users, workspaces and memberships are left alone.
"""
import random
import secrets
from datetime import date, timedelta

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.models import (
    Client, Invite, Membership, Participant, Series, SeriesDay, StaffAssignment, Tour, User, Vendor, Workspace, utcnow,
)
from app.routers.tours import sync_days
from app.security import hash_password
from app.services import create_workspace

DEV_PASSWORD = "demo-pass-2026"
# Also signed up by hand for the first-customer walkthrough: claude.owner@example.com, same password (its agency was deleted after the test).

USERS = {
    "silkroad.owner@example.com": "Nino Beridze",
    "silkroad.admin@example.com": "Davit Lomidze",
    "silkroad.manager@example.com": "Ana Gelashvili",
    "silkroad.staff@example.com": "Lizi Staff",
    "guide@example.com": "Levan Guide",
    "caucasus.owner@example.com": "Giorgi Kapanadze",
    "caucasus.manager@example.com": "Mariam Tsereteli",
}

# workspace name -> (owner email, base currency, language, {member email: role}, [pending invites])
WORKSPACES = {
    "Silk Road Tours": (
        "silkroad.owner@example.com", "USD", "ka",
        {
            "silkroad.admin@example.com": "admin",
            "silkroad.manager@example.com": "manager",
            "silkroad.staff@example.com": "staff",
            "guide@example.com": "guide",
        },
        [("new.accountant@example.com", "manager"), ("driver.bus2@example.com", "guide")],
    ),
    "Caucasus Adventures": (
        "caucasus.owner@example.com", "EUR", "en",
        {
            "caucasus.manager@example.com": "manager",
            # Same freelance guide works for both agencies.
            "guide@example.com": "guide",
        },
        [("office@example.com", "staff")],
    ),
}

# --- Milestone 2: vendors, clients, routes, tours (fictional businesses) ----------
# Tours are placed around today so the timeline and day view always have groups.
TODAY = date.today()

CATALOG = {
    "Silk Road Tours": {
        "vendors": [
            # name, type, city, phone, contact, payment (timing, days)
            ("Old Town Boutique Hotel", "hotel", "Tbilisi", "+995 555 10 10 01", "Reception", ("after", 7)),
            ("Rustaveli Grand Hotel", "hotel", "Tbilisi", "+995 555 10 10 02", "Sales dept.", ("after", 14)),
            ("Kazbegi Mountain Lodge", "hotel", "Kazbegi", "+995 555 10 10 03", "Giga", ("before", 3)),
            ("Gudauri Ski Inn", "hotel", "Gudauri", "+995 555 10 10 04", "Reception", ("after", 7)),
            ("Sighnaghi Hilltop Hotel", "hotel", "Sighnaghi", "+995 555 10 10 05", "Nana", ("after", 7)),
            ("Kutaisi Riverside Hotel", "hotel", "Kutaisi", "+995 555 10 10 06", "Reception", ("after", 10)),
            ("Batumi Seaside Resort", "hotel", "Batumi", "+995 555 10 10 07", "Group desk", ("after", 14)),
            ("Mestia Tower Guesthouse", "hotel", "Mestia", "+995 555 10 10 08", "Bela", ("before", 0)),
            ("Yerevan Central Hotel", "hotel", "Yerevan", "+374 99 10 10 09", "Armen", ("before", 7)),
            ("Borjomi Park Hotel", "hotel", "Borjomi", "+995 555 10 10 10", "Reception", ("after", 7)),
            ("Supra House", "restaurant", "Tbilisi", "+995 555 20 20 01", "Manager", ("after", 3)),
            ("Old Tbilisi Cellar", "restaurant", "Tbilisi", "+995 555 20 20 02", "Levani", ("after", 3)),
            ("Ananuri Roadside Kitchen", "restaurant", "Ananuri", "+995 555 20 20 03", "", ("after", 0)),
            ("Kazbegi Panorama Restaurant", "restaurant", "Kazbegi", "+995 555 20 20 04", "", ("after", 0)),
            ("Kakheti Wine Cellar", "restaurant", "Sighnaghi", "+995 555 20 20 05", "Dato", ("after", 7)),
            ("Imereti Family Kitchen", "restaurant", "Kutaisi", "+995 555 20 20 06", "", ("after", 0)),
            ("Adjara Fish House", "restaurant", "Batumi", "+995 555 20 20 07", "", ("after", 3)),
            ("Svan Tower Tavern", "restaurant", "Mestia", "+995 555 20 20 08", "", ("after", 0)),
            ("Ararat View Restaurant", "restaurant", "Yerevan", "+374 99 20 20 09", "", ("before", 0)),
            ("Caucasus Coaches", "transport", "Tbilisi", "+995 555 30 30 01", "Dispatcher", ("after", 30)),
            ("Mestia 4x4 Delica", "transport", "Mestia", "+995 555 30 30 02", "Zura", ("after", 0)),
            ("Levan Guide", "guide", "Tbilisi", "+995 555 40 40 01", "", ("after", 0)),
            ("Tamar Kvaratskhelia", "guide", "Tbilisi", "+995 555 40 40 02", "", ("after", 0)),
            ("Irakli Wang (中文)", "guide", "Tbilisi", "+995 555 40 40 03", "", ("after", 0)),
        ],
        "clients": [
            ("Orient Holidays", "agency", "China", "Ms. Li", "ops@orient-holidays.example.com"),
            ("Shanghai Silk Travel", "agency", "China", "Mr. Chen", "groups@silk-travel.example.com"),
            ("Seoul Tour Partners", "agency", "South Korea", "Kim Ji-ho", "booking@seoul-tp.example.com"),
            ("Müller family", "direct", "Germany", "Anna Müller", "anna.mueller@example.com"),
        ],
        # code, name, color, [(city, hotel, lunch, dinner, border)]
        "series": [
            ("HM", "Georgia Highlights 8D", "indigo", [
                ("Tbilisi", "Old Town Boutique Hotel", "", "Supra House", ""),
                ("Tbilisi", "Old Town Boutique Hotel", "Old Tbilisi Cellar", "", ""),
                ("Kazbegi", "Kazbegi Mountain Lodge", "Ananuri Roadside Kitchen", "Kazbegi Panorama Restaurant", ""),
                ("Tbilisi", "Rustaveli Grand Hotel", "Kazbegi Panorama Restaurant", "Supra House", ""),
                ("Sighnaghi", "Sighnaghi Hilltop Hotel", "Kakheti Wine Cellar", "Kakheti Wine Cellar", ""),
                ("Kutaisi", "Kutaisi Riverside Hotel", "", "Imereti Family Kitchen", ""),
                ("Batumi", "Batumi Seaside Resort", "Imereti Family Kitchen", "Adjara Fish House", ""),
                ("Batumi", "", "Adjara Fish House", "", ""),
            ]),
            ("GA", "Georgia & Armenia 10D", "emerald", [
                ("Tbilisi", "Rustaveli Grand Hotel", "", "Supra House", ""),
                ("Tbilisi", "Rustaveli Grand Hotel", "Old Tbilisi Cellar", "", ""),
                ("Kazbegi", "Gudauri Ski Inn", "Ananuri Roadside Kitchen", "Kazbegi Panorama Restaurant", ""),
                ("Tbilisi", "Old Town Boutique Hotel", "Kazbegi Panorama Restaurant", "Old Tbilisi Cellar", ""),
                ("Yerevan", "Yerevan Central Hotel", "", "Ararat View Restaurant", "Sadakhlo"),
                ("Yerevan", "Yerevan Central Hotel", "Ararat View Restaurant", "", ""),
                ("Yerevan", "Yerevan Central Hotel", "", "Ararat View Restaurant", ""),
                ("Borjomi", "Borjomi Park Hotel", "", "", "Bavra"),
                ("Tbilisi", "Old Town Boutique Hotel", "", "Supra House", ""),
                ("Tbilisi", "", "Old Tbilisi Cellar", "", ""),
            ]),
            ("SV", "Svaneti Adventure 6D", "amber", [
                ("Tbilisi", "Old Town Boutique Hotel", "", "Old Tbilisi Cellar", ""),
                ("Kutaisi", "Kutaisi Riverside Hotel", "", "Imereti Family Kitchen", ""),
                ("Mestia", "Mestia Tower Guesthouse", "Imereti Family Kitchen", "Svan Tower Tavern", ""),
                ("Mestia", "Mestia Tower Guesthouse", "Svan Tower Tavern", "Svan Tower Tavern", ""),
                ("Kutaisi", "Kutaisi Riverside Hotel", "Svan Tower Tavern", "Imereti Family Kitchen", ""),
                ("Tbilisi", "", "", "", ""),
            ]),
            ("KW", "Kakheti Wine Weekend 3D", "rose", [
                ("Tbilisi", "Rustaveli Grand Hotel", "", "Supra House", ""),
                ("Sighnaghi", "Sighnaghi Hilltop Hotel", "Kakheti Wine Cellar", "Kakheti Wine Cellar", ""),
                ("Tbilisi", "", "Kakheti Wine Cellar", "", ""),
            ]),
        ],
        # series, start offset from today, client, pax, rooms, guide, status
        "tours": [
            ("HM", -24, "Orient Holidays", 28, "13 DBL + 2 SGL", "Irakli Wang (中文)", "confirmed"),
            ("GA", -12, "Shanghai Silk Travel", 32, "15 DBL + 2 SGL", "Irakli Wang (中文)", "confirmed"),
            ("HM", -5, "Orient Holidays", 24, "12 DBL", "Levan Guide", "confirmed"),
            ("SV", -2, "Seoul Tour Partners", 16, "8 DBL", "Tamar Kvaratskhelia", "confirmed"),
            ("HM", 0, "Shanghai Silk Travel", 30, "14 DBL + 2 SGL", "Irakli Wang (中文)", "confirmed"),
            ("KW", -1, "Müller family", 4, "2 DBL", "Levan Guide", "confirmed"),
            ("GA", 3, "Orient Holidays", 26, "13 DBL", None, "confirmed"),
            ("HM", 6, "Seoul Tour Partners", 20, "10 DBL", "Tamar Kvaratskhelia", "confirmed"),
            ("SV", 9, "Orient Holidays", 12, "6 DBL", None, "inquiry"),
            ("HM", 13, "Shanghai Silk Travel", 34, "16 DBL + 2 SGL", None, "confirmed"),
            ("GA", 18, "Seoul Tour Partners", 22, "11 DBL", None, "inquiry"),
            ("HM", 4, "Orient Holidays", 18, "9 DBL", None, "cancelled"),
            ("KW", 25, "Shanghai Silk Travel", 10, "5 DBL", None, "inquiry"),
            ("HM", 30, "Orient Holidays", 28, "14 DBL", None, "confirmed"),
        ],
        "transport": "Caucasus Coaches",
    },
    "Caucasus Adventures": {
        "vendors": [
            ("Tbilisi Hostel & Suites", "hotel", "Tbilisi", "+995 555 50 50 01", "", ("after", 7)),
            ("Stepantsminda Eco Camp", "hotel", "Kazbegi", "+995 555 50 50 02", "", ("before", 7)),
            ("Mountain Trek Jeeps", "transport", "Kazbegi", "+995 555 50 50 03", "", ("after", 0)),
            ("Nika Trek Guide", "guide", "Kazbegi", "+995 555 50 50 04", "", ("after", 0)),
        ],
        "clients": [("Alpine Club Munich", "agency", "Germany", "Jonas", "trips@alpine-munich.example.com")],
        "series": [
            ("TRK", "Kazbegi Trekking 5D", "teal", [
                ("Tbilisi", "Tbilisi Hostel & Suites", "", "", ""),
                ("Kazbegi", "Stepantsminda Eco Camp", "", "", ""),
                ("Kazbegi", "Stepantsminda Eco Camp", "", "", ""),
                ("Kazbegi", "Stepantsminda Eco Camp", "", "", ""),
                ("Tbilisi", "", "", "", ""),
            ]),
        ],
        "tours": [
            ("TRK", -2, "Alpine Club Munich", 12, "6 TWN", "Nika Trek Guide", "confirmed"),
            ("TRK", 12, "Alpine Club Munich", 10, "5 TWN", "Nika Trek Guide", "inquiry"),
        ],
        "transport": "Mountain Trek Jeeps",
    },
}


# --- Milestone 3: passenger lists (fictional people) ------------------------------
NAMES = {
    "China": (["WANG", "LI", "ZHANG", "LIU", "CHEN", "YANG", "HUANG", "ZHAO", "WU", "ZHOU", "XU", "SUN"],
              ["Wei", "Fang", "Na", "Min", "Jing", "Lei", "Yan", "Jun", "Hui", "Qiang", "Ying", "Tao"], "E", "China"),
    "South Korea": (["KIM", "LEE", "PARK", "CHOI", "JUNG", "KANG", "CHO", "YOON"],
                    ["Ji-ho", "Seo-yeon", "Min-jun", "Ha-eun", "Do-yun", "Soo-ah", "Ji-woo", "Ye-jin"], "M", "South Korea"),
    "Germany": (["MÜLLER", "SCHMIDT", "SCHNEIDER", "FISCHER", "WEBER", "MEYER"],
                ["Anna", "Lukas", "Lena", "Jonas", "Mia", "Felix", "Laura", "Paul"], "C", "Germany"),
}


def seed_participants(db, ws: Workspace) -> None:
    """Fill confirmed tours that have no list yet: couples in DBL rooms, the odd one out in a SGL."""
    rng = random.Random(ws.slug)  # same people on every run
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.status == "confirmed")).all()
    for t in tours:
        if t.participants or not t.pax:
            continue
        surnames, given, prefix, nationality = NAMES.get(t.client.country if t.client else "", NAMES["Germany"])
        for i in range(t.pax):
            room = i // 2 + 1
            single = t.pax % 2 == 1 and i == t.pax - 1
            expiry = date(rng.randint(2028, 2035), rng.randint(1, 12), rng.randint(1, 28))
            if i == 3:  # one passport too close to the trip, to show the warning
                expiry = t.end_date + timedelta(days=60)
            t.participants.append(Participant(
                full_name=f"{rng.choice(surnames)} {rng.choice(given)}",
                gender=rng.choice("MF"),
                birth_date=date(rng.randint(1950, 2005), rng.randint(1, 12), rng.randint(1, 28)),
                nationality=nationality,
                passport_number=f"{prefix}{rng.randint(10_000_000, 99_999_999)}",
                passport_expiry=expiry,
                room_type="SGL" if single else "DBL",
                room_group=f"R{room}",
                position=i + 1,
            ))
    db.flush()


# --- Milestone 4: prices, exchange rates, costs, payments ----------------------------
EXCHANGE = {"USD": {"GEL": "0.37", "EUR": "1.08"}, "EUR": {"GEL": "0.34", "USD": "0.92"}}


SERVICE_NAMES = {
    "room_SGL": ("SGL room", "hotel", "room_night"), "room_DBL": ("DBL room", "hotel", "room_night"),
    "room_TWN": ("TWN room", "hotel", "room_night"), "lunch": ("Lunch", "meal", "person"),
    "dinner": ("Dinner", "meal", "person"), "day": ("Day rate", "other", "day"),
}


def _prices(v: Vendor, rng: random.Random) -> list[tuple[str, str, str]]:
    """(kind, price, currency) per vendor type; fictional but plausible."""
    if v.type == "hotel":
        dbl = rng.randrange(80, 150, 5)
        return [("room_DBL", str(dbl), "USD"), ("room_TWN", str(dbl), "USD"),
                ("room_SGL", str(dbl - 20), "USD"), ("dinner", str(rng.randrange(40, 70, 5)), "GEL")]
    if v.type == "restaurant":
        return [("lunch", str(rng.randrange(30, 50, 5)), "GEL"), ("dinner", str(rng.randrange(45, 80, 5)), "GEL")]
    if v.type == "guide":
        return [("day", str(rng.randrange(200, 320, 20)), "GEL")]
    if v.type in ("transport", "driver"):
        return [("day", str(rng.randrange(220, 320, 20)), "USD" if "Coach" in v.name else "GEL")]
    return []


def seed_finance(db, ws: Workspace) -> None:
    from decimal import Decimal
    from app import finance
    from app.models import ExchangeRate, Service, ServiceRate, TourCost, VendorPayment

    if db.scalar(select(TourCost.id).join(Tour).where(Tour.workspace_id == ws.id)):
        return
    rng = random.Random(f"{ws.slug}-money")
    for cur, rate in EXCHANGE.get(ws.base_currency, {}).items():
        db.add(ExchangeRate(workspace_id=ws.id, currency=cur, rate=Decimal(rate)))
    # Hotels charge more in high season (June to September), so prices depend on the travel date.
    high = (date(TODAY.year, 6, 1), date(TODAY.year, 9, 30))
    for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id)):
        for k, p, c in _prices(v, rng):
            name, category, unit = SERVICE_NAMES[k]
            if k in ("day", "person", "group"):
                category = {"guide": "guide", "transport": "transport", "driver": "transport"}.get(v.type, category)
            rates = [ServiceRate(price=Decimal(p), currency=c)]
            if k.startswith("room_"):
                rates.append(ServiceRate(valid_from=high[0], valid_to=high[1], price=Decimal(p) + 25, currency=c,
                                         notes="High season"))
            v.services.append(Service(code=k, name=name, category=category, unit=unit, rates=rates))
    db.flush()

    today = date.today()
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.status != "cancelled")
                       .order_by(Tour.start_date)).all()
    for i, t in enumerate(tours):
        if t.code.startswith("HM-") and t.start_date == TODAY:
            # A guide hand-over to show staff ranges: Chinese-speaking guide days 1-4, then Levan.
            guide = next((a for a in t.staff if a.role == "guide"), None)
            levan = db.scalar(select(Vendor).where(Vendor.workspace_id == ws.id, Vendor.name == "Levan Guide"))
            if guide and levan:
                guide.end_day = 4
                t.staff.append(StaffAssignment(vendor_id=levan.id, role="guide", start_day=5))
                db.flush()
        finance.generate(db, ws, t)
        db.flush()
        if t.status != "confirmed" or t.start_date > today + timedelta(days=10):
            continue
        vendors = finance.vendor_map(db, t)
        for p in finance.payables(t, vendors, today):
            v = vendors[p.vendor.id]
            finished = t.end_date < today
            if finished and i == 0 and v.type == "restaurant":
                continue  # one forgotten restaurant bill, so the schedule shows something overdue
            if finished or (p.due_date and p.due_date <= today and v.payment_timing == "before"):
                amount = Decimal(str(p.total))
            elif p.due_date and p.due_date <= today + timedelta(days=3):
                amount = (Decimal(str(p.total)) / 2).quantize(Decimal("0.01"))  # deposit paid
            else:
                continue
            if amount > 0:
                t.payments.append(VendorPayment(vendor_id=v.id, currency=p.currency, amount=amount,
                                                paid_on=min(today, p.due_date or today), method="bank",
                                                reference=f"INV-{rng.randint(1000, 9999)}"))
    db.flush()


# --- Milestone 5: client invoices and money received --------------------------------

def seed_invoices(db, ws: Workspace) -> None:
    from decimal import ROUND_HALF_UP, Decimal
    from app import finance
    from app.models import ClientPayment, Invoice, InvoiceLine
    from app.routers.invoices import next_number

    if db.scalar(select(Invoice.id).where(Invoice.workspace_id == ws.id)):
        return
    today = date.today()
    rates = finance.rates(db, ws)
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.status != "cancelled", Tour.client_id.is_not(None))
                       .order_by(Tour.start_date)).all()
    plan = []
    for t in tours:
        cost = sum((c.amount_base for c in t.costs), Decimal(0))
        pax = len(t.participants) or t.pax
        if not pax:
            continue
        # ~28% over cost, rounded to 10 per person: what an agency would quote.
        per_person = (cost * Decimal("1.28") / pax / 10).quantize(Decimal(1), ROUND_HALF_UP) * 10 or Decimal(500)
        singles = sum(1 for p in t.participants if p.room_type == "SGL")
        inv = Invoice(workspace_id=ws.id, client_id=t.client_id, tour_id=t.id, currency=ws.base_currency,
                      rate_to_base=rates[ws.base_currency], issue_date=min(today, t.start_date - timedelta(days=30)),
                      due_date=t.start_date - timedelta(days=7), notes="Bank transfer to the account on file.")
        inv.lines = [InvoiceLine(position=0, description=f"Tour {t.code} · {t.series.name if t.series else ''} · "
                                                       f"{t.start_date:%d.%m}–{t.end_date:%d.%m.%Y}",
                                 quantity=Decimal(pax), unit_price=per_person)]
        if singles:
            inv.lines.append(InvoiceLine(position=1, description="Single room supplement", quantity=Decimal(singles),
                                         unit_price=(per_person * Decimal("0.2")).quantize(Decimal(1))))
        db.add(inv)
        plan.append((t, inv))
    db.flush()

    # Issue in date order so numbers follow the calendar; later / unconfirmed stay drafts.
    for t, inv in sorted(plan, key=lambda x: x[1].issue_date):
        if t.status != "confirmed" or t.start_date > today + timedelta(days=21):
            continue
        inv.status = "issued"
        inv.number = next_number(db, ws.id, inv.issue_date.year)
        db.flush()
        total = inv.total
        if t.end_date < today:
            # One client still owes part of a finished tour: shows up as an overdue debt.
            owed = t.client and t.client.name == "Seoul Tour Partners"
            amount = (total * Decimal("0.6")).quantize(Decimal("0.01")) if owed else total
        elif t.start_date <= today:
            amount = total
        else:
            amount = (total * Decimal("0.3")).quantize(Decimal("0.01"))  # deposit
        inv.payments.append(ClientPayment(amount=amount, received_on=min(today, inv.due_date), method="bank",
                                          reference=f"SWIFT {inv.number}"))
    db.flush()


# --- Price calculations ---------------------------------------------------------------

def seed_quotes(db, ws: Workspace) -> None:
    """The HM sheet preset, attached to the HM route; HM tours point to it."""
    from app.models import Quote
    from app.quote_presets import hm_preset

    if ws.name != "Silk Road Tours" or db.scalar(select(Quote.id).where(Quote.workspace_id == ws.id)):
        return
    hm = db.scalar(select(Series).where(Series.workspace_id == ws.id, Series.code == "HM"))
    doc = hm_preset()
    doc.series_id, doc.status = (hm.id if hm else None), "accepted"
    doc.valid_from, doc.valid_to = date(TODAY.year, 3, 1), date(TODAY.year, 11, 30)
    q = Quote(workspace_id=ws.id, name=doc.name, status=doc.status, series_id=doc.series_id, currency=doc.currency,
              valid_from=doc.valid_from, valid_to=doc.valid_to, doc=doc.model_dump(mode="json"))
    db.add(q)
    db.flush()
    for t in db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.code.like("HM-%"))):
        t.quote_id = q.id
        t.quote_tourists = min(max(t.pax - doc.leaders, doc.pax_min), doc.pax_max)
    db.flush()


def seed_day_services(db, ws: Workspace) -> None:
    """Phase B2: services beyond hotel and meals on the HM route (and its tours):
    a jeep up to Gergeti, a wine tasting, Martvili canyon with the boat."""
    from decimal import Decimal
    from app.models import Series, Service, ServiceRate

    hm = db.scalar(select(Series).where(Series.workspace_id == ws.id, Series.code == "HM"))
    if not hm or db.scalar(select(Vendor.id).where(Vendor.workspace_id == ws.id, Vendor.name == "Martvili Canyon Park")):
        return
    high = (date(TODAY.year, 6, 1), date(TODAY.year, 9, 30))

    def vendor(name, vtype, city, services):
        v = Vendor(workspace_id=ws.id, name=name, type=vtype, city=city, payment_timing="after", payment_days=0)
        v.services = [Service(name=n, category=cat, unit=unit, rates=rates) for n, cat, unit, rates in services]
        db.add(v)
        db.flush()
        return {x.name: x.id for x in v.services}

    jeep = vendor("Kazbegi 4x4", "transport", "Stepantsminda", [
        ("Jeep to Gergeti (6 seats)", "transport", "vehicle_day", [ServiceRate(price=Decimal(150), currency="GEL")])])
    wine = vendor("Kakheti Wine Cellar", "activity", "Sighnaghi", [
        ("Wine tasting", "activity", "person", [ServiceRate(price=Decimal(35), currency="GEL")])])
    canyon = vendor("Martvili Canyon Park", "activity", "Kutaisi", [
        ("Canyon entrance + boat", "ticket", "person", [
            ServiceRate(price=Decimal(50), currency="GEL"),
            ServiceRate(valid_from=high[0], valid_to=high[1], price=Decimal(60), currency="GEL", notes="High season")])])
    by_day = {
        3: [{"id": "jeep", "service_id": jeep["Jeep to Gergeti (6 seats)"], "quantity": "3", "notes": "3 jeeps"}],
        5: [{"id": "wine", "service_id": wine["Wine tasting"], "quantity": None, "notes": ""}],
        6: [{"id": "martvili", "service_id": canyon["Canyon entrance + boat"], "quantity": None, "notes": ""}],
    }
    for d in hm.days:
        if d.day_number in by_day:
            d.extras = by_day[d.day_number]
    # Tours copy the route when created; give the existing HM tours the same services.
    for t in db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.series_id == hm.id)):
        for d in t.days:
            if d.day_number in by_day and not d.extras:
                d.extras = [dict(x) for x in by_day[d.day_number]]
    db.flush()


def seed_budgets(db, ws: Workspace) -> None:
    """Phase B4: tours sold from a calculation get their budget (the calculation at
    the size sold), and their cost lines are linked to it."""
    from app import budget, finance
    from app.models import Quote
    from app.quote_schemas import QuoteIn

    rates = finance.rates(db, ws)
    for t in db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.quote_id.is_not(None),
                                           Tour.budget_set_at.is_(None))):
        q = db.get(Quote, t.quote_id)
        doc = QuoteIn.model_validate(q.doc)
        tourists = min(max(t.quote_tourists or doc.pax_min, doc.pax_min), doc.pax_max)
        budget.apply(t, doc, tourists, rates, f"{q.name} · {tourists}+{doc.leaders}")
        db.flush()
        budget.link_unlinked(t)
    db.flush()


def seed_incidents(db, ws: Workspace, users: dict) -> None:
    """Phase C: two open incidents on the next HM group, for trying the decision flow:
    one reported by staff (no money yet), one a manager already priced."""
    from decimal import Decimal
    from app.models import Incident

    if db.scalar(select(Incident.id).where(Incident.workspace_id == ws.id)):
        return
    t = db.scalar(select(Tour).where(Tour.workspace_id == ws.id, Tour.code.like("HM-%"), Tour.start_date >= TODAY,
                                     Tour.status == "confirmed").order_by(Tour.start_date))
    if not t:
        return
    staff = users.get("silkroad.staff@example.com")
    manager = users.get("silkroad.manager@example.com")
    hotel = db.scalar(select(Vendor).where(Vendor.workspace_id == ws.id, Vendor.type == "hotel").order_by(Vendor.name))
    db.add(Incident(workspace_id=ws.id, tour_id=t.id, day=2, kind="client_request", title="Two guests want a wine tasting",
                    description="Asked the guide on the bus; they will pay on the spot or by invoice.",
                    carried_by="client", reported_by_id=staff.id if staff else None, costs=[]))
    db.add(Incident(workspace_id=ws.id, tour_id=t.id, day=1, kind="delay", title="Flight delayed: extra night in Tbilisi",
                    description="Arrival moved to the next morning; the hotel holds the rooms for one more night.",
                    carried_by="client", vendor_id=hotel.id if hotel else None,
                    reported_by_id=manager.id if manager else None,
                    costs=[{"vendor_id": hotel.id if hotel else None, "category": "hotel",
                            "description": "Extra night, 10 DBL", "quantity": "10", "unit_price": "95.00", "currency": "USD"}],
                    client_charge=Decimal("1100.00"), client_currency="USD"))
    db.flush()


# Phase C3: release terms by vendor type, and one partner with its own contract scale.
VENDOR_TERMS = {
    "hotel": [{"within_days": 30, "percent": 25}, {"within_days": 14, "percent": 50}, {"within_days": 3, "percent": 100}],
    "restaurant": [{"within_days": 2, "percent": 50}],
    "transport": [{"within_days": 7, "percent": 50}],
    "activity": [{"within_days": 7, "percent": 100}],
}


def seed_cancellation_terms(db, ws: Workspace) -> None:
    from app.models import Client

    for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id)):
        if not v.cancel_terms and v.type in VENDOR_TERMS:
            v.cancel_terms = [dict(r) for r in VENDOR_TERMS[v.type]]
    # Phase D2: the agency takes a 30% deposit; one partner has its own contract terms.
    if not (ws.payment_terms or {}).get("deposit_percent"):
        ws.payment_terms = {"deposit_percent": 30, "deposit_days": 7, "balance_days_before": 30}
    orient = db.scalar(select(Client).where(Client.workspace_id == ws.id, Client.name == "Orient Holidays"))
    if orient and orient.payment_terms is None:
        orient.payment_terms = {"deposit_percent": 20, "deposit_days": 5, "balance_days_before": 21}
    partner = db.scalar(select(Client).where(Client.workspace_id == ws.id, Client.name == "Seoul Tour Partners"))
    if partner and partner.cancellation_scale is None:
        partner.cancellation_scale = [{"within_days": 45, "percent": 20}, {"within_days": 21, "percent": 50},
                                      {"within_days": 7, "percent": 100}]
    db.flush()


# Set menus per restaurant (dishes let the app warn about the same food twice).
# Usual price per person of each dish; each restaurant charges its own factor of it.
DISH_PRICES = {
    "Khinkali": 9, "Khachapuri": 14, "Mtsvadi": 18, "Badrijani": 8, "Pkhali": 7, "Georgian salad": 9, "Lobio": 8,
    "Mchadi": 3, "Churchkhela": 4, "Kebab": 15, "Tomato salad": 7, "Lavash": 2, "Kubdari": 13, "Chvishtari": 6, "Matsoni": 4,
}


def priced_dishes(names, factor):
    return [{"name": n, "price": round(DISH_PRICES[n] * factor, 2)} for n in names]


MENUS = [
    ("Georgian supra", 65, ["Khinkali", "Khachapuri", "Mtsvadi", "Badrijani", "Pkhali", "Georgian salad"]),
    ("Light lunch", 35, ["Lobio", "Mchadi", "Georgian salad", "Churchkhela"]),
    ("Kebab & grill", 45, ["Mtsvadi", "Kebab", "Tomato salad", "Lavash"]),
    ("Mountain menu", 40, ["Khinkali", "Kubdari", "Chvishtari", "Matsoni"]),
]


def seed_menus(db, ws: Workspace) -> None:
    from decimal import Decimal
    from app.models import Series, Service, ServiceRate

    restaurants = db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id, Vendor.type == "restaurant")
                             .order_by(Vendor.name)).all()
    if not restaurants or any(sv.dishes for r in restaurants for sv in r.services):
        return
    by_vendor: dict[str, list] = {}
    for i, r in enumerate(restaurants):
        for name, price, dishes in (MENUS[i % len(MENUS)], MENUS[(i + 1) % len(MENUS)]):
            sv = Service(name=name, category="meal", unit="person", dishes=priced_dishes(dishes, 0.8 + 0.15 * (i % 4)),
                         rates=[ServiceRate(price=Decimal(price), currency="GEL")])
            r.services.append(sv)
            by_vendor.setdefault(r.id, []).append(sv)
    db.flush()

    def pick(vendor_id, n):
        menus = by_vendor.get(vendor_id) or []
        return menus[n % len(menus)].id if menus else None

    # The HM route and its tours that haven't started: a menu at every restaurant meal.
    hm = db.scalar(select(Series).where(Series.workspace_id == ws.id, Series.code == "HM"))
    if not hm:
        return
    days = list(hm.days)
    for t in db.scalars(select(Tour).where(Tour.series_id == hm.id, Tour.start_date > TODAY, Tour.closed_at.is_(None))):
        days += list(t.days)
    for d in days:
        if d.lunch_id:
            d.lunch_menu_id = pick(d.lunch_id, d.day_number)
        if d.dinner_id:
            d.dinner_menu_id = pick(d.dinner_id, d.day_number + 1)
    db.flush()


def seed_catalog(db, ws: Workspace, spec: dict) -> None:
    if db.scalar(select(Tour.id).where(Tour.workspace_id == ws.id)):
        return  # already seeded
    vendors = {}
    for name, vtype, city, phone, contact, (timing, days) in spec["vendors"]:
        v = Vendor(workspace_id=ws.id, name=name, type=vtype, city=city, phone=phone, contact_person=contact,
                   payment_timing=timing, payment_days=days)
        db.add(v)
        vendors[name] = v
    clients = {}
    for name, ctype, country, contact, email in spec["clients"]:
        c = Client(workspace_id=ws.id, name=name, type=ctype, country=country, contact_person=contact, email=email)
        db.add(c)
        clients[name] = c
    db.flush()

    vid = lambda name: vendors[name].id if name else None  # noqa: E731
    series = {}
    for code, name, color, days in spec["series"]:
        s = Series(workspace_id=ws.id, code=code, name=name, color=color)
        s.days = [SeriesDay(day_number=i + 1, city=city, hotel_id=vid(h), lunch_id=vid(l), dinner_id=vid(d),
                            border_crossing=border)
                  for i, (city, h, l, d, border) in enumerate(days)]
        db.add(s)
        series[code] = s
    db.flush()

    used_codes = set()
    for code, offset, client, pax, rooms, guide, st in spec["tours"]:
        s = series[code]
        start = TODAY + timedelta(days=offset)
        tour_code = f"{code}-{start:%m%d}"
        while tour_code in used_codes:
            tour_code += "B"
        used_codes.add(tour_code)
        t = Tour(workspace_id=ws.id, code=tour_code, series_id=s.id, client_id=clients[client].id,
                 start_date=start, end_date=start + timedelta(days=len(s.days) - 1), status=st, pax=pax,
                 rooms=rooms)
        t.staff = [StaffAssignment(vendor_id=vid(spec["transport"]), role="transport")]
        if guide:
            t.staff.append(StaffAssignment(vendor_id=vid(guide), role="guide"))
        db.add(t)
        sync_days(t, s.days)
    db.flush()


if not settings.database_url.startswith("sqlite"):
    raise SystemExit("seed_dev.py only runs against a local SQLite database")

with SessionLocal() as db:
    users: dict[str, User] = {}
    for email, name in USERS.items():
        user = db.scalar(select(User).where(User.email == email))
        if not user:
            user = User(email=email, full_name=name, password_hash=hash_password(DEV_PASSWORD))
            db.add(user)
            db.flush()
        users[email] = user

    for ws_name, (owner, currency, lang, members, invites) in WORKSPACES.items():
        ws = db.scalar(
            select(Workspace).join(Membership)
            .where(Workspace.name == ws_name, Membership.user_id == users[owner].id, Membership.role == "owner")
        )
        if not ws:
            ws = create_workspace(db, users[owner].id, ws_name, base_currency=currency, language=lang)
            db.flush()
        for email, role in members.items():
            exists = db.scalar(select(Membership).where(Membership.workspace_id == ws.id,
                                                        Membership.user_id == users[email].id))
            if not exists:
                db.add(Membership(workspace_id=ws.id, user_id=users[email].id, role=role))
        for email, role in invites:
            exists = db.scalar(select(Invite).where(Invite.workspace_id == ws.id, Invite.email == email))
            if not exists:
                db.add(Invite(workspace_id=ws.id, email=email, role=role, token=secrets.token_urlsafe(32),
                              invited_by_id=users[owner].id, expires_at=utcnow() + timedelta(days=7)))
        if ws_name in CATALOG:
            seed_catalog(db, ws, CATALOG[ws_name])
            seed_participants(db, ws)
            seed_day_services(db, ws)  # before costs, so tours are costed with them
            seed_finance(db, ws)
            seed_invoices(db, ws)
            seed_quotes(db, ws)
            seed_budgets(db, ws)
            seed_incidents(db, ws, users)
            seed_cancellation_terms(db, ws)
            seed_menus(db, ws)
    db.commit()

    print(f"Demo data ready. Password for every account: {DEV_PASSWORD}")
    for email in USERS:
        print("  ", email)
