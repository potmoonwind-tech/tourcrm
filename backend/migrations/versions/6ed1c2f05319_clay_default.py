"""clay default

Revision ID: 6ed1c2f05319
Revises: cecae3e4ecf7
Create Date: 2026-10-06 08:14:05.505201

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6ed1c2f05319'
down_revision: Union[str, Sequence[str], None] = 'cecae3e4ecf7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Clay (Claude's warm look) is the app's colour now: the default for new people, and for everyone
    still on the former default."""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('theme', existing_type=sa.String(length=20), server_default='clay')
    op.execute("UPDATE users SET theme = 'clay' WHERE theme = 'blue'")


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('theme', existing_type=sa.String(length=20), server_default='blue')
