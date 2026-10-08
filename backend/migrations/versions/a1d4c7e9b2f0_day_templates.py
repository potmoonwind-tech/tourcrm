"""day templates

Revision ID: a1d4c7e9b2f0
Revises: 803e00c08d9e
Create Date: 2026-10-08 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1d4c7e9b2f0'
down_revision: Union[str, Sequence[str], None] = '803e00c08d9e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('day_templates',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('workspace_id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('city', sa.String(length=120), server_default='', nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_day_templates_workspace_id_workspaces'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_day_templates'))
    )
    with op.batch_alter_table('day_templates', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_day_templates_workspace_id'), ['workspace_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('day_templates', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_day_templates_workspace_id'))
    op.drop_table('day_templates')
