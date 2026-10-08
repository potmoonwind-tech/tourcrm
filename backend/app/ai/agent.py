"""The setup assistant's loop: Claude reads what the person gave it, looks at the CRM, and fills
the session's plan with proposals (app/ai/tools.py). It never saves anything itself.

- Model: settings.ai_model (Claude Opus 5.5), adaptive thinking (always on for this model),
  effort "medium" - mapping spreadsheets to suppliers and prices is careful work, not research.
- Server-side refusal fallback is on ("default"), so a rare false-positive decline is retried on
  the model Anthropic recommends instead of failing the person's import.
- History is append-only (thinking blocks must come back unchanged), and the whole request is
  cached ("cache_control" at the top level), so each loop step re-reads the long sheets cheaply.
- Cost is metered per agency per month against settings.ai_monthly_usd.
"""
import logging
from datetime import date, datetime

from .lazy import anthropic
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import WorkspaceCtx
from ..models import AiSession, AiUsage, Membership, User, Workspace, utcnow
from . import keys, tools

log = logging.getLogger(__name__)
MAX_STEPS = 40                  # model calls per message from the person
MAX_TOKENS = 64000
# USD per million tokens (Claude Opus 5.5): input, output, cache write (5 min), cache read.
PRICE = {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.20}

SYSTEM = """You are the setup assistant inside TourCRM, a CRM for group-tour agencies (mostly in Georgia and the Caucasus). \
You help an agency move its existing data into the CRM and set up routes and tours: suppliers (hotels, restaurants, \
transport, guides, drivers, activities) with their prices, clients, routes (reusable day-by-day templates), tours \
(a group on dates) and their participants.

You cannot change anything directly. You propose items with the propose_* tools; the person reviews the plan as a \
checklist and confirms what to save. So propose freely, but correctly.

How to work:
- First look at what already exists (list_records) and reuse it. Never propose a supplier, client or route that \
already exists under the same or a very similar name - refer to the existing id instead.
- Take facts only from the files and messages: never invent prices, dates, people, phone numbers or passport data. \
If something important is missing or ambiguous (which currency? per person or per room? which year?), make no guess: \
leave it out, and say so in your summary. Ask a question instead of proposing when you can't tell what the person wants.
- Read every row of a spreadsheet you are importing (read_sheet pages through it) - the message shows only the start. \
The same for Word documents (read_document).
- A tour programme (Word or PDF: "Day 1: ...", meals, hotel class, sights) becomes a route: one day per programme day, \
city = where the group sleeps, stops = places visited, lunch/dinner mode from the meal lines (X or "free" = own). \
Name hotels and restaurants only when the programme names them; "a 5* hotel in Tbilisi" goes in the day's notes, \
not as a supplier. Programmes are often machine-translated: keep place names as the agency writes them in the CRM.
- Send proposals in batches of at most 40 items per call.
- Hotel prices are per room per night (codes room_SGL, room_DBL, room_TWN, room_TRP, room_QUAD, unit room_night). \
Restaurant lunch/dinner prices are per person (codes lunch, dinner). Seasons are valid_from/valid_to; group-size \
prices are min_pax/max_pax. Use the agency's base currency only when the source says nothing else and it is clearly local.
- Calculations (propose_calculation) are made from a route - an existing one or one you propose. Hotels, meals and \
day services are priced from the suppliers' saved prices; what has no price stays empty for the person to fill, so \
never put a price in a line unless the source gives it. Add lines only for what the route can't know (flights, \
trains, visas, entry tickets). "19+1" means one free place (leaders 1). Make a calculation when the person asks for \
prices or a calculation, not for every route.
- Changing what already exists ("in HM put dinner at Barbarestan on day 3", "the Kakheti route: add a winery on the \
second day"): find it first (list_records with a search), and read it (get_route) - never guess which one or which day. \
If two records could be meant, ask which. Then propose_route_changes with only what changes, referring to suppliers by \
their ids; the summary names the route, the day numbers and the old and new values, so the person can check it at a glance.
- Order: suppliers, then their prices, then clients, then routes, then calculations, then tours, then participants. Later proposals can \
refer to earlier ones by their plan id (p1, p2...).
- Write to the person in their language (Georgian or English, as they write), briefly. End with a short summary: \
what you proposed, what you skipped and why, and what they should check before confirming."""


def make_client(ws: Workspace) -> "anthropic.Anthropic":
    """Tests replace this. The agency's own key from Settings, else the server's (ANTHROPIC_API_KEY)."""
    return anthropic.Anthropic(api_key=keys.key_for(ws), max_retries=3, default_headers=keys.headers_for(ws) or None)


def available(ws: Workspace) -> bool:
    return bool(keys.key_for(ws))


# --- money -----------------------------------------------------------------------------------------

def month() -> str:
    return date.today().strftime("%Y-%m")


def spent_usd(db: Session, workspace_id: str) -> float:
    u = db.scalar(select(AiUsage).where(AiUsage.workspace_id == workspace_id, AiUsage.month == month()))
    return (u.cost_micro_usd if u else 0) / 1_000_000


def _meter(db: Session, workspace_id: str, usage) -> None:
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    plain, out = usage.input_tokens or 0, usage.output_tokens or 0
    cost = (plain * PRICE["input"] + out * PRICE["output"] + cache_write * PRICE["cache_write"] + cache_read * PRICE["cache_read"])
    u = db.scalar(select(AiUsage).where(AiUsage.workspace_id == workspace_id, AiUsage.month == month()))
    if u is None:
        u = AiUsage(workspace_id=workspace_id, month=month(), input_tokens=0, output_tokens=0, cost_micro_usd=0)
        db.add(u)
    u.input_tokens += plain + cache_write + cache_read
    u.output_tokens += out
    u.cost_micro_usd += round(cost)      # tokens × USD per million = micro-USD


# --- the loop ----------------------------------------------------------------------------------------

def _ctx(db: Session, s: AiSession) -> WorkspaceCtx:
    m = db.scalar(select(Membership).where(Membership.workspace_id == s.workspace_id, Membership.user_id == s.user_id))
    if not m:
        raise RuntimeError("The person who started this is no longer in the agency")
    return WorkspaceCtx(user=db.get(User, s.user_id), workspace=db.get(Workspace, s.workspace_id), membership=m)


def _say(s: AiSession, role: str, text: str, **extra) -> None:
    s.chat = [*s.chat, {"role": role, "text": text, "at": datetime.now().isoformat(timespec="seconds"), **extra}]


def run(db: Session, session_id: str) -> None:
    """Work on the session's last message until the assistant has nothing more to do."""
    s = db.get(AiSession, session_id)
    try:
        ctx = _ctx(db, s)
        client = make_client(ctx.workspace)
        for _ in range(MAX_STEPS):
            if spent_usd(db, s.workspace_id) >= settings.ai_monthly_usd:
                _say(s, "notice", "limit")
                break
            with client.beta.messages.stream(
                model=settings.ai_model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM,
                tools=[{**t, "eager_input_streaming": True} for t in tools.TOOLS],
                messages=s.history,
                output_config={"effort": "medium"},
                cache_control={"type": "ephemeral"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            ) as stream:
                msg = stream.get_final_message()
            _meter(db, s.workspace_id, msg.usage)
            if msg.stop_reason == "refusal":
                _say(s, "notice", "refused")
                break
            content = [b.to_dict() for b in msg.content]
            s.history = [*s.history, {"role": "assistant", "content": content}]
            text = "\n\n".join(b.text for b in msg.content if b.type == "text" and b.text.strip())
            uses = [b for b in msg.content if b.type == "tool_use"]
            if text:
                _say(s, "assistant", text)
            if not uses:
                break
            results = []
            for u in uses:
                if msg.stop_reason == "max_tokens":    # the call may have been cut off mid-input
                    results.append({"type": "tool_result", "tool_use_id": u.id, "is_error": True,
                                    "content": "Your answer was cut off. Send this again in smaller batches (at most 40 items)."})
                    continue
                if not isinstance(u.input, dict):     # streamed input that didn't parse
                    results.append({"type": "tool_result", "tool_use_id": u.id, "is_error": True,
                                    "content": "INVALID_JSON: the input didn't arrive as valid JSON — send it again"})
                    continue
                try:
                    out, line = tools.run(db, ctx, s, u.name, u.input)
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": out})
                    _say(s, "step", line)
                except tools.ToolError as e:
                    results.append({"type": "tool_result", "tool_use_id": u.id, "is_error": True, "content": str(e)})
            s.history = [*s.history, {"role": "user", "content": results}]
            s.updated_at = utcnow()
            db.commit()                       # progress shows on the screen while it works
        s.status, s.error = "idle", ""
    except anthropic.APIStatusError as e:
        log.warning("assistant %s: API error %s %s", session_id, e.status_code, getattr(e, "request_id", ""))
        db.rollback()
        s = db.get(AiSession, session_id)
        s.status, s.error = "error", ("The AI service is busy — try again in a minute" if e.status_code in (429, 529) or e.status_code >= 500
                                      else f"The AI service refused the request ({e.status_code})")
    except anthropic.APIConnectionError:
        db.rollback()
        s = db.get(AiSession, session_id)
        s.status, s.error = "error", "Couldn't reach the AI service — check the connection and try again"
    except Exception:
        log.exception("assistant %s failed", session_id)
        db.rollback()
        s = db.get(AiSession, session_id)
        s.status, s.error = "error", "Something went wrong — try again"
    s.updated_at = utcnow()
    db.commit()


def user_turn(s: AiSession, ws: Workspace, text: str, blocks: list[dict]) -> None:
    """Add the person's message (and file blocks) to the history. Volatile facts (today's date,
    the agency) go here, not in the cached system prompt."""
    first = not s.history
    kinds = ", ".join(f"{k.get('id')} ({k.get('name')})" for k in (ws.calc_style or {}).get("kinds") or [])
    intro = (f"[Agency: {ws.name}. Base currency: {ws.base_currency}. Today: {date.today().isoformat()}."
             f"{f' Its own kinds of cost: {kinds}.' if kinds else ''}]\n\n" if first else "")
    s.history = [*s.history, {"role": "user", "content": [*blocks, {"type": "text", "text": intro + (text or "(see the files)")}]}]
