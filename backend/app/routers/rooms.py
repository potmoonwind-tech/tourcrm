"""Rooms by night: every hotel, every night, how many rooms all our groups need there.

The season view the old "TOURS MAP" sheet gave: before writing to a hotel you see the whole
block across departures, not tour by tour. Worked out from the itineraries (a day's hotel = the
night of that date) and each tour's rooms (participants, else its Rooms field). When a group's
rooms aren't known yet they are guessed from its size (two per room) and marked as a guess.
Cancelled tours don't count; inquiries are shown apart ("maybe").
"""
import math
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..finance import group_size, room_counts
from ..models import Tour, TourBooking, TourDay
from ..schemas import SeriesColor, VendorRef

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["rooms"])
office = require_role("staff")

MAX_DAYS = 120
ROOM_ORDER = ("DBL", "TWN", "SGL", "TRP", "QUAD")
HOUSED_STAFF = {"guide", "driver", "tour_leader", "assistant"}


class GroupStay(BaseModel):
    tour_id: str
    code: str
    color: SeriesColor
    status: str                 # confirmed | inquiry
    client_name: str | None
    nights: list[date]          # the nights in the window at this hotel
    check_in: date              # the whole stay, also outside the window
    check_out: date
    rooms: dict[str, int]       # {"DBL": 9, "SGL": 1}; empty when guessed
    rooms_total: int
    guessed: bool               # rooms not known: pax / 2
    pax: int
    pax_estimated: bool
    staff: int                  # guides / drivers on the tour those nights (may need rooms too)
    booking: str                # to_book | requested | confirmed | problem | cancelled


class Night(BaseModel):
    date: date
    rooms: int                  # confirmed groups
    maybe: int                  # inquiries
    groups: int
    guessed: bool               # some of the count is a guess


class HotelRooms(BaseModel):
    vendor: VendorRef
    city: str
    nights: list[Night]         # only nights with someone there
    groups: list[GroupStay]
    rooms: int                  # room-nights in the window (confirmed)


class RoomsByNight(BaseModel):
    date_from: date
    date_to: date
    hotels: list[HotelRooms]


@router.get("/rooms-by-night", response_model=RoomsByNight)
def rooms_by_night(date_from: date = Query(...), date_to: date = Query(...), ctx: WorkspaceCtx = Depends(office),
                   db: Session = Depends(get_db)):
    if date_to < date_from or (date_to - date_from).days > MAX_DAYS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Pick at most {MAX_DAYS} days")
    tours = db.scalars(
        select(Tour).where(Tour.workspace_id == ctx.workspace.id, Tour.status != "cancelled",
                           Tour.start_date <= date_to, Tour.end_date >= date_from)
        .options(selectinload(Tour.days).selectinload(TourDay.hotel), selectinload(Tour.participants),
                 selectinload(Tour.staff), selectinload(Tour.series), selectinload(Tour.client))).all()
    bookings = {(b.tour_id, b.vendor_id): b.status for b in db.scalars(
        select(TourBooking).where(TourBooking.tour_id.in_([t.id for t in tours])))} if tours else {}

    hotels: dict[str, dict] = {}
    for t in tours:
        rooms = {k: v for k, v in sorted(room_counts(t).items(), key=lambda kv: ROOM_ORDER.index(kv[0])
                                         if kv[0] in ROOM_ORDER else 99) if v}
        pax = group_size(t) or 0
        guessed = not rooms
        total = sum(rooms.values()) if rooms else math.ceil(pax / 2)
        # Consecutive nights at one hotel are one stay.
        stays: list[tuple[TourDay, list[TourDay]]] = []
        for d in sorted(t.days, key=lambda x: x.day_number):
            if d.hotel is None:
                continue
            if stays and stays[-1][0].hotel_id == d.hotel_id and stays[-1][1][-1].date + timedelta(days=1) == d.date:
                stays[-1][1].append(d)
            else:
                stays.append((d, [d]))
        for first, days in stays:
            inside = [d for d in days if date_from <= d.date <= date_to]
            if not inside:
                continue
            h = hotels.setdefault(first.hotel_id, {"vendor": first.hotel, "cities": defaultdict(int), "groups": []})
            for d in inside:
                h["cities"][d.city] += 1
            staff = sum(1 for a in t.staff if a.role in HOUSED_STAFF
                        and any(a.covers(d.day_number) for d in inside))
            h["groups"].append(GroupStay(
                tour_id=t.id, code=t.code, color=t.series.color if t.series else "slate", status=t.status,
                client_name=t.client.name if t.client else None, nights=[d.date for d in inside],
                check_in=days[0].date, check_out=days[-1].date + timedelta(days=1), rooms=rooms, rooms_total=total,
                guessed=guessed, pax=pax, pax_estimated=t.pax_estimated, staff=staff,
                booking=bookings.get((t.id, first.hotel_id), "to_book")))

    out: list[HotelRooms] = []
    for h in hotels.values():
        per: dict[date, Night] = {}
        for g in h["groups"]:
            for n in g.nights:
                night = per.setdefault(n, Night(date=n, rooms=0, maybe=0, groups=0, guessed=False))
                night.groups += 1
                if g.status == "inquiry":
                    night.maybe += g.rooms_total
                else:
                    night.rooms += g.rooms_total
                night.guessed = night.guessed or g.guessed
        city = max(h["cities"].items(), key=lambda kv: kv[1])[0] if h["cities"] else ""
        out.append(HotelRooms(vendor=VendorRef.model_validate(h["vendor"]), city=city,
                              nights=sorted(per.values(), key=lambda n: n.date),
                              groups=sorted(h["groups"], key=lambda g: (g.check_in, g.code)),
                              rooms=sum(n.rooms for n in per.values())))
    out.sort(key=lambda h: (h.city.lower(), h.vendor.name.lower()))
    return RoomsByNight(date_from=date_from, date_to=date_to, hotels=out)
