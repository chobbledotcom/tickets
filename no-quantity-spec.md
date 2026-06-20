# Spec: "No-quantity" booking lines (`quantity = 0` sentinel), site-wide

> Standalone feature spec, extracted from the importer plan and hardened across
> six rounds of review. This feature is **independent** of the CSV importer and
> of PR #1335 — it can be built and shipped on its own; the importer is just one
> future consumer. Every file/function reference below was verified against the
> current codebase.

## 1. Concept

Introduce a first-class notion of a **booking line that exists but consumes
nothing**: a `listing_attendees` row with `quantity = 0`. It keeps the
attendee↔listing link (so the product stays structured/matched and the attendee
isn't an orphan) but counts toward **neither capacity nor ticket counts**,
carries **no income**, and is **hidden from operational, public, and marketing
surfaces** — while remaining **visible in admin record/detail views** with a
"no quantity" indicator.

Use cases this enables: placeholder / cancelled / quoted / "interested-in" lines
(owners get a manual checkbox; the importer will write them programmatically).

**Rule of thumb applied everywhere:** *operational, public, and capacity surfaces
exclude `quantity = 0`; admin record/detail views keep them.*

**Invariant:** a `quantity = 0` line always has `price_paid = 0`. Enforce on every
write path that can set `quantity = 0`.

## 2. Data model

- **No column change for quantity.** `listing_attendees.quantity` is
  `INTEGER NOT NULL DEFAULT 1` with **no CHECK constraint**, so `0` is already
  legal.
- `booked_quantity` (`SUM(quantity)`) and `income` (`SUM(price_paid)`) need **no
  change** — `SUM` already treats 0 correctly. Do not touch them.
- The **one** aggregate that must change is `tickets_count`, currently a plain
  `COUNT(*)`. See §3.

## 3. `tickets_count` → "count lines where `quantity > 0`"

`tickets_count` (the "Total Ticket Records" aggregate on `listings`) must stop
counting `quantity = 0` lines. It is computed in **five queries across four
files** that must all change consistently, or the recalculate/repair flow will
fight the triggers:

1. **The three `LISTING_AGGREGATE_TRIGGERS`** (INSERT/DELETE/UPDATE) in
   `src/shared/db/migrations/schema.ts`. Today each does
   `tickets_count = tickets_count ± 1`. Change to
   `± CASE WHEN <row>.quantity > 0 THEN 1 ELSE 0 END`. The UPDATE trigger already
   fires on `quantity` (it's in `LISTING_AGGREGATE_WRITE_COLUMNS`), so toggling a
   line 0↔n recomputes correctly via the OLD/NEW CASE deltas.
2. **Two separate queries in `src/shared/db/listings.ts`**, each with its own
   `tickets_count` — but they need **different** fragments, because one shares its
   `SELECT` with `income`:
   - `aggregateResetSql` (used by `resetListingAggregateFields`) builds a
     **separate** per-field subquery (`tickets_count = (SELECT COUNT(*) … WHERE
     listing_id = ?)`), independent of the `income`/`booked_quantity` fragments —
     so add `AND quantity > 0` to **its** `WHERE`.
   - `getListingAggregateRecalculation` computes `booked_quantity`,
     `tickets_count`, **and** `income` in **one** `SELECT … WHERE listing_id = ?`.
     Do **not** add `AND quantity > 0` to that shared `WHERE` — it would also drop
     a quantity-0 row's `price_paid` from the recalculated `income` (which must
     stay `SUM(price_paid)`) and silently normalize an invariant violation instead
     of surfacing it. Change only the count expression there to `COALESCE(SUM(CASE
     WHEN quantity > 0 THEN 1 ELSE 0 END), 0) AS tickets_count` — the `COALESCE` is
     required because `SUM` over zero rows returns `NULL` (unlike `COUNT(*)`'s
     `0`), so an empty listing would otherwise report bogus drift against a stored
     `0`; this matches the existing `income`/`booked_quantity` `COALESCE`. Leave
     `income`/`booked_quantity` summed over all rows.
   Missing the recalculation query makes the repair page report quantity-0 lines
   as drift and push owners to "fix" aggregates back to the wrong value.
3. **The full backfill in `src/shared/db/migrations/schema-sync.ts`**: the
   `tickets_count = COALESCE((SELECT COUNT(*) …), 0)` gains `AND quantity > 0`.
4. **The hold-delete restore in `src/shared/db/attendees/delete.ts`.**
   `deleteAttendee(id, { releaseBookings: false })` pre-computes per-listing
   contributions with `COUNT(*) AS tickets_count`, deletes the lines, then **adds
   the count back**. With a plain `COUNT(*)` it would add `1` back for a
   `quantity = 0` line the (now-fixed) delete trigger removed `0` for —
   permanently inflating `tickets_count`. Change its `COUNT(*) AS tickets_count`
   to `SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END)`. (`booked_quantity`/`income`
   there already use `SUM(quantity)`/`SUM(price_paid)` — leave them.)

**Anti-drift requirement:** the predicate (`quantity > 0`) must live in **one**
place — extract a constant (e.g. `TICKET_COUNTS_WHEN = "quantity > 0"`, or a tiny
helper that builds the `CASE`/`WHERE`/`SUM(CASE …)` fragments) and reference it
from every site (note `listings.ts` contributes two). This mirrors the existing shared
`LISTING_AGGREGATE_WRITE_COLUMNS`. Add a guard test (like the existing
"`LISTING_AGGREGATE_WRITE_COLUMNS` matches the trigger SQL" test) asserting the
shared predicate appears in every site, so a future edit can't silently diverge.
(Empty-set gotcha: every `SUM(CASE …)` count site — the recalc query and the
`delete.ts` pre-compute — must `COALESCE(…, 0)`, since `SUM` over zero rows is
`NULL`, not `0`.)

**Migration:** ship a migration that re-creates the triggers and recomputes
`tickets_count` for existing data (a no-op today, since no `quantity = 0` lines
exist yet). Update the listing-aggregates tests.

## 4. Owner UI — the "no quantity" checkbox (proxy for `quantity == 0`)

On the attendee edit form (`src/features/admin/attendee-form-model.ts` + its
template), each booking line gets a **"no quantity"** checkbox. Owners never see a
literal `0`.

- **Render:** a line read with `quantity = 0` renders with the box **checked** and
  its quantity input **hidden via CSS** — use the existing `hidden-in-form` mixin
  family in `src/ui/static/style.scss` (add a `hidden-when-checked` companion to
  the existing `reveal-when-checked` if absent). **No JavaScript** — pure
  checkbox-driven CSS.
- **Save:** box checked → store `quantity = 0` and **keep the line**; unchecked →
  store the entered quantity (`>= 1`). Round-trips both ways.
- **Clear `price_paid` when marking no-quantity** (same write), or forbid the box
  on a line with `price_paid > 0`. Income is `SUM(price_paid)`, so a paid line
  marked no-quantity would vanish from capacity/`tickets_count` yet keep
  contributing income. (Enforces the §1 invariant.)
- **Clear `checked_in` when marking no-quantity** (same write). The §6b
  `updateCheckedIn` guard only refuses *future* check-ins; a line already
  `checked_in = 1` keeps that flag when flipped to quantity-0, and the roster
  reads key off it with **no quantity predicate** — `filterAttendees`
  (`listings.tsx`) and `countCheckedInRows` (`detail-rows.tsx`, "ignoring
  quantity") — so the ghost stays in the "checked-in" filter and inflates
  row-level check-in progress. Clear the flag on the write (and in merge, §6b);
  excluding quantity-0 from those reads is a secondary defence, not a substitute.
- **Resolve `remaining_balance` when the last real line becomes no-quantity.** The
  public pay gate (§6a) refuses payment once an attendee has no `quantity > 0`
  line, but `attendees.remaining_balance` survives, so the admin balance page would
  still show an outstanding, unpayable amount/link (`remainingBalance > 0`) — a
  dead balance. When a save would leave an attendee with zero real lines, either
  block it or clear/zero `remaining_balance` (recording the prior value as audit
  metadata).
- **No auto-delete.** The save path must distinguish a deliberate `quantity = 0`
  line (box checked → keep) from a real removal (the line's explicit remove
  control → delete). Any existing logic that drops a line because its quantity is
  falsy/empty must be guarded so it only removes lines the owner actually removed.
  This applies to **all** booking lines once the checkbox exists.

## 5. Public-path guard (reject — do NOT coerce)

`quantity = 0` is **admin-only**. The public booking/checkout path must never
**persist** a quantity-0 line.

**Do not implement this by coercing submitted `0`s to the listing minimum.** The
public form deliberately renders `0` as the **"not selected"** option per listing,
and `parseQuantities` (`src/features/public/ticket-form.ts`) already drops entries
with `quantity <= 0`. So a `quantity_<id>=0` field means *"not in the cart"* —
coercing it to the minimum would book products the visitor left unselected
(especially on multi-listing checkouts).

The guard must keep treating public `0` as "not selected" while **rejecting any
persisted/selected zero-quantity line**, so a visitor can't end up with a
no-capacity "ghost" line. Keep this server-side, not just in the UI.

**Cover the JSON API too, not just the HTML form.** `POST /api/listings/:slug/book`
(`src/features/api/index.ts`) parses `body.quantity` with
`parsePositiveInt(...) ?? 1`, so a submitted `quantity: 0` currently becomes a
**one-ticket booking**. Put the rule below the form layer (at the shared
booking/checkout entry, or in each entry point) so a `0` is rejected or treated as
not-selected on the API route as well — otherwise API clients can still create
real bookings from `0`.

## 6. Reader/writer audit — site-wide

Sweep `listing_attendees` SQL across `src` and apply the rule. Verified surfaces:

### 6a. MUST exclude / refuse `quantity = 0`

- **Daily calendar** — `getDailyListingAttendeeDates` and
  `getDailyListingAttendeesByDate` (`listings.ts`), used by `admin/calendar.ts`:
  add `AND quantity > 0` to both.
- **`getAttendeesByListingIds`** (`listings.ts`) — **filter at the call sites, NOT
  in the helper.** It feeds (a) the ICS calendar feed `buildCalendarFeed` in
  `src/features/feeds.ts` (`GET /caldav/events.ics`) and (b) the admin calendar's
  standard-listing rows + CSV via `loadStandardListingAttendees` in
  `admin/calendar.ts` — both operational, exclude — **but it also feeds the admin
  group-detail roster in `src/features/admin/groups.ts`, which must keep
  `quantity = 0`.** Add an opt-in `quantity > 0` param the feed/calendar callers
  pass, or split off a dedicated active-only helper. Never filter the shared
  helper unconditionally. (This is the easiest thing to get wrong — it'll look
  like you should just add the predicate to the helper.)
- **Bulk email** (`src/shared/bulk-email-targets.ts`) — two queries:
  - Listing-scoped ("Active listing attendees" / "Attendees of X") via
    `getAttendeePiiBlobsForListings` (`attendees/queries.ts`): add
    `AND quantity > 0`.
  - The **`all`** audience via `getAllAttendeePiiBlobs()` bypasses the listing
    filter — restrict it to attendees with `EXISTS` a `quantity > 0` line, so a
    quantity-0-**only** attendee isn't emailed.
  - The **single-attendee** target (`/admin/emails?attendee=<token>`,
    `attendeeSpec` → `getAttendeePiiBlobForToken`) skips `listing_attendees`
    entirely, so an owner can compose to a quantity-0-only attendee through the
    bulk-email system. Decide explicitly: either include the attendee-token target
    in the real-line guard (no recipients / refuse when the attendee has no
    `quantity > 0` line), or classify this one-off admin send as **transactional**
    and out of the marketing rule — but note it still emits a `{{ ticket_url }}`
    that 404s for an all-ghost attendee.
- **Logistics / delivery runs** (`src/shared/db/logistics.ts`) — guard the read,
  the completion write, **and the assignment write**:
  - Read: `getAgentRunSheet` — exclude `quantity = 0` (a no-quantity line is not a
    drop-off/collection).
  - Completion: the mark-done action `setLegDone` (called from
    `src/features/admin/deliveries.ts`) scopes its update by
    `attendee_id`/`listing_id`/agent with **no quantity predicate**, so a
    quantity-0 line that still has an agent assigned could be marked done by a
    stale/crafted delivery form. Add the same `quantity > 0` guard there.
  - Assignment: the attendee edit/save path renders logistics selectors for every
    `deliveredBookedLines` entry (any `existingBooking`) and `parseLogisticsPlan`
    persists the agents/times — so a quantity-0 line would keep accepting
    assignments that then vanish from run sheets (scheduled work silently
    disappears). Clear/hide the logistics fields for a no-quantity line.
- **Ticket / check-in / scanner / wallet token flows** — `getAttendeesByTokens`
  (`attendees/queries.ts`) returns every line with no quantity filter and feeds:
  - the customer ticket page `/t/:tokens`,
  - the check-in flow `/checkin/:tokens` (`src/features/checkin.ts`),
  - the admin scanner (`src/features/admin/scanner.ts`),
  - the wallet pass routes `/wallet/:token.pkpass`, `/gwallet/:token`,
    `/v1/passes/:passType/:token` via `lookupSingleTokenPassData`
    (`src/features/tickets/token-utils.ts`),
  - the post-payment success page `/payment/success?tokens=`
    (`renderSuccessFromTokens`, `src/features/api/webhooks.ts`) — builds the
    customer ticket link and thank-you URL from the resolved tokens.

  Quantity-0 lines must not render as a ticket, not produce a wallet pass, and not
  be checkable. Filter them from the ticket/wallet render and the check-in
  eligibility set, and **guard the check-in action**: `updateCheckedIn`
  (`attendees/update.ts`) has no quantity guard — make it refuse `quantity = 0`,
  mirroring the existing refunded-ticket guard ("Cannot check in refunded
  tickets") in `checkin.ts`. Because `getAttendeesByTokens` has other consumers
  (webhook/merge/group flows), filter at these call sites + the action, **not** in
  the shared helper. For a mixed attendee, any "primary line" selection must
  prefer a `quantity > 0` line, not a lower-id ghost. Consequences of filtering
  (rather than changing the shared helper), plus related token-trusting pages:
  - **An empty filtered set must 404, not render an empty surface.** A
    quantity-0-*only* token still passes `lookupAttendees`, so `handleTicketView`
    could return a 200 page with no cards and `handleTicketSvg` (`/t/:token/svg`)
    could emit a QR without resolving entries. Treat an empty filtered set as
    not-found on both `/t/:tokens` and `/t/:token/svg`.
  - **The post-payment success page must filter ghosts and reject an all-ghost
    set.** `renderSuccessFromTokens` verifies the URL tokens via
    `getAttendeesByTokens`, then builds the ticket link `/t/:tokens` and the
    single-listing thank-you URL from **every** returned booking's `listing_id`.
    A quantity-0-*only* (or crafted/stale) token would render a "paid" page
    linking to a `/t/:token` that now 404s; and for a **mixed** attendee the
    ghost line inflates `uniqueListingIds`, silently suppressing the real
    single-listing thank-you redirect. Exclude quantity-0 bookings when
    collecting listing IDs, and treat a token resolving only to quantity-0 lines
    as an invalid callback (the same `paymentErrorResponse` the existing
    `verifiedTokens.length === 0` path returns).
  - **The reservation success page must validate its tokens too.** `GET
    /ticket/reserved?tokens=` (`handleReservedGet`,
    `src/features/public/ticket-routes.ts`) never calls `getAttendeesByTokens` —
    it builds a `/t/:tokens` "booking confirmed" CTA straight from the query
    string. A stale/crafted quantity-0-only token renders a success page linking
    to a ticket URL that now 404s. Resolve and filter the tokens here too (as
    `/payment/success` does) and treat an all-ghost/empty set as not-found, so the
    CTA only appears when a real line exists.
  - **Signed attachment downloads need the guard too.** `GET /attachment/:id`
    verifies the signed attendee/listing pair via `getAttendeeRaw` then calls
    `incrementAttachmentDownloads` — neither has a quantity predicate, so a
    customer holding a still-valid URL for a line later marked no-quantity could
    keep downloading the protected listing attachment. Add `quantity > 0` to the
    download authorization (and the counter).
- **Scanner manual list (separate preload).** Besides token resolution, the
  scanner page `GET /admin/listing/:id/scanner` (`src/features/admin/scanner.ts`)
  calls `getAttendeesRaw(listing.id)` and builds the manual check-in candidate
  list filtering only `!checked_in && !refunded` — so a quantity-0 row appears as
  a manual candidate and then errors/behaves oddly once the `updateCheckedIn`
  guard rejects it. Exclude `quantity = 0` from this manual list too.
- **Public balance / pay flow** (`src/features/public/balance.ts` +
  `src/shared/db/attendees/balance.ts`) — three parts:
  - A `Balance` is publicly payable only when the attendee has ≥1 `quantity > 0`
    line (the public pay route already gates on `status.is_reservation`; add the
    real-line condition), so a quantity-0-only attendee can't be paid into a
    ghost.
  - **Settlement must target a real line.** `settleAttendeeBalance` folds payment
    into `id = (SELECT MIN(id) FROM listing_attendees WHERE attendee_id = ?)` with
    no quantity predicate. Add `AND quantity > 0` so even a *mixed* attendee folds
    payment onto the lowest-id **real** line, never a lower-id ghost. It then runs
    a *separate* `SELECT listing_id … ORDER BY id LIMIT 1` to pick the listing it
    logs the payment activity against (and returns) — add `AND quantity > 0` there
    too, or the activity/returned listing is still the ghost. **And make the
    finalize conditional on that fold hitting a real line.** Today the settle
    verdict is the *last* statement — the `remaining_balance = 0` clear — which is
    independent of the price_paid fold. If the last real line is marked no-quantity
    after checkout but before settlement, the (now `quantity > 0`-guarded) fold
    affects **zero** rows while the clear still finalizes, paying off the balance
    with **no income recorded on any line**. Abort when the fold touches no row
    (guard the clear on `EXISTS` a `quantity > 0` line, or treat the fold's
    `rowsAffected = 0` as the mismatch verdict) — don't rely on the §4
    balance-clear or the pay-page gate alone to close this race.
  - **The pay page itself must pick a real line.** `/pay/:token` renders
    `getAttendeeOrderSummary()`, which selects every `listing_attendees` row
    ordered by id, and the POST uses `summary.lines[0]?.listingId` as the checkout
    item. For a mixed attendee whose lower-id line is quantity-0, the page would
    show the ghost product and tag the checkout/activity to the ghost listing.
    Exclude quantity-0 from the order summary and the checkout-line selection so
    the displayed product and the tagged listing are the real one.

### 6b. Writer side

- **`updateCheckedIn`** — add the `quantity > 0` guard (refuse), as above.
- **`setLegDone`** — add the `quantity > 0` guard, as above.
- The edit-form save enforces the **`price_paid = 0` when `quantity = 0`**
  invariant (§4).
- **Merge writer.** `applyAttendeeMerge` (`src/shared/merge/attendee-merge.ts`)
  copies a source `ListingAttendeeRow`'s `quantity` and `price_paid` **verbatim**
  and can delete a target's real line while inserting a source `quantity = 0`
  line, without touching `attendees.remaining_balance`. So merge can create a
  quantity-0 line with `price_paid > 0` (violating the §1 invariant) and leave an
  attendee with no real line but a surviving, now-unpayable `remaining_balance`
  (the §4 dead-balance case via merge, not the checkbox). Apply the same rules in
  the merge writer: force `price_paid = 0` on copied quantity-0 lines, clear
  `checked_in` on any line it makes quantity-0, and block/clear
  `remaining_balance` when the merged result has no `quantity > 0` line.

### 6c. INTENTIONALLY UNCHANGED (call out so nobody "fixes" them)

- **Capacity** — `attendees/capacity.ts` and `booked_quantity` use
  `SUM(quantity)`; 0 contributes 0. Correct as-is.
- **Orphan auto-purge** — `src/shared/db/orphan-attendees.ts` (`ORPHAN_IDS`) keys
  off row existence; a `quantity = 0` line deliberately keeps the attendee
  non-orphan. That's the point of writing the line.
- **Built-site assignment release** — *not* handled here, deliberately. Flipping
  an `assign_built_site` line to no-quantity leaves the
  `built_sites.assigned_attendee_id`/`assigned_listing_id` assignment in place
  (the site stays `assignable = 0`, out of `getAssignableBuiltSites`) and renewal
  access tied to the line. But this is **pre-existing built-sites behaviour, not a
  no-quantity divergence**: no release/unassign path exists for **any**
  booking-ending action today — deleting or refunding the attendee doesn't release
  the site either (no FK on `assigned_attendee_id`, no unassign helper). So
  no-quantity matches current behaviour; site release belongs to the built-sites
  feature and must cover delete/refund/no-quantity uniformly, not be bolted onto
  the no-quantity save path alone.
- **Edit-form custom-question loading + answer save** — must **keep** quantity-0
  lines. `loadQuestionsForExisting` (`attendee-form-routes.ts`) derives its
  `listingIds` from **all** of the attendee's bookings (`existing.map`, no
  quantity predicate), and the admin question fields render without
  `data-listing-ids`, so they are **not** quantity-hidden (the `quantity_<id> > 0`
  visibility in `custom-question-visibility.ts` is a *public-form* behaviour
  only). Because the save replaces the attendee's whole answer set from the
  *rendered* form (`saveAttendeeAnswers`), do **not** add a `quantity > 0` filter
  to the edit-form question loading or answer save: doing so would stop rendering
  a no-quantity line's questions and silently drop their answers on the first edit
  (e.g. a cancelled/quoted import stored entirely as quantity-0). This is the one
  place the audit's "add `quantity > 0`" reflex is **wrong** — call it out.
- **Admin per-listing attendee roster / check-in *list*, group-detail roster,
  per-attendee detail, edit/merge views** — these reads **keep** `quantity = 0`
  rows (show the "no quantity" indicator); they're real records (merge as a
  *write* path is a different matter — see §6b). **But several
  per-row *actions* must be guarded even though the row stays visible** — keeping
  the record is not the same as keeping its operational/financial/customer-facing
  buttons:
  - **Check-in** — the inline `CheckinButton`
    (`src/ui/templates/attendee-table.tsx`) → `handleAttendeeCheckin`
    (`src/features/admin/attendees.ts`) → `updateCheckedIn` must be
    hidden/disabled for quantity-0 rows (render the indicator instead), since
    `updateCheckedIn` now refuses them.
  - **Refunds (single + bulk).** `isRefundable`
    (`src/ui/templates/admin/attendee-form.tsx`) and `getRefundable`
    (`src/features/admin/attendee-refunds.ts`) gate only on
    `payment_id`/`refunded`, and `markRefunded(..., listingId)` refunds against the
    invoking listing page. A mixed attendee (real paid line + a no-quantity
    interested/cancelled line on another listing) would expose refund / refund-all
    from the **ghost** listing and refund the shared attendee-level payment. Add
    the quantity guard to the single and bulk refund UI and actions (and target
    the real line).
  - **Refresh-payment route.** `POST /admin/attendees/:id/refresh-payment`
    (`handleRefreshPayment` → `loadRefreshContext`,
    `src/features/admin/attendees-edit.ts`) picks the attendee's first booking
    row via `ORDER BY start_at, listing_id LIMIT 1` (no quantity predicate) and,
    when the provider reports the payment refunded, calls
    `markRefunded(attendeeId, listing.id)` against it. For a mixed attendee whose
    first row is quantity-0, this marks the **ghost** `(attendee_id, listing_id)`
    row refunded while the real paid line stays active. Pick a `quantity > 0` row
    as the refund target and the logged-activity listing, mirroring the
    manual-refund guard above.
  - **Re-send notification.** The edit-page `AttendeeActions`
    (`src/ui/templates/admin/attendee-form.tsx`) "Re-send notification" →
    `handleResendNotification` (`src/features/admin/attendees.ts`) calls
    `logAndNotifyRegistration([{ attendee, listing }])`, emailing the customer a
    confirmation with a ticket URL/SVG. For a quantity-0 row this sends a
    customer-facing ticket for a non-booking — hide/refuse it, or retarget to a
    real line.
  - **Customer ticket URL display / export.** The row stays visible, but the
    ticket link in `AttendeeDetail`, the attendee table's `ticket` column
    (`src/ui/templates/attendee-table.tsx`), and the attendees CSV `ticket_url`
    column (`src/features/admin/attendees-csv.ts`, built unconditionally as
    `…/t/:ticket_token`) are **dead public URLs** once `/t` 404s for an all-ghost
    token — staff can still click or copy them to a customer. When the attendee
    has no `quantity > 0` line, show the "no quantity" indicator / plain token
    text instead of a ticket link, and omit or blank the CSV `ticket_url`.

> Treat 6a as the known set, not a guarantee of completeness — re-run
> `rg "listing_attendees" src` during implementation and apply the rule to
> anything new.

## 7. Tests (must cover)

- Aggregates via live triggers: inserting a `quantity = 0` line leaves
  `tickets_count` unchanged (a `quantity-n` line +1); changing a line 0↔n updates
  `tickets_count` and `booked_quantity` correctly (UPDATE trigger) with **no
  recalc drift** (`resetListingAggregateFields`/drift display agree); deleting a
  `quantity = 0` line leaves `tickets_count` unchanged; deleting an attendee whose
  only line is `quantity = 0` with `releaseBookings: false` does **not** inflate
  `tickets_count`.
- The shared-predicate guard test (predicate present at every site, incl. both
  `listings.ts` queries — reset and recalculation).
- Checkbox round-trip: stored `0` → box checked; save checked → re-stores `0` and
  keeps the line; uncheck + quantity → stores it; explicit remove still deletes;
  marking no-quantity clears/blocks `price_paid`.
- Public path: a selected/persisted 0 is rejected, **and** a normal
  `quantity_<id>=0` ("not selected") field is still treated as not-in-cart (not
  coerced to a booking) — including a multi-listing checkout where only some
  listings are selected.
- `quantity = 0` lines are absent from: daily calendar, ICS feed, standard-listing
  calendar + CSV, bulk email (listing, `all`, **and** single-attendee target),
  logistics run sheet,
  `/t/:tokens`, `/checkin/:tokens`, scanner, wallet passes, the `/pay/:token`
  order summary, and signed attachment downloads (`/attachment/:id`) — **while
  still present** in the per-listing roster and the group-detail roster (with no
  check-in button) and per-attendee detail.
- A quantity-0-*only* token returns **not found** on `/t/:tokens` and
  `/t/:token/svg` (no empty page, no QR), an **invalid-callback** page on
  `/payment/success?tokens=`, and a not-found / no-CTA result on the reservation
  success page `/ticket/reserved?tokens=` (no "booking confirmed" page linking to
  a dead ticket); a mixed attendee's payment-success thank-you URL still resolves
  to the real single listing.
- Logistics: mark-done (`setLegDone`) refuses a quantity-0 line even with an agent
  assigned; the edit/save path doesn't render or persist logistics assignments for
  a no-quantity line.
- Check-in state: marking a checked-in line no-quantity (via the save **and** via
  merge) clears `checked_in`, so the row drops out of the "checked-in" filter
  (`filterAttendees`) and `countCheckedInRows`; `updateCheckedIn` still refuses a
  fresh check-in of a quantity-0 line.
- Edit-form answers: a quantity-0-only attendee's custom-question answers still
  render on the admin edit form and survive a save (no `quantity > 0` filter on
  the question loading drops them).
- Balance: a quantity-0-only attendee's balance isn't publicly payable; for a
  mixed attendee the pay-page product/checkout line, the settlement, **and the
  logged-activity listing** all land on the real line; marking the last real line
  no-quantity clears/blocks the now-unpayable `remaining_balance` — **via the
  merge writer as well as the checkbox save** (a merge that removes the last real
  line clears the balance and never copies a `price_paid > 0` quantity-0 line).
- Admin per-row action guards: a quantity-0 row shows no check-in button, no
  refund / refund-all control, no working re-send-notification (or it targets
  a real line), and no live customer ticket URL (the detail/table link and the
  CSV `ticket_url` show the indicator / blank for an all-ghost record); the
  refresh-payment route refunds the real line, never a ghost-first row; the
  scanner manual list omits quantity-0 candidates.
- Public API `POST /api/listings/:slug/book` rejects/ignores `quantity: 0` (no
  one-ticket booking created).
- Capacity unaffected (`SUM(quantity)`); orphan purge keeps a quantity-0 attendee.

## 8. Build order & independence

This feature stands alone — it does **not** depend on the CSV importer or on PRs
#1335/#1332/#1333, and should land first. Recommended order:

1. `tickets_count` shared predicate + migration + guard test.
2. Edit-form "no quantity" checkbox + save path (incl. `price_paid`).
3. The reader/writer audit surfaces (§6a/§6b).
4. Public guard (§5).

Each is independently testable.

### Out of scope (related, but NOT this feature)

These came up alongside the sentinel but belong to the importer / staff-only
questions work, not the no-quantity feature:

- QR direct-checkout gating (`listingSupportsDirectCheckout`, `src/shared/qr.ts`)
  filtering out *staff-only questions* — that's the staff-only-question flag, a
  separate change.
- Imported visit history using the source booking date instead of `nowMs()`
  (clamped to `MAX(existing.last_activity, source)` so it never moves an active
  contact backwards into prune range) — that's the importer's visit-recording
  writer.
