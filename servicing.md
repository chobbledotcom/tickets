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
*presented and handled* (kept token but hidden from the public site, no contact,
no ticket/QR UI, its own pages).

This reuse is the whole point: we get per-day capacity, multi-day ranges, group
caps, the overlap index, and atomic create/edit for free.

## Why this fits the existing model

The attendee record already supports a "name only, nothing else" shape:

- PII lives encrypted in `attendees.pii_blob` as `{n,e,p,a,s,pi,t}` (name,
  email, phone, address, special_instructions, payment_id, ticket_token) —
  `src/shared/db/attendees/pii.ts`. A servicing event sets only `n` (name) and
  leaves the rest empty.
- Servicing events **keep** a real ticket token (kept for possible future use),
  so the token-based paths (`/ticket/:token`, wallet passes, token bulk-email
  lookup via `getAttendeesByTokens` / `getAttendeePiiBlobForToken` in
  `src/shared/db/attendees/queries.ts`) would resolve them unless explicitly
  filtered. They are made "hidden from the public site" by a `kind='attendee'`
  filter on those paths, and the token UI is simply not rendered (see "Hidden
  from public site").
- Custom questions attach to *listings* and answers to *attendees*
  (`attendee_answers`), so a servicing event can answer custom questions with no
  schema change — `src/shared/db/questions.ts`.

So the "no contact" behaviour falls out for free (empty contact fields); the
work is adding the discriminator, suppressing the public/ticket surfaces by kind,
giving servicing its own create/edit/list pages, and filtering servicing rows out
of the customer-facing attendee surfaces.

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
- For servicing: pass `name` only, empty contact fields. **Keep minting a ticket
  token** exactly as today — tokens may be useful later, and keeping them means
  the existing atomic write is untouched: the
  `(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)` lookup
  (`create.ts:289-304`) and the all-failed cleanup DELETE (`create.ts:177-186`)
  both still resolve. No change to the create/cleanup mechanics is needed. The
  token simply never surfaces in any UI (see "Hidden from public site" below).
- **Skip `recordOrderActivity`** (`create.ts:349`) for servicing — there is no
  contact identity, no visit, no booking count. Guard it on `kind === 'attendee'`
  (servicing has no email/phone anyway, so `orderContactHashes` already returns
  `[]`, but make the intent explicit).
- Keep `allowOverbook` available — an operator may want to hold capacity beyond
  the normal cap (e.g. close a day entirely).

### Hidden from public site (forced on, not editable)

Servicing events are created **hidden from the public site** and that state is
**not editable** — it is intrinsic to `kind='servicing'`, not a toggle the
operator can flip (mirrors how the listing/group `hidden` checkbox reads, but
here it is locked on). Because we keep a real ticket token, the record would
otherwise resolve on its public surfaces, so the kind must actively suppress
them:

- **Public ticket page / wallet passes** — `getAttendeesByTokens`
  (`queries.ts:251`, the first query at `:269-275`) and
  `getAttendeePiiBlobForToken` (`queries.ts:172`) must filter to
  `kind='attendee'`, so `/ticket/:token`, Apple/Google Wallet, and token
  bulk-email lookups return 404 / no match for a servicing token. This is the
  concrete enforcement of "hidden from public site"; it is **not** free anymore
  (the row has a valid token index), so the filter is required.
- **Admin UI** — show the locked state for transparency (a checked, disabled
  "Hidden from public site" indicator on the servicing form, per the malleable
  software preference), but enforce it server-side by kind; the servicing
  routes never accept a value that would unhide it.

### No ticket / QR interface

Do **not** render any ticket/QR/wallet UI for servicing events — not the public
ticket page (404 per above) and not the admin attendee detail's ticket/QR/wallet
panels. The servicing edit page omits these sections entirely (it is a distinct,
trimmed template — see Admin UI). The token still exists in the row; it just has
no rendered interface.

### Editing

Reuse `applyAttendeeAtomicEdit` / `loadExistingLines` / `getAttendee`. The edit
path already rebuilds the pii_blob from `name + (empty) contact + token`
(`attendee-form-routes.ts:775`); for servicing the contact fields stay blank and
the existing token is preserved (read from the loaded row and re-encrypted into
the blob, exactly as the attendee edit path already does).

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

Token paths (`getAttendeesByTokens`, `getAttendeePiiBlobForToken`) **do** need a
`kind='attendee'` filter now that servicing events keep a real ticket token —
this is what makes them "hidden from the public site" (public ticket page /
wallet 404). See the "Hidden from public site" section above; do not skip this,
because the token index is populated and would otherwise resolve.

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

**`getAttendee` is not the only direct single-record loader — guard the
listing-scoped and balance loaders too.** Several customer-only actions never go
through `getAttendee`:

- `loadAttendeeForListing` (`attendees-route-helpers.ts:34`) →
  `getListingWithAttendeeRaw` (`listings.ts:608`) backs the listing-scoped
  `/admin/listing/:listingId/attendee/:attendeeId/{delete,resend-notification,checkin}`
  actions.
- `getAttendeeBalanceState` (`balance.ts:28`) backs the admin balance page
  (`features/admin/attendee-balance.ts`).

A servicing id reached via an activity-log link or a copied listing-scoped URL
could otherwise be deleted / checked-in / resend-notified / balance-edited. Apply
the same kind predicate/guard to these direct loaders (return null/404 for
`kind='servicing'`), not just to `getAttendee`.

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
  / `parseQuestionAnswers` / `saveAttendeeAnswers`). **Note the create-mode gap:**
  the existing admin `applyCreate` (`attendee-form-routes.ts:724`) never saves
  question answers — only `applyEdit` calls `saveAttendeeAnswers` — and
  `loadAttendeeQuestionData` returns `undefined` for an empty `attendeeIds` (there
  is no attendee id until after the insert). So if the servicing **create** form
  is to collect answers, the plan must add: (a) a create-mode question *loader*
  keyed by the selected listing ids alone (no attendee id) to render the
  questions, and (b) a `saveAttendeeAnswers` call against the new id *after* the
  atomic create returns it. Otherwise answers entered at creation are silently
  dropped until the operator re-opens the row in edit mode. (If we decide
  servicing events don't need questions at creation, state that explicitly and
  collect them on edit only.)
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
- [ ] Wallet passes / SVG ticket / `/ticket/:token` — **must** 404 for servicing
      via the `kind='attendee'` filter on the token paths (the token index is
      populated, so this is not free). This is the "hidden from public site"
      enforcement.
- [ ] Attendee merge (`attendees-merge.ts`).
- [ ] SMS / phone-index (`attendee-phone-index.ts`, webhooks).
- [ ] Contact preferences / history (`contact-preferences.ts`) — not written for
      servicing (we skip `recordOrderActivity`).
- [ ] Listing `tickets_count` aggregate — triggers **and** the recompute paths
      (`getListingAggregateRecalculation`, `resetListingAggregateFields`,
      schema-sync backfill) must share the kind predicate; `booked_quantity`
      keeps counting servicing. See the aggregates decision above.
- [ ] Activity log links must be kind-aware. `refLink` in
      `activityLog.tsx:80` hard-codes `/admin/attendees` for `entry.attendee_id`,
      and `refs.attendees` is a `Map<number,string>` of labels with no kind. Once
      the attendee pages are kind-guarded, a logged servicing id would point at
      the customer edit page (or 404). Load the kind alongside the ref (extend the
      ref map to carry kind, or look it up) and link servicing rows to
      `/admin/servicing/:id`. (`getAttendeeNamesByIds` itself can stay; it's the
      link routing that must change.)
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
- **Hidden from public site**: a created servicing event has a real ticket token,
  but `/ticket/:token`, wallet-pass lookup, and token bulk-email **404 / resolve
  to nothing** because the token paths filter `kind='attendee'`. The "hidden"
  state is not editable — a servicing edit submission can never unhide it.
- **No ticket/QR UI**: the servicing edit page renders no ticket/QR/wallet panel;
  the public ticket page is unreachable (covered above).
- **Exclusion**: servicing rows do not appear in attendees browser, dashboard
  recents, bulk-email targets, merge candidates.
- **Aggregates**: `booked_quantity` includes servicing qty; `income` unaffected;
  `tickets_count` excludes servicing (per decision).
- **Form**: create/edit persists name + bookings + question answers; no contact
  fields are stored; editing preserves the existing token.
- **Negative paths**: empty name rejected; at least one booked listing required
  (reuse `NO_LINES_ERROR`); negative quantity rejected.

Run `deno task precommit` (typecheck, lint, 0% cpd, tests) before finishing, and
consider `deno task mutation` on the capacity predicate and the kind filter.

---

## Suggested implementation order

1. Migration (with `indexes` + **`MIGRATIONS` registration**) + `schema.ts`
   column/index + sync assertions.
2. Thread `kind` through types + `createAttendeeAtomic` (keep token; skip
   contact activity) with unit tests. The atomic write is unchanged because the
   token (and its index) is still minted.
3. Query-layer `kind` filters (including the token paths, for "hidden from public
   site") + kind-guarded single reads — `getAttendee`/`getAttendeeRaw` **and** the
   direct loaders `getListingWithAttendeeRaw` (via `loadAttendeeForListing`) and
   `getAttendeeBalanceState` — + new servicing readers (including the
   `listings.ts` loaders).
4. Aggregates decision + implementation (triggers **and** recompute paths;
   recommended `is_hold` mirror column).
5. Extract the shared create/edit core from the attendee form routes; build the
   servicing routes (kind-guarded edit, no ticket/QR UI, locked "hidden") +
   name-only field schema. If questions are collected at creation, add the
   create-mode question loader + post-insert `saveAttendeeAnswers` (the existing
   `applyCreate` does not save answers).
6. Nav entry + calendar deep-link + kind-aware activity-log links
   (`/admin/servicing/:id` for servicing rows).
7. Audit and exclude across all customer surfaces (checklist above).
8. Full test pass + precommit.

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
