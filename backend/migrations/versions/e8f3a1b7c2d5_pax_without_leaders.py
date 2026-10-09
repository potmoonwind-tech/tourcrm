"""pax counts the guests only: tour leaders travel on top (19+1)

Revision ID: e8f3a1b7c2d5
Revises: d2b6e9a4c1f8
Create Date: 2026-10-09 15:00:00

Tours made from a calculation stored Pax with the free leaders in it (12+1 -> 13). Pax now means the guests,
so those (and only those: Pax = the calculation's group + the leaders) become 12 with 1 leader.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'e8f3a1b7c2d5'
down_revision: Union[str, Sequence[str], None] = 'd2b6e9a4c1f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE tours SET pax = pax - leaders "
               "WHERE quote_id IS NOT NULL AND leaders > 0 AND quote_tourists IS NOT NULL AND pax = quote_tourists + leaders")


def downgrade() -> None:
    op.execute("UPDATE tours SET pax = pax + leaders "
               "WHERE quote_id IS NOT NULL AND leaders > 0 AND quote_tourists IS NOT NULL AND pax = quote_tourists")
