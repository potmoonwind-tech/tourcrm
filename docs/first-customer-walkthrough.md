# First-customer walkthrough — 3 Oct 2026

A brand-new owner ("Claude", agency **Claude Tours**, account `claude.owner@example.com`) signed up
and created a first tour using only the screens, the way a new agency would. Goal: a 3-day
Tbilisi tour for 18 tourists from a Latvian partner agency — hotel, restaurant, guide, bus — and
an invoice to the client.

**Result:** the tour got built (TBS-1020, 20–22 Oct), but a new owner would have ended up with
**wrong money numbers** without noticing: hotel cost missing and "Profit 6,840 USD, margin 100%"
on the tour. Two bugs were fixed during the run (marked ✅); the rest is below, most important first.

## What happened, step by step

| # | Step | Time feel | What went well | What went wrong |
|---|------|-----------|----------------|-----------------|
| 1 | Open the app | — | — | Only a "Log in" form on a narrow window; nothing says what TourCRM is; "Create account" is a small link |
| 2 | Sign up | fast | 4 fields | Never asked for **currency** or country → agency silently in **USD** |
| 3 | First Home | — | "Get started" with 6 steps is clear | Below it a wall of empty widgets (0, 0, 0, empty chart "Net 0.00 USD") |
| 4 | Add a hotel | slow | Drawer stays open after Create (new) | 11 fields + cancellation terms for a first supplier; prices hidden below the fold after Create |
| 5 | Enter room prices | **hardest** | Saved toast | Price box off-screen to the right; 3 near-identical dropdowns (code / category / unit); every row defaults to USD; room type changed but its name didn't ✅ |
| 6 | Restaurant, guide, bus | ok | Restaurant → Lunch/Dinner picked automatically | Guide and bus prices filed as "Other · per day"; setting the supplier's currency is the hidden trick that makes rows default to GEL |
| 7 | After suppliers | — | Checklist ticks (2 of 6) | Nothing says "next: build a route" — had to go back to Home |
| 8 | Build a route | ok | City carries to next days, "Same hotel next night", menu picker | "Code*" required first, Name optional; where do guide and bus go (route Services vs tour Staff)? Services list also offers room and meal prices → double counting risk; tap-to-place forgets the item after one day |
| 9 | Add the client | fast | Short form | "Uses the agency's terms from Settings" — terms the owner never saw |
| 10 | Create the tour | fast | Copies the route; client "+ Add new"; code generated | Route not pre-selected although there is only one; status list offers "Cancelled" for a new tour; rooms "8 double + 2 single" (the suggested wording) were **not understood** ✅ |
| 11 | Add the guide | ok | Staff tab with day range | The tour page opens with a long edit form; tabs are far down on a small screen |
| 12 | Calculate costs | — | Meals count 18 + 1 guide, explained | **Hotel missing** (rooms not understood) ✅; headline **Costs 0.00 USD** because GEL has no rate in a USD agency |
| 13 | Invoice the client | ok | Pre-filled line "18 × price"; confirm before issuing | Tour shows **Profit 6,840 USD · margin 100%** — costs counted as 0; only a small amber line warns. No alert anywhere |

## Fixed during the run ✅

1. **Rooms text in plain words.** "8 double + 2 single" (the form's own example), Georgian
   ("8 ორადგილიანი + 2 ერთადგილიანი") and Russian now count; before, only DBL/SGL codes did and the
   hotel cost was silently zero. Test added.
2. **Room type and its name.** Changing a price row from TWN to SGL now renames it too (unless you
   typed your own name). Before, the row said "TWN room / night" while charging as SGL.

## What to improve (by impact)

### Must fix — wrong money a new owner won't notice
1. **Ask the agency currency at sign-up** (pre-filled from the browser's country, e.g. Georgia → GEL).
   Everything else defaults from it: price rows, invoices, reports.
2. **Never show a money headline that silently counts amounts as 0.** When a rate is missing, show
   the total "8,170 GEL (no rate to USD)" or "—", not "0.00 USD", and block "Profit / margin" with
   a "Set the GEL rate" button. Make it a red alert on Home and on the tour.
3. **New price rows take the currency of the row above** (or the supplier's), not the agency default.
4. **A tour with costs and no hotel lines while it has hotel nights** → alert ("rooms unknown").

### Should fix — friction on the first day
5. **Short supplier form**: Name, Type, City, Phone, Currency. "More details" folds the rest
   (contact, email, payment terms, cancellation terms).
6. **Simple price row**: Price + currency first and visible; "Room type" (for hotels) or nothing;
   season and group size behind "Different price by season / group size". Hide the
   code / category / unit trio behind sensible defaults per supplier type
   (guide → Guide · per day, bus → Transport · per vehicle/day).
7. **After "Create", scroll to the price list**; one Save for the whole drawer.
8. **Next-step nudge**: after a step is done, a small bar "Done: suppliers ✓ · Next: build a route →".
9. **Day-one Home**: until the first tour exists, show only "Get started" (and maybe Starting soon),
   not empty money charts.
10. **Route form**: Name first (required), code suggested from it ("Tbilisi weekend" → TBW).
11. **One place for guide and bus**: say it on the route ("Guides and drivers are added per tour,
    in Staff") and keep room/meal prices out of the Services list.
12. **Tap-to-place**: keep the item picked until Esc, or offer "Add to every day".
13. **New tour**: pre-select the route when there is only one; no "Cancelled" for a new tour;
    rooms as small number fields (Double / Twin / Single / Triple) instead of free text.
14. **Selling price**: the tour has no "price per person"; revenue appears only after an invoice.
    Offer "Price per person" on the tour (pre-filled from a calculation, or cost per person +
    margin) and use it for the invoice line.

### Nice to have
15. Landing/sign-up: one sentence on what TourCRM does; "Create account" as a real button.
16. Plural fix "1 days"; labels on route colour swatches; required marks on sign-up.
17. On narrow screens, collapse the tour's edit form so the tabs are visible.

## Data left from the run
Agency **Claude Tours** (owner `claude.owner@example.com`, dev password from `seed_dev.py`): 4
suppliers, route TBS, client Baltic Travel Partners, tour TBS-1020 with costs and issued invoice
2026-0001 (6,840 USD). Its hotel still has the old mislabelled "TWN room / night" row (charged as SGL).

## Follow-up (same day) — done

- **1. Currency at sign-up** — asked next to the agency name, guessed from the computer's time zone
  (Tbilisi → GEL). Prices and invoices can still be in any currency.
- **2. No fake zeros** — when a currency has no rate, costs / profit / margin show "—" and a red box
  asks for exactly those rates inline ("1 GEL = [ ] USD", with the reverse shown). Saving values the
  amounts already calculated (cost lines and issued invoices). Same on Finance and the Home widgets.
  Red alert "No exchange rate for …" on the tour and in Needs attention.
- **3. Price rows** start in the currency of the row above, else the supplier's.
- **4. Alert "Hotel nights but no rooms"** when the Rooms field can't be read.
- **5. Short supplier form** — name, type, city, phone, currency; the rest under "More details".
- **6. Simple price row** — "What is it" + price + currency; season / group size behind "Different price
  by season or group size"; name, unit and cost group behind "More options". Guide → Guide cost,
  bus → Transport · per vehicle/day. Room names in words ("Double room · per night").
- **7. After "Create"** the drawer scrolls to the price list, with "Add the first price".
- **9. Day-one Home** shows only "Get started" until the first tour exists.
- **10. Route form** — name first (required), code suggested from it (Georgian names too).
- **13. New tour** — the only route is pre-selected; no "Cancelled" for a new tour.

Still open: 8 (next-step nudge), 11 (one place for guide and bus), 12 (add a service to every day),
14 (selling price on the tour), 15–17.

## Round 2 — done

- **14. Selling price** — "Price per person" + currency on the tour (managers only). Until invoiced, the
  money tab shows *expected* revenue (pax × price), expected profit and margin; without a price it shows
  cost per tourist. Invoices and the payment schedule start from it; a tour created from a calculation
  gets the price sold at that size.
- **8. Next-step bar** on Suppliers, Prices, Routes, Clients, Tours: "Build a route — done · Next: …".
- **11. Guides and buses** — the builder's Services list no longer offers guides/drivers (they go in
  Staff) or room/meal prices (they have slots), and says so. New alert when one supplier is both on
  Staff and a day service the same day ("would be paid twice").
- **12. Add to every day** — a picked service stays picked and the bar offers "Add to every day".
- **15–17.** Landing says what TourCRM does on any screen, with four plain benefits and a real
  "Create an account" button; "1 day / 1 night" plurals; colour swatches labelled; the tour's details
  fold to one line on phones so the tabs come first.
- **Found while testing:** closing the route drawer silently dropped unsaved changes — now it asks.

## Walkthrough 2 — "Newcomer Travel" (same day, after the fixes)

Owner without an agency → set up agency (GEL) → 4 suppliers with prices (hotel, restaurant with a
priced set menu, guide, bus) → route TAK (3 days, bus every day) → client → tour TAK-1112
(16 pax, "7 double + 2 single") → bookings → guide → costs → price → invoice → tasks → search.

**Worked:** short supplier form; prices in view after Create; GEL everywhere without touching a
currency; plain room names; dish prices → menu price; guide/bus filed correctly; route name first
with code suggested; bus on every day in one click; next-step bar on every setup page; route
pre-selected; rooms in words understood; costs 7,409 GEL — checked by hand (hotel 2,940 + meals
2,669 incl. the guide + bus 1,140 + guide 660); invoice and payment schedule start from 16 × price;
closing untouched forms asks nothing.

**Fixed during this run:**
- 🐞 The builder's Services list offered the set menu → it would be paid twice (meal slot + extra). Meals are now never offered as extras.
- 🐞 Saving the tour's price didn't refresh the money panel → it does now (and bookings, tasks).
- 🐞 Route not pre-selected when the form opens before the routes have loaded → fills in when they arrive.
- "Profit −7,409" in red before anything is sold → "—" until there's a price or an invoice.
- Top-bar task count ignored "nobody's" tasks → counts them (same as the Mine list).
- No "Set menu" choice → "Set menu (with dishes)" for restaurants and hotels; "Own service (no code)" → "Something else"; price types limited to what fits the supplier (no "Double room" for a restaurant).
- "2 night(s)", "Per day × 3", "7 DBL" → "2 nights", "3 days", "7 double"; "Create 1 draft invoices" → "invoice".
- Enter saves a confirmation number; price per person on the new-tour form; duplicate "Add service" button hidden while empty; agency setup page: one title, "Currency" with an explanation; "Customize" hidden on day one.

**Fixed after the run:** one Save at the bottom of the supplier drawer saves details and prices together (an incomplete price blocks it with a message, nothing half-saved); search finds set menus, services, and menus by a dish ("khinkali").

## Walkthrough 3 — a real series: ZK (Georgia + Armenia part), 2026-10-03/04

Input: the partner's Excel of group dates (ZK/ZV/ZS) and the ZK programme (.docx, translated).
Our part is Georgia + Armenia only: group day 3 (pick-up at the Azerbaijan border) to day 11
(flight CZ6040 home). Done in "Newcomer Travel", through the normal screens.

What was made: 6 hotels (no prices), route ZK (9 days, "via" stops, 3 borders, programme in day
notes, km from the map: 2,034 km), 21 departures ZK-1025 … ZK-0314 as inquiries, ~20 pax, 10 TWN.

Fixed during the run:
- **Separate stays read as one long stay** in Bookings ("27 Oct – 3 Nov · 2 nights" for two single
  nights a week apart). Now: check-in → check-out per stay, "2 separate stays".
- **No way to create a series** — 21 tours one by one. Now: New tour → Several departures
  (repeat weekly, or paste the codes and dates from the Excel; our part starts on the group's day N;
  preview before creating; one taken code doesn't stop the rest).
- **Same-name places sent the km astray**: "Khertvisi" was taken as the village in Adjara (day 6:
  749 km). Places are now chosen for the whole path at once (shortest, preferring the map's first
  answer): 361 km.

Problems in the data (for the partner):
- Day 9 of the group (our day 7) is always a Monday: Etchmiadzin museum is closed on Mondays.
- ZS: the January–March departures are dated 2026 instead of 2027.
- Unknown: hotel prices and currencies, restaurants (only "local food"; 3 special meals: marani +
  dance show, duduk dinner, Sevan fish), tickets, buses and guides for 2 countries, the client (the
  Chinese partner), price per person, tour leader / singles, the hand-over time and border.

Still missing in the app (by impact):
1. **Series bookings**: 21 tours × 6 hotels = 126 "book" tasks. A series hotel is contracted once
   (allotment) — needs "confirm this hotel for all ZK departures" and one task per hotel per series.
2. **Calculation for a series**, both ways: from a calculation create the departures, or attach a
   calculation to departures that exist (see the proposal in the chat).
3. **What's not planned yet** isn't flagged: costs list only the hotels; no warning that there is no
   bus, no guide, no lunches. Meals the client doesn't get ("dinner: on own") can't be marked.
4. **Opening days of sights** (closed on Mondays) — would have caught the Etchmiadzin problem.
5. **Winter variant** of days 2–3 (Kazbegi road closed): only as a note; no way to switch a tour
   to another route's days.
6. **Flights and hand-over** (CZ6040 22:45, border pick-up time): only free text in notes.

### Walkthrough 3, part 2 — the whole job for ZK (example prices)

Built for it: meals "included / tourists pay / on their own"; flights on route days (copied to every
departure; alerts for no transport and late check-out); a calculation for a series both ways
(create departures from it, or apply it to existing departures); series bookings (one task per supplier
per series, confirm/assign/pay terms for all departures at once); "update departures from the route".

Run (suppliers and prices marked "(example)"): 9 restaurants + 3 set menus, bus, guide, 5 tickets;
route filled (meals, menus, free dinners, one tourists-pay dinner, bus + guide every day, tickets,
CZ6040 on day 9); pushed to 21 departures; calculation from the route (2,479 GEL pp at 20+1) applied to
all 21; Hualing confirmed for the season in one action (126 → 18 tasks before, 17 after); ZK-1025:
costs 44,690 GEL vs budget 48,980, deposit invoice issued and paid, Hualing half paid.

Fixed during the run: calculation lines per day ("Bus" ×9) → one line per service; empty template
"Guide"/"Bus" lines kept when the route has them; "ZK · ZK ·" name; a 0 price kept as "the confirmed
price" after confirming (a missing price is never agreed); "1 departures".

Still missing:
- **Staff for a series**: bus and guide are day services on the route (fine for costs and the
  calculation), but the guide's phone link and the "team" need a person on the Staff tab — per tour.
  Proposal: staff on the route (role, days, supplier), copied to departures, the person changed per
  departure; costs from the staff line.
- Setting the client on many existing departures at once.
- The calculation's dates should be set to the series' season (ZK-1025 starts before 1 Nov).

### Walkthrough 3, part 3 — changes during the season (2026-10-04)

- **Overbooked series hotel on one departure:** Bookings → hotel → *Change hotel…*. Pick the nights and the new hotel; the dialog shows the old and new cost and the difference (per person too). When a price is missing it says so instead of guessing. Who pays: we do / the partner (a draft supplement invoice) / the overbooked hotel (a claim). Then a partner message is ready to copy, WhatsApp or email. Costs, bookings (old hotel "changed", new hotel "to book") and the team's change list follow.
- **Day programme:** each day has an ordered programme with times (breakfast → museum → lunch → free time → dinner), dragged into order; until arranged, a suggestion comes from the day.
- **Same city, same day:** Day view → *By city and time*: a timeline per city, a warning when two groups are at the same restaurant, sight or hotel at overlapping times (e.g. ZK-1025 and ZK-1101 both checking in at Hualing Tbilisi 18:00 on 3 Nov), and each group's programme to change right there.
- **Team notified:** every change to days or staff is written in words; the guide/driver sees it on their phone page until they tap *Got it*; the office sees who has seen it and can WhatsApp the unseen changes.
- **Guides split by days:** Staff → *Hand over…* (e.g. days 7–9 to an Armenian guide): shows both day prices and the difference, splits the assignment, works out the costs again. On the route (series page): *Guides and drivers on this route* — calculations from the route get one line per guide at their own day price ("Armenian guide: Nino · days 8–9"); new departures get these people; *Give to departures* adds them to existing ones without touching what was changed per departure.
- Still open: the example Chinese-speaking guide has no day price in the catalog (the calculation warns).

