"""Saved days ("Kutaisi day"): a day of a tour kept with its hotel, meals, activities and timeline, to fill
a day of another tour in one tap. The builder saves and applies them; the catalogue lists them to rename
or delete. Applying is the builder's own change (saved with the tour), so every supplier is checked there.
"""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs
from ..models import DayTemplate

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["day templates"])
can_read = require_jobs("operations", "finance", "sales")
can_edit = require_jobs("operations")

MAX_DATA = 200_000   # a day is a few KB; this only stops abuse
# A date belongs to the tour, not to the saved day.
DROP = ("date", "id", "day_number", "tour_id")


class DayTemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    city: str = Field(default="", max_length=120)
    data: dict

    @field_validator("data")
    @classmethod
    def small(cls, v: dict) -> dict:
        if len(json.dumps(v, default=str)) > MAX_DATA:
            raise ValueError("The day is too large to save")
        return {k: x for k, x in v.items() if k not in DROP}


class DayTemplatePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    city: str | None = Field(default=None, max_length=120)


class DayTemplateOut(BaseModel):
    id: str
    name: str
    city: str
    data: dict
    created_at: datetime

    model_config = {"from_attributes": True}


def _own(db: Session, ctx: WorkspaceCtx, template_id: str) -> DayTemplate:
    t = db.scalar(select(DayTemplate).where(DayTemplate.id == template_id, DayTemplate.workspace_id == ctx.workspace.id))
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Saved day not found")
    return t


@router.get("/day-templates", response_model=list[DayTemplateOut])
def list_templates(ctx: WorkspaceCtx = Depends(can_read), db: Session = Depends(get_db)):
    return db.scalars(select(DayTemplate).where(DayTemplate.workspace_id == ctx.workspace.id)
                      .order_by(DayTemplate.city, DayTemplate.name)).all()


@router.post("/day-templates", response_model=DayTemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(body: DayTemplateIn, ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    t = DayTemplate(workspace_id=ctx.workspace.id, name=body.name.strip(), city=body.city.strip(), data=body.data)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


@router.patch("/day-templates/{template_id}", response_model=DayTemplateOut)
def update_template(template_id: str, body: DayTemplatePatch, ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    t = _own(db, ctx, template_id)
    if body.name is not None:
        t.name = body.name.strip()
    if body.city is not None:
        t.city = body.city.strip()
    db.commit()
    db.refresh(t)
    return t


@router.delete("/day-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(template_id: str, ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    db.delete(_own(db, ctx, template_id))
    db.commit()
