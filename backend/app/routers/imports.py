from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..date_grid import read_grid
from ..db import get_db
from ..deps import WorkspaceCtx, get_ctx
from ..importer import MAX_BYTES, ImportFileError, read_table, run_import, template
from ..models import Tour
from ..schemas import ImportIssue, ImportResult
from ..scoping import get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}/import", tags=["import"])

Entity = Literal["participants", "tours", "vendors", "clients"]
# Same rule as editing each kind by hand: catalog entries are a manager's job.
MIN_ROLE = {"participants": "staff", "tours": "staff", "vendors": "manager", "clients": "manager"}
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _allow(ctx: WorkspaceCtx, entity: str) -> None:
    if not ctx.has_role(MIN_ROLE[entity]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {MIN_ROLE[entity]} role or higher")


@router.get("/{entity}/template")
def download_template(entity: Entity, ctx: WorkspaceCtx = Depends(get_ctx)):
    _allow(ctx, entity)
    return Response(template(entity), media_type=XLSX,
                    headers={"Content-Disposition": f'attachment; filename="tourcrm-{entity}-template.xlsx"'})


class GridDepartureOut(BaseModel):
    code: str
    start: date
    end: date
    places: list[str]
    warnings: list[str]
    suggested_start: date | None


class GridSeriesOut(BaseModel):
    prefix: str
    note: str
    places: list[str]
    warnings: list[str]
    departures: list[GridDepartureOut]


@router.post("/departure-grid", response_model=list[GridSeriesOut])
async def departure_grid(file: UploadFile = File(...), ctx: WorkspaceCtx = Depends(get_ctx)):
    """Read the partner's departure plan (codes across, nights down) — nothing is saved; the
    departures form shows it and creates the tours."""
    _allow(ctx, "tours")
    data = await file.read(MAX_BYTES + 1)
    try:
        found = read_grid(read_table(data, file.filename or ""))
    except ImportFileError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    if not found:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            "No departures found: expected a row of codes (ZK-1025 …) with a date for every night under each code")
    return [GridSeriesOut(prefix=s.prefix, note=s.note, places=s.places, warnings=s.warnings, departures=[
        GridDepartureOut(code=x.code, start=x.start, end=x.dates[-1], places=x.places, warnings=x.warnings,
                         suggested_start=x.suggested_start) for x in s.departures]) for s in found]


@router.post("/{entity}", response_model=ImportResult)
async def import_file(entity: Entity, file: UploadFile = File(...), commit: bool = False,
                      tour_id: str | None = None, mode: Literal["append", "replace"] = Query(default="append"),
                      ctx: WorkspaceCtx = Depends(get_ctx), db: Session = Depends(get_db)):
    """commit=false previews; commit=true saves every valid row and skips the rest."""
    _allow(ctx, entity)
    tour = None
    if entity == "participants":
        if not tour_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "tour_id is required")
        tour = get_owned(db, ctx, Tour, tour_id)
    data = await file.read(MAX_BYTES + 1)
    try:
        table = read_table(data, file.filename or "")
        out = run_import(db, ctx, entity, table, commit, tour=tour, replace=mode == "replace")
        if entity == "tours" and not out.valid and (grid := read_grid(table)):
            n = sum(len(s.departures) for s in grid)
            out.errors.insert(0, ImportIssue(row=0, message=(
                f"This looks like a partner's departure plan ({n} departures of {', '.join(s.prefix for s in grid)}): "
                "open New tour → Several departures → Read the partner's Excel")))
        return out
    except ImportFileError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
