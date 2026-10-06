"""Spreadsheet import for participants, tours, vendors and clients.

Partner agencies send lists in whatever shape they have, so parsing is forgiving:
- .xlsx or .csv (any common delimiter, UTF-8 or Windows-1251);
- the header row is found automatically, even under a title line;
- column names are matched in English, Georgian, Russian and Chinese;
- dates as Excel dates, 2026-09-06, 06.09.2026, 06/09/2026 or 06SEP2026.

Every import runs twice: once as a preview (commit=False) that reports what
would happen row by row, then for real. Invalid rows are skipped, never guessed.
"""
import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Callable

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .deps import WorkspaceCtx
from .models import Client, Participant, Series, Tour, Vendor
from .routers.people import next_position
from .routers.tours import MAX_TOUR_DAYS, _code_taken, _generate_code, sync_days
from .schemas import ImportIssue, ImportResult

MAX_ROWS = 2000
MAX_BYTES = 5 * 1024 * 1024


class ImportFileError(ValueError):
    """The file as a whole can't be read (wrong format, empty, too big)."""


# --- reading ---------------------------------------------------------------------------

def read_table(data: bytes, filename: str) -> list[tuple[int, list]]:
    """[(spreadsheet row number, [cell values])], empty rows dropped."""
    if len(data) > MAX_BYTES:
        raise ImportFileError("File is larger than 5 MB")
    name = filename.lower()
    if name.endswith((".xlsx", ".xlsm")):
        try:
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception as e:  # corrupt / not really xlsx
            raise ImportFileError("Could not read the Excel file") from e
        ws = wb.worksheets[0]
        rows = []
        for i, r in enumerate(ws.iter_rows(values_only=True), 1):
            rows.append((i, list(r)))
            if i > MAX_ROWS + 50:      # a tiny file can unpack to millions of rows: stop early
                break
        wb.close()
    elif name.endswith((".csv", ".txt")):
        for enc in ("utf-8-sig", "cp1251"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ImportFileError("Could not decode the CSV file")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = [(i, r) for i, r in enumerate(csv.reader(io.StringIO(text), dialect), 1)]
    else:
        raise ImportFileError("Upload an .xlsx or .csv file")
    rows = [(i, r) for i, r in rows if any(_blank(v) is not None for v in r)]
    if not rows:
        raise ImportFileError("The file is empty")
    return rows


def _blank(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def norm_header(h) -> str:
    return re.sub(r"[\s_\-.*:#()/№'\"]+", "", str(h or "").lower())


# --- fields & value parsing ------------------------------------------------------------

@dataclass
class F:
    key: str
    aliases: tuple[str, ...]
    parse: Callable[[object], object] = lambda v: str(v).strip()
    required: bool = False
    example: object = ""


def as_text(limit: int) -> Callable[[object], str]:
    def p(v):
        if isinstance(v, float) and v.is_integer():
            v = int(v)  # phone / passport numbers stored as numbers in Excel
        s = str(v).strip()
        if len(s) > limit:
            raise ValueError(f"longer than {limit} characters")
        return s
    return p


_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%Y.%m.%d",
                 "%d %b %Y", "%d %B %Y", "%d%b%Y", "%d.%m.%y", "%d/%m/%y")


def as_date(v) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)) and 1000 < v < 80000:  # Excel serial day in a CSV
        return date(1899, 12, 30) + timedelta(days=int(v))
    s = str(v).strip().split(" 00:00")[0]
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"'{s}' is not a date (use 2026-09-06 or 06.09.2026)")


def as_int(v) -> int:
    try:
        n = int(float(str(v).strip()))
    except ValueError:
        raise ValueError(f"'{v}' is not a number") from None
    if n < 0:
        raise ValueError("must not be negative")
    return n


def as_choice(mapping: dict[str, str], label: str) -> Callable[[object], str]:
    table = {norm_header(k): val for k, val in mapping.items()}

    def p(v):
        key = norm_header(v)
        if key in table:
            return table[key]
        raise ValueError(f"unknown {label} '{v}'")
    return p


GENDER = as_choice({
    "m": "M", "male": "M", "man": "M", "mr": "M", "მ": "M", "მამრ": "M", "კაცი": "M", "м": "M", "муж": "M", "мужской": "M", "男": "M",
    "f": "F", "female": "F", "woman": "F", "mrs": "F", "ms": "F", "ქ": "F", "მდედრ": "F", "ქალი": "F", "ж": "F", "жен": "F", "женский": "F", "女": "F",
}, "gender")

ROOM = as_choice({
    "sgl": "SGL", "single": "SGL", "sngl": "SGL", "1": "SGL", "单人间": "SGL", "单间": "SGL", "ერთადგილიანი": "SGL",
    "dbl": "DBL", "double": "DBL", "dbl room": "DBL", "2": "DBL", "双人间": "DBL", "大床": "DBL", "大床房": "DBL", "ორადგილიანი": "DBL",
    "twn": "TWN", "twin": "TWN", "标间": "TWN", "双床": "TWN", "双床房": "TWN",
    "trp": "TRP", "tpl": "TRP", "triple": "TRP", "3": "TRP", "三人间": "TRP", "სამადგილიანი": "TRP",
    "quad": "QUAD", "qdr": "QUAD", "4": "QUAD", "四人间": "QUAD",
}, "room type")

STATUS = as_choice({
    "confirmed": "confirmed", "ok": "confirmed", "yes": "confirmed", "დადასტურებული": "confirmed", "подтвержден": "confirmed",
    "inquiry": "inquiry", "option": "inquiry", "request": "inquiry", "tentative": "inquiry", "მოთხოვნა": "inquiry", "запрос": "inquiry",
    "cancelled": "cancelled", "canceled": "cancelled", "cancel": "cancelled", "cxl": "cancelled", "გაუქმებული": "cancelled", "отмена": "cancelled",
}, "status")

VENDOR_TYPE = as_choice({
    "hotel": "hotel", "სასტუმრო": "hotel", "гостиница": "hotel", "отель": "hotel", "酒店": "hotel",
    "restaurant": "restaurant", "რესტორანი": "restaurant", "ресторан": "restaurant", "餐厅": "restaurant",
    "transport": "transport", "bus": "transport", "ტრანსპორტი": "transport", "транспорт": "transport", "车": "transport",
    "guide": "guide", "გიდი": "guide", "гид": "guide", "导游": "guide",
    "driver": "driver", "მძღოლი": "driver", "водитель": "driver", "司机": "driver",
    "activity": "activity", "აქტივობა": "activity", "other": "other", "სხვა": "other",
}, "vendor type")

TIMING = as_choice({"before": "before", "prepay": "before", "prepaid": "before", "წინასწარ": "before", "до": "before",
                    "after": "after", "postpay": "after", "შემდეგ": "after", "после": "after"}, "payment timing")

CLIENT_TYPE = as_choice({"agency": "agency", "სააგენტო": "agency", "агентство": "agency", "旅行社": "agency",
                         "direct": "direct", "პირდაპირი": "direct", "частный": "direct"}, "client type")


def as_currency(v) -> str:
    s = str(v).strip().upper()
    if len(s) != 3 or not s.isalpha():
        raise ValueError(f"'{v}' is not a 3-letter currency code")
    return s


# Shared aliases
NAME = ("name", "სახელი", "название", "имя", "名称")
NOTES = ("notes", "note", "remarks", "remark", "comment", "comments", "შენიშვნა", "შენიშვნები", "примечание", "комментарий", "备注")
PHONE = ("phone", "mobile", "tel", "telephone", "ტელეფონი", "მობილური", "телефон", "电话", "手机")
EMAIL = ("email", "e-mail", "mail", "ელფოსტა", "почта", "邮箱")

SPECS: dict[str, list[F]] = {
    "participants": [
        F("full_name", ("fullname", "full name", "name", "passenger", "guest", "tourist", "traveller", "სახელიგვარი",
                        "სახელი და გვარი", "სახელი", "ტურისტი", "фио", "имя", "姓名", "名字", "拼音"), as_text(200), example="WANG Li"),
        F("first_name", ("first name", "given name", "given names", "სახელი (first)", "имя (first)", "名")),
        F("last_name", ("last name", "surname", "family name", "გვარი", "фамилия", "姓")),
        F("gender", ("gender", "sex", "სქესი", "пол", "性别"), GENDER, example="F"),
        F("birth_date", ("date of birth", "dob", "birth date", "birthday", "born", "დაბადების თარიღი", "დაბადება",
                         "дата рождения", "出生日期", "生日"), as_date, example=date(1985, 4, 12)),
        F("nationality", ("nationality", "citizenship", "country", "მოქალაქეობა", "ეროვნება", "гражданство", "国籍"), as_text(100), example="China"),
        F("passport_number", ("passport", "passport no", "passport number", "pass no", "passport #", "პასპორტი",
                              "პასპორტის ნომერი", "паспорт", "номер паспорта", "护照", "护照号", "护照号码"), as_text(50), example="E12345678"),
        F("passport_expiry", ("passport expiry", "expiry", "expiry date", "date of expiry", "valid until", "expires",
                              "passport valid", "პასპორტის ვადა", "ვადა", "срок действия", "有效期", "护照有效期"), as_date, example=date(2031, 1, 31)),
        F("room_type", ("room type", "room", "accommodation", "ოთახის ტიპი", "ოთახი", "тип номера", "номер", "房型"), ROOM, example="DBL"),
        F("room_group", ("room no", "room number", "room group", "roommate", "roommates", "sharing", "share with",
                         "ოთახის ნომერი", "№ номера", "房号", "房间", "同住"), as_text(40), example="R1"),
        F("phone", PHONE, as_text(50)),
        F("notes", NOTES, as_text(2000), example="Vegetarian"),
    ],
    "tours": [
        F("code", ("code", "tour code", "tour", "group", "group code", "ტურის კოდი", "კოდი", "ტური", "код", "团号"), as_text(40), example="HM-1106"),
        F("route", ("route", "series", "program", "programme", "მარშრუტი", "სერია", "маршрут", "线路"), as_text(20), example="HM"),
        F("start_date", ("start", "start date", "from", "arrival", "date from", "დაწყება", "დაწყების თარიღი", "ჩამოსვლა",
                         "начало", "заезд", "开始", "抵达"), as_date, required=True, example=date(2026, 11, 6)),
        F("end_date", ("end", "end date", "to", "departure", "date to", "დასრულება", "დასრულების თარიღი", "გამგზავრება",
                       "конец", "выезд", "结束", "离开"), as_date),
        F("client", ("client", "agency", "partner", "customer", "კლიენტი", "სააგენტო", "клиент", "агентство", "客户", "旅行社"), as_text(200), example="Orient Holidays"),
        F("pax", ("pax", "people", "persons", "tourists", "group size", "ტურისტები", "რაოდენობა", "кол-во", "человек", "人数"), as_int, example=24),
        F("rooms", ("rooms", "rooming", "ოთახები", "номера", "房间"), as_text(200), example="12 DBL"),
        F("status", ("status", "სტატუსი", "статус", "状态"), STATUS, example="confirmed"),
        F("name", ("name", "title", "tour name", "სახელი", "название"), as_text(200)),
        F("notes", NOTES, as_text(5000)),
    ],
    "vendors": [
        F("name", NAME, as_text(200), required=True, example="Old Town Hotel"),
        F("type", ("type", "category", "kind", "ტიპი", "კატეგორია", "тип", "类型"), VENDOR_TYPE, required=True, example="hotel"),
        F("city", ("city", "town", "location", "ქალაქი", "город", "城市"), as_text(100), example="Tbilisi"),
        F("contact_person", ("contact", "contact person", "manager", "საკონტაქტო პირი", "контакт", "联系人"), as_text(200)),
        F("phone", PHONE, as_text(50), example="+995 555 000 000"),
        F("phone2", ("phone 2", "phone2", "second phone", "მეორე ტელეფონი", "телефон 2"), as_text(50)),
        F("email", EMAIL, as_text(255)),
        F("payment_days", ("payment days", "days", "pay days", "გადახდის დღეები", "дней оплаты"), as_int, example=7),
        F("payment_timing", ("payment timing", "timing", "pay", "გადახდა", "оплата"), TIMING, example="after"),
        F("currency", ("currency", "ვალუტა", "валюта", "币种"), as_currency),
        F("notes", NOTES, as_text(5000)),
    ],
    "clients": [
        F("name", NAME, as_text(200), required=True, example="Orient Holidays"),
        F("type", ("type", "ტიპი", "тип"), CLIENT_TYPE, example="agency"),
        F("country", ("country", "ქვეყანა", "страна", "国家"), as_text(100), example="China"),
        F("contact_person", ("contact", "contact person", "manager", "საკონტაქტო პირი", "контакт", "联系人"), as_text(200)),
        F("email", EMAIL, as_text(255)),
        F("phone", PHONE, as_text(50)),
        F("notes", NOTES, as_text(5000)),
    ],
}


def _alias_table(spec: list[F]) -> dict[str, str]:
    # Earlier fields win, so a bare "name" means full_name before first_name.
    table: dict[str, str] = {}
    for f in spec:
        for a in (f.key, *f.aliases):
            table.setdefault(norm_header(a), f.key)
    return table


@dataclass
class Parsed:
    columns: dict[str, str | None]
    total: int = 0  # data rows under the header
    records: list[tuple[int, dict]] = field(default_factory=list)
    errors: list[ImportIssue] = field(default_factory=list)
    warnings: list[ImportIssue] = field(default_factory=list)


def parse(entity: str, table: list[tuple[int, list]]) -> Parsed:
    spec = SPECS[entity]
    aliases = _alias_table(spec)
    by_key = {f.key: f for f in spec}

    # Header = the first of the top rows that names at least two known columns.
    header_idx = 0
    for i, (_, row) in enumerate(table[:10]):
        if len({aliases[n] for n in map(norm_header, row) if n in aliases}) >= 2:
            header_idx = i
            break
    _, header = table[header_idx]
    col_map: dict[int, str] = {}
    columns: dict[str, str | None] = {}
    for idx, h in enumerate(header):
        if _blank(h) is None:
            continue
        key = aliases.get(norm_header(h))
        if key in col_map.values():
            key = None  # second column for the same field: ignore it
        columns[str(h).strip()] = key
        if key:
            col_map[idx] = key

    result = Parsed(columns=columns)
    missing = [f.key for f in spec if f.required and f.key not in col_map.values()]
    if entity == "participants" and "full_name" not in col_map.values() and not {"first_name", "last_name"} & set(col_map.values()):
        missing.append("full_name")
    if missing:
        result.errors.append(ImportIssue(row=table[header_idx][0], message=f"Missing column(s): {', '.join(missing)}"))
        return result

    body = table[header_idx + 1:]
    if len(body) > MAX_ROWS:
        raise ImportFileError(f"At most {MAX_ROWS} rows per import")
    for rownum, row in body:
        rec: dict = {}
        problems = []
        cells = {idx: (_blank(row[idx]) if idx < len(row) else None) for idx in col_map}
        if all(v is None for v in cells.values()):
            continue  # nothing in the recognised columns (e.g. only a row number)
        result.total += 1
        for idx, key in col_map.items():
            raw = cells[idx]
            if raw is None:
                continue
            try:
                rec[key] = by_key[key].parse(raw)
            except ValueError as e:
                problems.append(f"{key}: {e}")
        if entity == "participants":
            first, last = rec.pop("first_name", ""), rec.pop("last_name", "")
            if not rec.get("full_name") and (first or last):
                # Passport order: SURNAME Given names
                rec["full_name"] = f"{str(last).upper()} {first}".strip()
            if not rec.get("full_name"):
                problems.append("full_name: missing")
        for f in spec:
            if f.required and f.key not in rec:
                problems.append(f"{f.key}: missing")
        if problems:
            result.errors.append(ImportIssue(row=rownum, message="; ".join(problems)))
        else:
            result.records.append((rownum, rec))
    return result


# --- per-entity checks against the database and saving ---------------------------------

def _ci(col):
    return func.lower(col)


def run_import(db: Session, ctx: WorkspaceCtx, entity: str, table: list[tuple[int, list]], commit: bool,
               tour: Tour | None = None, replace: bool = False) -> ImportResult:
    p = parse(entity, table)
    created = 0
    preview: list[dict] = []
    valid = 0
    if p.records:
        handler = {"participants": _participants, "tours": _tours, "vendors": _vendors, "clients": _clients}[entity]
        for rownum, rec, obj in handler(db, ctx, p, tour, replace if commit else False):
            valid += 1
            if len(preview) < 200:
                preview.append({"row": rownum, **{k: (v.isoformat() if isinstance(v, date) else v) for k, v in rec.items()}})
            if commit and obj is not None:
                db.add(obj)
                created += 1
        if commit:
            db.commit()
        else:
            db.rollback()
    p.errors.sort(key=lambda e: e.row)
    return ImportResult(total=p.total, valid=valid, created=created, committed=commit, columns=p.columns,
                        errors=p.errors, warnings=p.warnings, preview=preview)


def _participants(db, ctx, p: Parsed, tour: Tour, replace: bool):
    if replace:
        db.execute(delete(Participant).where(Participant.tour_id == tour.id))
    pos = next_position(db, tour.id)
    limit = tour.end_date + timedelta(days=183)
    seen: set[str] = set()
    for rownum, rec in p.records:
        pn = rec.get("passport_number", "").replace(" ", "").upper()
        if pn:
            if pn in seen:
                p.warnings.append(ImportIssue(row=rownum, message=f"passport {pn} appears twice in the file"))
            seen.add(pn)
        if rec.get("passport_expiry") and rec["passport_expiry"] < limit:
            p.warnings.append(ImportIssue(row=rownum, message="passport expires within 6 months of the tour end"))
        yield rownum, rec, Participant(tour_id=tour.id, position=pos, **rec)
        pos += 1


def _tours(db, ctx, p: Parsed, tour, replace):
    series = {s.code.upper(): s for s in db.scalars(select(Series).where(Series.workspace_id == ctx.workspace.id))}
    clients = {c.name.lower(): c for c in db.scalars(select(Client).where(Client.workspace_id == ctx.workspace.id))}
    codes_in_file: set[str] = set()
    for rownum, rec in p.records:
        s = None
        if rec.get("route"):
            s = series.get(rec["route"].upper())
            if not s:
                p.errors.append(ImportIssue(row=rownum, message=f"route '{rec['route']}' does not exist"))
                continue
        start = rec["start_date"]
        end = rec.get("end_date") or (start + timedelta(days=len(s.days) - 1) if s and s.days else None)
        if end is None:
            p.errors.append(ImportIssue(row=rownum, message="end_date is required when there is no route"))
            continue
        if end < start or (end - start).days + 1 > MAX_TOUR_DAYS:
            p.errors.append(ImportIssue(row=rownum, message="end date must be after start (max 60 days)"))
            continue
        code = (rec.get("code") or "").upper() or _generate_code(db, ctx, s, start)
        while not rec.get("code") and code in codes_in_file:  # two generated codes in one file
            code += "B"
        if code in codes_in_file or _code_taken(db, ctx, code):
            p.errors.append(ImportIssue(row=rownum, message=f"tour code {code} already exists"))
            continue
        codes_in_file.add(code)
        client = None
        if rec.get("client"):
            client = clients.get(rec["client"].lower())
            if not client and not ctx.can("finance", "sales"):
                p.errors.append(ImportIssue(row=rownum, message=f"unknown client '{rec['client']}' — ask a manager to add it"))
                continue
            if not client:
                client = Client(workspace_id=ctx.workspace.id, name=rec["client"])
                clients[rec["client"].lower()] = client
                db.add(client)
                p.warnings.append(ImportIssue(row=rownum, message=f"new client '{rec['client']}' will be created"))
        t = Tour(workspace_id=ctx.workspace.id, code=code, series_id=s.id if s else None, client=client,
                 start_date=start, end_date=end, status=rec.get("status", "confirmed"), pax=min(max(rec.get("pax", 0) or 0, 0), 10000),
                 rooms=rec.get("rooms", ""), name=rec.get("name", ""), notes=rec.get("notes", ""))
        sync_days(t, s.days if s else None)
        yield rownum, {**rec, "code": code, "end_date": end}, t


def _vendors(db, ctx, p: Parsed, tour, replace):
    existing = {(n.lower(), t) for n, t in db.execute(
        select(Vendor.name, Vendor.type).where(Vendor.workspace_id == ctx.workspace.id))}
    for rownum, rec in p.records:
        key = (rec["name"].lower(), rec["type"])
        if key in existing:
            p.errors.append(ImportIssue(row=rownum, message=f"{rec['type']} '{rec['name']}' already exists"))
            continue
        existing.add(key)
        yield rownum, rec, Vendor(workspace_id=ctx.workspace.id, **rec)


def _clients(db, ctx, p: Parsed, tour, replace):
    existing = {n.lower() for n in db.scalars(select(Client.name).where(Client.workspace_id == ctx.workspace.id))}
    for rownum, rec in p.records:
        if rec["name"].lower() in existing:
            p.errors.append(ImportIssue(row=rownum, message=f"client '{rec['name']}' already exists"))
            continue
        existing.add(rec["name"].lower())
        yield rownum, rec, Client(workspace_id=ctx.workspace.id, **rec)


# --- templates -------------------------------------------------------------------------

def template(entity: str) -> bytes:
    spec = [f for f in SPECS[entity] if f.key not in ("first_name", "last_name")]
    wb = Workbook()
    ws = wb.active
    ws.title = entity.capitalize()
    ws.append([f.key for f in spec])
    ws.append([f.example if f.example != "" else None for f in spec])
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="4F46E5")
    for c in ws[2]:
        if isinstance(c.value, date):
            c.number_format = "YYYY-MM-DD"
    for i, f in enumerate(spec):
        ws.column_dimensions[chr(65 + i)].width = max(14, len(f.key) + 4)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
