"""older calculations written the new way

Revision ID: a3c5e1f0b7d2
Revises: 88ca2cd6c7c4
Create Date: 2026-10-06 12:00:00

"""
import uuid
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a3c5e1f0b7d2'
down_revision: Union[str, Sequence[str], None] = '88ca2cd6c7c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOTE = {"en": "Who travels and the profit written out in Build (prices unchanged)",
        "ka": "ვინ მოგზაურობს და მოგება გადატანილია აწყობაში (ფასები არ შეცვლილა)"}

quotes = sa.table("quotes", sa.column("id", sa.String), sa.column("workspace_id", sa.String), sa.column("doc", sa.JSON))
workspaces = sa.table("workspaces", sa.column("id", sa.String), sa.column("language", sa.String))
versions = sa.table("quote_versions", sa.column("id", sa.String), sa.column("quote_id", sa.String),
                    sa.column("number", sa.Integer), sa.column("doc", sa.JSON), sa.column("note", sa.String),
                    sa.column("created_by_id", sa.String), sa.column("created_at", sa.DateTime(timezone=True)))


def upgrade() -> None:
    """Each older calculation gets "Who travels" and "How we price" written out - only when every price stays
    the same; the others keep their older fields (the editor converts them on the first change, as before)."""
    from app.calc_convert import convert
    from app.quote_schemas import QuoteIn

    db = op.get_bind()
    lang = {w.id: w.language for w in db.execute(sa.select(workspaces.c.id, workspaces.c.language))}
    for row in db.execute(sa.select(quotes.c.id, quotes.c.workspace_id, quotes.c.doc)).all():
        try:
            q = QuoteIn.model_validate(row.doc)
        except ValueError:
            continue
        language = lang.get(row.workspace_id) or "en"
        new = convert(q, language)
        if new is None:
            continue
        doc = new.model_dump(mode="json")
        db.execute(quotes.update().where(quotes.c.id == row.id).values(doc=doc))
        last = db.execute(sa.select(sa.func.max(versions.c.number)).where(versions.c.quote_id == row.id)).scalar() or 0
        db.execute(versions.insert().values(id=str(uuid.uuid4()), quote_id=row.id, number=last + 1, doc=doc,
                                            note=NOTE.get(language, NOTE["en"]), created_by_id=None,
                                            created_at=datetime.now(timezone.utc)))


def downgrade() -> None:
    pass
