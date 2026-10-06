"""Migrations run against real data must not lose rows.

SQLite applies most ALTERs by rebuilding the table; with foreign keys enforced
that rebuild cascades into child tables. This replays the M2 -> M3 upgrade on a
populated database and checks every child row survives.
"""
import sqlite3
from pathlib import Path

from alembic import command
from alembic.config import Config

from app.config import settings

BACKEND = Path(__file__).resolve().parents[1]


def _alembic(db_file: Path, monkeypatch) -> Config:
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{db_file.as_posix()}")
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    return cfg


def test_upgrade_keeps_child_rows_and_moves_guides(tmp_path, monkeypatch):
    db_file = tmp_path / "m.db"
    cfg = _alembic(db_file, monkeypatch)
    command.upgrade(cfg, "fafcb330f885")  # Milestone 2 schema

    c = sqlite3.connect(db_file)
    c.executescript("""
        INSERT INTO workspaces (id, name, slug, base_currency, language, created_at)
            VALUES ('w', 'W', 'w', 'USD', 'en', '2026-01-01');
        INSERT INTO vendors (id, workspace_id, name, type, city, contact_person, phone, phone2, email,
                             payment_timing, payment_days, currency, notes, is_active, created_at)
            VALUES ('g', 'w', 'Guide', 'guide', '', '', '', '', '', 'after', 0, '', '', 1, '2026-01-01');
        INSERT INTO tours (id, workspace_id, code, name, start_date, end_date, status, pax, rooms,
                           guide_id, notes, created_at)
            VALUES ('t', 'w', 'T-1', '', '2026-09-01', '2026-09-02', 'confirmed', 10, '', 'g', '', '2026-01-01');
        INSERT INTO tour_days (id, tour_id, day_number, date, city, border_crossing, notes)
            VALUES ('d1', 't', 1, '2026-09-01', 'Tbilisi', '', ''), ('d2', 't', 2, '2026-09-02', 'Kazbegi', '', '');
    """)
    c.commit()
    c.close()

    command.upgrade(cfg, "head")

    c = sqlite3.connect(db_file)
    assert c.execute("SELECT count(*) FROM tour_days").fetchone()[0] == 2
    assert c.execute("SELECT vendor_id, role, start_day, end_day FROM staff_assignments").fetchall() == [
        ("g", "guide", 1, None)]
    c.close()


def test_models_match_migrations(tmp_path, monkeypatch):
    """A model change without its migration fails here, not in production."""
    cfg = _alembic(tmp_path / "check.db", monkeypatch)
    command.upgrade(cfg, "head")
    command.check(cfg)


def test_full_upgrade_downgrade_cycle(tmp_path, monkeypatch):
    cfg = _alembic(tmp_path / "cycle.db", monkeypatch)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
