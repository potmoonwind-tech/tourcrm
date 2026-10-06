"""Production start (Render, Docker): get the database ready, then serve.

A brand-new database gets today's tables in one go and is marked as up to date; an existing one
runs the migrations it hasn't had yet. Then the app listens on $PORT behind the host's proxy.
"""
import os

import uvicorn
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

import app.models  # noqa: F401  (every table on Base.metadata)
from app.config import settings
from app.db import Base, make_engine


def prepare_database() -> None:
    cfg = Config(os.path.join(os.path.dirname(__file__), "alembic.ini"))
    engine = make_engine(settings.database_url, enforce_fk=False)
    if "alembic_version" not in inspect(engine).get_table_names():
        Base.metadata.create_all(engine)
        command.stamp(cfg, "head")
    else:
        command.upgrade(cfg, "head")
    engine.dispose()


if __name__ == "__main__":
    prepare_database()
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
                proxy_headers=True, forwarded_allow_ips="*")
