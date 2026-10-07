"""Email from the CRM, sent from the person's own mailbox (SMTP).

- The mailbox: Gmail / Outlook with an app password (or another SMTP server). The password is
  encrypted with a key derived from SECRET_KEY and never leaves the server.
- Templates: built-in wording per kind and language (DEFAULTS), which an agency can rewrite; `{name}`
  placeholders are filled from the booking (dates, nights, rooms, meals, people...).
- Sending: plain text, Reply-To the sender, so the supplier's answer comes back to their inbox; the
  provider keeps it in the Sent folder. Every email (or failure) is logged on the tour.
"""
import base64
import hashlib
import ipaddress
import re
import smtplib
import socket
import ssl
from datetime import date, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from cryptography.fernet import Fernet, InvalidToken

from . import dishes as dish_util, seating
from .config import settings


def share_any(menu, t, agency_share: int) -> bool:
    return dish_util.sharing(menu.dishes, t.plate_share, agency_share)

PROVIDERS = {"gmail": ("smtp.gmail.com", 587), "outlook": ("smtp-mail.outlook.com", 587)}
KINDS = ("booking_request", "booking_change", "booking_cancel", "restaurant", "payment")
LANGS = ("en", "ka", "ru")


def _box() -> Fernet:
    raw = hashlib.sha256(f"tourcrm-mail:{settings.secret_key}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(raw))


def seal(secret: str) -> str:
    return _box().encrypt(secret.encode()).decode()


def unseal(token: str) -> str | None:
    try:
        return _box().decrypt(token.encode()).decode()
    except InvalidToken:
        return None


class MailError(Exception):
    """Something the person can fix: the message says what."""


def safe_host(host: str, port: int) -> None:
    """Another SMTP server is allowed, but only a public one on a mail port (no internal addresses)."""
    if port not in (465, 587):
        raise MailError("Use port 587 (STARTTLS) or 465 (SSL)")
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise MailError(f"Can't find the server {host}") from e
    for *_, addr in infos:
        ip = ipaddress.ip_address(addr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise MailError("That server address isn't allowed")


def _connect(host: str, port: int, username: str, password: str) -> smtplib.SMTP:
    ctx = ssl.create_default_context()
    try:
        if port == 465:
            s: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20, context=ctx)
        else:
            s = smtplib.SMTP(host, port, timeout=20)
            s.starttls(context=ctx)
        s.login(username, password)
        return s
    except smtplib.SMTPAuthenticationError as e:
        raise MailError("The mailbox refused the login. For Gmail and Outlook use an app password, not your normal password.") from e
    except (smtplib.SMTPException, OSError) as e:
        raise MailError(f"Couldn't reach the mail server: {e}") from e


def check_login(host: str, port: int, username: str, password: str) -> None:
    s = _connect(host, port, username, password)
    try:
        s.quit()
    except smtplib.SMTPException:
        pass


def send(host: str, port: int, username: str, password: str, *, sender: str, from_name: str,
         to: list[str], cc: list[str], subject: str, body: str,
         attachments: list[tuple[str, bytes, str]] | None = None) -> str:
    """Send one plain-text email (with files: name, content, mime type); returns its Message-ID."""
    msg = EmailMessage()
    msg["From"] = formataddr((from_name, sender)) if from_name else sender
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Reply-To"] = sender
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=sender.split("@")[-1])
    msg.set_content(body)
    for name, data, mime in attachments or []:
        main, _, sub = mime.partition("/")
        msg.add_attachment(data, maintype=main, subtype=sub, filename=name)
    s = _connect(host, port, username, password)
    try:
        s.send_message(msg)
    except smtplib.SMTPRecipientsRefused as e:
        raise MailError(f"The server refused the address: {', '.join(e.recipients)}") from e
    except smtplib.SMTPException as e:
        raise MailError(f"Not sent: {e}") from e
    finally:
        try:
            s.quit()
        except smtplib.SMTPException:
            pass
    return msg["Message-ID"]


# --- templates ---------------------------------------------------------------------------------------

DEFAULTS: dict[str, dict[str, tuple[str, str]]] = {
    "booking_request": {
        "en": ("Booking request · {group} · {dates}",
               "Dear {supplier},\n\nWe would like to book for our group {group} ({pax} people):\n\n{what}\n\n{notes}"
               "Please confirm availability and the price, and send us your confirmation number.\n\nThank you,\n{signature}"),
        "ka": ("ჯავშნის მოთხოვნა · {group} · {dates}",
               "მოგესალმებით, {supplier}!\n\nგვსურს დავჯავშნოთ ჩვენი ჯგუფისთვის {group} ({pax} ადამიანი):\n\n{what}\n\n{notes}"
               "გთხოვთ, დაგვიდასტუროთ ადგილები და ფასი და გამოგვიგზავნოთ დადასტურების ნომერი.\n\nმადლობა,\n{signature}"),
        "ru": ("Запрос на бронирование · {group} · {dates}",
               "Здравствуйте, {supplier}!\n\nПросим забронировать для нашей группы {group} ({pax} чел.):\n\n{what}\n\n{notes}"
               "Пожалуйста, подтвердите наличие и цену и пришлите номер подтверждения.\n\nСпасибо,\n{signature}"),
    },
    "booking_change": {
        "en": ("Change to booking · {group} · {dates}",
               "Dear {supplier},\n\nPlease note a change to our booking for group {group}{reference_line}. It is now:\n\n{what}\n\n{notes}"
               "Please confirm the change.\n\nThank you,\n{signature}"),
        "ka": ("ჯავშნის ცვლილება · {group} · {dates}",
               "მოგესალმებით, {supplier}!\n\nგთხოვთ, გაითვალისწინოთ ცვლილება ჯგუფის {group} ჯავშანში{reference_line}. ახლა:\n\n{what}\n\n{notes}"
               "გთხოვთ, დაგვიდასტუროთ ცვლილება.\n\nმადლობა,\n{signature}"),
        "ru": ("Изменение бронирования · {group} · {dates}",
               "Здравствуйте, {supplier}!\n\nПросим учесть изменение в бронировании группы {group}{reference_line}. Теперь:\n\n{what}\n\n{notes}"
               "Пожалуйста, подтвердите изменение.\n\nСпасибо,\n{signature}"),
    },
    "booking_cancel": {
        "en": ("Cancellation · {group} · {dates}",
               "Dear {supplier},\n\nWe are sorry to cancel our booking for group {group}{reference_line}:\n\n{what}\n\n"
               "Please confirm the cancellation.\n\nThank you,\n{signature}"),
        "ka": ("გაუქმება · {group} · {dates}",
               "მოგესალმებით, {supplier}!\n\nსამწუხაროდ, ვაუქმებთ ჯგუფის {group} ჯავშანს{reference_line}:\n\n{what}\n\n"
               "გთხოვთ, დაგვიდასტუროთ გაუქმება.\n\nმადლობა,\n{signature}"),
        "ru": ("Отмена бронирования · {group} · {dates}",
               "Здравствуйте, {supplier}!\n\nК сожалению, отменяем бронирование группы {group}{reference_line}:\n\n{what}\n\n"
               "Пожалуйста, подтвердите отмену.\n\nСпасибо,\n{signature}"),
    },
    "restaurant": {
        "en": ("Table booking · {group} · {dates}",
               "Dear {supplier},\n\nWe would like to book tables for our group {group}:\n\n{what}\n\n{notes}"
               "Please confirm, and let us know the menu if it is set.\n\nThank you,\n{signature}"),
        "ka": ("მაგიდის დაჯავშნა · {group} · {dates}",
               "მოგესალმებით, {supplier}!\n\nგვსურს მაგიდების დაჯავშნა ჩვენი ჯგუფისთვის {group}:\n\n{what}\n\n{notes}"
               "გთხოვთ, დაგვიდასტუროთ და გაგვიზიაროთ მენიუ.\n\nმადლობა,\n{signature}"),
        "ru": ("Бронирование столов · {group} · {dates}",
               "Здравствуйте, {supplier}!\n\nПросим забронировать столы для нашей группы {group}:\n\n{what}\n\n{notes}"
               "Пожалуйста, подтвердите и сообщите меню.\n\nСпасибо,\n{signature}"),
    },
    "payment": {
        "en": ("Payment · {group}",
               "Dear {supplier},\n\nWe have paid for group {group}{reference_line} ({dates}). Please send us your invoice if you haven't yet.\n\n"
               "Thank you,\n{signature}"),
        "ka": ("გადახდა · {group}",
               "მოგესალმებით, {supplier}!\n\nჯგუფის {group} თანხა გადახდილია{reference_line} ({dates}). გთხოვთ, გამოგვიგზავნოთ ინვოისი, თუ ჯერ არ გამოგიგზავნიათ.\n\n"
               "მადლობა,\n{signature}"),
        "ru": ("Оплата · {group}",
               "Здравствуйте, {supplier}!\n\nМы оплатили услуги для группы {group}{reference_line} ({dates}). Пришлите, пожалуйста, счёт, если ещё не прислали.\n\n"
               "Спасибо,\n{signature}"),
    },
}
PLACEHOLDERS = ("supplier", "contact", "group", "tour_code", "client", "pax", "dates", "check_in", "check_out", "nights",
                "rooms", "what", "reference", "reference_line", "notes", "my_name", "agency", "signature")

WORDS = {
    "en": {"night": "night", "nights": "nights", "rooms": "Rooms", "breakfast": "Breakfast", "lunch": "Lunch", "dinner": "Dinner", "people": "people",
           "check_in": "Check-in", "check_out": "check-out", "tourists_pay": "the guests pay on the spot",
           "staff": "plus guide and driver", "days": "days", "ref": "your ref.",
           "plate_rule": "one plate per {n} people ({plates} plates of each dish)", "plates": "plates",
           "staff_rooms": "Driver and guide", "staff_table": "separate staff table"},
    "ka": {"night": "ღამე", "nights": "ღამე", "rooms": "ოთახები", "breakfast": "საუზმე", "lunch": "სადილი", "dinner": "ვახშამი", "people": "ადამიანი",
           "check_in": "შესვლა", "check_out": "გასვლა", "tourists_pay": "სტუმრები იხდიან ადგილზე",
           "staff": "პლუს გიდი და მძღოლი", "days": "დღე", "ref": "თქვენი ნომერი",
           "plate_rule": "ერთი თეფში {n} ადამიანზე (თითო კერძი {plates} თეფში)", "plates": "თეფში",
           "staff_rooms": "მძღოლი და გიდი", "staff_table": "ცალკე მაგიდა პერსონალისთვის"},
    "ru": {"night": "ночь", "nights": "ночи", "rooms": "Номера", "breakfast": "Завтрак", "lunch": "Обед", "dinner": "Ужин", "people": "чел.",
           "check_in": "Заезд", "check_out": "выезд", "tourists_pay": "гости оплачивают на месте",
           "staff": "плюс гид и водитель", "days": "дн.", "ref": "ваш номер",
           "plate_rule": "одна тарелка на {n} чел. ({plates} тарелок каждого блюда)", "plates": "тарелок",
           "staff_rooms": "Водитель и гид", "staff_table": "отдельный стол для персонала"},
}
MONTHS = {"en": "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(),
          "ka": "იან თებ მარ აპრ მაი ივნ ივლ აგვ სექ ოქტ ნოე დეკ".split(),
          "ru": "янв фев мар апр мая июн июл авг сен окт ноя дек".split()}


def d_(x: date, lang: str) -> str:
    return f"{x.day} {MONTHS[lang][x.month - 1]} {x.year}"


def fill(text: str, values: dict[str, str]) -> str:
    """{name} → value; unknown names stay as written (so a typo shows instead of vanishing)."""
    return re.sub(r"\{([a-z_]+)\}", lambda m: values.get(m.group(1), m.group(0)), text)


def booking_values(t, b, u, lang: str, *, my_name: str, agency: str, signature: str, agency_share: int = 1) -> dict[str, str]:
    """What a booking email says, in the supplier's language: the stays (check-in/out, nights, rooms),
    the meals (dates, people), services and staff days."""
    w = WORDS[lang]
    det = u.details(t) if u is not None else {}
    lines: list[str] = []
    for s in det.get("stays", []):
        ci, co = date.fromisoformat(s["check_in"]), date.fromisoformat(s["check_out"])
        n = s["nights"]
        lines.append(f"{w['check_in']} {d_(ci, lang)}, {w['check_out']} {d_(co, lang)} · {n} {w['night'] if n == 1 else w['nights']}")
    if det.get("rooms"):
        lines.append(f"{w['rooms']}: " + " + ".join(f"{n} {k}" for k, n in det["rooms"].items()))
    if det.get("staff_rooms"):
        sr = det["staff_rooms"]
        n = sr["nights"]
        lines.append(f"{w['staff_rooms']}: " + " + ".join(f"{k} {x}" for x, k in sr["rooms"].items())
                     + f" · {n} {w['night'] if n == 1 else w['nights']}")
    people = det.get("people") or (len(t.participants) or t.pax)
    for d in sorted(t.days, key=lambda x: x.day_number):
        for meal in ("breakfast", "lunch", "dinner"):
            if getattr(d, f"{meal}_id") == b.vendor_id and (getattr(d, f"{meal}_mode") or "included") not in ("own", "hotel"):
                extra = f" ({w['tourists_pay']})" if getattr(d, f"{meal}_mode") == "tourists" else ""
                menu = getattr(d, f"{meal}_menu")
                # Who sits where: the group's table (with the staff who eat with them), and the staff table.
                seat = seating.tables(t, d.day_number, people, meal)
                plates = lambda share: " + ".join(str(dish_util.plates(n, share)) for n in seat.tables)    # noqa: E731
                if menu is not None and dish_util.sharing(menu.dishes, t.plate_share, agency_share):
                    # Family style: the restaurant needs the plates, dish by dish (each table its own).
                    share = t.plate_share or agency_share
                    extra += f" · {w['plate_rule'].format(n=share, plates=plates(share))}"
                if seat.staff:
                    extra += f" · {w['staff_table']} × {seat.staff}"
                lines.append(f"{w[meal]}: {d_(d.date, lang)} · {seat.group} {w['people']}{extra}")
                if menu is not None:
                    for x in dish_util.normalize(menu.dishes):
                        s = dish_util.share_of(x, t.plate_share, agency_share)
                        lines.append(f"   – {x['name']}" + (f": {plates(s)} {w['plates']}" if s > 1 or share_any(menu, t, agency_share) else ""))
    for name, days in (det.get("services") or {}).items():
        lines.append(f"{name} × {days} {w['days']}")
    for s in det.get("staff") or []:
        a, z = t.start_date + timedelta(days=s["from"] - 1), t.start_date + timedelta(days=s["to"] - 1)
        lines.append(f"{s['role'].replace('_', ' ').title()}: {d_(a, lang)} – {d_(z, lang)}")
    stays = det.get("stays") or []
    first = min((date.fromisoformat(s["check_in"]) for s in stays), default=None) or (min(u.dates) if u and u.dates else t.start_date)
    last = max((date.fromisoformat(s["check_out"]) for s in stays), default=None) or (max(u.dates) if u and u.dates else t.end_date)
    v = b.vendor
    return {
        "supplier": v.contact_person or v.name, "contact": v.contact_person or "", "group": t.code, "tour_code": t.code,
        "client": t.client.name if t.client else "", "pax": str(len(t.participants) or t.pax or ""),
        "dates": d_(first, lang) if first == last else f"{d_(first, lang)} – {d_(last, lang)}",
        "check_in": d_(date.fromisoformat(stays[0]["check_in"]), lang) if stays else "",
        "check_out": d_(date.fromisoformat(stays[-1]["check_out"]), lang) if stays else "",
        "nights": str(det.get("nights", "")),
        "rooms": " + ".join(f"{n} {k}" for k, n in (det.get("rooms") or {}).items()),
        "what": "\n".join(f"• {x}" for x in lines) or "•",
        "reference": b.reference or "", "reference_line": f" ({w['ref']} {b.reference})" if b.reference else "",
        "notes": f"{b.note.strip()}\n\n" if b.note and b.note.strip() else "",
        "my_name": my_name, "agency": agency, "signature": signature.strip() or f"{my_name}\n{agency}",
    }


def default_kind(vendor_type: str) -> str:
    return "restaurant" if vendor_type == "restaurant" else "booking_request"
