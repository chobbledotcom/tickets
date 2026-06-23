# Servicing Events — Test Inventory

A named list of tests to write for the servicing-events feature, each with what
it must prove. Built from `servicing.md` so every behaviour and every
review/self-review risk has an explicit test before implementation begins.

Follow the AGENTS.md test standards: assert exact observable outcomes (HTTP
status, persisted rows, rendered content), cover negative/idempotency paths, and
give any branch a **direct in-process unit/integration test** rather than relying
on incidental e2e coverage (e2e coverage is non-deterministic). Level tags below:
**[U]** unit (pure functions, no DB), **[I]** integration (DB + helpers), **[E]**
e2e (`TestBrowser`).

**Rule:** every **[E]** behaviour must have a backing **[U]** or **[I]** test that
exercises the same branch in-process — the e2e is the user-visible proof, the
unit/integration test is what actually holds the coverage deterministically.

---

## 0. Unit tests (pure functions, no DB)

The small, branch-heavy logic the rest of the feature is built from — fast,
deterministic, table-driven where possible:

- **`kind guard helper classifies rows` [U]** — the `isServicing` / kind
  predicate returns true only for `kind='servicing'`; table-driven over
  `'attendee'`, `'servicing'`, and any unknown value (unknown ⇒ not servicing).
- **`kind-aware ref link routing` [U]** — the pure link builder returns
  `/admin/servicing/:id` for a servicing row and `/admin/attendees/:id` for a
  normal one; this is the function the activity log and calendar both call.
- **`servicing field schema omits contact/payment fields` [U]** — the servicing
  `Field[]` builder includes `name` + the booking grid and **excludes** email,
  phone, address, special_instructions, status, and balance (assert exact field
  names, not just a count).
- **`servicing field schema marks hidden-from-public as locked` [U]** — the
  hidden indicator field is present, checked, and disabled/non-editable.
- **`parse servicing form maps to a kind='servicing' create input` [U]** — the
  form parser produces an input carrying `kind='servicing'`, the name, the booked
  lines, and empty contact fields.
- **`servicing form validation requires a name` [U]** — `validateAttendeeBlock`
  (reused) returns the name-required error for a blank name and passes with a
  name and no email (proves name-only is valid).
- **`buildPiiBlob with name only produces an all-empty-but-name blob` [U]** — the
  encoded blob has the name in `n` and empty strings for `e/p/a/s` (and the
  kept-token in `t`).
- **`capacity overlap predicate is half-open` [U]** — `overlapsDay` /
  `expandDailyRange` include `start` and exclude `start+duration`; boundary cases
  (single day, adjacent ranges) table-driven.
- **`capacity-checked insert builds the WHERE guard` [U]** —
  `buildCapacityCheckedInsert` includes the capacity condition unless
  `allowOverbook`, in which case it is dropped (mutation-resistant: flipping the
  flag changes the SQL).
- **`servicing skips order/status/balance resolution` [U]** — the pure helpers
  that compute status/balance notices are not applied for a servicing input (no
  default status coerced, no balance notice produced).
- **`demo override replaces a servicing name with a servicing reason` [U]** —
  with `SERVICING_DEMO_FIELDS`, `applyDemoOverrides` sets `name` from
  `DEMO_SERVICING_NAMES`, never a `DEMO_NAMES` person (see §13).
- **`DEMO_SERVICING_NAMES is non-empty and distinct` [U]** — no duplicates,
  parity count with `DEMO_NAMES`.

---

## 1. Migration & schema

- **`kind column defaults existing attendees to 'attendee'` [I]** — after the
  migration runs on a DB with pre-existing attendee rows, every existing row has
  `kind = 'attendee'`; no row is left null.
- **`kind index is created by the migration` [I]** — `idx_attendees_kind` exists
  after migrate (guards the `requires.indexes` omission Codex flagged; a missing
  `indexes` entry must fail this test).
- **`migration is registered and runs on an existing database` [I]** — applying
  the full `MIGRATIONS` list to a schema without `kind` ends with the column
  present (guards the manual-registration gap; fails if the file isn't appended
  to `MIGRATIONS`).
- **`backup then restore round-trips the kind column` [I]** — a servicing event
  survives a backup/restore cycle with `kind='servicing'` intact.
- **`schema and migration stay in sync` [U]** — the schema-sync assertion passes
  with `kind` + index declared in `schema.ts`.

## 2. Capacity blocking (the headline behaviour)

- **`servicing hold reduces availability for its date range` [I]** — after a
  servicing event books qty N on a listing/date, `checkListingAvailability`
  reports N fewer spots for that date.
- **`a customer booking is rejected once servicing fills the listing` [I]** —
  with `max_attendees = M` and a servicing hold of M, a subsequent customer
  booking for that date fails the capacity check (metamorphic: customer alone
  would have fit).
- **`servicing only blocks overlapping days` [I]** — a multi-day servicing hold
  reduces availability for days inside `[start, start+duration)` and leaves
  adjacent days untouched.
- **`deleting a servicing event restores capacity` [I]** — availability returns
  to its pre-hold value after the servicing event is deleted (idempotency of the
  capacity accounting).
- **`servicing consumes group-level capacity` [I]** — for a listing in a group
  with a group cap, a servicing hold counts against `groups.max_attendees` for
  the day (confirms reuse of the group path is intended).
- **`servicing on a standard listing consumes cumulative capacity` [I]** — a
  date-less standard listing's remaining count drops by the held quantity.
- **`servicing may overbook when allowOverbook is set` [I]** — an operator can
  hold capacity beyond `max_attendees` (e.g. close a day) without the insert
  being rejected.

## 3. Creation

- **`creating a servicing event persists name, bookings and kind` [I]** — the
  attendee row has `kind='servicing'`, the chosen name, and one
  `listing_attendees` row per booked listing/date with the right quantity.
- **`a servicing event still gets a ticket token` [I]** — `ticket_token_index`
  is populated (tokens are kept), and the atomic create/cleanup still resolves
  the new attendee (guards against regressing the token-index subquery).
- **`creating a servicing event records no contact activity` [I]** —
  `recordVisit`/`recordBooking` are not invoked and no `contact_preferences` row
  is written (servicing has no contact identity).
- **`servicing event stores empty contact fields` [I]** — email/phone/address/
  special_instructions decrypt to empty; only name is set in the PII blob.
- **`servicing create is all-or-nothing across multiple bookings` [I]** — if one
  booking can't be created the whole create rolls back (no half-saved hold).

## 4. Editing

- **`editing a servicing event preserves its token` [I]** — the existing
  `ticket_token` is unchanged after an edit (read-and-reencrypt path).
- **`editing updates name and bookings` [I]** — changed name and quantities
  persist; removed listings drop their `listing_attendees` rows.
- **`editing a servicing event cannot change its kind or unhide it` [I]** — a
  submission that tries to set `kind='attendee'` (or a "hidden" toggle) is
  ignored; the row stays `kind='servicing'`.

## 5. Hidden from public site

- **`public ticket page 404s for a servicing token` [E]** — `GET /ticket/:token`
  for a servicing event's token returns 404 (the token resolves internally but
  the public path filters `kind='attendee'`).
- **`wallet pass lookup 404s for a servicing token` [I]** — Apple/Google wallet
  pass build returns not-found for a servicing token.
- **`token bulk-email lookup skips servicing` [I]** —
  `getAttendeePiiBlobForToken` returns null for a servicing token.
- **`servicing form shows hidden state as locked` [E]** — the servicing
  create/edit page shows a checked, disabled "hidden from public site" indicator
  with no enabled control to change it.

## 6. No ticket / QR interface

- **`servicing edit page renders no ticket/QR/wallet panel` [E]** — the servicing
  edit page omits the QR image, ticket link, and wallet buttons that the attendee
  edit page renders.
- **`servicing create form omits contact and payment fields` [E]** — no email,
  phone, address, special-instructions, status, or balance inputs are present.

## 7. Exclusion from customer surfaces

- **`attendees browser excludes servicing` [I]** — `getAttendeesPage` with the
  attendee kind returns no servicing rows; the servicing reader returns only
  servicing rows.
- **`dashboard "newest attendees" excludes servicing` [I]** —
  `getNewestAttendeesRaw` omits servicing rows.
- **`bulk email targets exclude servicing` [I]** — `getAllAttendeePiiBlobs` /
  `getAttendeePiiBlobsForListings` resolve no servicing recipients.
- **`per-listing attendee table excludes servicing` [I]** —
  `getListingWithAttendeesRaw` (via `withDecryptedAttendees`) returns no
  servicing rows for the listing detail page.
- **`CSV export excludes servicing` [E]** — exporting a listing's attendees does
  not include the servicing hold's row.
- **`refund-all and check-in counts exclude servicing` [I]** — bulk refund and
  check-in operations neither act on nor count servicing rows.
- **`attendee merge candidate list excludes servicing` [I]** — servicing events
  never appear as a merge source or target option.

## 8. Calendar, groups & feeds

- **`servicing events appear on the admin calendar` [E]** — a servicing hold is
  rendered on the calendar for its date (operator decision: shown, not hidden).
- **`calendar links a servicing event to /admin/servicing/:id` [E]** — the
  calendar cell for a servicing event links to the servicing route, not
  `/admin/attendees/:id`.
- **`servicing events are visually distinct on the calendar` [E]** — the
  servicing entry is marked/styled so it doesn't read as a customer.
- **`groups page handles servicing per the chosen rule` [I]** — confirms the
  decided show/hide behaviour for `getAttendeesByListingIds` on the groups page.
- **`CalDAV feed excludes servicing events` [I]** — the syndicated feed
  (external clients) contains no servicing VEVENT, so an admin URL/"Boiler
  Service" hold isn't leaked.

## 9. Single-record route guards

- **`/admin/attendees/:id 404s for a servicing id` [E]** — the customer edit page
  rejects a servicing id (copied URL / activity-log link can't open it).
- **`listing-scoped attendee actions 404 for a servicing id` [E]** —
  `/admin/listing/:lid/attendee/:aid/{delete,resend-notification,checkin}` reject
  a servicing id (guards `loadAttendeeForListing`/`getListingWithAttendeeRaw`).
- **`admin balance page 404s for a servicing id` [E]** —
  `/admin/attendees/:id/balance` rejects a servicing id (guards
  `getAttendeeBalanceState`).
- **`/admin/servicing/:id 404s for a normal attendee id` [E]** — the servicing
  pages load only `kind='servicing'` rows.
- **`merge POST is rejected when either id is servicing` [I]** —
  `applyAttendeeMerge` / its validator refuses a hand-crafted merge involving a
  servicing event (guarded at the action, not just the dropdown).

## 10. Listing aggregates

- **`booked_quantity includes servicing holds` [I]** — the listing's
  `booked_quantity` counts the servicing quantity (this is what blocks capacity).
- **`tickets_count excludes servicing holds` [I]** — "tickets sold" does not
  count servicing rows.
- **`income is unaffected by servicing holds` [I]** — servicing `price_paid = 0`
  contributes nothing to `income`.
- **`aggregate recompute matches the triggers` [I]** — running
  `getListingAggregateRecalculation` / `resetListingAggregateFields` after holds
  exist yields the same split (booked_quantity counts servicing, tickets_count
  doesn't); a recalc never re-introduces servicing into tickets_count.

## 11. Custom questions

- **`servicing create renders questions for the selected listings` [E/I]** — a
  create-mode loader keyed by listing ids (no attendee id) returns the listings'
  questions for the form.
- **`answers entered at creation are saved against the new servicing id` [I]** —
  after create, `attendee_answers` rows exist for the new id (guards the
  `applyCreate`-doesn't-save gap).
- **`editing a servicing event loads and saves its answers` [I]** — existing
  answers render and changes persist on edit.

## 12. Activity log

- **`activity-log link for a servicing entry points to /admin/servicing/:id` [I/E]**
  — a logged servicing attendee_id renders a link to the servicing route.
- **`activity-log link for a normal attendee still points to /admin/attendees/:id`
  [I/E]** — the customer routing is unchanged for non-servicing rows.

## 13. Demo mode

Covered by the two demo unit tests in §0 (`demo override replaces a servicing
name with a servicing reason`, `DEMO_SERVICING_NAMES is non-empty and distinct`).
Listed there because they are pure-function tests; this section is the index
entry so the demo surface isn't lost in the cross-check.

## 14. Validation & negative paths

- **`servicing create requires a name` [I]** — a blank name is rejected with the
  name-required error (reuses `validateAttendeeBlock`).
- **`servicing create requires at least one booked listing` [I]** — zero
  bookings is rejected (`NO_LINES_ERROR`).
- **`servicing create rejects negative quantities` [I]** — a negative quantity is
  rejected, never stored (would skew capacity sums).
- **`servicing create rejects duplicate listing/date slots` [I]** — two bookings
  for the same listing+date in one submission are rejected (unique-index guard).

## 15. Deletion & orphan purge

- **`deleting a servicing event removes it and its dependent rows` [I]** —
  `deleteAttendee` clears the attendee, its `listing_attendees`, and
  `attendee_answers`; capacity is restored (see §2).
- **`orphan purge sweeps a servicing event with no bookings` [I]** — a servicing
  event whose only listing was deleted is removed by `purgeOrphanedAttendees`
  past the cutoff (parity with attendee orphan handling).

---

## Coverage cross-check

Each `servicing.md` risk maps to at least one test above:

| Plan risk | Test section |
| --- | --- |
| Migration `indexes` omission | §1 |
| Migration not registered | §1 |
| Token-index subquery on create | §3 |
| Hidden-from-public (token paths) | §5 |
| Aggregate triggers **and** recompute | §10 |
| Single-record guard (`getAttendee`) | §9 |
| Direct loaders (`getListingWithAttendeeRaw`, balance) | §9 |
| Listing attendee loaders (`getListingWithAttendeesRaw`) | §7 |
| Calendar/groups/feed (`getAttendeesByListingIds`) | §8 |
| Activity-log kind-aware links | §12 |
| Create-mode questions | §11 |
| Merge guarded at the action | §9 |
| Demo-mode name rewrite | §13 |
| Orphan purge / delete parity | §15 |
