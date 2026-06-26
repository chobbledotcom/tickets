# Servicing Events — Exhaustive Code Review

Reviewed branch `claude/servicing-events-planning-7v7hi0` @ `bef905b` (after the
import-order lint fix), against `origin/main`. Five slices: core lifecycle, cost
& ledger model, exclusion & guards, migrations & schema, test-suite quality.

**Bottom line:** the feature is in good shape — exclusion/guards are *complete*
and the migration/schema mechanics are *sound*. The defects cluster almost
entirely in the **service-cost edit model** (memo-linked adjustments, listing-
scoped edit guard, delta-vs-original) and in **route-level error handling**.
Several are the same items Codex flagged; this review verified each against the
code and adds orphan-cleanup and test-gap findings Codex didn't reach.

CI lint blocker (merge-artifact import order in `migrations.ts`) is already
fixed in `bef905b`.

---

## P0 — fix before merge

### 1. Cross-event service-cost edit (authorization gap)
`src/shared/db/attendees/servicing.ts:634` (`costBelongsToServicing`) authorizes a
cost edit by checking only that the event *holds the cost's listing*
(`servicingHoldsListing`), **not** that the `service_costs` row links
`transfer_id = costId` to `servicing_attendee_id = servicingId`. Two service
events that both hold listing L can edit each other's costs via
`/admin/servicing/:otherId/cost/:costId`.
**Fix:** replace the listing check with an existence check on the link row —
`SELECT 1 FROM service_costs WHERE transfer_id = ? AND servicing_attendee_id = ?`
— in `costBelongsToServicing` and inside `editServiceCost` (servicing.ts:657-659).
**Test gap:** the two cross-event tests use *different* listings, so the bug never
triggers (`route-guards.test.ts:107`, `ledger.test.ts:415`). Add a same-listing case.

### 2. `service_costs` rows orphaned on delete
`src/shared/db/attendees/delete.ts:49-72` (`purgeAttendee`) deletes
`attendee_answers`, `listing_attendees`, `system_notes`, `processed_payments`,
then `attendees` — but never `service_costs`. Deleting a service event (or
purging an orphan / merging) leaves `service_costs` rows pointing at a gone
`servicing_attendee_id`; with autoincrement id reuse after a restore, stale costs
resurface against the wrong event.
**Fix:** add `DELETE FROM service_costs WHERE servicing_attendee_id = ?` to the
purge batch (and the merge cleanup in `attendee-merge.ts`).

### 3. Edit answer-save failure permanently loses prior answers
`src/shared/db/attendees/servicing.ts:455-460` (`updateServicingEvent`)
compensates a failed `saveServicingAnswers` by restoring PII + booking rows only.
But `saveAttendeeAnswers` (`questions.ts`) commits `DELETE FROM attendee_answers`
in its own batch *before* the re-insert batch — so if the insert (or string
encryption) throws, the old answers are already gone and the "restore" leaves the
event with none.
**Fix:** capture the pre-edit answers and re-save them in `restoreServicingState`,
or make `saveAttendeeAnswers` delete+insert in a single batch.

---

## P1 — fix before relying on the cost feature

### 4. Adjustment legs linked by parsing operator memo text
`src/shared/db/attendees/servicing.ts:698,737` — `getServicingCosts` attributes
each adjustment to its original by regex-matching the decrypted memo against
`/^edit service cost (\d+)$/`. The memo on an *original* cost is operator-supplied
(`servicing.tsx:493`), so a memo of literally `edit service cost 5` mints a
phantom adjustment against cost 5 and double-counts.
**Fix:** give adjustments a non-user-controlled link (store the original
`transfer_id` on the adjustment / as a `service_costs` adjustment row) and
aggregate on that, not the memo.

### 5. `service_cost` legs are invisible in the admin ledger
`src/shared/accounting/queries.ts:90` (`VISIBLE_TRANSFER_SCOPE`) admits an
external-cash leg only when `kind LIKE 'manual_%'`. A service cost is
`cost:L → world` with `kind='service_cost'`, so it is filtered out of
`/admin/ledger` entirely — real money out, no audit trail (manual listing costs,
`manual_*`, *are* visible).
**Fix:** include `kind = 'service_cost'` in the visibility scope (or rename to a
`manual_` kind).

### 6. Deleting a transfer 500s the whole cost list
`src/shared/accounting/manual-entries.ts:205` can delete a `service_cost` leg that
a `service_costs.transfer_id` references; `getServicingCosts`
(`servicing.ts:753`) then does `decoded.find(leg => leg.id === r.transfer_id)!`
— the non-null assertion throws and `/admin/servicing/:id` 500s.
**Fix:** block deleting service-cost legs that back a `service_costs` row, cascade
the `service_costs` delete, or make `getServicingCosts` tolerate a missing leg.

### 7. Create / edit / duplicate routes 500 on recoverable domain errors
`src/features/admin/servicing.tsx:505-556` call `createServicingEvent` /
`updateServicingEvent` / `duplicateServicingEvent` with no try/catch. These throw
on `capacity_exceeded`, `encryption_error`, blank name, and "must hold at least
one capacity slot" — all normal stale/over-capacity form cases — so the operator
gets the generic error page and loses their input instead of a form-error
redirect (the pattern `handleCostPost` already uses at `servicing.tsx:476-489`).
**Fix:** catch known reasons and `redirect(action, message, false)`; let only
unexpected errors propagate.

---

## P2 — correctness/UX, lower blast radius

### 8. Cost edit delta computed against the original, not current, amount
`src/shared/db/attendees/servicing.ts:660` — `delta = update.amount −
original.amount` uses the first leg's amount, ignoring prior adjustments. Record
£90 → edit £60 → edit £100 posts +£10 (100−90), landing at £70, not £100. The
ledger and the displayed amount agree with each other but disagree with the
operator's intent.
**Fix:** delta against the *current* amount (original + Σ adjustments) — reuse the
accumulation `getServicingCosts` already does.

### 9. Idempotency race: concurrent double-submit → 500
`src/shared/db/attendees/servicing.ts:539,563-567` — the duplicate-reference
pre-check runs outside the write transaction, and the `eventGroup` includes a
per-request `occurredAt` (`servicing.tsx:494`). Two concurrent submits with the
same idempotency key share a `reference` but get *different* event groups, so the
second hits `LedgerConflictError` → 500 instead of an idempotent no-op.
**Fix:** derive the event group solely from the stable idempotency parts (exclude
`occurredAt` when a `reference` is supplied).

### 10. Costs dated to submit time, not the service date
`src/features/admin/servicing.tsx:494` stamps `occurredAt = now`, so a cost for a
past/future service lands in the wrong ledger period and sorts oddly on the cost
list. **Fix:** date to the service event's date (fall back to now only if absent).

### 11. Dateless (standard-listing) events age out of "upcoming"
`src/shared/db/attendees/servicing.ts:310-312` filters/sorts with
`COALESCE(DATE(ea.start_at), SUBSTR(a.created,1,10))`. A standard-listing hold has
no `start_at`, so it's treated as "scheduled" on its creation day and drops off
the dashboard's upcoming block once created-date < today (and shows a blank date).
**Fix:** treat `start_at IS NULL` as "no horizon" (always upcoming) rather than
coalescing to `created`.

### 12. `getAttendeesByListingIds` kind opt-in is the one leak-prone shared reader
`src/shared/db/listings.ts:783-804` — the roster reader includes servicing only
when a caller passes `kindScope: "attendees-and-servicing"` (today only the admin
calendar). Correct now, but the only thing keeping every other caller clean is the
default. **Fix:** add a guard test pinning the default to attendees-only.

---

## Test-suite gaps (these let the bugs above ship)

The known bugs have **no guarding test** — nearby tests use shapes that route
around the defect:

- No second-edit test for the delta bug (#8) — `editServiceCost` is only ever
  called once per cost id (`ledger.test.ts:286,292` are different legs).
- No test that a `service_cost` leg is visible in the ledger (#5) — the ledger
  template test enumerates every event family *except* `service_cost`
  (`ledger.test.ts:228`, generic fallback only at `:337`).
- No route-level test that an over-capacity servicing POST returns a 302 form
  error rather than 500 (#7) — capacity is only tested at the DB layer /
  `expectRejects` (`editing.test.ts:92`).
- No same-listing cross-event cost-edit test (#1).
- No memo-collision / non-matching-memo test for adjustment attribution (#4).

Weak assertions worth tightening:
- `ledger.test.ts:254` `toBeGreaterThanOrEqual(2)` → assert `=== 2` + amounts
  (the raise case already does at `:273`; mirror for the reduction case).
- `editing.test.ts:68` "cannot change kind or unhide" asserts only kind — the
  unhide half is never checked (split the test or assert persisted hidden state).
- `custom-questions.test.ts:94` `toContain("checked")` collides with the disabled
  hidden-from-public indicator — scope the match to the answer input.
- `dashboard.test.ts:149-150` substring `toContain("2099")` / `"1 listing · 2"`
  — pin the formatted date + quantity cell.
- `test-utils/servicing.ts:213` `expectEmptyContactFields` dereferences with
  optional chaining after a null guard, so a null row passes silently — use
  non-optional access.

---

## Verified correct (no action — reassurance)

- **Exclusion & single-record guards: complete.** Token paths, all list/collection
  reads, bulk-email, merge/balance/refresh-payment/listing-scoped actions, the
  `/admin/servicing/:id` reverse-guard, kind-aware activity-log links, and the SMS
  phone-index all filter by kind. No missed surface, no bypassable guard.
- **Migration/schema mechanics: sound.** `kind` default + NOT-NULL backfill-before-
  tighten (`COALESCE` in the rebuild), `CHECK (kind IN (...))` matches the
  `ATTENDEE_KIND`/`SERVICING_KIND` constants, `idx_attendees_kind` declared in both
  schema and migration `indexes`, aggregate triggers share one kind predicate
  across triggers + recompute + backfill (booked_quantity includes servicing,
  tickets_count excludes it), `service_costs` columns/indexes/registration correct,
  migrations idempotent and ordered.
- **Profit projection correct.** Income gross (matches the listing row, refund-
  agnostic), cost a positive magnitude, `profit = income − cost`.
- **Duplicate** mints a fresh token and independent capacity holds.
- **Atomicity tests** genuinely poison `db.batch` and assert persisted rollback;
  idempotency (same-reference / double-submit) is well covered with exact leg
  counts and `costOf`.

---

## Suggested fix order

1. P0 #1–#3 (auth gap, orphan cleanup, answer loss) — data integrity.
2. Redesign cost adjustments to a structured link (fixes #4, enables correct #8,
   and lets #5/#6 be handled cleanly) — this is the one design change; the rest are
   localized.
3. P1 #5–#7 (ledger visibility, transfer-delete safety, route error handling).
4. P2 #8–#12.
5. Backfill the missing guarding tests alongside each fix.
