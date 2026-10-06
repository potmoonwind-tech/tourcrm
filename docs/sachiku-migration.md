# Sachiku — moving the old program (sachoki360) into TourCRM

Started 2026-10-04. The old program changes nothing and is not touched: it was copied, and its own
sheet readers were run on the copy (read-only on Google Sheets) — every workbook downloaded once.

## What the old program has

| Source | Contents | Found |
|---|---|---|
| Master sheet "2026 TOURS MAP" (grid) | 2026 schedule: code, dates, guide, booking marks | 130 tours (30 Apr – 2 Nov 2026) |
| Master sheet "cancelled" | cancelled tours | 20 |
| Master sheet "informations" | guides, hotels, restaurants, staff stays, office people, extra (delicas, boat, border transport) | 77 guides, 17 hotels, 20 restaurants, 7 stays, 3 office, 4 extra |
| Code: seed_data.py | 17 series (routes): night by night city, hotel, lunch, dinner, border | ZT, ZT1, LN, KT, DT1, DT2, LT, HM, HM1, HM2, HT, HT1–3, TH, TK, TM, TV |
| Old database (daily_log) | each 2026 tour's days: city, hotel, lunch, dinner, border | 967 days |
| 6 BALANCE workbooks (2026) | one tab per tour: every cost line (GEL, rate, USD, invoice arrived, paid by whom/cash, VAT, notes), meals dated, summary (spent, tour price, profit, VAT, received) | 129 tabs |
| 4 archive BALANCE workbooks | the same for earlier seasons | 117 tours (2024: 33, 2025: 84) |
| Menu workbook + menu_data.py | restaurant set menus (dishes, portions) | 13 restaurants |
| Old database (payment_terms) | supplier payment timing + prices (hotels USD/night, restaurants, guide/driver per series) | 14 |
| **Not here** | what was typed into the old app (tour notes, log notes, settings) lives only in `gtc360.db` on Railway | — |

## Plan

1. Export (old program's readers + the raw tabs) → one clean file.
2. Agency **Sachiku**: base currency **USD** (the old program counts profit and revenue in USD), language
   Georgian, countries GE/AM/AZ, client terms 60% advance at the start, 40% within 14 days after the end.
3. Import, in order: suppliers (merged names) → prices, payment terms, set menus → routes (series) →
   tours (2026, past seasons, cancelled) with their days and rooms → staff (guides/drivers named) →
   costs per balance line (GEL with the line's rate, or USD) → supplier bills (invoice arrived) and
   payments (paid; who/cash in the note) → the partner's invoice (tour price) and payments (received).
4. Check every tour: imported totals against the sheet's own summary (spent / revenue). List what
   didn't fit.

## Result

Agency **Sachiku** (slug `sachiku`), owner: the seed owner account (change before real use).

| What | Imported |
|---|---|
| Suppliers | 329 — guides 120, hotels 46, restaurants 50, transport 15, activity 14, drivers 24, other 60; 124 with a phone |
| Services / prices | 71 services, 52 rates (hotel per night and restaurant lunch/dinner per person from the old payment terms or the median of real lines), 19 set menus with dishes |
| Routes | 18 series, 136 nights (city, hotel, lunch, dinner, border) |
| Tours | 286 — 2026: 169, 2025: 84, 2024: 33; 37 cancelled; 2,094 days (794 with a hotel, 514 lunch, 565 dinner) |
| Costs | 7,388 lines, locked (GEL lines keep the sheet's own rate, so totals match the sheet) |
| Supplier bills / payments | 6,845 bills (invoice arrived), 6,669 payments (570 cash) |
| Partner | 195 invoices (tour price from the tab's summary), 140 payments (the "received" amount) |
| Staff | 16 guide assignments (only where the schedule names a guide that matched a supplier) |
| Closed | 36 ended tours that pass every closing check |

**Check against the sheets:** 233 of 243 tours with a balance tab match the sheet's "spent" within
0.5%. Off: BG-0930, H-0811, H-0814, TE-0804, TN-0618, H-0712, DT2-0927, TE-0811, H-0807B, H-0807 —
each has a line the sheet counts differently (a formula row, a typed total, a line outside the
money columns). Open them side by side with the tab.

**Ended but not closed (the app is right — the sheets say so too):**
- 149 — the partner still owes something (received < tour price on the tab);
- 44 — supplier lines not marked paid (no green colour / no "paid" status);
- 30 — no tour price on the tab, so there is no invoice.

**Alerts after import (156):** partner overdue 40, bookings late 21, staff double-booked 4,
supplier overdue 41, hotel in another city than the day 10, no hotel 5, plan incomplete 13, no
participants 11, no guide 1, pax unconfirmed 5, rooms unknown 5, not closed 50. Most are real
(the sheets have the same gaps); the 4 double bookings and 10 hotel-city ones are worth checking first.

Checked: every tour opens (10 screens × 286 tours, no errors, all under 1 s); tour list, finance,
tasks and alerts load.

Tools (re-runnable): `tools/import_sachoki360/` — `run_sync.py` (downloads the sheets once, runs
the old program's readers), `export.py` (→ `export.json`), `import_sachiku.py` (dry run by
default; `--commit`, `--replace`). Backup before import: `%LOCALAPPDATA%\Temp\tourcrm-before-sachiku.db`.

## Notes — missing, unclear, to improve

**Missing (could not be moved):**
1. What was typed into the old app itself (tour notes, daily-log notes, settings, edited payment
   terms) lives only in `gtc360.db` on Railway. Download that file and the import can add it.
2. The partner's name is not in any sheet → one client "Chinese partner (from the old program)". Rename it.
3. Tab "TN1005 13+1" (MT_ST workbook) has no current-season code → skipped. Tell us which tour it is.
4. The "payment statuses" sheet would not export (HTTP 400). Paid/received comes from the cell colours
   and the status text instead — same rule the old program uses.
5. Flights have no numbers in the old data → written into the day notes, not as flights.
6. Hotels marked "(TBD)" → in the day notes, not as a hotel.

**Unclear (please check):**
7. Derived prices (median of real lines) — hotel per night, restaurant per person. Check the 52 rates
   before using them for new calculations.
8. Restaurant prices in the old payment terms: per group or per person? Imported as per person.
9. 43 guides are named by first name only (e.g. "ნინო") — they may be the same person as a full-name
   supplier. Merge them in Suppliers if so. Guides and drivers were never merged automatically.
10. 60 "other" suppliers are one-off lines (tips, SIM cards, cash withdrawals, exchange difference).
    Fine for history; don't reuse them.
11. Armenia and Azerbaijan partners are suppliers (one line per tour), not detailed per service.
12. Negative lines (money returned) are kept as negative bills/payments "Returned to us".
13. Base currency is USD (as the old profit). GEL rate = median 2026 rate (1 USD = 2.64 GEL).

**Be careful:**
14. Imported cost lines are locked. Pressing "Calculate from itinerary" on an imported tour would
    *add* automatic lines next to them → double costs. Use it only on new tours.
15. The old app has default passwords in its code and the sheets are open to anyone with the link.
    Once Sachiku is in use, restrict the sheets.

**To improve in TourCRM (found during the move):**
- **VAT** — the sheets track VAT per line and per tour; TourCRM has no VAT. Now only in tour notes.
- **Payment terms "balance after the tour"** — the partner pays the rest after; the terms can only
  say "% at start / within N days after end". Needs a "remaining after end" option.
- **Allotment view** — rooms per hotel per night across all departures (the 2026 map grid does this).
- **One rate table** — the sheets use a different GEL rate per line; we need a rate per date.
- **Flights after midnight** — a "+1 day" marker on arrival/departure times.
- **Cash / who paid** — the status column says who paid (cash, card, guide); now only in the payment note.
  A "paid by" field would make the guide's cash report possible.

## Update — VAT and who paid (step 2, 2026-10-04)

Sachiku was rebuilt from the same export with two new TourCRM features:

- **VAT 18%** (Settings → "VAT inside suppliers' prices"). 84 suppliers marked "Gives VAT invoices"
  (most of their lines in the sheets carry VAT); 566 lines that differ from their supplier have their
  own VAT (18 or 0). Every line's VAT equals the sheet's VAT column. Per tour, 205 of 241 match the
  sheet's "VAT" summary; the other 36 sheets' summary cell does not add up all of the tab's own VAT
  lines (e.g. TK-0917: lines 1,668.93, summary 1,551.49) — TourCRM shows the line total.
  Tour and report profit now show "after VAT" (ZT-0511: 2,652.45 vs sheet 2,652.46).
- **Who paid.** The status "ok natia" names who paid; when it is the tour's own guide, the payment is
  "paid by" that guide (446 payments, cash). The sheets never list the cash handed to guides, so each
  such tour has one "Cash for the tour" payment to the guide equal to what they paid — balances stay as
  in the sheets. Office names (rati, goga…) have no login here and stay in the payment note.
- **Guides on tours:** 117 tours now have their guide (was 16), matched from the balance tab's header
  ("xatia mchedlishvili" → ხატია მჭედლიშვილი). 81 headers matched no guide or more than one.

The agency's id changed with the rebuild (`import_result.json`).
