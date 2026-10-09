"""opening hours of picked places

Revision ID: a6d1e3f9b8c2
Revises: f4c9d2a8e6b1
Create Date: 2026-10-09 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a6d1e3f9b8c2'
down_revision: Union[str, Sequence[str], None] = 'f4c9d2a8e6b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('geo_places', schema=None) as batch_op:
        batch_op.add_column(sa.Column('hours', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('geo_places', schema=None) as batch_op:
        batch_op.drop_column('hours')
