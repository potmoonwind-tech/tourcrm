"""the language of the map's place names

Revision ID: c3f8a1e6d2b4
Revises: b7e2c4d9a1f3
Create Date: 2026-10-11 14:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3f8a1e6d2b4'
down_revision: Union[str, Sequence[str], None] = 'b7e2c4d9a1f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.add_column(sa.Column('place_lang', sa.String(length=5), nullable=False, server_default=''))


def downgrade() -> None:
    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.drop_column('place_lang')
