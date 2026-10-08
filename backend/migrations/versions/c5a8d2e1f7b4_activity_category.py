"""activity category

Revision ID: c5a8d2e1f7b4
Revises: b7e2f1c4d9a3
Create Date: 2026-10-08 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c5a8d2e1f7b4'
down_revision: Union[str, Sequence[str], None] = 'b7e2f1c4d9a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('vendors', schema=None) as batch_op:
        batch_op.add_column(sa.Column('category', sa.String(length=40), server_default='', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('vendors', schema=None) as batch_op:
        batch_op.drop_column('category')
