"""A calculation's tickets on the tour it becomes: the journey on the tour's days (its arrival and
departure flights) and a task to issue the tickets by the fare's deadline."""
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Task, Tour
from .quote_schemas import QuoteIn, QuoteItemIn


def journey(item: QuoteItemIn) -> str:
    legs = item.travel.legs if item.travel else []
    return " · ".join(f"{x.from_place or '?'} → {x.to_place or '?'}" for x in legs if x.from_place or x.to_place)


def _day_of(t: Tour, item: QuoteItemIn, k: int):
    """The tour day a leg is on: its own date when the tour has that date, else the line's day for the
    first leg and the tour's last day for the way back."""
    days = sorted(t.days, key=lambda d: d.day_number)
    if not days:
        return None
    leg = item.travel.legs[k]
    if leg.on:
        hit = next((d for d in days if d.date == leg.on), None)
        if hit:
            return hit
    if k == 0:
        return next((d for d in days if d.day_number == item.day), days[0]) if item.day else days[0]
    return days[-1] if k == len(item.travel.legs) - 1 else None


def _time(s: str) -> str:
    s = s.strip()
    return s if len(s) == 5 and s[2] == ":" and s[:2].isdigit() and s[3:].isdigit() and int(s[:2]) < 24 and int(s[3:]) < 60 else ""


def to_tour(db: Session, t: Tour, doc: QuoteIn, user_id: str | None, source: str) -> list[str]:
    """Flights with a number go on the tour's days (once); each ticket line with an issue-by date
    becomes a task (once). Returns notes for the team."""
    notes: list[str] = []
    for item in doc.items:
        if not item.included or not item.travel:
            continue
        name = f"{item.name} · {journey(item)}" if journey(item) else item.name
        if item.travel.mode == "flight":
            first = min((d.day_number for d in t.days), default=1)
            for k, leg in enumerate(item.travel.legs):
                number = leg.number.strip().upper().replace(" ", "")
                day = _day_of(t, item, k) if len(number) >= 2 else None
                if day is None:
                    continue
                arriving = day.day_number == first
                flight = {"direction": "arrival" if arriving else "departure", "number": number[:12],
                          "time": _time(leg.arrive if arriving else leg.depart), "airport": "",
                          "other": (leg.from_place if arriving else leg.to_place)[:60], "notes": ""}
                have = list(day.flights or [])
                if not any(f.get("number") == flight["number"] and f.get("direction") == flight["direction"] for f in have):
                    day.flights = [*have, flight][:6]
        tb = item.travel.ticket_by
        if tb:
            title = f"Issue tickets: {name}"[:300]
            exists = db.scalar(select(Task.id).where(Task.tour_id == t.id, Task.title == title).limit(1))
            if not exists:
                db.add(Task(workspace_id=t.workspace_id, tour_id=t.id, title=title, due_date=tb, created_by_id=user_id,
                            note=f"From the calculation {source}. Group fares are held until this date."))
            if tb < date.today():
                notes.append(f"{item.name}: tickets should have been issued by {tb}")
    return notes
