"""meal to be decided

Revision ID: b7e2f1c4d9a3
Revises: a1d4c7e9b2f0
Create Date: 2026-10-08 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7e2f1c4d9a3'
down_revision: Union[str, Sequence[str], None] = 'a1d4c7e9b2f0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ('series_days', 'tour_days'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column('meal_tbd', sa.JSON(), server_default='{}', nullable=False))


def downgrade() -> None:
    for table in ('tour_days', 'series_days'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_column('meal_tbd')
