"""where each staff member sleeps

Revision ID: f4c9d2a8e6b1
Revises: e8f3a1b7c2d5
Create Date: 2026-10-09 16:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f4c9d2a8e6b1'
down_revision: Union[str, Sequence[str], None] = 'e8f3a1b7c2d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ('series_days', 'tour_days'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column('staff_stays', sa.JSON(), server_default='{}', nullable=False))


def downgrade() -> None:
    for table in ('tour_days', 'series_days'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_column('staff_stays')
