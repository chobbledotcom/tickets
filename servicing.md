# Servicing Events — Planning Doc

## Goal

Let an operator block out **quantities of a listing for specific times** by
creating "servicing events" — e.g. a boiler service, a deep clean, a staff
hold, a maintenance window, equipment out for repair. These consume capacity
exactly like a real booking, so the affected quantity becomes unavailable to
customers for the chosen dates/times, but they are **not** customers: no QR
code, no tickets, no email/phone/address, no contact history, no payment.

We want this to be **generic and flexible** — one mechanism that covers many
"hold some capacity for a reason" situations, not a one-off "boiler service"
feature.

## Core idea

A servicing event is just an `attendees` row + its `listing_attendees`
booking rows, distinguished by a new discriminator column. Because capacity is
already computed by summing `listing_attendees.quantity` per day (see
`src/shared/db/attendees/capacity.ts` and the `booked_quantity` triggers in
`src/shared/db/migrations/schema.ts:878+`), a servicing booking **automatically
makes that quantity unavailable** for its date range with no new capacity code.
The booking rows do all the work; the discriminator only changes how the row is
*presented and handled* (no token, no contact, its own pages).

This reuse is the whole point: we get per-day capacity, multi-day ranges, group
caps, the overlap index, and atomic create/edit for free.

## Why this fits the existing model

The attendee record already supports a "name only, nothing else" shape:

- PII lives encrypted in `attendees.pii_blob` as `{n,e,p,a,s,pi,t}` (name,
  email, phone, address, special_instructions, payment_id, ticket_token) —
  `src/shared/db/attendees/pii.ts`. A servicing event sets only `n` (name) and
  leaves the rest empty.
- `ticket_token_index` is nullable. SQLite/libsql treats `NULL` as distinct in
  a UNIQUE index, so **many** servicing rows can each have a `NULL`
  `ticket_token_index`. A row with no token is automatically invisible to every
  token-based path (`/ticket/:token`, wallet passes, token bulk-email lookup) —
  see `getAttendeesByTokens` / `getAttendeePiiBlobForToken` in
  `src/shared/db/attendees/queries.ts`, which match on `ticket_token_index IN
  (...)` and never match `NULL`.
- Custom questions attach to *listings* and answers to *attendees*
  (`attendee_answers`), so a servicing event can answer custom questions with no
  schema change — `src/shared/db/questions.ts`.

So most of the "no token / no contact" behaviour falls out for free; the work is
adding the discriminator, giving servicing its own create/edit/list pages, and
filtering servicing rows out of the customer-facing attendee surfaces.

---

## Database

### New column: a generic discriminator

Add to the `attendees` table (`src/shared/db/migrations/schema.ts:267`):

```
["kind", "TEXT NOT NULL DEFAULT 'attendee'"]
```

- `'attendee'` — a normal customer (default; every existing row migrates to
  this with no backfill needed).
- `'servicing'` — a capacity hold / servicing event.

`kind` is a generic discriminator, not a fixed "servicing" boolean, so future
non-customer holds (`'staff'`, `'maintenance'`, …) can be added without another
migration. Keep the *specific* reason ("Annual boiler service", "Deep clean") in
the existing `pii_blob` **name** field — that is the per-event free text, while
`kind` is the coarse category. This keeps the "flexible / applies to lots of
situations" requirement: `kind` groups behaviour, `name` describes the instance.

Add an index so we can cheaply filter/exclude by kind and so the attendees
browser can scope to one kind:

```
{ columns: ["kind"], name: "idx_attendees_kind" }
```

### Migration

New file `src/shared/db/migrations/2026-06-22_attendee_kind.ts`, following the
`schemaMigration` pattern (see `2026-06-20_answer_active.ts`):

```ts
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_attendee_kind",
  "Add a kind discriminator to attendees so capacity-only 'servicing' holds " +
    "(boiler service, cleaning, staff holds) can block listing quantity for a " +
    "time range without being treated as customers (no token/tickets/contact).",
  { columns: { attendees: ["kind"] }, indexes: ["idx_attendees_kind"] },
);
```

**The `indexes` requirement is mandatory, not optional.** `schemaMigration` only
calls `syncIndexes()` when `requires.indexes` is non-empty (`define.ts:23`);
`applySchemaChanges()` only adds missing *columns*. If `indexes` is omitted, an
existing production database would gain `attendees.kind` but **never** create
`idx_attendees_kind`, so the kind-scoped reads would run unindexed until some
later full reconcile. List it here.

**Register the migration in the `MIGRATIONS` array.** Migrations in this repo are
not auto-discovered — each is manually imported and appended to the `MIGRATIONS`
array in `src/shared/db/migrations.ts:179` (the module even asserts "Every SCHEMA
change must ship with a new entry in MIGRATIONS", `migrations.ts:316`). Add the
`import` and the array entry, or existing databases will never run
`2026-06-22_attendee_kind` and `attendees.kind` will be absent in production even
though fresh schemas include it.

Add the `kind` column + `idx_attendees_kind` to `schema.ts` so the declarative
schema and the migration stay in sync (`schema-sync.ts` asserts this).

### Listing aggregates (triggers + recompute paths) — decision needed

The `trg_listing_attendees_aggregates_*` triggers maintain three columns on
`listings`: `booked_quantity`, `tickets_count`, `income`
(`schema.ts:878+`).

- **`booked_quantity`** — servicing rows **must** count here. This is what makes
  capacity unavailable. ✅ keep as-is (the trigger sums `quantity` regardless of
  kind, which is exactly what we want).
- **`income`** — servicing `price_paid` is always `0`, so income is naturally
  unaffected. ✅ no change.
- **`tickets_count`** — counts `listing_attendees` rows. **Recommendation:**
  exclude servicing rows here so "tickets sold" stats aren't inflated by holds.
  Note the asymmetry: `tickets_count` excludes servicing while `booked_quantity`
  (the same rows) **includes** it, so the kind predicate must be applied
  per-column, not as a blanket filter on the booking table.

**Triggers are not the only writer of these aggregates — every recompute path
must apply the same per-column kind predicate, or a recalculation will silently
undo the trigger logic.** The app rebuilds the aggregates independently of the
triggers in `src/shared/db/listings.ts`:

- `getListingAggregateRecalculation` (`listings.ts:444`) — `COUNT(*)`,
  `SUM(quantity)`, `SUM(price_paid)` straight off `listing_attendees`.
- `resetListingAggregateFields` (`listings.ts:490`) — the `booked_quantity` /
  `income` / `tickets_count` reset expressions (`listings.ts:482-486`).
- The schema-sync aggregate backfill that runs during migrations.

If these are not updated together with the triggers, an operator recalculation or
an aggregate backfill will put servicing holds back into `tickets_count`.

> **Recommendation — mirror a flag onto `listing_attendees`.** Because
> `listing_attendees` has no `kind` of its own, both the triggers *and* every
> recompute query above would otherwise need a correlated join back to
> `attendees` to read `kind`. Mirroring a small `is_hold INTEGER NOT NULL DEFAULT
> 0` column onto `listing_attendees` (set on create/edit from the parent kind)
> keeps all of these as simple single-table predicates: `booked_quantity`/`income`
> over all rows, `tickets_count` filtered to `is_hold = 0`. The cost is one extra
> column to keep consistent on create/edit (and to backfill in the migration).

---

## Data layer

### Creation

Reuse `createAttendeeAtomic` (`src/shared/db/attendees/create.ts`) with minimal
additions:

- Thread a `kind` through `AttendeeInput` (`attendee-types.ts:70`) defaulting to
  `'attendee'`, and include it in `buildAttendeeInsert` (`create.ts:83`).
- For servicing: pass `name` only, empty contact fields, and **do not generate a
  ticket token** — set `ticket_token_index` to `NULL` and the blob's `t` to
  empty. `encryptAttendeeFields` currently always mints a token; add a path (or
  flag) that skips token generation for non-customer kinds.
- **The atomic write must stop relying on `ticket_token_index` to identify the
  just-inserted attendee before tokens become optional.** `createAttendeeAtomic`
  currently locates the new attendee for each booking insert via
  `(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)`
  (`create.ts:289-304`), and the all-failed cleanup DELETE uses the same subquery
  (`create.ts:177-186`). With a `NULL` `ticket_token_index`,
  `WHERE ticket_token_index = ?` never matches, so booking inserts would get a
  null attendee id and the cleanup could not remove an unbooked servicing row.
  **Fix before going tokenless:** drive both the booking inserts and the cleanup
  off the inserted row id instead — i.e. always use the interactive-transaction
  path (`writeWithLedger`, `create.ts:213`, which already threads `insertId`
  through) rather than the batch path, or otherwise resolve the attendee by its
  rowid. The batch path's `last_insert_rowid()` caveat (`create.ts:286`) is
  exactly why it used the token-index subquery, so this is a real structural
  change, not a one-line tweak.
- **Skip `recordOrderActivity`** (`create.ts:349`) for servicing — there is no
  contact identity, no visit, no booking count. Guard it on `kind === 'attendee'`
  (servicing has no email/phone anyway, so `orderContactHashes` already returns
  `[]`, but make the intent explicit).
- Keep `allowOverbook` available — an operator may want to hold capacity beyond
  the normal cap (e.g. close a day entirely).

### Editing

Reuse `applyAttendeeAtomicEdit` / `loadExistingLines` / `getAttendee`. The edit
path already rebuilds the pii_blob from `name + (empty) contact + token`
(`attendee-form-routes.ts:775`); for servicing the token stays empty and contact
fields stay blank.

### Queries — exclude servicing from customer surfaces

Add an explicit `kind` filter to the broad attendee reads in
`src/shared/db/attendees/queries.ts` so servicing holds never leak into
customer-facing lists:

| Query | File | Change |
| --- | --- | --- |
| `getAttendeesPage` | queries.ts:98 | add `WHERE a.kind = ?` (param) so the admin browser can show *attendees* and a separate servicing view |
| `getAttendeesRaw` | queries.ts:43 | filter to `kind='attendee'` (per-listing attendee list) |
| `getNewestAttendeesRaw` | queries.ts:57 | filter to `kind='attendee'` (dashboard recent registrations) |
| `getAllAttendeePiiBlobs` | queries.ts:138 | filter to `kind='attendee'` (bulk email) — servicing has empty email so it's already dropped after decrypt, but filter explicitly |
| `getAttendeePiiBlobsForListings` | queries.ts:150 | same |

Token paths (`getAttendeesByTokens`, `getAttendeePiiBlobForToken`) need no change
— servicing rows have `NULL` token index and never match.

**The broad readers in `queries.ts` are not the only attendee loaders.** The
per-listing detail, CSV export, refund-all, and calendar flows load attendees
through `src/shared/db/listings.ts` — notably `getListingWithAttendeesRaw`
(`listings.ts:509`) and the calendar's attendee loaders in the same module. These
batch reads must take the same `attendees.kind` predicate, or servicing holds
will still appear in per-listing attendee tables, exports, refund-all counts, and
calendar attendee views even after the `queries.ts` helpers are fixed. Audit
every `JOIN attendees` / `FROM listing_attendees` read that surfaces *people*, not
just capacity numbers.

**Guard single-record customer routes by kind, not just list queries.** Filtering
lists still leaves `/admin/attendees/:id` able to load a servicing row by id —
`getAttendee` is keyed only by id (`queries.ts:237`), and the attendee edit page
renders customer-only actions (re-send notification, SMS, merge, delete). A
servicing id reached from the activity log or a copied URL would be treated as a
customer. Add a kind-aware single read (or a route guard): the normal attendee
pages must 404/redirect when the row is `kind='servicing'`, and the servicing
pages must load *only* `kind='servicing'` rows. Cheapest implementation: have
`getAttendeeRaw`/`getAttendee` accept an expected kind (default `'attendee'`) and
return null on mismatch, so both page families share one guarded read.

Add a dedicated servicing reader, e.g. `getServicingEventsPage` / per-listing
`getServicingForListing`, sharing the same SELECT via the existing
`ATTENDEE_JOIN_SELECT` constant and a `kind` predicate (curry the predicate to
avoid duplicating the query — jscpd runs at 0%).

> **Reuse note:** rather than duplicating each query for `'attendee'` vs
> `'servicing'`, parameterise the kind. The existing `getAttendeesPage` already
> takes a `listingIds` filter; adding a `kind` filter to the same function (and
> exposing it as both an "attendees" and a "servicing" page) is the
> zero-duplication path.

### Deletion / merge / phone-index / balance

- `deleteAttendee` works unchanged (deletes attendee + its listing_attendees).
- Attendee **merge** (`src/features/admin/attendees-merge.ts`,
  `src/shared/merge/attendee-merge.ts`) is a customer-only operation — exclude
  servicing rows from merge candidate lists.
- `attendee-phone-index.ts`, `balance.ts`, statuses, logistics: servicing events
  should not appear. Decide per-feature whether to hard-exclude or simply rely on
  them having no phone/balance/status. **Recommendation:** hard-exclude by kind
  wherever a list is built, so a servicing hold can never surface in a
  customer-only workflow.

---

## Admin UI

### Routes

New feature module `src/features/admin/servicing-form-routes.ts`, mirroring
`attendee-form-routes.ts`:

```
GET  /admin/servicing/new        — render create form
POST /admin/servicing/new        — create
GET  /admin/servicing/:id        — render edit form
POST /admin/servicing/:id        — update
GET  /admin/servicing            — list servicing events (optional)
```

Wire into the admin router barrel (`src/features/admin/index.ts`).

The two form-route files share a lot. To honour the 0% duplication rule, factor
the common create/edit machinery (parse → validate → atomic save → re-render)
into a shared helper parameterised by:

- which fields to render (full contact vs name-only),
- the `kind` to persist,
- whether to record contact activity / mint a token,
- redirect/label copy.

The attendee form route is large; expect to **extract** the reusable core from
`attendee-form-routes.ts` rather than copy it.

### Form (name-only + bookings + questions)

Reuse the declarative field schema approach (`src/ui/templates/fields.ts`,
`src/shared/forms.tsx`). The servicing form is a **subset** of the attendee
form:

Include:
- **Name** (the reason — "Annual boiler service").
- **Listing booking grid** — one quantity box per active listing, the shared
  start date + day-count range (the exact mechanism in
  `attendee-form.tsx` / `attendee-dates.ts`). This is how the operator picks
  *which listings* and *how much* to hold and *for which dates*.
- **Custom questions** for the booked listings (reuse `loadAttendeeQuestionData`
  / `parseQuestionAnswers` / `saveAttendeeAnswers`).
- Optionally **time-of-day** if logistics-style timing is wanted (the
  `listing_attendees.start_time/end_time` fields already exist) — see open
  questions.

Exclude:
- Email, phone, address, special instructions.
- Status, remaining balance, reservations.
- Ticket/QR/wallet/contact-history panels.
- Logistics agents (unless we decide servicing should be assignable).

Build the servicing field list as its own `Field[]` and render with the existing
`renderFields` — reuse the rendering, vary only the schema (per AGENTS.md
"schema over organic structure").

### Navigation

Add a "Servicing" entry to the admin nav (`src/ui/templates/admin/nav.tsx`),
likely under the same section as Attendees/Calendar. The nav is declarative
(`Section` / `NavItem`), so this is a data addition.

### Calendar / availability deep-link

The attendee create form can be deep-linked from the calendar availability
checker (`?select_<id>=1&start_date=…`). The servicing create form should accept
the same deep-link params so an operator viewing a date can "hold this capacity"
in one click. Reuse `parseSelectedListingIds` / `START_DATE_FIELD`
(`src/shared/order-select.ts`).

---

## Surfaces to audit for exclusion

A servicing row must never be treated as a customer. Checklist (search anchor:
`FROM attendees`, `JOIN attendees`, `listing_attendees`):

- [ ] Admin attendees browser (`attendees-list.ts`) — show attendees only;
      add a separate servicing list.
- [ ] Single-record customer routes (`/admin/attendees/:id` and its POST,
      re-send/SMS/merge/delete actions) — guard by kind so a servicing id 404s
      on the attendee pages (see "Guard single-record customer routes" above).
- [ ] Per-listing attendee loaders in `src/shared/db/listings.ts`
      (`getListingWithAttendeesRaw` + calendar loaders) feeding listing detail,
      CSV export, refund-all, and calendar attendee views.
- [ ] Dashboard "newest attendees" (`features/admin/dashboard.ts`).
- [ ] Bulk email targets (`src/shared/bulk-email-targets.ts`,
      `getAllAttendeePiiBlobs`).
- [ ] Wallet passes / SVG ticket / `/ticket/:token` — covered for free by the
      `NULL` token, but confirm no path assumes a token exists.
- [ ] Attendee merge (`attendees-merge.ts`).
- [ ] SMS / phone-index (`attendee-phone-index.ts`, webhooks).
- [ ] Contact preferences / history (`contact-preferences.ts`) — not written for
      servicing (we skip `recordOrderActivity`).
- [ ] Listing `tickets_count` aggregate — triggers **and** the recompute paths
      (`getListingAggregateRecalculation`, `resetListingAggregateFields`,
      schema-sync backfill) must share the kind predicate; `booked_quantity`
      keeps counting servicing. See the aggregates decision above.
- [ ] Activity log labels (`getAttendeeNamesByIds`) — fine to keep; a servicing
      edit can still log. Confirm the link target is the servicing edit page, not
      the attendee one.
- [ ] Backup/restore (`backup.ts`) round-trips the new column automatically (it
      dumps every column) — no change, but verify.

---

## Testing

Per AGENTS.md (100% coverage, mutation-resistant, behaviour-focused):

- **Migration**: new column present, defaults existing rows to `'attendee'`,
  index created, round-trips through backup/restore.
- **Capacity**: a servicing event of qty N on a date reduces available capacity
  by N for that date range and for overlapping days only (metamorphic: customer
  booking after a servicing hold is rejected once the combined qty exceeds
  `max_attendees`; capacity is restored when the servicing event is deleted).
  This is the headline behaviour — test it directly against
  `checkListingAvailability` / the atomic insert.
- **No token**: created servicing rows have `NULL` `ticket_token_index`; multiple
  servicing rows coexist (UNIQUE-NULL); `/ticket/:token` and token bulk-email
  resolve to nothing.
- **Exclusion**: servicing rows do not appear in attendees browser, dashboard
  recents, bulk-email targets, merge candidates.
- **Aggregates**: `booked_quantity` includes servicing qty; `income` unaffected;
  `tickets_count` excludes servicing (per decision).
- **Form**: create/edit persists name + bookings + question answers; no contact
  fields are stored; editing preserves the empty token.
- **Negative paths**: empty name rejected; at least one booked listing required
  (reuse `NO_LINES_ERROR`); negative quantity rejected.

Run `deno task precommit` (typecheck, lint, 0% cpd, tests) before finishing, and
consider `deno task mutation` on the capacity predicate and the kind filter.

---

## Suggested implementation order

1. Migration (with `indexes` + **`MIGRATIONS` registration**) + `schema.ts`
   column/index + sync assertions.
2. Rework the atomic write to identify the new attendee by rowid (drop the
   `ticket_token_index` subquery) **before** making tokens optional — this is a
   prerequisite for tokenless creates, not a later step.
3. Thread `kind` through types + `createAttendeeAtomic` (token-skip + activity
   skip) with unit tests.
4. Query-layer `kind` filters + kind-guarded single read + new servicing readers
   (including the `listings.ts` loaders).
5. Aggregates decision + implementation (triggers **and** recompute paths;
   recommended `is_hold` mirror column).
6. Extract the shared create/edit core from the attendee form routes; build the
   servicing routes (with kind-guarded edit) + name-only field schema.
7. Nav entry + calendar deep-link.
8. Audit and exclude across all customer surfaces (checklist above).
9. Full test pass + precommit.

---

## Open questions / decisions for the operator

1. **Time-of-day granularity.** Listings model availability by *day*
   (`start_at`/`end_at` as date ranges); `listing_attendees` also has
   `start_time`/`end_time` strings used only for logistics. Do servicing events
   need sub-day "specific times" (e.g. 14:00–16:00), or is per-day holding
   enough? Per-day is the path of least resistance and matches how capacity is
   actually computed today. Sub-day blocking would be a larger change to the
   capacity model. **Recommendation:** start per-day; revisit sub-day later.
2. **`tickets_count` treatment.** Exclude servicing from the "tickets sold"
   aggregate (recommended) — accepting that both the triggers *and* the recompute
   paths (`getListingAggregateRecalculation` / `resetListingAggregateFields` /
   backfill) need the kind predicate, most cleanly via an `is_hold` mirror column
   on `listing_attendees`? Or accept the simpler "servicing counts as a ticket in
   stats" and document it?
3. **Group caps.** Should a servicing hold also consume *group*-level capacity
   (`groups.max_attendees`), not just the single listing? Reusing the existing
   capacity machinery means **yes** by default — confirm that's desired.
4. **Name storage.** Reuse the encrypted `pii_blob` name (recommended:
   zero new columns, full reuse, but viewing the servicing list needs the
   session private key like every other attendee page) vs. a plaintext `label`
   column (no key needed to view, but a second "name" concept). Recommendation:
   reuse `pii_blob`.
5. **Logistics.** Should servicing events be assignable to logistics agents
   (vans/crews), or never? Default: never (excluded).
