"""vendor placeholder (staff to be named)

Revision ID: d2b6e9a4c1f8
Revises: c5a8d2e1f7b4
Create Date: 2026-10-09 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd2b6e9a4c1f8'
down_revision: Union[str, Sequence[str], None] = 'c5a8d2e1f7b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('vendors', schema=None) as batch_op:
        batch_op.add_column(sa.Column('placeholder', sa.Boolean(), server_default='0', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('vendors', schema=None) as batch_op:
        batch_op.drop_column('placeholder')
