# Servicing Branch Todos

Deep dive scope: current branch `claude/servicing-events-planning-7v7hi0`
against `origin/main` (`main` at `a5a33ee96f6e2c1984920e5506f4162b111fc4c4`;
merge-base `43e0461167b8cb6db07ec561c52d5aff7b48214e`). The branch adds the
servicing-capacity-hold model on top of attendee rows, admin routes/UI, kind
filtering, aggregate trigger changes, ledger service costs, and a large servicing
test inventory.

## P0 - Fix Before Merge

### 1. Make `attendees.kind` a real database invariant

`src/shared/db/migrations/schema.ts:276` declares:

```ts
TEXT DEFAULT 'attendee' CHECK (kind IS NULL OR kind IN (...)) /* NOT NULL */
```

That is not actually `NOT NULL`; the comment only makes
`test/lib/servicing/migration.test.ts:64` pass. A row with `kind = NULL` can be
inserted/updated, consumes `booked_quantity`, is excluded from both
`kind='attendee'` and `kind='servicing'` readers, and is not counted by
`tickets_count`.

Fix:

- Change the schema to a real `TEXT NOT NULL DEFAULT ... CHECK (kind IN (...))`.
- Add/adjust a migration that repairs existing nullable dev schemas, likely via
  table recreation, not only additive `ALTER TABLE`.
- Assert `PRAGMA table_info(attendees).notnull === 1`.
- Add SQL-level regression tests that `INSERT/UPDATE kind = NULL` fails and
  that a repaired database has no limbo rows.

### 2. Escape listing names in the servicing form

`src/features/admin/servicing.tsx:99` and `:106` interpolate `listing.name`
directly into raw HTML for table rows and `<option>` labels. Listing names are
operator-controlled but still untrusted HTML, and this bypasses the JSX escaping
used elsewhere.

Fix:

- Render the listing rows/options through JSX or call `escapeHtml` consistently.
- Add a regression test with a listing named like `<script>alert(1)</script>` and
  assert the servicing create/edit page contains escaped text, not executable
  markup.

### 3. Validate service-cost inputs and prevent negative cost states

The route parses costs with `toMinorUnits(Number(...))`
(`src/features/admin/servicing.tsx:361`, `:432`). Invalid, empty, negative, or
unsafe values become exceptions or ledger adjustments instead of a user-facing
validation failure. `recordServiceCost` rejects non-positive create amounts
(`src/shared/db/attendees/servicing.ts:431`), but `editServiceCost` accepts any
`update.amount`, including negative target amounts (`:467`).

Fix:

- Use a shared money parser/validator for service costs.
- Require a positive safe integer target amount for both create and edit.
- Validate `target_listing_id` is a positive integer before hitting the ledger.
- Return a normal form error/redirect, not a 500.
- Add tests that invalid create/edit amounts write no `service_cost` transfers.

### 4. Make servicing mutation routes fail closed as 404/validation, not throws

`POST /admin/servicing/:id` checks the event exists, but delete/duplicate do not
(`src/features/admin/servicing.tsx:407`, `:415`). Cost edit checks the event
exists, but a missing or unrelated `costId` throws from `editServiceCost`. These
paths should not produce unhandled 500s for ordinary stale-form cases.

Fix:

- Guard delete, duplicate, and cost edit like the main update route.
- Convert domain "not found" failures into `notFoundResponse()`.
- Add route-level tests for missing delete, duplicate, and cost-id cases.

### 5. Stop accidental duplicate service-cost postings

The cost form does not carry an idempotency key. The default reference includes
`occurredAt` and `amount` (`src/shared/db/attendees/servicing.ts:408`), while the
route supplies `new Date().toISOString()` (`src/features/admin/servicing.tsx:366`).
A double-submit or browser retry can post the same human cost twice.

Fix:

- Add a stable per-form idempotency token/reference, or model service costs as
  first-class editable records with stable ids before posting ledger legs.
- Add a double-submit regression test that only one cost is recorded.

## P1 - Correctness And Operator Workflow

### 6. Show existing holds on inactive listings in the edit form

`loadEditPage` uses only `activeListings(await getAllListings())`
(`src/features/admin/servicing.tsx:297`). If a service event already holds a
listing that is later deactivated, the edit form omits that row. Saving the form
can silently drop the held line.

Fix:

- For edit pages, include all active listings plus every listing already held by
  the event, with an "inactive" indicator where needed.
- If the listing was deleted, show a repair/delete indicator instead of silently
  hiding the line.
- Add a regression test for deactivating a held listing, opening the service
  event, and saving without losing the hold.

### 7. Decide and encode the calendar CSV policy for servicing rows

The admin calendar intentionally includes servicing holds. The CSV export uses
the same daily loader (`src/features/admin/calendar.ts:393`) and therefore can
export servicing pseudo-attendees with blank contact fields. That may be right
for an operator run sheet, but it is not explicit, labelled, or covered by a
CSV-specific test.

Fix:

- Decide: exclude servicing from CSV, or include it with a clear "Service event"
  type/status column.
- Add tests for the chosen CSV behavior, including a logistics listing.

### 8. Align profit semantics across SQL and pure ledger projections

Listing rows project profit as recognised income minus costs
(`src/shared/db/listings.ts:238`). The pure helper says "Gross listing income
less servicing costs" but computes `accountBalance(revenue) - cost`
(`src/shared/accounting/projection.ts:10`), which is net of refunds. After a
refund these diverge.

Fix:

- Either change the pure helper to match `listingProfitSubquery`, or rename it to
  make the net-balance semantics explicit.
- Add a refund regression test that compares listing row profit, the listing
  ledger breakdown, and the pure helper.

### 9. Rename or group "servicing events" list rows

`getAllServicingEvents` returns one row per `listing_attendees` booking line
(`src/shared/db/attendees/servicing.ts:262`), not one row per servicing event.
Multi-listing holds will appear multiple times in `/admin/servicing` and on the
dashboard. That may be useful, but the names (`ServicingEvent`,
`UpcomingServicingEvent`, `getAllServicingEvents`) imply event-level summaries.

Fix:

- Either group rows by service event and render listing summaries inside one row,
  or rename the reader/types to `ServicingBookingSummary` style names.
- Add a multi-listing hold test that pins the chosen UI.

### 10. Make servicing create/update side effects atomic

`createServicingEvent` creates the attendee/booking first, then saves answers
and logs activity (`src/shared/db/attendees/servicing.ts:228`). Update similarly
edits the attendee/lines first, then saves answers (`:329`). A failure after the
first write can leave a partially saved service event.

Fix:

- Move the whole create/update unit into one transaction, or make the side
  effects explicitly retryable and documented.
- Add a regression test that stubs/fails answer saving and proves no partial
  event state remains.

### 11. Make service costs first-class on the servicing page

The branch adds `editServiceCost` and a `POST /admin/servicing/:id/cost/:costId`
route, but the servicing page only has a "Record Cost" form. It does not list
existing costs, their memos, dates, or edit actions, so the edit route is not
operator-reachable.

Fix:

- Add a service-cost list to `/admin/servicing/:id`, with amount, date, memo,
  listing, and edit controls.
- Keep ledger append-only behavior, but expose the derived current cost record
  clearly enough that operators can repair mistakes without DB surgery.

## P2 - Clarity, Standards, And Test Quality

### 12. Replace raw servicing markup with schema/shared renderers

`src/features/admin/servicing.tsx` builds form rows, options, list rows, and cost
controls by hand. This is easy to drift from escaping, i18n, and table/form
patterns used elsewhere.

Fix:

- Model the servicing page as data: field schema, listing row schema, cost form
  schema, and shared render helpers.
- Prefer JSX for markup so escaping is automatic.
- Move repeated row rendering into helpers before jscpd forces a smaller, less
  coherent curry later.

### 13. Clean stale "test-first contract" comments and tautological tests

Several new tests still read like planning specs rather than final regression
tests. Example: `test/lib/servicing/admin-homepage.test.ts:35` feeds the same
rows into `renderListingsTableSection` twice and asserts the outputs are equal;
it does not prove the servicing dashboard uses that renderer. Some comments also
say "code not yet written" after implementation exists
(`test/test-utils/servicing.ts:15`).

Fix:

- Remove tautological tests or replace them with behavior tests that fail under
  realistic regressions.
- Update stale contract comments so tests describe current observable behavior,
  not the plan that led to it.
- Run `deno task test:quality-audit` over the added servicing tests and review
  truthiness/presence-only findings.

### 14. Use constants/parameters for attendee kind SQL

Some servicing queries use bound `SERVICING_KIND`, while others hard-code
`'servicing'` in SQL (`src/shared/db/attendees/servicing.ts:271`, `:400`).
The values are stable, but mixed styles make future schema changes harder and
hide which paths are intentionally kind-scoped.

Fix:

- Use `ATTENDEE_KIND` / `SERVICING_KIND` consistently, preferably as bound query
  parameters for non-DDL SQL.
- Add a small code-quality assertion if this convention is important.

### 15. Reconcile planning docs before merge

This branch adds both `servicing.md` and `tests.md`, while the implementation
and tests have moved beyond parts of the original plan. Keep the useful
architecture/operator decisions, but avoid merging obsolete checklist prose that
future agents will treat as current truth.

Fix:

- Consolidate durable decisions into `servicing.md` or the admin guide.
- Drop or clearly mark historical planning notes.
- Ensure any remaining docs match the implemented routes, cost workflow, and
  calendar/CSV policy.

## Suggested Verification After Fixes

- Focused tests while iterating:
  - `deno task test:files test/lib/servicing/migration.test.ts test/lib/servicing/migration-edge-cases.test.ts`
  - `deno task test:files test/templates/admin/dashboard.test.ts test/lib/servicing/admin-homepage.test.ts`
  - `deno task test:files test/lib/servicing/ledger.test.ts test/lib/servicing/calendar-groups-feeds.test.ts`
- Quality sweep for the added tests:
  - `deno task test:quality-audit`
- Final check:
  - `mise exec -- deno task precommit`
