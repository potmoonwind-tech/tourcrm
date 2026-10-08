"""A restaurant's dishes and its set menus (the menu builder).

Every restaurant keeps its own dish list - name, section (salads, mains…), price - filled by hand, from an
Excel file or from a photo of its menu (AI reads it; nothing is saved before the manager checks it). Set
menus are built from those dishes. A dish's new price is kept in its history and goes to every set menu of
the restaurant that serves it; tours already costed keep their numbers.
"""
import base64
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import dishes as dish_util
from ..config import settings
from ..db import get_db
from ..deps import WorkspaceCtx, require_jobs
from ..importer import ImportFileError, _blank, norm_header, read_table
from ..models import DishPriceChange, RestaurantDish, Service, ServiceRate, Vendor
from ..scoping import get_owned

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["menus"])
can_read = require_jobs("operations", "finance", "sales")
can_edit = require_jobs("operations")

MAX_IMAGE = 8 * 1024 * 1024


class PriceChangeOut(BaseModel):
    price: Decimal | None
    currency: str
    changed_at: datetime


class DishIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: str = Field(default="", max_length=40)
    price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    currency: str = Field(default="", max_length=3)
    per_plate: int | None = Field(default=None, ge=1, le=20)


class DishUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    category: str | None = Field(default=None, max_length=40)
    price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    currency: str | None = Field(default=None, max_length=3)
    per_plate: int | None = Field(default=None, ge=1, le=20)
    position: int | None = None


class DishOut(BaseModel):
    id: str
    name: str
    category: str
    price: Decimal | None
    currency: str
    per_plate: int | None
    position: int
    history: list[PriceChangeOut]     # newest first


def _vendor(db: Session, ctx: WorkspaceCtx, vendor_id: str) -> Vendor:
    return get_owned(db, ctx, Vendor, vendor_id)


def _out(d: RestaurantDish) -> DishOut:
    return DishOut(id=d.id, name=d.name, category=d.category, price=d.price, currency=d.currency, per_plate=d.per_plate,
                   position=d.position, history=[PriceChangeOut(price=h.price, currency=h.currency, changed_at=h.changed_at)
                                                 for h in sorted(d.history, key=lambda h: h.changed_at, reverse=True)])


def _dishes(db: Session, v: Vendor) -> list[RestaurantDish]:
    return list(db.scalars(select(RestaurantDish).where(RestaurantDish.vendor_id == v.id)
                           .order_by(RestaurantDish.position, RestaurantDish.name)))


@router.get("/vendors/{vendor_id}/dishes", response_model=list[DishOut])
def list_dishes(vendor_id: str, ctx: WorkspaceCtx = Depends(can_read), db: Session = Depends(get_db)):
    return [_out(d) for d in _dishes(db, _vendor(db, ctx, vendor_id))]


@router.post("/vendors/{vendor_id}/dishes", response_model=list[DishOut])
def add_dishes(vendor_id: str, body: list[DishIn], ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    """Add dishes (by hand, or the checked rows of an Excel or a photo). A name already listed is updated instead."""
    v = _vendor(db, ctx, vendor_id)
    have = {d.name.strip().lower(): d for d in _dishes(db, v)}
    pos = max((d.position for d in have.values()), default=0)
    # The restaurant's own currency: as in the catalogue, else its prices', else the agency's.
    from collections import Counter
    used = Counter(r.currency for s in v.services for r in s.rates if r.currency)
    currency = (v.currency or (used.most_common(1)[0][0] if used else "") or ctx.workspace.base_currency or "").upper()
    for x in body[:300]:
        cur = have.get(x.name.strip().lower())
        if cur is not None:
            _update(db, ctx, v, cur, DishUpdate(category=x.category or None, price=x.price, currency=x.currency or None))
            continue
        pos += 1
        d = RestaurantDish(vendor_id=v.id, name=x.name.strip(), category=x.category.strip(), price=x.price,
                           currency=(x.currency or currency).upper(), per_plate=x.per_plate, position=pos)
        db.add(d)
        db.flush()
        if d.price is not None:
            db.add(DishPriceChange(dish_id=d.id, price=d.price, currency=d.currency, changed_by_id=ctx.user.id))
        have[d.name.lower()] = d
    db.commit()
    return [_out(d) for d in _dishes(db, v)]


def _update(db: Session, ctx: WorkspaceCtx, v: Vendor, d: RestaurantDish, body: DishUpdate) -> None:
    old_name, old_price, old_cur = d.name, d.price, d.currency
    values = body.model_dump(exclude_unset=True)
    for k, val in values.items():
        if val is None and k not in ("price", "per_plate"):
            continue
        setattr(d, k, val.strip() if isinstance(val, str) and k != "currency" else (val.upper() if k == "currency" and val else val))
    price_changed = "price" in values and (d.price != old_price or d.currency != old_cur)
    if price_changed:
        db.add(DishPriceChange(dish_id=d.id, price=d.price, currency=d.currency, changed_by_id=ctx.user.id))
    if price_changed or d.name != old_name:
        # Every set menu of the restaurant serving it: the new name and price (by its link, or by name when the
        # dish it was linked to is gone).
        live = {x.id for x in _dishes(db, v)}
        for s in v.services:
            changed = False
            rows = []
            for x in dish_util.normalize(s.dishes):
                if x.get("dish_id") == d.id or (x.get("dish_id") not in live and x["name"].lower() == old_name.lower()):
                    x = {**x, "name": d.name, "price": float(d.price) if d.price is not None else None, "dish_id": d.id}
                    changed = True
                rows.append(x)
            if changed:
                s.dishes = rows


@router.patch("/vendors/{vendor_id}/dishes/{dish_id}", response_model=DishOut)
def update_dish(vendor_id: str, dish_id: str, body: DishUpdate, ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    v = _vendor(db, ctx, vendor_id)
    d = db.get(RestaurantDish, dish_id)
    if d is None or d.vendor_id != v.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dish not found")
    _update(db, ctx, v, d, body)
    db.commit()
    db.refresh(d)
    return _out(d)


@router.delete("/vendors/{vendor_id}/dishes/{dish_id}", status_code=204)
def delete_dish(vendor_id: str, dish_id: str, ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    """The dish leaves the list; set menus keep it as written."""
    v = _vendor(db, ctx, vendor_id)
    d = db.get(RestaurantDish, dish_id)
    if d is None or d.vendor_id != v.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dish not found")
    db.delete(d)
    db.commit()


# --- reading a menu: Excel / CSV, or a photo --------------------------------------------------------

class ReadDish(BaseModel):
    name: str
    category: str = ""
    price: Decimal | None = None


class ReadOut(BaseModel):
    dishes: list[ReadDish]
    by_ai: bool = False


NAME_H = {norm_header(x) for x in ("dish", "dishes", "name", "item", "menu item", "title", "блюдо", "название", "наименование",
                                   "კერძი", "დასახელება", "菜名", "菜品", "名称", "品名")}
PRICE_H = {norm_header(x) for x in ("price", "cost", "amount", "цена", "стоимость", "ფასი", "价格", "单价", "价钱")}
CAT_H = {norm_header(x) for x in ("category", "section", "group", "type", "раздел", "категория", "группа", "კატეგორია", "类别", "分类")}


def _money(v) -> Decimal | None:
    if v is None:
        return None
    if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
        return Decimal(str(v)).quantize(Decimal("0.01")) if v >= 0 else None
    m = re.search(r"\d+(?:[.,]\d{1,2})?", str(v).replace(" ", ""))
    if not m or not re.fullmatch(r"[^\w]*\d+(?:[.,]\d{1,2})?\s*(?:₾|gel|lari|лари|usd|\$|eur|€|ლარი|元)?[^\w]*", str(v).strip().lower()):
        return None
    try:
        return Decimal(m.group(0).replace(",", ".")).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def read_sheet(table) -> list[ReadDish]:
    """Dishes from a sheet: the name, section and price columns when it has headers; else each row's text and
    its last number. A row with only a text above dishes is a section ("Salads")."""
    header_i, cols = None, {}
    for i, (_, row) in enumerate(table[:10]):
        found = {}
        for j, h in enumerate(row):
            n = norm_header(h)
            if n in NAME_H:
                found.setdefault("name", j)
            elif n in PRICE_H:
                found.setdefault("price", j)
            elif n in CAT_H:
                found.setdefault("category", j)
        if "name" in found and "price" in found:
            header_i, cols = i, found
            break
    out, section = [], ""
    for _, row in table[header_i + 1 if header_i is not None else 0:]:
        cells = [_blank(v) for v in row]
        if cols:
            name = cells[cols["name"]] if cols["name"] < len(cells) else None
            price = _money(cells[cols["price"]]) if cols["price"] < len(cells) else None
            cat = cells[cols["category"]] if "category" in cols and cols["category"] < len(cells) else None
        else:
            texts = [c for c in cells if isinstance(c, str) and _money(c) is None]
            nums = [_money(c) for c in cells if c is not None and _money(c) is not None]
            name, price, cat = (texts[0] if texts else None), (nums[-1] if nums else None), None
        if name is None:
            continue
        name = " ".join(str(name).split())[:120]
        if price is None and not cat and sum(1 for c in cells if c is not None) == 1:
            section = name[:40]            # a heading row
            continue
        out.append(ReadDish(name=name, category=str(cat or section)[:40], price=price))
    return out[:300]


def make_client(ws):
    """Tests replace this."""
    from ..ai.agent import make_client as ai_client
    return ai_client(ws)


def read_photo(ws, data: bytes, media_type: str) -> list[ReadDish]:
    """A photo or scan of a menu, read by AI: each dish with its section and price."""
    prompt = (
        "This is a photo of a restaurant's menu (Georgia, Armenia, Azerbaijan; any language). List every dish with its "
        "section and price. Answer with only a JSON list: [{\"name\": \"Khinkali\", \"category\": \"Mains\", \"price\": 12.5}]. "
        "Keep the dish names as the menu writes them (if it has two languages, the Latin one); price is a number or null; "
        "leave out drinks only if the menu has none.")
    try:
        msg = make_client(ws).messages.create(
            model=settings.ai_translate_model, max_tokens=8000,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.b64encode(data).decode()}},
                {"type": "text", "text": prompt}]}])
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        got = json.loads(text[text.index("["): text.rindex("]") + 1])
    except Exception as e:          # noqa: BLE001
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Couldn't read the photo. Try a sharper one, or an Excel file") from e
    out = []
    for x in got if isinstance(got, list) else []:
        if isinstance(x, dict) and str(x.get("name") or "").strip():
            out.append(ReadDish(name=" ".join(str(x["name"]).split())[:120], category=str(x.get("category") or "")[:40],
                                price=_money(x.get("price"))))
    return out[:300]


@router.post("/vendors/{vendor_id}/dishes/read", response_model=ReadOut)
async def read_menu(vendor_id: str, file: UploadFile = File(...), ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    """What a menu file or photo lists - nothing is saved: the manager checks the rows, then adds them."""
    _vendor(db, ctx, vendor_id)
    data = await file.read(MAX_IMAGE + 1)
    name = (file.filename or "").lower()
    kind = (file.content_type or "").lower()
    if kind.startswith("image/") or name.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
        from ..ai import keys
        if not keys.key_for(ctx.workspace):
            raise HTTPException(status.HTTP_409_CONFLICT, "Reading a photo needs the AI key (Settings → AI)")
        if len(data) > MAX_IMAGE:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The photo is larger than 8 MB")
        media = {"png": "image/png", "webp": "image/webp", "gif": "image/gif"}.get(name.rsplit(".", 1)[-1], "image/jpeg")
        media = kind if kind in ("image/jpeg", "image/png", "image/webp", "image/gif") else media
        return ReadOut(dishes=read_photo(ctx.workspace, data, media), by_ai=True)
    try:
        return ReadOut(dishes=read_sheet(read_table(data, file.filename or "")))
    except ImportFileError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


# --- a set menu's dishes (and its price) -------------------------------------------------------------

class MenuDish(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: float | None = Field(default=None, ge=0, le=100000)
    per_plate: int | None = Field(default=None, ge=1, le=20)
    dish_id: str | None = Field(default=None, max_length=36)


class MenuIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    dishes: list[MenuDish] = Field(max_length=40)
    price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)   # the menu's price per person
    currency: str | None = Field(default=None, max_length=3)


@router.put("/vendors/{vendor_id}/menus/{service_id}", status_code=204)
def save_menu_dishes(vendor_id: str, service_id: str, body: MenuIn, ctx: WorkspaceCtx = Depends(can_edit), db: Session = Depends(get_db)):
    """A set menu's dishes (dragged in from the restaurant's list), its name, and - when given - its price."""
    v = _vendor(db, ctx, vendor_id)
    s = db.scalar(select(Service).where(Service.id == service_id, Service.vendor_id == v.id))
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Menu not found")
    if body.name:
        s.name = body.name.strip()
    s.dishes = dish_util.normalize([x.model_dump() for x in body.dishes])
    if body.price is not None:
        cur = (body.currency or v.currency or ctx.workspace.base_currency or "GEL").upper()
        if len(s.rates) > 1:
            raise HTTPException(status.HTTP_409_CONFLICT, "This menu has several prices (seasons, group sizes): change them in its price list")
        if s.rates:
            s.rates[0].price, s.rates[0].currency = body.price, cur
        else:
            s.rates.append(ServiceRate(price=body.price, currency=cur))
    db.commit()
