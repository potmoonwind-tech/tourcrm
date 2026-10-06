"""The partner's departure plan as a grid: codes across, one row per night down."""
import io
from datetime import date, datetime

from openpyxl import Workbook

from app.date_grid import read_grid
from app.importer import read_table


def grid_file() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append([None, "ZS", "10twin"])
    ws.append([None, "ZS-1223", None, "ZS-0106", None])
    for k, place in enumerate(["hualing tbilisi", "marco polo gudauri", "Flight"]):
        ws.append([None, datetime(2026, 12, 23 + k), place, datetime(2026, 1, 6 + k), place])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_reads_series_departures_and_places():
    [s] = read_grid(read_table(grid_file(), "plan.xlsx"), today=date(2026, 10, 4))
    assert (s.prefix, s.note, s.places) == ("ZS", "10twin", ["hualing tbilisi", "marco polo gudauri", "Flight"])
    first, second = s.departures
    assert (first.code, first.start, first.dates[-1], first.warnings) == ("ZS-1223", date(2026, 12, 23), date(2026, 12, 25), [])
    # Dated a year too early: it comes after December 2026 in the plan.
    assert second.suggested_start == date(2027, 1, 6) and "probably 06.01.2027" in second.warnings[0]
    assert s.warnings == ["1 departures look like the wrong year: ZS-0106"]


def test_tour_import_points_to_the_departures_form(make_client):
    from .test_tours import agency
    c, base, _ = agency(make_client)
    r = c.post(f"{base}/import/tours", files={"file": ("plan.xlsx", grid_file())}).json()
    assert r["valid"] == 0 and "Several departures" in r["errors"][0]["message"]
    g = c.post(f"{base}/import/departure-grid", files={"file": ("plan.xlsx", grid_file())}).json()
    assert [x["code"] for x in g[0]["departures"]] == ["ZS-1223", "ZS-0106"]
