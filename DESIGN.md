# TourCRM design system

Based on monday.com's **Vibe** design system: its colours, type, sizes and interaction patterns,
implemented in our own Tailwind components (not the `@vibe/core` library).
Tokens live in `frontend/src/index.css`; building blocks in `frontend/src/components/ui.tsx`,
`components/overlay.tsx` and `components/tour.tsx`.

## Tokens

| | Value | Use |
|---|---|---|
| Primary | `#0073ea` (`brand-600`), hover `#0060b9`, selected `#cce5ff` | the one main action, links, selection |
| Text | `#323338` (`slate-800`), secondary `#676879` (`slate-500`) | body, labels |
| Borders | `#d0d4e4` layout (`slate-200`), `#c3c6d4` controls (`slate-300`) | cards, inputs |
| Surfaces | page `#f6f7fb` (`slate-50`), cards white | |
| Status | done `#00c875`, working `#fdab3d`, stuck `#e2445c`, blue `#579bfc`, purple `#a25ddc` | status labels only |
| Font | Figtree (+ Noto Sans Georgian), 14px body | |
| Radius | 4px controls, 8px cards, 16px dialogs | |
| Controls | 40px tall (32px `size="sm"`) | |

## Where things open

| Pattern | When | Examples |
|---|---|---|
| **Page** (has a URL) | a place you go and work in | tours, a tour, a calculation, payments, finance |
| **Drawer** (side panel, `Drawer`) | view or edit **one record** while the list stays behind it; many fields or related lists | vendor, client, invoice / credit note, incident, a vendor's bills, a route, a calculation line, a scenario, history, "explain this price" |
| **Dialog** (centered, `Modal` / `Dialog`) | a **decision** or a **short task** that blocks until done; wizards | new tour, new calculation, create tour from a calculation, add cost, record payment, fill from route, update prices, payment schedule, cancel tour, import, "driver & guide every night" |

The test: **is there one thing being looked at and changed?** → drawer (you keep seeing the screen
behind it: a hotel night, a line, a type of person). **Is it an action that is over when you press
the button?** → dialog (create, apply to all nights, confirm).
| **Confirmation** (`ask`, `askText`) | before anything irreversible or important; red for destructive | delete, void, issue, close, cancel, reopen (with a reason) |
| **Inline** | quick edits in tables (blur saves) | itinerary cells, cost quantities and prices, day services |

Never use the browser's `confirm()` / `prompt()`. Confirmations sit above drawers; Escape closes
only the top layer.

## Hierarchy on a screen

1. **Page header**: title (24px semibold), one line of context, then actions on the right.
2. **One primary button** per screen (blue, filled): the thing people come here to do
   ("New tour", "Save", "Close tour"). Others are secondary (outlined) or tertiary (text).
3. **"⋯" menu** (`Menu`) for secondary and destructive actions (duplicate, cancel tour, delete).
4. **Lifecycle / status** right under the header (the tour's lifecycle bar), then tabs, then content.
5. Destructive actions are never next to the primary button; they live in "⋯" or at the bottom
   left of a drawer, and always ask first.

## Type scale (only these)

| Role | Style |
|---|---|
| Page title | 24px semibold |
| Drawer / dialog title | 20px semibold |
| Panel title | 16px semibold, with a 14px grey line under it |
| Row title, field label, step name | 14px medium |
| Body, row details | 14px regular (`slate-800`, details `slate-500`) |
| Captions, legends | 12px (never for something you act on) |
| Hero number (a price) | 32px semibold |

**Control heights: two, by place.** Everything in a page header, a dialog or a drawer footer is
40px (buttons, "⋯", icon buttons, inputs). Inside panels, rows and tables it is 32px. Never mix
the two in one row.

Spacing is on a 4px grid: 16px between panels and inside them, 8px between rows, 12px inside a row.

## Panels: one anatomy for every part of a working screen (`Panel`, `ListRow`)

```
[›] [icon] Title                               value   [+ Add]  [⋯]
           one line: what's in it (folded) / what it's for (open)
```

- **Left = what it is.** The fold arrow sits before the title (monday's groups) and folds the whole
  header; it is never mixed in with actions.
- **Right = what it adds up to, then actions.** At most one "+ Add …" (`Button variant="tertiary"` or
  `Menu kind="add"`), everything else in one quiet "⋯" (`Menu kind="icon"`). No chips, links or
  outlined buttons as panel actions.
- **Lists you edit are rows** (`ListRow`): name, one grey line saying how it is set ("Travels free ·
  single room · +1 per 15"), at most one quick control (a count stepper), "⋯". Clicking the row opens
  its drawer with every setting and what it means. Fields are not spread across the row.
- Row actions (move, duplicate, delete) live in the row's "⋯", not as a line of icons.

## Undo instead of "Are you sure?" inside an editor

Screens that edit a draft with its own Save (a calculation) delete at once and show
"Deleted · Undo" (`useRemove`). Ctrl+Z / Ctrl+Shift+Z undo and redo, Ctrl+S saves; Undo/Redo
buttons sit next to Save. Confirmations (`ask`) stay for things saved straight away (records,
invoices, tours).

## Status labels

One component, `Label` (solid colour, white text, fixed width so columns line up):

| Meaning | Tone |
|---|---|
| done / paid / on budget / matches / approved / closed | green |
| waiting / unpaid / open / differs / settling | orange |
| problem / overdue / over budget / disputed | red |
| in progress / partial / confirmed / under budget | blue |
| on tour / refund due | purple |
| inactive / cancelled / rejected | grey |
| not started / draft / no cost yet | light |

## Navigation

One menu entry per **section**; a section's pages are **view tabs** under the page title
(monday's board views), not more menu entries. Counts show what needs attention.

| Menu | Views (tabs) |
|---|---|
| Home | — (needs attention, today, starting soon, waiting to close) |
| Tours | List · Timeline · Day view |
| Incidents (open count) | — |
| Calculations | — |
| Clients | — |
| Catalog | Routes · Vendors · Prices |
| Finance (overdue count) | Profit · Invoices · Debts · Vendor payments |
| Settings (bottom) | General · Team · Import |

Sections are defined once in `components/SectionNav.tsx`; `PageHeader section="…"` shows the tabs.
The bell next to the workspace name lists errors and warnings across all tours.

## Notices (conflicts and attention)

Computed on the server (`/alerts`, `/tours/{id}/alerts`) as codes + parameters, worded in the
user's language (`alert_*` keys). Severity sets the colour: **error** (red, wrong now: a guide on
two tours at once, a client overdue), **warning** (orange, will go wrong: no hotel for a night,
passports expiring, no guide 7 days before), **info** (blue: open incidents, not closed yet).
They appear as bars at the top of a tour (with "Fix" → the right tab), on the day card they
concern, in the bell and on Home. Closed tours raise none. Money notices are for managers only.

## Itinerary builder

Routes and tours use one builder (`components/ItineraryBuilder.tsx`): day cards with slots
(hotel, lunch, dinner, services), a palette of hotels / meals / catalog services.
Drag a palette item onto a slot, drag a day's handle to reorder, duplicate or insert days,
"same hotel next night". Every slot is also a dropdown, and on phones you tap an item then the
slot (tap to place). A tour saves all days at once from a "Save changes / Discard" bar; dates
stay, content moves.

**Add new where you pick.** Every hotel/restaurant dropdown, the palette and the services picker
offer "+ Add new…" (managers): a short dialog creates it and puts it straight into the slot
(the day's city is pre-filled). Details are completed later in Catalog.

**Set menus.** A restaurant's set menus are its "meal" services with a dish list; each lunch and
dinner can pick one (it sets the price in costs and calculations, and staff see the dishes in
the day view). The same dish at lunch and dinner is shown in red on the day and raises a
notice; so does the same dish on two days running, and dishes served on many days are listed
in one line.

## Writing

Plain words, sentence case, no jargon ("Accept their amount", not "Reconcile variance").
Explain consequences before the button ("When approved: …"). Numbers carry their currency.
Every label exists in English and Georgian.
Words a newcomer knows: **supplier** (not vendor), **agency** (not workspace). Hints are visible
text under a field, not only a tooltip. Every page header has a one-line "what this page is for".

## Readable and accessible (WCAG 2.2 AA)

- **Text** 14px minimum for content you work with (12px only for captions and legends); 16px on
  the guide's phone page. Secondary text `slate-600`/`slate-500`, never `slate-300/400` for text or icons
  that matter (contrast at least 4.5:1 for text, 3:1 for icons and control borders).
- **Targets** at least 36px (40px controls, 32px `size="sm"`); icon-only buttons are 36–40px with a
  16–18px icon.
- **Never colour alone**: a coloured block also has an icon or a word (clash = red + ⚠ + "same
  place, same time"); colour charts get a legend.
- **Keyboard**: everything reachable with Tab, a visible focus ring (global `:focus-visible` in
  `index.css`), drag-and-drop also by keyboard (dnd-kit: Space, arrows, Space) with instructions read aloud.
- **Names**: icon buttons have `aria-label` saying what and which ("Remove: Lunch at Barbarestan");
  groups of options are `fieldset` + `legend`; an invalid entry gets `aria-invalid` and a red border.
- **Tooltips** (`components/Tooltip.tsx`): `Tooltip` on icon buttons and dense items (timeline
  blocks), shown on hover and keyboard focus, read by screen readers, Escape hides them. `InfoTip`
  (ⓘ) explains a term and also opens on tap for phones. A tooltip adds to visible text and never
  replaces it.
- **Times** are 24-hour text boxes (type 930 or 09:30, ↑/↓ = 15 minutes), not the browser's time
  picker (its AM/PM layout gets cut off).
- **Choices with consequences** are cards with one line on what happens ("A draft supplement invoice
  for the partner. You check it before sending.").

## First use and feedback

- **Get started** (Home): six steps in the order that makes the rest work — suppliers → prices →
  route → clients → first tour → team. Ticked from real data (`GET /setup`); hides when all are
  done or when closed (remembered per agency in the browser).
- **Empty states** say what the thing is and offer the next step as a button (`EmptyState` +
  `ButtonLink`). "Nothing exists yet" and "nothing matches your filter" are different messages;
  the second offers "Show all".
- **Saved**: every successful change shows a short toast, from one place (the mutation cache in
  `main.tsx`). Checks and previews opt out with `meta: { silent: true }`.
- **Confirm** every delete, reject, reopen, settle or "accept their amount" with `ask()`, saying
  what will happen. Closing a drawer with unsaved prices asks first.
- **Required** fields get a red asterisk automatically (a `Field` whose input is `required`).
  Compact one-row forms use `MiniField` captions, never placeholder-only labels.
- **Dead ends** get a way out: pick lists offer "+ Add new…" (clients, suppliers, guides, menus);
  a new supplier's drawer stays open after "Create" so its prices can be added at once; warnings
  link to where the fix is (missing exchange rate → Settings).
- **Loading** inside a tab or drawer shows a small spinner in place, never a blank area.

## Home widgets

Home is a grid of widgets (`components/widgets.tsx`), one card each. Every role starts from a
sensible default; "Customize" (drawer) switches widgets on/off, reorders them by dragging, and
sets half or full width. Saved per person and agency (`memberships.dashboard`, `GET/PUT/DELETE
/dashboard/layout`); `null` = the role default, "Reset to default" returns to it. Money widgets
are manager+. A widget with nothing to say renders nothing and leaves no gap. The grid fills the
screen: 1 column on phones, 2 from `lg`, 3 on very wide screens; "full" spans every column.
New widget = an entry in `WIDGETS` + `w_<id>` / `wd_<id>` labels in both languages.

## Kinds of cost (the agency's own) and tickets

Built-in kinds (hotel, meal, transport, guide, ticket, activity, tips, border, other) plus the agency's
own (`calc_style.kinds`: Flight, Train, Ferry, Visa, Insurance or anything), shared by all its
calculations and managed from "Kinds of cost…" (Items tab, or a day's "+ Add"). An own kind has a name,
icon, colour, how it's charged and **what it counts as** (its base kind: budgets, finance and bookings
see the base); a pricing step can mark it up on its own. A **travel** kind's lines are tickets: legs
(from → to, date, number, times), class, baggage, taxes added to every fare, and "issue tickets by"
(amber 14 days before, red after; shown in the trip). Children's / infants' fares are an own price in
"Who uses what". Tickets and own kinds are written into the price list's "Included".
On a tour made from the calculation: flights with a number go on the tour's first/last day (or the
leg's date), the budget line names the journey, and "Issue tickets: …" becomes a task due on the date.

**Formulas** (quantity or price of any line) can use the counts (days, group, persons…), the
calculation's inputs, and **cost totals**: `cost_total`, `cost_hotel`, `cost_meal`, `cost_<own kind>`,
what the group costs (lines that use them are priced after the others). A line can **come with**
another (in the price only when that one is). The agency keeps a **formula library**
(`calc_style.formulas`), opened under any formula box.

## Money in several currencies

Prices, costs and invoices keep their own currency (GEL hotel, USD guide, EUR invoice). Totals,
profit and reports are in the agency's currency (asked at sign-up) using the agency's **own** rates
("1 GEL = 0.37 USD"); "Use National Bank rate" (`app/nbg.py`, Bank of Georgia public API, cached 1 h)
only *fills* the boxes as a suggestion. A total that needs a missing rate is never shown as 0: show "—" plus
`RatesNeeded` (inline "1 X = [ ] base"), and the tour gets a red `rate_missing` alert.

## Frame (monday-style)

A white top bar across the page (`--color-app-bg`, white by choice): **the agency** top-left
(its letter, name, your role — the switcher; never the product name), a wide "Search for
anything…" pill in the middle (Ctrl+K), and on the right My tasks (count), the bell, invite (admins)
and the user’s avatar menu (language, settings, log out). The white menu sits under the bar; pages sit on
a panel with rounded corners and a thin border that scrolls inside (corners always show). Page headers: a big title, a one-line
subtitle, the main "New …" button on the right, underlined view tabs.

## Bookings and tasks

Each supplier on a tour is a booking (`app/bookings.py`): what is booked is worked out from the
itinerary and staff; the row keeps status, confirmation no., who books it (else Settings → Who does
what), book-by date and the payment plan (when / how / office or guide in cash). A change after a
confirmation shows "confirm again"; a booked supplier that left the itinerary shows "cancel it".
Tasks (`app/routers/tasks.py`) = booking tasks + payment tasks (worked out, never stored) + own tasks.


## Motion

Short and calm; motion shows where something came from, never decorates.

- **One easing, three lengths:** `--ease-out` (quick start, soft stop); 120 ms (fades), 200 ms (most), 280 ms (drawers). Nothing bounces or overshoots.
- **From where it belongs:** drawers slide from the side (`animate-drawer`), menus pop from their button (`animate-pop`), dialogs rise a little (`animate-dialog`), toasts rise from below (`animate-rise`), an opened section or a new tab's content reveals from its heading (`animate-reveal`), a new page fades up (`animate-page`).
- **Feedback:** buttons, icon buttons and chips press in slightly when clicked; a changed price flashes softly once (`animate-flash`, never on page open); "Saved" checks in (`animate-check`).
- **Off when asked:** all animation stops with the system "reduce motion" setting and in the easy-to-see view.
