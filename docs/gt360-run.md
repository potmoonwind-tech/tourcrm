# GT360 — the partner's files from scratch (2026-10-04)

Agency **GT360** (owner Nino Beridze, base currency GEL), empty at the start: no suppliers, routes,
clients or tours. Input — only what the partner sent:

- `date-ZK&ZV&ZS.xlsx`: three series, **48 departures** — ZK 21, ZV 16, ZS 11; "10twin" each; a date
  and a hotel for every night.
- `ZK-2026冬春季团期计划及行程0918.zh-CN.ka.docx`: the ZK programme (machine-translated to Georgian),
  group days 3–12. **No programme for ZV and ZS.**

Our part is Georgia + Armenia only. Every step was done in the app as the owner; where something
was entered through the app's API instead of clicking (repeated rows), it says so.

Legend: ✅ worked · ⚠️ worked with friction · ❌ problem (fixed now = 🔧)

## Step 0 — log in, open the agency

- ✅ Log in; ⚠️ it opens the owner's **first** agency (Silk Road Tours), not the one used last on this
  device — switched with the agency menu.
- ⚠️ Home of an empty agency is blank for a moment before **Get started** (0 of 6) appears — no spinner.
- ❌ The AI assistant (built to read these files) can't be used: no Anthropic key in the agency or on
  the server. Everything below is by hand.

## Step 1 — the partner's Excel of dates

- ❌🔧 **Settings → Import → Tours** rejected the file: "Missing column(s): start_date". The import wants
  one row per tour; partners send a **grid** (codes across, one row per night down).
- ❌🔧 Pasting into **New tour → Several departures** didn't work either: copied from Excel, the codes
  come as one line and the dates as another; the box wants "code date" per line. 48 departures would
  have had to be retyped.
- 🔧 **Fixed:** *Several departures → Read the partner's Excel*. It finds every series in the file
  (ZK 21, ZV 16, ZS 11), fills the list, works out where our part starts (the night at the route's
  first hotel: group day 3 for ZK/ZV, day 1 for ZS), shows the group's nights and flags dates that
  look wrong. The tour import now says where to take such a file.
- ❌ **In the partner's data:** 5 ZS departures are dated **2026** instead of 2027 (ZS-0106, -0120,
  -0203, -0217, -0303: January–March 2026, in the past and between December 2026 and March 2027
  departures). The app now flags them and offers the corrected dates.
- Found while fixing: a hidden circular import between the staff screens and finance (from the guide
  hand-over work) that broke loading the importer on its own — 🔧 fixed.

## Step 2 — suppliers and prices

- ✅ Catalog → Suppliers → New supplier: **Hualing Tbilisi** by hand; the drawer stays open for prices;
  "Twin room · per night" 260 GEL (the partner's "10twin" = 10 twin rooms). ⚠️ Two blue "New
  supplier" buttons on the empty page (header + empty state).
- The other 29 suppliers were entered through the app's API (same as the form). **Nothing of this is
  in the files** — every name below marked "(name unknown)" and every price is an example:
  - 5 more hotels from the Excel (Gudauri, Kutaisi, Batumi, Borjomi in GEL; Radisson Yerevan in USD),
    twin + single; dinner buffets at Marco Polo and Kutaisi Inn (the programme says "hotel buffet").
  - 12 restaurants — the programme only says "local food", except: wine cellar + dance show (Tbilisi),
    special dinner + duduk (Yerevan), Sevan fish (Sevan), Chinese lunch (Tbilisi).
  - Coach company, Chinese-speaking guide (GEL/day), Armenian guide (USD/day).
  - Tickets: Narikala cable car, Stalin Museum, Borjomi park, Vardzia, Zvartnots, Etchmiadzin museum
    (closed Mondays), Garni, Underground Printing House; 4x4 to Gergeti (not in the programme, but the
    coach can't go up — in winter the jeeps are the only way).
- Client: "Chinese partner (ZK / ZV / ZS)" — the files don't name the partner, contact or currency.

## Step 3 — routes and the 48 departures, from the Excel

New tour → Several departures → **Read the partner's Excel** (once per series):

| | ZK | ZV | ZS |
|---|---|---|---|
| Departures | 21 of 21 made | 16 of 16 | 11 of 11 |
| Our part | group days 3–11 | 3–10 | 1–10 |
| Route from the file | 9 days: Tbilisi → Gudauri → Kutaisi → Batumi → Borjomi → Yerevan ×2 → Tbilisi → flight | 8 days: Tbilisi ×2 → … → Yerevan → flight | 10 days: Tbilisi → … → Yerevan ×2 → Tbilisi ×2 → night train |

- 🔧 **Route from the file:** with no route ZK yet, the panel offered "Create route ZK from the file":
  each night's hotel matched to the suppliers (6 of 6), cities from the suppliers, plus the day out
  (flight / train). It then picked that route, filled the 21 lines and set "our part starts on day 3".
- ❌🔧 The file button sat under the "Paste a list" tab (Repeat is the default) — moved to the top.
- ❌🔧 After ZK existed, the form kept ZK selected while ZV was read: "the file has 8 days, the route 9".
  Choosing a series now selects the route with that code, or none.
- ❌🔧 "The route's first hotel isn't in the file" showed while there was no route at all — hidden.
- ❌🔧 The wrong-year list read "6 Jan → 6 Jan" (dates without the year) — now 06.01.2026 → 06.01.2027.
- ✅ ZS: the 5 wrong-year departures were created in 2027 ("Use the corrected dates", on by default).
- Questions for the partner from this step:
  - **ZV flies out from Yerevan** (last night Radisson Yerevan, then "Flight") — which flight, which airport?
  - **ZS:** arrival flight on day 1 (Tbilisi)? Day 10 is "夜宿火车" (overnight train to Baku) — is the
    station transfer ours, and the train tickets? The night label is left in Chinese on the route.
  - ZS-0106 … ZS-0303: confirm 2027.

## Step 4 — the ZK programme on the route (from the Word file)

Our days 1–9 = the group's days 3–11. Entered on route ZK (through the API, then checked and saved
in the route editor): stops ("via"), lunch/dinner per day (two dinners "on their own", day 8 "not
included"), coach every day, tickets, 4 cars to Gergeti, three borders (Lagodekhi in, Bavra out to
Armenia, Sadakhlo back), flight CZ6040 22:45 on day 9, the winter variant and the doubts in the notes.

- ❌🔧 **Suggest km from the map: 7,817 km.** Day 2 came out at 6,084 km: the map knows "Friendship
  monument" only in **Tirana and Budapest**, and every "Jvari" it knows is a village in Samegrelo, so
  the route went through Albania. Now a stop the map only knows far off the way (it would add more
  than 200 km and 1.5× the direct way) is left out of the km and named — "Found only far away:
  Friendship monument (Tirana…)" — and the day still gets its km; unknown stops ("KTW winery") are
  listed too. After renaming ("Jvari Monastery", "Russia–Georgia Friendship Monument"): **2,098 km**.
  🔧 Follow-up: the monument is of course on the Georgian Military Road — it was the map's plain search
  that only knew Tirana's. Now a stop found only far away (or not at all) is searched again **inside
  the area of the stops around it**: "Jvari" → Jvari Monastery (Mtskheta), "Friendship monument" →
  the Georgia–Russia Friendship Monument near Gudauri — no renaming needed (day 2: 210 km).
- ❌ (workaround) **Day 1 had 0 km** although the coach drives ~150 km from the border: a route has no
  "where the day starts" for day 1. Added "Lagodekhi" as the first via stop.
- ❌🔧 The **suggested day programme flagged itself** ("1 to check"): with 5 stops the 5th was put at
  13:30, after lunch at 13:00. Suggestions now fit the stops around lunch and only move forward.
- ✅ Series page → **Guides and drivers on this route**: Chinese-speaking guide all days, Armenian guide
  days 7–8. ❌🔧 "Add a person" cut the first guide to days 1–8 (it assumed a hand-over) — adding a
  person no longer changes the others.
- ✅ **Update departures from the route**: 21 of 21 (the route was filled after the departures were made).
- ❌🔧 **The Armenian guide wasn't added** to the departures: the rule was "only where nobody in that
  role works those days", and the Chinese-speaking guide does. Now a plan line is skipped only if the
  same person (or one added for the same line) is there — a guide changed on one departure still
  stays. "Give to 21 departures": 21 of 21, both guides.
- Questions for the partner from the programme:
  - **Two different day 11s** (Tbilisi city + Chronicles, lunch Chinese / dinner own — and Ananuri,
    Jvari, Mtskheta + Chronicles, lunch local / dinner Chinese); the first also says "lunch at your
    own expense". Which one?
  - Day 3: the morning is in Sheki (Azerbaijan) — at what time and where do we take the group?
  - Etchmiadzin museum is closed on Mondays and our day 7 (group day 9) is always a **Monday**.
  - Winter: Kazbegi road closed → days 4–5 change (city tour + Gori); then no Gudauri night and
    Hualing needs an extra night. Who decides, and when?
  - Gergeti needs 4x4 cars (not in the programme); restaurant names; "local food" budget.

## Step 5 — the ZK calculation, applied to the 21 departures

Calculations → New calculation → From a route → ZK.

- ❌🔧 The route list said "ZK · ZK · Georgia + Armenia" (code + a name that starts with the code) — once now.
- ❌🔧 The travel date (prices depend on it) defaulted to **today**; now the route's next departure (27 Oct).
- ❌🔧 The hint said "Add guide and transport yourself" — they come from the route now (coach every
  day; the route's guides, each at their own day price); the hint says so.
- ✅ Built from the route: 26 lines (15 meals, coach ×9, 4 cars to Gergeti, 7 tickets, **Chinese-speaking
  guide days 1–9 at 350 GEL and Armenian guide days 7–8 at 90 USD** — from the route's guide plan).
- ❌🔧 Three lines were called just "Entrance" (Vardzia, Zvartnots, Garni) — lines from a supplier's
  service now start with the supplier: "Garni Temple: Entrance".
- ❌🔧 **"Fix these to see prices"** listed the same cause 10 times ("no exchange rate for USD" — the
  Armenian hotel, meals, tickets, guide). Now one line: "No exchange rate for USD (10 lines): 1 USD =
  [ ] GEL [Use]" + **Use National Bank rate** (filled 2.604). Also found: the app has two opposite rate
  directions — agency rates "1 USD = 2.70 GEL", the calculation "1 GEL = 0.37 USD"; the box asks the
  usual way and converts. The settings hint "E.g. GEL 2.70 means 1 GEL = 2.70 GEL" made no sense for a
  GEL agency — the example is now in another currency.
- ❌🔧 **Leaving the calculation through a menu link lost unsaved changes silently** (only reloading the
  page asked). Now any link inside the app asks "Leave without saving?" too.
- Result (example prices, 20 + 1 leader): cost 2,553 GEL, **price 2,582 GEL per person**, single
  supplement 885 GEL, group 51,640 GEL.
- ✅ **Apply to departures**: 21 of 21 got this budget and price.
- ⚠️ One calculation for the whole season prices everything on 27 Oct; winter (Jan–Mar) prices need
  their own calculation or seasonal prices in the catalog.
- Questions: is there a **free tour leader** (+1)? Is "10twin" always 20 tourists? In which **currency**
  does the partner pay?

## Step 6 — guides for a whole season, hotels, alerts

- ❌🔧 **40 "double-booked" errors** after giving the route's guide to all 21 ZK departures: a weekly
  9-day series overlaps by 2 days (ZK-1025 ends 3–4 Nov when ZK-1101 starts) — one guide can't do
  every departure. "Give to departures" now skips a person busy on another tour those days and lists
  the departures that still need someone; **two plan lines with the same name are alternatives**
  (Chinese-speaking guide 1 or 2): each departure gets the first one who is free. ZK: guide 1 on 11
  departures, guide 2 on 10. ❌🔧 The calculation priced every alternative — now one per name.
- Season staffing the app worked out with all three series (example people, "name unknown"):
  **5 Chinese-speaking guides** (ZK 2, ZV 2, ZS 1) and **2 Armenian guides** (ZS is in Armenia on the
  same days as ZK). No double booking left.
- ✅ Series page → each hotel → Confirmed + reference → "Apply to 21": 6 hotels × 21 ZK departures in
  6 actions (ZV 16 and ZS 11 the same way).
- ❌ (not built) **Rooms per hotel per night across series**: Hualing has 2 groups (20 twin) on 25
  nights, Radisson Yerevan on 11 nights — the allotment to ask for. Nothing in the app shows it.
- ❌🔧 **No warning that ZV/ZS had nothing planned** but hotels (25 days before ZV-1027): new alert
  "Starts in 25 days and nothing is planned yet for: meals, transport, guide" (within 45 days).
- ❌🔧 ZV's flight CZ8164 at **00:45** (the night after the last day) raised no "late check-out" note —
  flights between 00:00 and 05:00 on the last day now count as the night after.
- ⚠️ A flight after midnight is still entered on the last day with "00:45": the app has no "+1 day".

## Step 7 — one departure end to end (ZK-1025)

- ✅ Costs → **Calculate from itinerary**: hotels (10 twin), meals for 20 + the guides who eat, coach,
  tickets, 4x4, both guides by their days.
- ❌ (by design, but surprising) The USD rate entered in the calculation isn't the agency's rate:
  costs said "USD has no exchange rate" until it was entered again (Use National Bank rate → Save).
- ❌🔧 **"20 × 2,617 GEL"** under expected revenue although the amount (49,723) is 19 × 2,617 — the free
  leader isn't paying. The label now shows who pays: "19 × 2,617".
- ❌🔧 **Borjomi lunch and dinner at one restaurant** stayed unmatched with the budget (2 budget lines
  "no cost yet", 2 costs "not in budget"): the rule found two candidates and gave up. Lunch now goes
  to "Lunch: …" and dinner to "Dinner: …".
- ❌🔧 Budget box said **Profit −47,767 GEL** before any invoice (costs against no revenue) next to
  "Expected profit 1,955". Now "— · no invoice yet · Planned 554 GEL".
- Budget vs actual: planned 49,169, actual 47,768 (hotels −130/night: the partner's 10 twin vs the
  calculation's 19 in double + leader single). Margin on example prices: 3.9% — the default profit
  (30 GEL/person) is too low for real use.
- ✅ Payment schedule → one draft invoice 49,723 GEL due 13 Oct (agency terms; the partner's are unknown).
- ✅ Staff → Phone link for the Chinese-speaking guide; the guide's page (phone size): "Working with
  you: Armenian guide, days 7–8", each day with places, km, the kept programme in 16 px (09:30
  Lagodekhi → … → 19:30 dinner), border, map buttons, coach, notes.
- ⚠️ The coach is a day service, not a person: the driver isn't counted for meals and gets no phone page.

## Step 8 — the ZV and ZS programmes (sent during the run)

- ✅ Read both files; ZV and ZS routes filled the same way (stops, meals, borders, tickets, 4x4,
  winter notes): ZV 1,819 km, ZS 2,162 km; departures updated 16/16 and 11/11; calculations from the
  routes (ZV 2,317 GEL, ZS 2,822 GEL per person at 20, example prices) applied 16/16 and 11/11; the
  agency's USD rate now filled the calculations by itself.
- New facts and questions from them:
  - **ZV leaves from Yerevan on CZ8164 at 00:45** (the night after group day 10); dinner is included
    that day, then the airport.
  - **ZS arrives on CZ6039 at 21:20** (Urumqi → Tbilisi) on day 1, no meals; leaves on day 10 by the
    **night train to Baku** — station transfer and train tickets: ours?
  - ZV group day 9 goes Borjomi → Etchmiadzin → Yerevan: the lunch place isn't named (Gyumri assumed).
  - ZS day 8 lunch is "local food", not the Sevan fish of ZK/ZV; ZS day 8 dinner is Chinese.
  - The ZS file's exchange note (1 GEL = 2.5 CNY) suggests the partner thinks in **CNY**.
  - Both have the same winter variant (Kazbegi closed).

## Summary — where the problems were

**In the partner's files** (to send back): 5 ZS dates a year early; the two day-11 versions of ZK
(and "lunch Chinese" vs "lunch at own expense"); Etchmiadzin museum closed on ZK's Monday; no partner
name, contact, currency, prices, rooming beyond "10twin", tour leader, hand-over times, restaurants
or bus/guide companies; flights only as "reference flights"; the overnight train in ZS.

**Fixed in the app during the run (22):** read the partner's date grid (+ route from it, the series
picked by code, wrong-year dates with the year shown, the file button on top); the tour import points
to it; a circular import; a stop found only far away (Tirana) or not found no longer wrecks the day's
km; the suggested programme no longer contradicts itself; "Add a person" doesn't cut others; a second
guide on the same days is added; busy people skipped and alternatives take turns; alternatives priced
once; calculation route label, travel date, hint; lines named by supplier; one missing exchange rate
asked once with the National Bank button; the rate hint; leaving an unsaved calculation asks;
"19 × price" for revenue; lunch/dinner at one restaurant matched to the budget; no fake loss before
invoicing; "nothing planned yet" warning; after-midnight flights need a late check-out.

**Still open (not built):** the AI assistant needs a key; rooms per hotel per night across series
(allotments); where day 1 starts (airport / border) for the km; "+1 day" for flights after midnight;
one rate table instead of two (calculation vs agency); drivers as people (meals, phone page) when the
coach is a day service; seasonal prices / one calculation per season; winter variant as a switch, not
a note; opening days of sights; login opens the first agency, not the last used; two blue buttons on
the empty suppliers page; "Add a person" starts after the last row's end (an alternative must be
moved to day 1 by hand).

**State of GT360 now:** 36 suppliers (6 hotels from the Excel; 13 restaurants, 7 guides, coach, 4x4
and 8 sights — all with example prices, names unknown except hotels and sights), 1 client, 3 routes
(ZK, ZV, ZS) with programme, km and guides; 48 departures with budgets and prices; every hotel
confirmed for the season; ZK-1025 costed, draft invoice, guide phone link; 69 open booking tasks
(restaurants, coach, tickets, guides — one per supplier per series). Alerts left: only "late
check-out" notes — 21 for ZK (CZ6040 22:45) and 16 for ZV (CZ8164 00:45).

## Step 9 — the map searches our countries, and driving time (after the run)

- **Settings → General:** "Countries you work in" (GT360: GE, AM, AZ) — the map searches only there; and
  "Coach time compared with a car" (125% by default — the map's times are for cars).
- A stop the map knows only far away (or not at all) is also searched **around the stops before and
  after it** — "Friendship monument" and "Jvari" are found as they are (no renaming).
- ❌🔧 Turning the countries on first made **Batumi, Borjomi, Vardzia… "not on the map"**: every name
  looked new, and the map allows 12 lookups per click. Places already found are reused when their
  address is in the agency's countries; past the limit it says "not looked up yet — press again".
- **Driving time** comes with the km (the road service's time for each leg), kept per day:
  "≈ 4 h 30 driving" on each day, "≈ 44 h driving" for the route, and the **suggested programme now
  follows the drives** (leave 09:00, drive, an hour at each stop, lunch after 12:30, check-in on
  arrival). Never past 23:45.
- New warning **"Day N: about X h on the road"** (more than 9 h of coach time). It flags day 8 on every
  ZK (13 h 20: Yerevan → Sevan → Garni → Tbilisi + border), ZS (13.3 h) and ZV (9.6 h: Khor Virap,
  Sevan, Garni, then the 00:45 flight) departure — **a programme problem to raise with the partner**.
- Precision: "Sevan" is the middle of the lake; "Sevanavank" would be closer (the first leg of day 8
  may be long because of it).
- ❌🔧 `/settings` (and any wrong address inside an agency) showed a **blank page**: now Settings opens
  General and unknown addresses go to the agency's Home.
