from sqlalchemy import MetaData, create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


def normalize_url(url: str) -> str:
    # Railway/Heroku hand out postgres:// URLs; SQLAlchemy wants an explicit driver.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def make_engine(url: str, enforce_fk: bool = True, **kwargs):
    """enforce_fk=False is for migrations only: SQLite applies ALTERs by
    rebuilding the table (copy, DROP, rename), and with foreign keys on, that
    DROP cascades into every child table and silently deletes their rows."""
    url = normalize_url(url)
    if url.startswith("sqlite"):
        # timeout: wait for another request's write (e.g. caching a place found on the map) instead of
        # failing with "database is locked" after SQLite's default 5 s.
        kwargs.setdefault("connect_args", {"check_same_thread": False, "timeout": 30})
    engine = create_engine(url, pool_pre_ping=True, **kwargs)
    if url.startswith("sqlite") and enforce_fk:
        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
    return engine


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    # Named constraints, so migrations can always refer to (and drop) them.
    metadata = MetaData(naming_convention={
        "ix": "ix_%(column_0_label)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    })


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
