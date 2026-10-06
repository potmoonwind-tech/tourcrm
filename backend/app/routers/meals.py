"""A tour's meals, dish by dish: what is served where, repeats, and what it costs.

One row per lunch and dinner (restaurant, set menu, dishes, price per person for that
date and group size, people eating, total), and every dish across the tour with the
days it's served and its price at each restaurant. Prices are for managers only.
"""
from collections import defaultdict
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import catalog, dishes as dish_util
from ..db import get_db
from ..deps import WorkspaceCtx, require_role
from ..finance import MEAL_STAFF, group_size
from ..models import Service, StaffAssignment, Tour, TourDay, Vendor
from ..schemas import VendorRef

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["meals"])
office = require_role("staff")


class DishOut(BaseModel):
    name: str
    price: float | None        # one plate (managers only)
    per_plate: int = 1         # people sharing one plate
    plates: int = 0            # plates of it for this meal
    same_day: bool             # also at the other meal that day
    prev_day: bool             # also served the day before


class MealRow(BaseModel):
    day: int
    date: date
    meal: str                  # breakfast | lunch | dinner
    vendor: VendorRef
    menu_id: str | None
    menu_name: str | None
    dishes: list[DishOut]
    people: int                # tourists + staff eating that day
    price_pp: float | None     # the menu's (or the restaurant's usual) price for that date and group
    dish_sum: float | None     # sum of the dish prices, when all are priced
    currency: str | None
    total: float | None
    tourists_pay: bool = False  # reserved by us, paid by the tourists: not in our totals
    shared: bool = False        # family style: priced plate by plate (total = Σ dish price × plates)


class DishPlace(BaseModel):
    vendor: VendorRef
    menu_name: str
    price: float | None


class DishSummary(BaseModel):
    name: str
    days: list[int]
    servings: int              # lunches and dinners it's on
    places: list[DishPlace]    # where it's served and what it costs there
    min_price: float | None
    max_price: float | None


class TourMeals(BaseModel):
    rows: list[MealRow]
    dishes: list[DishSummary]
    totals: dict[str, float]   # per currency
    sees_prices: bool
    plate_share: int | None = None    # this tour's people per plate (None = the agency's)
    agency_plate_share: int = 1


@router.get("/tours/{tour_id}/meals", response_model=TourMeals)
def tour_meals(tour_id: str, ctx: WorkspaceCtx = Depends(office), db: Session = Depends(get_db)):
    t = db.scalar(select(Tour).where(Tour.id == tour_id, Tour.workspace_id == ctx.workspace.id)
                  .options(selectinload(Tour.days).options(selectinload(TourDay.breakfast).selectinload(Vendor.services).selectinload(Service.rates),
                                                           selectinload(TourDay.lunch).selectinload(Vendor.services).selectinload(Service.rates),
                                                           selectinload(TourDay.dinner).selectinload(Vendor.services).selectinload(Service.rates)),
                           selectinload(Tour.staff).selectinload(StaffAssignment.vendor), selectinload(Tour.participants)))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tour not found")
    money = ctx.can("operations", "finance", "sales")    # menu prices
    share_all = ctx.workspace.plate_share or 1
    pax = group_size(t) or 0
    rows: list[MealRow] = []
    totals: dict[str, Decimal] = defaultdict(Decimal)
    summary: dict[str, dict] = {}
    prev: set[str] = set()
    for d in sorted(t.days, key=lambda x: x.day_number):
        staff = sum(1 for a in t.staff if a.role in MEAL_STAFF and a.covers(d.day_number))
        meals = []
        for meal, vendor, menu_id in (("breakfast", d.breakfast, d.breakfast_menu_id), ("lunch", d.lunch, d.lunch_menu_id),
                                      ("dinner", d.dinner, d.dinner_menu_id)):
            if vendor is None or (getattr(d, f"{meal}_mode", None) or "included") in ("own", "hotel"):
                continue
            menu = next((s for s in vendor.services if s.id == menu_id), None)
            ds = dish_util.normalize(menu.dishes if menu else [])
            meals.append((meal, vendor, menu, ds))
        today: dict[str, int] = defaultdict(int)
        for _, _, _, ds in meals:
            for x in ds:
                today[x["name"].lower()] += 1
        for meal, vendor, menu, ds in meals:
            rate = catalog.pick(menu.rates, d.date, pax or None) if menu else catalog.price_for(vendor, meal, d.date, pax or None)
            people = pax + staff
            price = rate.price if rate else None
            total = (price * people).quantize(Decimal("0.01")) if price is not None else None
            # Family style: so many plates of each dish (12 people, 1 plate per 4 → 3 plates).
            shared = bool(menu) and dish_util.sharing(menu.dishes, t.plate_share, share_all)
            if shared:
                total = dish_util.plate_total(menu.dishes, people, t.plate_share, share_all)
                price = (total / people).quantize(Decimal("0.01")) if total is not None and people else None
            paid_by_them = (getattr(d, f"{meal}_mode", None) or "included") == "tourists"
            if total is not None and money and not paid_by_them:
                totals[rate.currency] += total
            rows.append(MealRow(
                day=d.day_number, date=d.date, meal=meal, vendor=VendorRef.model_validate(vendor),
                menu_id=menu.id if menu else None, menu_name=menu.name if menu else None,
                shared=shared,
                dishes=[DishOut(name=x["name"], price=x["price"] if money else None, same_day=today[x["name"].lower()] > 1,
                                per_plate=dish_util.share_of(x, t.plate_share, share_all),
                                plates=dish_util.plates(people, dish_util.share_of(x, t.plate_share, share_all)),
                                prev_day=x["name"].lower() in prev) for x in ds],
                people=people, price_pp=price if money else None,
                dish_sum=dish_util.total(menu.dishes) if (money and menu) else None,
                currency=rate.currency if (rate and money) else None, total=total if money else None,
                tourists_pay=paid_by_them))
            for x in ds:
                s = summary.setdefault(x["name"].lower(), {"name": x["name"], "days": set(), "servings": 0, "places": {}})
                s["days"].add(d.day_number)
                s["servings"] += 1
                s["places"][(vendor.id, menu.name)] = DishPlace(vendor=VendorRef.model_validate(vendor), menu_name=menu.name,
                                                                price=x["price"] if money else None)
        prev = set(today)
    dishes = []
    for s in sorted(summary.values(), key=lambda s: (-s["servings"], s["name"].lower())):
        prices = [p.price for p in s["places"].values() if p.price is not None]
        dishes.append(DishSummary(name=s["name"], days=sorted(s["days"]), servings=s["servings"], places=list(s["places"].values()),
                                  min_price=min(prices) if prices else None, max_price=max(prices) if prices else None))
    return TourMeals(rows=rows, dishes=dishes, totals={k: float(v) for k, v in sorted(totals.items())}, sees_prices=money,
                     plate_share=t.plate_share, agency_plate_share=share_all)
