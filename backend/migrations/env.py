from logging.config import fileConfig

from alembic import context

from app import models  # noqa: F401  (registers tables on Base.metadata)
from app.config import settings
from app.db import Base, make_engine, normalize_url

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
# SQLite can't ALTER most things in place; batch mode rebuilds tables instead.
_batch = settings.database_url.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(url=normalize_url(settings.database_url), target_metadata=target_metadata,
                      literal_binds=True, render_as_batch=_batch)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = make_engine(settings.database_url, enforce_fk=False)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=_batch)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
