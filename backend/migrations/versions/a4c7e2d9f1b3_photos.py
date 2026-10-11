"""photos of places (the tour presentation)

Revision ID: a4c7e2d9f1b3
Revises: f1b6d8a3c5e7
Create Date: 2026-10-11 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4c7e2d9f1b3'
down_revision: Union[str, Sequence[str], None] = 'f1b6d8a3c5e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'photos',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('vendor_id', sa.String(length=36), nullable=True),
        sa.Column('place', sa.String(length=200), nullable=False, server_default=''),
        sa.Column('source', sa.String(length=12), nullable=False, server_default='upload'),
        sa.Column('storage_key', sa.String(length=120), nullable=True),
        sa.Column('url', sa.String(length=1000), nullable=False, server_default=''),
        sa.Column('thumb', sa.String(length=1000), nullable=False, server_default=''),
        sa.Column('credit', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('link', sa.String(length=1000), nullable=False, server_default=''),
        sa.Column('auto', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name='fk_photos_workspace_id_workspaces', ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.id'], name='fk_photos_vendor_id_vendors', ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name='pk_photos'),
    )
    op.create_index('ix_photos_workspace_id', 'photos', ['workspace_id'])
    op.create_index('ix_photos_vendor_id', 'photos', ['vendor_id'])
    op.create_index('ix_photos_place', 'photos', ['place'])


def downgrade() -> None:
    op.drop_table('photos')
