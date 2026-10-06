"""back to blue

Revision ID: 88ca2cd6c7c4
Revises: 6ed1c2f05319
Create Date: 2026-10-06 08:18:46.815822

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '88ca2cd6c7c4'
down_revision: Union[str, Sequence[str], None] = '6ed1c2f05319'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Clay is gone: blue is the default again, and everyone on Clay is back on blue."""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('theme', existing_type=sa.String(length=20), server_default='blue')
    op.execute("UPDATE users SET theme = 'blue' WHERE theme = 'clay'")


def downgrade() -> None:
    pass
