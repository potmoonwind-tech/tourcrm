"""Tasks: what each person has to do, in one list.

- Booking tasks come from bookings (book it, get the confirmation, confirm again after a change,
  cancel with the supplier, sort out a problem). They go to the booking's person, else to the
  person who does that kind of work (Settings → Who does what). Done = the booking moves on.
- Payment tasks come from what we owe suppliers, due within two weeks or overdue; they go to the
  payments person (managers only — it's money). Done = the payment is recorded. A booking paid
  by the guide in cash is the guide's, not the office's.
- Own tasks are written by anyone and ticked off.
"""
from collections import defaultdict
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import bookings as bk, finance
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs, require_role
from ..models import Membership, StaffAssignment, Task, TaskAssignment, Tour, TourBooking, TourDay, User, Vendor, utcnow

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["tasks"])
office = require_role("staff")
can_ope_fin = require_jobs('operations', 'finance')
PAY_AHEAD = 14


class TaskItem(BaseModel):
    key: str                      # booking:<id> | pay:<tour>:<vendor>:<cur> | task:<id>
    kind: Literal["book", "chase", "reconfirm", "cancel", "problem", "pay", "own"]
    title: str                    # own tasks: the text; others: the supplier
    note: str = ""
    tour_id: str | None = None
    tour_code: str | None = None
    tour_start: date | None = None
    booking_id: str | None = None
    task_id: str | None = None
    vendor_kind: str | None = None
    amount: float | None = None
    currency: str | None = None
    due_date: date | None = None
    assignee_id: str | None = None
    assignee_name: str | None = None
    type_id: str | None = None          # own tasks: the agency's task type
    count: int | None = None            # a series task: how many departures it covers
    vendor_id: str | None = None
    done: bool = False
    link: str = ""


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    note: str = Field(default="", max_length=5000)
    tour_id: str | None = None
    assignee_id: str | None = None
    type_id: str | None = Field(default=None, max_length=20)
    due_date: date | None = None


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    note: str | None = Field(default=None, max_length=5000)
    assignee_id: str | None = None
    type_id: str | None = Field(default=None, max_length=20)
    due_date: date | None = None
    done: bool | None = None



class TaskType(BaseModel):
    id: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=40)
    color: Literal["green", "orange", "red", "blue", "purple", "dark", "grey"] = "blue"


STATE_KIND = {"to_book": "book", "waiting": "chase", "changed": "reconfirm", "cancel": "cancel", "problem": "problem"}


def _members(db: Session, ws_id: str) -> dict[str, str]:
    rows = db.execute(select(User.id, User.full_name, User.email).join(Membership, Membership.user_id == User.id)
                      .where(Membership.workspace_id == ws_id)).all()
    return {uid: (name or email) for uid, name, email in rows}


def _group_series(items: list[TaskItem], tours: dict) -> list[TaskItem]:
    """The same supplier, the same thing to do, on several departures of one route: one task
    ("Book Hualing Tbilisi · 21 ZK departures"), done on the route's bookings page."""
    groups: dict[tuple, list[TaskItem]] = defaultdict(list)
    rest = []
    for i in items:
        t = tours.get(i.tour_id)
        if i.booking_id and t is not None and t.series_id:
            groups[(t.series_id, i.title, i.kind, i.vendor_kind)].append(i)
        else:
            rest.append(i)
    for (series_id, title, kind, vkind), xs in groups.items():
        if len(xs) == 1:
            rest.extend(xs)
            continue
        first = min(xs, key=lambda x: (x.due_date or date.max))
        code = tours[first.tour_id].series.code if tours[first.tour_id].series else ""
        same = len({x.assignee_id for x in xs}) == 1
        rest.append(TaskItem(
            key=f"series:{series_id}:{first.vendor_id}", kind=kind, title=title, tour_code=code, tour_start=first.tour_start,
            vendor_kind=vkind, vendor_id=first.vendor_id, due_date=first.due_date, count=len(xs),
            assignee_id=first.assignee_id if same else None, assignee_name=first.assignee_name if same else None,
            link=f"series/{series_id}?vendor={first.vendor_id}"))
    return rest


def all_tasks(db: Session, ctx: WorkspaceCtx, include_done: bool = False) -> list[TaskItem]:
    ws = ctx.workspace
    today = date.today()
    owners = ws.task_owners or {}
    names = _members(db, ws.id)
    items: list[TaskItem] = []

    # --- bookings of tours not over yet --------------------------------------------------------
    tours = db.scalars(select(Tour).where(Tour.workspace_id == ws.id, Tour.end_date >= today, Tour.status != "cancelled",
                                          Tour.closed_at.is_(None))
                       .options(selectinload(Tour.days).selectinload(TourDay.hotel), selectinload(Tour.staff).selectinload(StaffAssignment.vendor),
                                selectinload(Tour.participants), selectinload(Tour.series))).all()
    vendors = {v.id: v for v in db.scalars(select(Vendor).where(Vendor.workspace_id == ws.id))}
    guide_cash: set[tuple[str, str]] = set()      # (tour, vendor) paid by the guide on the spot
    for t in tours:
        rows, used = bk.sync(db, t, vendors)
        for b in rows:
            if b.paid_by == "guide":
                guide_cash.add((t.id, b.vendor_id))
            u = used.get(b.vendor_id)
            st = bk.state(b, t, u)
            if st not in STATE_KIND:
                continue
            # Only while the service is still ahead: nobody books last night's hotel.
            if (min(u.dates) if u and u.dates else t.start_date) <= today:
                continue
            kind = bk.kind_of(b.vendor)
            who = b.assignee_id or bk.owner_of(owners, kind)
            items.append(TaskItem(
                key=f"booking:{b.id}", kind=STATE_KIND[st], title=b.vendor.name, tour_id=t.id, tour_code=t.code,
                tour_start=t.start_date, booking_id=b.id, vendor_kind=kind, vendor_id=b.vendor_id, due_date=bk.book_by(t, b, used.get(b.vendor_id)),
                assignee_id=who, assignee_name=names.get(who), link=f"tours/{t.id}?tab=bookings"))
    db.commit()
    items = _group_series(items, {t.id: t for t in tours})

    # --- payments due (money: the finance job) ---------------------------------------------------
    if ctx.can("finance"):
        from .finance import schedule
        payer = bk.owner_of(owners, "payments")
        picked = dict(db.execute(select(TaskAssignment.key, TaskAssignment.assignee_id)
                                 .where(TaskAssignment.workspace_id == ws.id)).all())
        for p in schedule(status_="open", due_to=today + timedelta(days=PAY_AHEAD), vendor_id=None, ctx=ctx, db=db).items:
            if (p.tour_id, p.vendor.id) in guide_cash or p.balance <= 0:
                continue                       # the guide pays it, or the supplier owes us
            key = f"pay:{p.tour_id}:{p.vendor.id}:{p.currency}"
            who = picked.get(key) or payer
            items.append(TaskItem(
                key=key, kind="pay", title=p.vendor.name, tour_id=p.tour_id,
                tour_code=p.tour_code, amount=p.balance, currency=p.currency, due_date=p.due_date,
                assignee_id=who, assignee_name=names.get(who), link=f"tours/{p.tour_id}?tab=costs"))

    # --- own tasks ------------------------------------------------------------------------------
    types = {x["id"] for x in ws.task_types or []}
    q = select(Task).where(Task.workspace_id == ws.id).options(selectinload(Task.tour))
    if not include_done:
        q = q.where(Task.done_at.is_(None))
    for x in db.scalars(q):
        items.append(TaskItem(
            key=f"task:{x.id}", kind="own", title=x.title, note=x.note, task_id=x.id, tour_id=x.tour_id,
            tour_code=x.tour.code if x.tour else None, tour_start=x.tour.start_date if x.tour else None,
            due_date=x.due_date, assignee_id=x.assignee_id, assignee_name=names.get(x.assignee_id),
            type_id=x.type_id if x.type_id in types else None, done=x.done_at is not None, link=f"tours/{x.tour_id}" if x.tour_id else ""))
    items.sort(key=lambda i: (i.done, i.due_date or date.max, i.tour_start or date.max, i.title.lower()))
    return items


@router.get("/tasks", response_model=list[TaskItem])
def list_tasks(who: str = Query(default="me", max_length=40), include_done: bool = False,
               ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """who = me (mine + nobody's), all (managers), nobody, or a person's id (managers)."""
    items = all_tasks(db, ctx, include_done)
    me = ctx.user.id
    if who == "me":
        return [i for i in items if i.assignee_id in (me, None)]
    if not ctx.can("operations", "finance"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers see everyone's tasks")
    if who == "all":
        return items
    if who == "nobody":
        return [i for i in items if i.assignee_id is None]
    return [i for i in items if i.assignee_id == who]


@router.get("/tasks/summary")
def task_summary(ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """For the menu badge and Home: my open tasks, how many are late, and how many have nobody."""
    items = all_tasks(db, ctx)
    today = date.today()
    # Same as the "Mine" list: my tasks plus nobody's (in a small agency, nobody's are mine).
    mine = [i for i in items if i.assignee_id in (ctx.user.id, None)]
    by_person: dict[str, int] = defaultdict(int)
    for i in items:
        by_person[i.assignee_id or ""] += 1
    return {"mine": len(mine), "late": sum(1 for i in mine if i.due_date and i.due_date < today),
            "nobody": by_person.get("", 0)}


@router.put("/tasks/types", response_model=list[TaskType])
def set_types(body: list[TaskType] = Body(max_length=30), ctx: WorkspaceCtx = Depends(can_ope_fin),
              db: Session = Depends(get_db)):
    """The agency's own task types, as a whole list. A removed type leaves its tasks untyped."""
    if len({x.id for x in body}) != len(body) or len({x.name.strip().lower() for x in body}) != len(body):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Each task type needs its own name")
    ctx.workspace.task_types = [x.model_dump() for x in body]
    db.commit()
    return body


def _check_type(ctx: WorkspaceCtx, type_id: str | None) -> None:
    if type_id and type_id not in {x["id"] for x in ctx.workspace.task_types or []}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown task type")


class AssignIn(BaseModel):
    key: str = Field(min_length=3, max_length=160)
    assignee_id: str | None = None      # None = back to the usual owner / nobody


@router.put("/tasks/assign", status_code=status.HTTP_204_NO_CONTENT)
def assign(body: AssignIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    """Give one task to someone. Staff can only take a task for themselves; managers give to anyone."""
    if not ctx.can("operations", "finance") and body.assignee_id != ctx.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers give tasks to other people")
    _check(db, ctx, body.assignee_id, None)
    kind, _, rest = body.key.partition(":")
    if kind == "booking":
        b = db.scalar(select(TourBooking).join(Tour).where(TourBooking.id == rest, Tour.workspace_id == ctx.workspace.id))
        if not b:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found")
        b.assignee_id = body.assignee_id
    elif kind == "task":
        _own(db, ctx, rest).assignee_id = body.assignee_id
    elif kind == "series":          # every upcoming departure of the route, for that supplier
        series_id, _, vendor_id = rest.partition(":")
        rows = db.scalars(select(TourBooking).join(Tour).where(
            Tour.workspace_id == ctx.workspace.id, Tour.series_id == series_id, TourBooking.vendor_id == vendor_id,
            Tour.end_date >= date.today(), Tour.closed_at.is_(None))).all()
        if not rows:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nothing to assign")
        for b in rows:
            b.assignee_id = body.assignee_id
    elif kind == "pay":
        if not ctx.can("finance"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Payments are for finance")
        tour_id = rest.split(":")[0]
        if not db.scalar(select(Tour.id).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
        row = db.scalar(select(TaskAssignment).where(TaskAssignment.workspace_id == ctx.workspace.id,
                                                     TaskAssignment.key == body.key))
        if body.assignee_id is None:
            if row:
                db.delete(row)
        elif row:
            row.assignee_id, row.updated_at = body.assignee_id, utcnow()
        else:
            db.add(TaskAssignment(workspace_id=ctx.workspace.id, key=body.key, assignee_id=body.assignee_id))
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown task")
    db.commit()


def _own(db: Session, ctx: WorkspaceCtx, task_id: str) -> Task:
    x = db.scalar(select(Task).where(Task.id == task_id, Task.workspace_id == ctx.workspace.id))
    if not x:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    return x


def _check(db: Session, ctx: WorkspaceCtx, assignee_id: str | None, tour_id: str | None) -> None:
    if assignee_id and not db.scalar(select(Membership.id).where(Membership.workspace_id == ctx.workspace.id,
                                                                  Membership.user_id == assignee_id)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Not a member of this agency")
    if tour_id and not db.scalar(select(Tour.id).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")


@router.post("/tasks", response_model=TaskItem, status_code=status.HTTP_201_CREATED)
def create_task(body: TaskIn, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    _check(db, ctx, body.assignee_id, body.tour_id)
    _check_type(ctx, body.type_id)
    x = Task(workspace_id=ctx.workspace.id, title=body.title.strip(), note=body.note, tour_id=body.tour_id,
             assignee_id=body.assignee_id, type_id=body.type_id, due_date=body.due_date, created_by_id=ctx.user.id)
    db.add(x)
    db.commit()
    return next(i for i in all_tasks(db, ctx, True) if i.task_id == x.id)


@router.patch("/tasks/{task_id}", response_model=TaskItem)
def update_task(task_id: str, body: TaskPatch, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    x = _own(db, ctx, task_id)
    values = body.model_dump(exclude_unset=True)
    _check(db, ctx, values.get("assignee_id"), None)
    _check_type(ctx, values.get("type_id"))
    for k in ("title", "note"):
        if values.get(k) is not None:
            setattr(x, k, values[k])
    for k in ("assignee_id", "due_date", "type_id"):
        if k in values:
            setattr(x, k, values[k])
    if "done" in values and values["done"] is not None:
        x.done_at = utcnow() if values["done"] else None
    db.commit()
    return next(i for i in all_tasks(db, ctx, True) if i.task_id == x.id)


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    db.delete(_own(db, ctx, task_id))
    db.commit()
