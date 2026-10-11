"""the agency's time zone (for "now" on the Today board)

Revision ID: e5a9c2f7b3d1
Revises: c3f8a1e6d2b4
Create Date: 2026-10-11 17:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5a9c2f7b3d1'
down_revision: Union[str, Sequence[str], None] = 'c3f8a1e6d2b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.add_column(sa.Column('timezone', sa.String(length=40), nullable=False, server_default=''))


def downgrade() -> None:
    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.drop_column('timezone')
