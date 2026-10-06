"""Run the old program's own startup + one full sheet sync, into a local gtc360.db (READ-ONLY on the sheets).
Every download is kept in raw/ (and reused), so the sheets are read once."""
import hashlib
import os
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).parent
APP = HERE / "app"
RAW = HERE / "raw"
RAW.mkdir(exist_ok=True)
os.chdir(APP)
sys.path.insert(0, str(APP))

import requests  # noqa: E402

_real_get = requests.get
LOG = []


def cached_get(url, *a, **k):
    name = hashlib.sha1(url.encode()).hexdigest()[:16]
    f = RAW / name
    if f.exists():
        r = requests.models.Response()
        r.status_code = 200
        r._content = f.read_bytes()
        r.url = url
        return r
    r = _real_get(url, *a, **k)
    if r.status_code == 200:
        f.write_bytes(r.content)
        (RAW / (name + ".url")).write_text(url, encoding="utf-8")
    LOG.append((url.split("/d/")[-1][:12] + "…", r.status_code, len(r.content)))
    time.sleep(0.5)
    return r


requests.get = cached_get

import database as db  # noqa: E402
import menu_data  # noqa: E402
from archive_sync import fetch_archive_tours  # noqa: E402
from cancel_sync import fetch_cancelled_tour_codes  # noqa: E402
from contacts_sync import fetch_contacts  # noqa: E402
from debts_sync import fetch_tour_debts  # noqa: E402
from meals_sync import fetch_all_meals  # noqa: E402
from menu_sync import fetch_menu  # noqa: E402
from payments_sync import fetch_payment_statuses  # noqa: E402
from profit_sync import fetch_tour_profit  # noqa: E402
from schedule_sync import fetch_active_tours, fetch_all_tour_rooms  # noqa: E402
from sheets_sync import fetch_hotel_assignments  # noqa: E402

if Path("gtc360.db").exists():
    Path("gtc360.db").unlink()
db.init_db()
db.seed_db()


def step(name, fn):
    t = time.time()
    try:
        out = fn()
        print(f"[ok]   {name}: {out!s:.200} ({time.time() - t:.1f}s)")
    except Exception as e:
        print(f"[FAIL] {name}: {e}")
        traceback.print_exc(limit=2)


step("cancelled", lambda: db.remove_cancelled_tours(fetch_cancelled_tour_codes()))
step("schedule", lambda: db.apply_schedule_sync(fetch_active_tours()))
step("rooms", lambda: db.bulk_update_rooms(fetch_all_tour_rooms()))
for s in ("ZT", "ZT1", "LN", "KT", "DT1", "DT2", "LT", "TH", "TK", "TM", "TV"):
    step(f"series hotels {s}", lambda s=s: db.sync_series_hotels(s))
    step(f"series meals {s}", lambda s=s: db.sync_series_meals(s))
step("hotel assignments", lambda: db.update_hotels_from_sheets(fetch_hotel_assignments()))
step("meals from balance", lambda: db.sync_meals_from_financials(fetch_all_meals()))
step("payment statuses", lambda: db.sync_payment_statuses(fetch_payment_statuses()))
step("profit", lambda: db.sync_tour_profit(fetch_tour_profit()))
step("debts", lambda: db.sync_tour_debts(fetch_tour_debts()))
step("archive", lambda: db.sync_archive_tours(fetch_archive_tours()))
step("contacts", lambda: db.sync_contacts(fetch_contacts()))
step("menu", lambda: menu_data.sync_menu_data(fetch_menu()))
print("downloads:", LOG)
