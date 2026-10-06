# TourCRM

Multi-agency CRM for group tours. See [PLAN.md](PLAN.md) for the architecture and milestones.

## Status

**Milestone 1 — done:** sign up, log in, workspaces (one per agency, a user can be in several),
team invites by link, roles (owner / admin / manager / staff / guide), workspace settings,
Georgian/English UI, phone-friendly layout.

**Milestone 2 — done:** vendors (hotels, restaurants, transport, guides… with payment terms),
clients, routes (day-by-day templates), tours created from a route (code like `HM-0906`
generated, itinerary copied), inline itinerary editing, timeline (Gantt), day view,
dashboard with today's groups and upcoming starts.

**Milestone 3 — done:** participant lists per tour (inline editing, passport-expiry warnings),
rooming summary ("12 DBL + 2 SGL") and Excel rooming list for hotels, staff assignments by
day range (guide for days 1–4, another from day 5; ranges follow the tour when dates move),
Excel/CSV import with preview for participants, tours, vendors and clients (headers matched in
English, Georgian, Russian and Chinese; downloadable templates).

**Milestone 4 — done:** vendor price lists (per room/night, per person, per day), exchange rates
to the workspace currency, tour costs calculated from the itinerary (hotel nights × rooms,
meals × pax, staff × days) plus manual lines, what is owed per tour + vendor with due dates from
the vendor's payment terms, partial payments, overdue tracking, a cross-tour payment schedule,
and a "payments due" dashboard card. Money is manager+ only; amounts are exact decimals.

**Milestone 5 — done:** client invoices (draft → issued → void; numbered on issue, per agency and
year, so issued numbers have no gaps), money received with partial payments and overdue status,
a printable / save-as-PDF invoice page, client debts, and profit (issued revenue − costs, in the
base currency) per tour, per month and per route, plus a revenue/profit summary on each tour.

**Tour price calculations — done:** a flexible calculation engine (items priced per group, per
person — tourists / with leaders / everyone — or per vehicle of N seats; quantities as small
formulas over days, nights, group size and the agency's own variables; prices and quantities
that change with group size; hotel nights with DBL/SGL/TRP room prices; profit rule = max(group
profit ÷ pax, minimum per person, margin floor); rounding). Ships with an "HM" preset that
reproduces GTC 360's Excel sheet exactly for every group size (`tests/test_quote_engine.py`).
Live preview while editing, line-by-line breakdown per group size, fill from a route and vendor
prices, partner price lists in any language (EN/ZH/KA built in) as print/PDF and Excel, create a
tour + draft invoice from a calculation, and planned-vs-actual profit on each tour.

**Calculation editor, Phase A — done:** lines read as sentences and are edited with a rule
builder (choices first, formula as an option); a formula helper (autocomplete, live values per
group size, plain-language errors with one-click fixes, examples); "explain this price" from
lines to the rounded price; version history (who/when/note, plain-language diffs with price
effect, restore); and scenarios stored as patches on the calculation, compared side by side,
applied or turned into a separate calculation. Lines and nights carry stable ids for this.

**Phase B1 — seasonal price catalog — done:** each vendor sells services (an optional system
code such as "DBL room", a unit, a category) priced in rows by season (from–to, or all year) and
group size. The narrowest matching row wins; partly overlapping rows are refused (and flagged
live in the editor). Tour costs price each night/meal on its own date and the group's size;
"Fill from route" prices for a chosen travel date; the Price catalog page shows every price on a
date. Logic: `app/catalog.py`; API: `app/routers/pricing.py`. The old one-price-per-kind
`vendor_rates` were migrated to all-year rows.

**Phase B2 — any service on any day — done:** route and tour days carry `extras` (catalog
services: a jeep, a tasting, a canyon ticket) with an optional quantity; empty = counted from the
unit (per person → group size, room/night → rooms, per group/vehicle/day → 1; litre/km/item must
be set). Copied from route to tour like the other day fields, priced by tour-cost generation on
the day's date and group size, shown in the itinerary table, the route editor and the day view.
`GET /services` lists services without prices for staff.

**Phase B3 — calculations from route + catalog — done:** "New calculation → From a route" (or
"Fill from route" in the editor) turns a route's hotels, meals and day services into nights and
lines priced for the travel date (each day on its own date). Group-size price bands become line
tiers (`route_build.priced` folds sizes with the same price into one tier). Lines remember their
`service_id` and are marked "catalog"; "Update prices" re-prices them (and hotel nights) for
another date and shows the changes before applying. Missing exchange rates are filled from
Settings. Logic: `app/route_build.py`.

**Phase B4 — tour budget — done:** a tour sold from a calculation gets a budget: the
calculation's lines (and hotel nights) frozen at the size sold (`tour_budget_lines`; total =
the calculation's group cost). Cost lines point to their budget line (`tour_costs.budget_line_id`):
generation links them by catalog service → hotel night → vendor → the only line of that kind →
a line named like the staff role; ambiguous ones are left for a person (bulk "link to…"), and a
person's choice is never overridden (`budget_by_hand`). The tour's Costs tab shows planned vs
actual per line, "not costed yet" (never counted as saving) and "not in budget"; budget lines
with no itinerary counterpart (guide, bus) can get planned cost lines. Re-taking the budget
keeps line ids and links. Replaces the old `/tours/{id}/plan`. Cost generation now also counts
guides/drivers working that day at meals, as calculations do. Logic: `app/budget.py`.

**Phase C1 — incidents — done:** anything beyond the plan is an incident on a tour (day, kind,
what happened, who carries it: client / agency / vendor). Staff report; managers add the money
(cost lines, from the catalog or typed; a charge to the client; a claim against the vendor at
fault) and approve. Approving creates it all together: cost lines with `reason="incident"`, a
draft invoice for the client, and a negative `vendor_credit` line on the vendor's account.
Above the agency's `incident_approval_limit` (Settings → General) only an admin/owner approves.
Reopen undoes the effects while nothing is issued or paid. Staff never see amounts. Incidents
show on the tour (tab), across tours (Incidents page), in the day view (open ones) and in the
budget (net effect per incident; draft charges aren't revenue yet). API: `app/routers/incidents.py`.

**Phase C2 — credit notes — done:** issued invoices never change; corrections are credit notes
(`invoices.kind = "credit_note"`, `credits_id` → the invoice), numbered in their own series
(`CN-2026-0001`), never more than is left to credit, locked to the invoice's client, tour and
currency. Issued credit notes lower revenue (`signed_total_base`) and the invoice's balance
(total − credited − paid). If the client had already paid, the invoice shows **refund due**
(also in Debts) and the refund is recorded as a negative payment (`POST /invoices/{id}/refunds`).
An invoice with issued credit notes can't be voided; a credit note whose refund was paid can't
either. Incidents can compensate the client: approving makes a draft credit note on the tour's
issued invoice.

**Phase C3 — cancellations — done:** scales are "within N days → X%" rows (narrowest applicable
wins; earlier than all = free). Client side: the agency's scale (Settings) or the client's own
(their contract, on the client); that percent of each issued invoice (net of credits) is kept,
the rest credited by a draft credit note, money paid above it becomes a refund due; with nothing
issued yet, a draft penalty invoice is made from draft invoices or the budget's planned price.
Vendor side: each vendor's release terms, counted from its first service on the tour, as a
percent of what was booked; booked lines become one penalty line per vendor, payments stay (a
vendor paid more shows as owing us back). The **Cancel tour** wizard previews everything, every
percent can be overridden, and applying records an approved `cancellation` incident (approval
limit applies). API: `app/routers/cancellation.py`. Also: a server that can't be reached no
longer looks like a logout (the app waits and retries).

**Phase D1 — lifecycle and closing — done:** every tour shows one line: inquiry → confirmed →
on tour → settling → closed (cancelled tours settle and close too). Once it ends, a checklist
says what's still open (invoiced, no drafts, client settled incl. refunds, every vendor settled
incl. money owed back, no open incidents, exchange rates known; budget lines without cost as a
warning). Closing freezes revenue and cost (`tours.final_*`) and **locks** the tour: any write to
it or its days, people, costs, payments, budget, incidents, invoices or client payments is
refused (409) by one flush guard in `app/locks.py`, so new endpoints are covered automatically.
Admins/owners can close with open items (a note is required) and reopen (with a reason).
The dashboard lists tours waiting to close and what blocks each. API: `app/routers/lifecycle.py`.

**Phase D2 — client payment terms — done:** terms are "deposit X% due N days after booking,
balance due M days before arrival" — the agency's (Settings) or the client's own (their
contract). "Payment schedule" on a tour drafts the deposit and balance invoices with those due
dates (total pre-filled from the price sold at); the balance invoice lists the full price and
deducts the deposit ("Less deposit", a negative line — invoice totals must still be positive).
No deposit, or booked too late for one, gives a single invoice. Creating a tour from a
calculation follows the same terms. Logic: `app/schedule.py`.

**Phase D3 — vendor invoice matching — done:** invoices vendors send (`vendor_bills`: number,
date, optional due date, amount) are recorded per tour and compared, per vendor and currency,
with what we expected to pay (the cost lines, penalties and claims included). Within the
agency's tolerance (Settings, default 1%, never under 1.00) they match. A difference is
accepted — one `bill_adjustment` cost line, linked to the vendor's budget line — or a bill is
disputed (with a reason), which blocks closing until resolved. A bill's due date beats the
vendor's terms. Every payable shows its invoice state; Payments has an "Invoice issues" filter;
the close checklist warns about missing invoices. API: `app/routers/bills.py`.

**Meals and dish prices — done:** a set menu's dishes can each carry a price per person; the
menu editor shows their sum and can use it as the menu price. A tour's **Meals** tab lists every
lunch and dinner (restaurant, menu, dishes, price per person, people eating incl. staff, total)
with repeats marked (same day red, day before orange), and every dish across the tour with its
price at each restaurant — big spreads flagged. Prices are manager+. API: `app/routers/meals.py`.

**First-use UX — done:** a "Get started" guide on Home (suppliers → prices → route → clients →
first tour → team, ticked from `GET /setup`), empty states that explain and offer the next step,
a "Saved" toast after every change, confirmations on deletes and irreversible actions, required
fields marked, quick "+ Add new" for clients and guides, plain wording (supplier, agency).
Rules in `DESIGN.md` → "First use and feedback".

**Customizable Home — done:** Home is made of widgets; each person picks theirs ("Customize":
on/off, drag to reorder, half/full width), saved per person and agency, with a default per role.
14 widgets: get started, today in numbers, needs attention, groups today, starting soon, guides
and drivers this week (double bookings in red), open incidents, tours to close, payments due,
clients who owe you, profit this vs last month, cash for the next 30 days (in vs out by week),
supplier invoice issues, calculations awaiting an answer. API: `app/routers/dashboard.py`.

## Run locally

Backend (FastAPI, http://localhost:8000):

```bash
cd backend
.venv/Scripts/python -m alembic upgrade head
.venv/Scripts/python seed_dev.py
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

Frontend (React + Vite, http://localhost:5173 — proxies `/api` to the backend):

```bash
cd frontend
npm run dev
```

Demo accounts and their password are in `backend/seed_dev.py`.

## Tests

```bash
cd backend
.venv/Scripts/python -m pytest -q
```

`tests/test_tenancy.py` holds the workspace-isolation guarantees: every new feature's
routes must go through `get_ctx` / `require_role` in `app/deps.py` and filter by
`ctx.workspace.id`.

## Database changes

SQLite rebuilds tables for most ALTERs, so migrations run with foreign keys off
(`make_engine(..., enforce_fk=False)` in `migrations/env.py`); otherwise the rebuild cascades
and deletes child rows. `tests/test_migrations.py` guards this.

Edit `app/models.py`, then:

```bash
.venv/Scripts/python -m alembic revision --autogenerate -m "describe change"
.venv/Scripts/python -m alembic upgrade head
```

## Production settings (env vars)

| Variable        | Example                              |
|-----------------|--------------------------------------|
| `DATABASE_URL`  | Railway Postgres URL                 |
| `SECRET_KEY`    | long random string (required)        |
| `COOKIE_SECURE` | `true`                               |
| `APP_URL`       | `https://app.yourdomain.com`         |
| `GOOGLE_MAPS_KEY` | optional: Google Maps on the server (Geocoding, Routes, Places API (New)); without it, OpenStreetMap |
| `GOOGLE_MAPS_BROWSER_KEY` | optional, with the one above: the trip map in the browser (Maps JavaScript API), limited to the site address |

With Google, saved coordinates and roads are refreshed after 30 days (Google's terms); picked places keep their Google place id for that.
