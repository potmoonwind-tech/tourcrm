"""a person's date format

Revision ID: b7e2c4d9a1f3
Revises: a6d1e3f9b8c2
Create Date: 2026-10-11 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7e2c4d9a1f3'
down_revision: Union[str, Sequence[str], None] = 'a6d1e3f9b8c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('date_style', sa.String(length=8), nullable=False, server_default='dmy'))


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('date_style')
