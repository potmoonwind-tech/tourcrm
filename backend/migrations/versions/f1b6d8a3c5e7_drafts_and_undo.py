"""tour drafts; the change log remembers how to take a change back

Revision ID: f1b6d8a3c5e7
Revises: e5a9c2f7b3d1
Create Date: 2026-10-11 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1b6d8a3c5e7'
down_revision: Union[str, Sequence[str], None] = 'e5a9c2f7b3d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('tour_changes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('undo', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('tour_changes', schema=None) as batch_op:
        batch_op.drop_column('undo')
