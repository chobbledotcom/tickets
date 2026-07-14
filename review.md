# Deep-dive branch review

Reviewed `2786a994` against fetched `origin/main` at `8d87b16f` (merge base
`34d162cd`). The latest five main commits merge cleanly and do not invalidate
the findings below.

## P1 - Fix before merge

### 1. Stripe treats an unfinished refund as completed

**Code:** `src/shared/stripe-provider.ts:60-62`, `src/shared/stripe.ts:368-373`,
`src/features/api/payment-processing/store-refund.ts:294-336`

Stripe can return a refund with `pending`, `requires_action`, `failed`, or
`canceled` status. The adapter returns `true` for every non-null refund object,
so the staged flow records `refund_cash`, marks the stage failed, and stops all
retries even when no money has reached the customer. A pending refund that later
fails therefore leaves the customer charged while the application and ledger
say it was returned.

The provider tests cover only a returned object and a thrown request. Add status
cases and prove that only a completed refund can resolve a stage or post
`refund_cash`.

### 2. A false-negative refund can later activate as a live ticket

**Code:** `src/features/api/payment-processing/store-refund.ts:268-292`,
`src/features/api/payment-processing/index.ts:403-419`,
`src/features/api/payment-processing/create.ts:366-404`

If the provider accepts a refund but the response and immediate status lookup
both fail, `tryRefund` returns false. The code leaves the stage pending, writes
no ledger legs, and releases the payment reservation. On redelivery it runs the
whole booking decision again. If the original refusal has disappeared, such as
capacity becoming available or registration reopening, the refunded payment is
activated into a live ticket.

Existing retry tests keep the refusal in place. Add a regression where the first
refund settles remotely but reports failure, then make the order bookable before
redelivery and prove it cannot activate.

### 3. A partial refund-ledger write is sealed as a complete outcome

**Code:** `src/shared/refund-ledger.ts:309-335`,
`src/features/api/payment-processing/store-refund.ts:294-307`,
`src/features/api/payment-processing/index.ts:163-185`

`recordPlaceholderRefund` commits the received `payment` and returned
`refund_cash` through two separate `postTransfers` calls. If the second call
fails, the first remains committed and the stage stays pending. On redelivery,
the payment leg makes the ledger preflight classify the session as `orphaned`.
That branch resolves the stage without retrying the missing `refund_cash` leg.
The ledger then permanently says the business still holds money that was
already returned.

Tests cover a failure before the payment leg and a complete two-leg replay, but
not failure between the two posts. The cash round-trip needs one atomic post or
a replay state that can distinguish and finish a partial round-trip.

### 4. A normal large cart exceeds the activation transaction budget

**Code:** `src/shared/db/attendees/activate.ts:112-155`,
`src/shared/accounting/store.ts:107-116`,
`src/shared/checkout-complete.ts:67-81`

Activation executes one round trip per booking, modifier use, and ledger leg,
plus the PII, ledger snapshot, event-group, finalize, and stage writes. A paid
cart with 12 listings and no modifiers already reaches 31 statements: 12
booking updates, 13 money legs, and 6 fixed statements. The repository limit is
30. Development and tests throw and roll back at statement 31; production only
warns, leaving the same transaction exposed to the libsql timeout the guard is
designed to prevent.

Because the staged attendee already owns the ticket token, recovery rethrows
rather than refunding. Every retry repeats the deterministic oversized
transaction, leaving captured money with no ticket or refund. The largest
activation test has two bookings. Add a realistic large-cart test and move this
input-sized write to one guarded batch.

### 5. One retained deleted-listing row breaks the global CSV export

**Code:** `src/shared/db/listings/delete.ts:19-23`,
`src/features/admin/attendees-list.ts:195-208`,
`src/features/admin/calendar-csv.ts:64-68`

The branch deliberately preserves a pending stage's booking row when listing
deletion wins the preflight race. After the payment resolves, the unfiltered
attendee query still returns that row, but the listing collection contains only
live listings. `toCalendarAttendees` passes an undefined lookup to
`listingDetails`, which throws. One raced deletion therefore makes every global
`/admin/attendees/csv` request return 500 until the data is repaired.

Add a server regression that exports a resolved attendee whose listing was
deleted and returns a valid placeholder row rather than throwing.

### 6. Resolved deleted-listing records cannot be deleted

**Code:** `src/features/admin/attendee-page.ts:74-79`,
`src/features/admin/attendees-route-helpers.ts:82-88`,
`src/shared/db/orphan-attendees.ts:31-37`

Once the stage resolves, the detail page hides Actions because the home listing
is gone. Direct delete routes also require that listing and return 404. The
preserved `listing_attendees` row means orphan pruning does not consider the
attendee an orphan either. The result is retained personal data with no normal
operator or scheduled deletion path.

Current tests assert that Actions is hidden but never require an alternative
deletion path. Add a resolved deleted-listing case that can be deleted together
with all dependent rows.

## P2 - Should fix

### 7. A stale payment claim prevents stage pruning forever

**Code:** `src/shared/db/checkout-stages.ts:288-326`,
`src/shared/db/prune.ts:79-119`, `src/features/admin/listing-page-data.ts:203-216`

Stage pruning excludes a session whenever any `processed_payments` row exists,
while payment pruning deliberately keeps unresolved reservations. The only
production call that deletes stale reservations is loading an admin listing
overview; it is not a scheduled task. A worker crash can therefore leave the
stage, attendee PII, and payment claim indefinitely, while the pending state
continues blocking edits, merges, and deletion.

No test combines an expired stage with a stale unresolved payment row and runs
scheduled pruning. The scheduler needs to clear stale claims before pruning or
handle the pair atomically.

### 8. Existing Stripe endpoints never gain the expiry event

**Code:** `src/shared/stripe.ts:235-241`,
`src/features/admin/settings-stripe.ts:22-31`,
`src/features/admin/settings-helpers.ts:385-388`

The branch adds `checkout.session.expired` only when creating a new endpoint,
but endpoint setup runs only when the owner submits a new secret. Existing
installations keep their old completed-only subscription after upgrade. Their
abandoned stages retain PII and block attendee/listing operations until the
seven-day pruner runs.

Add an upgrade test for a stored Stripe key and old endpoint without resubmitting
the key, and reconcile required events during upgrade or startup.

### 9. The attendee browser hides retained deleted-listing bookings

**Code:** `src/shared/attendee-table-rows.ts:40-53`

`groupAttendeeRows` resolves bookings only against live listings. It silently
drops a deleted line from a mixed order and omits an attendee whose only line is
the preserved deleted one. This makes the exceptional record hardest to find at
the time it needs operator attention.

The pure test currently expects unknown listing IDs to be dropped. Add server
coverage for sole and mixed deleted-listing rows and render the same plain
placeholder used on the attendee detail page.

### 10. Omitting the locked deleted-listing field deletes the row

**Code:** `src/features/admin/attendee-form-model.ts:490-505,665-681`,
`src/shared/db/attendees/atomic-update.ts:306-338`

The lock validator checks only submitted lines. A crafted edit that omits the
hidden deleted-listing line never presents it to validation; if another line
remains, the atomic editor interprets the omitted stored key as a deletion and
succeeds. This contradicts the UI promise that the row can only be kept as-is.

Add a request test that omits the deleted line while retaining another booking
and assert rejection with all stored rows unchanged.

### 11. Direct QR availability failures are returned as HTTP 500

**Code:** `src/shared/db/checkout-stages.ts:89-102`,
`src/features/public/ticket-payment.ts:161-168`,
`src/features/public/qr-book.ts:125-130`

Staged checkout now returns an expected availability refusal, and
`runCheckoutFlow` passes it to `onError` as status 400. The QR callback ignores
the message and status and always creates a 500 response, so a sold-out scan is
reported as a server failure/invalid QR rather than an unavailable booking.

Add a valid direct-checkout QR whose capacity is exhausted before checkout and
assert the user-facing refusal with a non-500 status.

### 12. Resolved stages retain a weaker copy of every ticket token

**Code:** `src/shared/db/checkout-stages.ts:112-119,264-286`,
`src/shared/db/attendees/activate.ts:145-149`

Booked and failed transitions update only `state`; replay needs that state but
not `ticket_tokens`. The stage copy therefore remains environment-key
decryptable for the attendee's lifetime, while the canonical attendee copy is
protected inside the owner-key-encrypted PII blob. It is a second long-lived
bearer credential that can open the ticket and its attachments.

Keep the resolved replay guard but scrub its token on every terminal transition.
Tests currently assert state retention without checking credential removal.

### 13. Backups can split the new stage invariant across snapshots

**Code:** `src/shared/db/backup.ts:193-209`,
`src/shared/db/checkout-stages.ts:202-213`,
`src/shared/db/attendees/activation-refusal.ts:43-61`

Backups read tables independently and four at a time. A checkout commit between
the attendee, booking, and stage snapshots can produce a restore with a stage
but no attendee/lines, making every paid callback throw as an impossible state.
The opposite split restores a quantity-zero attendee without its stage, so the
callback creates a second attendee through the fresh path.

Independent backup snapshots predate this branch, but the new hard relation
makes the restored payment path unrecoverable. Add a concurrent stage/backup/
restore test and take a consistent snapshot or reconcile incomplete stage
triples on restore.

### 14. A code-only rollback leaves a staged attendee permanently stuck

**Code:** `src/shared/db/checkout-stages.ts:124-157`,
`src/features/api/payment-processing/index.ts:86-103,145-184`

If this release stages attendee A and the script is rolled back before payment,
the old code ignores the stage and creates live attendee B for the callback.
When this release returns, processed-payment or booked-ledger replay returns B
before inspecting A's stage. A remains pending, cannot be edited or deleted,
blocks listing deletion, and cannot be pruned because the finalized payment row
uses the same session ID.

The restore workflow can deploy an older commit to the same database, so this is
a persisted-data compatibility case rather than hypothetical API compatibility.
Add a pre-stage processor recovery case or make rollout/rollback fail closed for
pending staged sessions.

## P3 - Cleanup

### 15. Reference-style Markdown still renders forbidden ledger links

**Code:** `src/shared/markdown.ts:83-92`,
`src/ui/templates/admin/attendee-notes.tsx:62`

`withoutLinksTo` strips only inline `[text](target)` syntax. A note using
`[ledger][ref]` plus `[ref]: /admin/ledger/...` survives and renders a live
owner-only link for lower roles. Authorization still protects the target, but
the UI emits a forbidden link that cannot be followed.

Parse link tokens rather than matching one Markdown spelling, and cover
reference-style links.

### 16. Held-cash records still offer a delete action that always fails

**Code:** `src/features/admin/attendee-page.ts:85-110`,
`src/features/admin/attendees.ts:93-105`

The Actions tab always includes Delete when the listing exists, but the POST
always refuses while the attendee holds unreturned conflict cash. Hide or
disable Delete under the same held-cash condition so the page does not promise
an action the operator cannot complete.

### 17. Resolved stages make the staging table and prune scan unbounded

**Code:** `src/shared/db/checkout-stages.ts:288-326`,
`src/shared/db/migrations/schema/tables-attendees.ts:164-180`

Every paid checkout leaves a booked or failed stage until its attendee is
deleted. The scheduled prune filters by `state` and `created_at`, but the table
has only its session primary key and an attendee index. Over time each prune and
the listing-delete pending-stage subquery scans the lifetime history of paid
checkouts.

Define resolved-row retention and add an index beginning with `state,
created_at`; tests currently confirm old failed rows survive but do not require a
bounded table or indexed prune plan.

## Verification

- Fetched the latest remote refs; the review branch itself was already current.
- `git merge-tree --write-tree HEAD origin/main` completed without conflicts.
- Focused payment/admin verification runs completed with 357 passing tests.
- Lint, typecheck, copy checks, the edge build, and the full coverage suite pass.
- The jscpd precommit step could not start its dynamically linked npm binary on
  NixOS, including inside `nix develop`; it did not report an actual clone.
- Existing tests do not exercise the exact failure scenarios listed above.
