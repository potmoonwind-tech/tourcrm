# TourCRM — multi-agency CRM for group tours

Successor to ki.360. Any travel agency signs up, gets its own **workspace**, invites its
team, and manages group tours end to end: itinerary → vendors → payments → client
invoices → profit.

## Stack

| Layer    | Choice                                                         |
|----------|----------------------------------------------------------------|
| Backend  | FastAPI, SQLAlchemy 2.0, Alembic migrations, Pydantic v2         |
| Database | Postgres in production (Railway), SQLite for local development  |
| Auth     | Email + password (argon2 hash), JWT in httpOnly cookie          |
| Frontend | React + Vite + TypeScript, Tailwind, TanStack Query, i18n (KA/EN) |
| Import   | openpyxl — standard Excel template per entity                    |
| Deploy   | Railway: one service serves the API and the built frontend        |

## Multi-tenancy model

- One shared database. **Every business table has a `workspace_id`.**
- A user can belong to several workspaces (e.g. a freelance guide working for two agencies).
- Each request carries the active workspace; a single dependency (`get_ctx`) resolves
  user + workspace + role and **every query is filtered through it**. There are no
  unscoped queries in route code.
- Tests assert that workspace A can never read or modify workspace B's data.

### Roles

| Role    | Can do                                                        |
|---------|---------------------------------------------------------------|
| owner   | everything, billing, delete workspace, manage roles           |
| admin   | everything except billing / deleting the workspace            |
| manager | tours, vendors, payments, clients; sees finance               |
| staff   | tours & itineraries; no finance (like ki.360's LIZI/BUS)       |
| guide   | only the tours assigned to them (the ki.360 guide portal)      |

## Data model (MVP)

```
workspace ── membership ── user
    │
    ├── settings (base currency, other currencies, language, tour-code prefixes)
    ├── client          (B2B partner agency or direct customer)
    ├── vendor          (type: hotel | restaurant | transport | guide | driver | other,
    │                    contacts, payment terms: before/after N days)
    ├── series          (a reusable route template, e.g. "HM", with template days)
    └── tour            (code, series, client, start/end, status, pax, rooms, notes)
          ├── tour_day        (date, city, hotel_vendor, notes, border crossing)
          │     └── service   (meal/transfer/ticket: vendor, qty, unit price, currency)
          ├── participant     (name, passport, nationality, room type)
          ├── staff_assignment (guide/driver vendor ↔ tour, dates)
          ├── cost            (derived from services + extras; due date from vendor terms)
          │     └── vendor_payment (amount, currency, rate, date, paid)
          └── invoice         (to client) ── client_payment
```

Money: every amount stores `currency` and the exchange rate used, so profit is computed
in the workspace's base currency (GEL/USD/EUR…) — replacing ki.360's hardcoded GEL/USD/CNY.

## Screens (MVP)

1. **Sign up / log in / accept invite / workspace switcher**
2. **Dashboard:** tours running today, payments due this week, unpaid client invoices
3. **Timeline:** Gantt of tours (port of ki.360)
4. **Day view:** for a date, every group: city, hotel, lunch, dinner, guide, border
5. **Tour detail:** itinerary editor, participants, staff, costs, invoices, profit
6. **Series (templates):** build a route once, create tours from it with a start date
7. **Vendors and contacts**
8. **Payments:** schedule of vendor payments due/overdue, mark as paid
9. **Finance:** invoices & client debts, profit per tour / month / series
10. **Settings:** workspace, team & roles, currencies, import (Excel template)
11. **Guide portal:** mobile view of the assigned tour's days and contacts

## Milestones

| # | Deliverable                                                                      |
|---|----------------------------------------------------------------------------------|
| 1 | Project skeleton, auth, workspaces, invites, roles, tenant-isolation tests         |
| 2 | Vendors, clients, series templates, tours + itinerary days; timeline & day view   |
| 3 | Participants, staff assignments, Excel/CSV import                                 |
| 4 | Costs, vendor payment schedule, paid/unpaid                                        |
| 5 | Client invoices, payments, debts, profit reports                                   |
| 6 | Guide portal, KA/EN polish, Railway deploy; migrate GTC 360's own data in           |

## Later (post-MVP)
Subscription billing per workspace, email/WhatsApp notifications, PDF vouchers and
invoices, audit log, public API, optional Google Sheets sync.
