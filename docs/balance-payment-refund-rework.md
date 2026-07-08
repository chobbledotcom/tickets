# Plan: balance payments for any status, and refundability of balance-settled accounts

Status: **approved for implementation**. Part 1 (remove the reservation
restriction) is already implemented and pushed on this branch (PR #1655). Part 2
(the refund rework) is now being built with the decisions recorded below.

## 1. What already shipped in this PR

The original request: _remove the restriction "it isn't in a reservation status
— only reservations can take a balance payment online."_

Done, in three places:

- **Public `/pay/:token`** (`src/features/public/balance.ts`): dropped the
  `!status?.is_reservation` gate. Any attendee who still owes money can pay it
  online. The other guards stay: nothing owed → "nothing to pay"; no real
  (quantity > 0) line → "no tickets to pay for".
- **Admin ledger panel** (`src/ui/templates/admin/attendee-ledger-panel.tsx`):
  the customer pay link now shows for any status with a provider and a real
  line; removed the not-a-reservation offline reason.
- Removed the now-unused `attendee_balance.offline_reason_not_reservation` copy.

Security review (token signing, admin-only link generation, amount validation)
and the full test/mutation pass are green; the amount a customer pays is
server-computed from the live ledger and validated at the webhook (signed price
proof + charged-equals-signed + settle guarded on the live balance).

## 2. Automated review (Codex) — findings and verdicts

Three P2 comments, all anchored to the changed line. Verified against the code:

1. **"already paid / full order price" overstate the totals** — _REAL but
   pre-existing._ `getAttendeeOrderSummary` derives `depositPaid` from
   `pricePaidFromLedger`, which sums the **gross `sale` leg**, not cash
   received; `fullPrice = depositPaid + remainingBalance` then double-counts the
   unpaid remainder. This is identical for reservations and is documented as an
   accepted quirk (`test/lib/server-reservation/edge-cases.test.ts:63-71`).
   Removing the restriction only widened _who reaches the page_, not the
   computation. **Not a regression.** (Could be fixed separately — see §8.)
2. **`feeSubtotal: 0` under-collects the booking fee** — _NOT real._
   Provider-less bookings (`ticket-submit.ts:156-175`) and admin-set balances
   (`attendee-form-model.ts` `toLedgerOrder`) post **no `fee` leg** and no fee
   is part of the owed balance; a reservation pays its whole fee at deposit time
   (`checkout-pricing.ts` `priceCheckout`). So `feeSubtotal: 0` on a balance
   collects exactly what is outstanding in every case.
3. **Balance payments aren't refundable in-app for empty-`payment_id`
   attendees** — _REAL and newly reachable._ This is what §3–§7 address.

## 3. The refund gap in detail

An admin refund is two steps:

1. **Money** — `provider.refundPayment(attendee.payment_id)`
   (`attendee-refunds.ts:117`). Requires a non-empty `payment_id`; the GET/POST
   routes reject an empty one (`attendee-refunds.ts:71,101`).
2. **Ledger** — `recordAttendeeRefund` → `computeAttendeeRefund` →
   `soleBookingOrder` (`refund-ledger.ts:50-92`). It **only** auto-reverses when
   the account is a _single_ event group that recognises revenue **and**
   `balanceOf(account) === 0`. The `refunded` flag then projects from the
   resulting `refund_cash` leg (`queries.ts:44`).

Two structural facts make balance-settled accounts un-refundable in-app:

- **Empty `payment_id`.** `payment_id` is set only when the booking was created
  from a paid provider session (`attendee-baseFields` → `createAttendeeAtomic`).
  Provider-less bookings and admin-added attendees have `payment_id = ''`, so
  step 1 is blocked outright — this is the new gap the restriction removal
  exposes.
- **Two event groups.** Every balance-settled account has the original booking
  group **plus** a separate `balance` group (the settle posts its payment leg
  under `balanceEventGroup`). `soleBookingOrder` returns `null` for
  `groups.size
  !== 1`, so step 2 returns `posted: false` → the admin sees
  "refund not recorded" and the `refunded` flag never sets. This already affects
  **settled reservations** (the code comments name that case explicitly) —
  reservations just aren't _blocked_ at step 1 because they carry the deposit's
  `payment_id`.
- **The balance charge's provider reference is discarded.** `processed_payments`
  stores only the session id (`payment_session_id`), never the provider payment
  reference (`pi_…`). The settle path never persists `session.paymentReference`.
  So even where step 1 fires, it refunds the _booking_ charge, not the balance
  charge — the balance charge is never refundable by reference for anyone today.

Net: writing `payment_id` alone (the "partial" option) unblocks step 1 for the
new case but leaves step 2 punting to manual adjustment, and does nothing for
the reservation double-charge. A clean refund needs all three facts addressed.

## 4. Goals

- An admin can fully refund a **balance-settled account** from the app: every
  provider charge the customer made is returned, the ledger reverses cleanly,
  and the `refunded` flag sets — no manual adjustment.
- Works for the newly-enabled non-reservation cases **and** for settled
  reservations (the two-charge case), per the decision to rework the shared
  path.
- Idempotent and fail-safe: a provider refund that already committed must never
  be turned into a 500 or double-refunded; a redelivered webhook must not
  double-charge or double-reverse.
- No behaviour change for the common case (a single fully-paid booking with one
  charge) beyond what's described here.

## 5. Proposed design

### 5.1 Persist every provider charge's refundable reference

Add `payment_reference TEXT NOT NULL DEFAULT ''` and
`provider_refunded_at TEXT NOT NULL DEFAULT ''` columns to
**`processed_payments`** (migration). On finalize, record the session's provider
payment reference (`session.paymentReference`) there — for the booking session
_and_ for each balance session. `processed_payments` is already keyed by
`attendee_id` and has exactly one row per processed provider session, so it
becomes the complete, enumerable record of an account's charges.

The stored provider reference is owner-key encrypted. Checkout/webhook code only
needs the public key to write it; admin refund routes decrypt it inside an
authenticated request. Development rows created by the in-flight branch before
encryption remain readable so they do not strand refunds.

Rationale for `processed_payments` over a new `attendees` column: an attendee
can have more than one charge (deposit + balance, or several balances over time
as an admin re-opens a balance), so a single `attendees.payment_id` cannot hold
them all. `attendee.payment_id` stays as-is for backward compatibility and the
display path; the refund path stops depending on it.

Decision: use `processed_payments.payment_reference`. This keeps the charge
reference with the already-existing per-session idempotency row instead of
adding a second charge table.

### 5.2 Refund every charge for the account

Rework the refund handler so that, for an attendee, it:

1. Loads all `processed_payments` rows for `attendee_id` with a non-empty
   `payment_reference`.
2. Refunds each distinct reference at the provider, skipping rows already marked
   in `provider_refunded_at`. Each `refundPayment` is idempotent per reference;
   an already-refunded reference returns false and is treated as already-done,
   mirroring the existing already-refunded handling.
3. Falls back to `attendee.payment_id` when there are no `processed_payments`
   rows carrying a reference (older single-charge bookings), so existing
   single-booking refunds are unchanged.

If one provider charge is returned but another fails, the successful
`processed_payments` rows are marked with `provider_refunded_at` and the ledger
is not reversed yet. A retry resumes from the unreturned charge instead of
double-refunding the one that already succeeded.

The "no payment to refund" guard becomes "no refundable reference anywhere"
(neither `processed_payments` nor `payment_id`), so an admin-set balance that
was paid online is now refundable, while a truly never-charged attendee is still
blocked.

### 5.3 Reverse the whole account in the ledger

Generalise `computeAttendeeRefund` / `soleBookingOrder`:

- Keep the fully-paid guard (`balanceOf(account) === 0`) and the
  already-refunded short-circuit (`refund_cash` present).
- Instead of requiring a single group, reverse **every** event group on the
  account that isn't already a refund group: map each booking group with
  `mapRefund` (revenue/fee/modifier back to the attendee, cash → world as
  `refund_cash`), and reverse each `balance` group's payment leg the same way
  (its `refund_cash` is what sets the `refunded` flag and returns the balance
  cash). Post them as one atomic group set.
- Each reversal keeps `mapRefund`'s derived per-group refund event group, so a
  redelivery/re-submit still replays as a no-op.

The `refunded` projection is unchanged (any `refund_cash` sourced from the
attendee ⇒ refunded); reversing all groups guarantees it fires.

### 5.4 Persist the balance reference on settle

Thread `session.paymentReference` into the balance settle so §5.1's column is
populated. Smallest touch to `settleBalanceSession` (`payment-processing.ts`):
add one guarded statement to the settle batch that writes the reference to the
balance session's `processed_payments` row (alongside
`balanceFinalizeStatement`, same owed-guard so it only applies when the balance
genuinely settles).

## 6. Reservation behaviour change (intended)

Today, refunding a settled reservation refunds only the deposit at the provider
and punts the ledger to manual adjustment. After this change it refunds **both**
the deposit and the balance charge and reverses the whole account. This is the
intended improvement the "full rework" option accepts. It must be called out in
the PR description and covered by tests.

## 6.1 Status transition on balance settle (new Codex finding)

`settleAttendeeBalance` (`balance.ts:207-208`) always moves the attendee to
`getPaidDefaultStatus()` on settle. For a reservation that is the intended
"reserved → paid" lifecycle. But now that any status can pay online, a
non-reservation attendee in an **owner-defined status** is silently moved off it
when they pay — losing the status the admin set.

Decision: **only auto-transition reservations**. For reservations the
paid-default move is the designed lifecycle; for an arbitrary admin-set status
the operator's choice should win.

**Subtlety that makes this non-trivial:** that `UPDATE … SET status_id …`
statement is _also_ the settle's **verdict** — `results[0].rowsAffected === 0`
is how `settleAttendeeBalance` detects an amount mismatch (balance changed
mid-checkout) and refunds. So we can't just skip it for non-reservations, or
every non-reservation settle would report `amount_mismatch` and refund a valid
payment. The fix must split the two concerns: a verdict statement that always
fires when `owed === expectedAmount` (even setting status to itself), and a
_separate_ paid-default move gated on the current status being a reservation.
Both stay in the settle batch under the owed-guard.

Decision: split the settle verdict from the status move. The verdict statement
must still fire for every successful balance settle; the paid-default status
move only runs when the current status is a reservation.

## 7. Idempotency, edge cases, safety

- **Already refunded:** `refund_cash` present ⇒ ledger no-op; each provider
  reference refund is idempotent. A re-submit is safe.
- **Provider refunded but ledger post missed:** unchanged contract — surface
  `posted: false` so the admin sees it, never silently drop.
- **Partial provider refund:** returned charge references are marked on
  `processed_payments`; the whole-account ledger reversal waits until every
  charge for that attendee has been returned.
- **Still owing / holds credit:** `balanceOf !== 0` still punts to manual
  adjustment (an unpaid or over-paid account can't map cleanly).
- **Bulk refund** (`refund-all`) uses the same `getRefundable` filter and
  `recordAttendeeRefundsBatch`; both must be updated for the multi-reference /
  multi-group shape and re-tested for the SQLITE_BUSY batching behaviour.
- **Historical settlements:** acceptable because there are no existing balance
  settlements. Balance charges settled _before_ §5.1 ships would have no stored
  `payment_reference` (the `pi_` was discarded), so their balance charge could
  not be auto-refunded. A backfill can populate booking references from
  `attendee.payment_id` but cannot recover lost balance references.
- **Pruning:** old `processed_payments` rows are only removed when they no
  longer help a future refund: terminal failures after the retry window,
  finalized rows with no reference, missing attendees, or attendees that already
  have the ledger's `refund_cash` record.

## 8. Out of scope (track separately)

- The overstated `depositPaid` / `fullPrice` display (Codex #1) — pre-existing,
  affects reservations equally; fixing it means making `pricePaidFromLedger` (or
  the summary) report cash received rather than the gross sale leg. Separate PR.

## 9. Test plan

- Settle writes encrypted `payment_reference` to the balance session's row; only
  when the balance genuinely settles (owed-guard), and a mismatch writes
  nothing.
- Stored provider references are not plaintext at rest and decrypt through the
  admin private key path.
- Non-reservation, provider-less/admin-set, empty `payment_id`: pays balance
  online → admin refund returns the balance charge, reverses both groups, sets
  `refunded`, no "not recorded".
- Reservation deposit + balance: admin refund returns **both** charges and
  reverses the whole account; `refunded` sets.
- Partial provider failure: a returned charge is durably marked, the ledger
  stays unreversed, and a retry only returns the remaining charge.
- Idempotency: re-submitting a completed refund is a no-op (no double provider
  refund, no duplicate legs).
- Pruning keeps old processed-payment rows while their references are still
  useful for refund recovery, then removes them after the attendee is refunded.
- Single fully-paid booking (one charge, one group): behaviour unchanged.
- Bulk refund over a mix of the above.
- Guard: a never-charged attendee (no references anywhere) is still rejected.
- Mutation: target `deno task mutation` on the new/changed units
  (`refund-ledger.ts`, the settle statement, the reference query). Note the
  whole-file precommit mutation gate on the large `payment-processing.ts` is not
  achievable from the changed tests alone; CI does not gate mutation (test.yml
  runs lint/typecheck/cpd/build/coverage), so coverage + targeted mutation on
  the changed units is the bar here.

## 10. Risks

- Touches shared money code (`refund-ledger.ts`, the settle path, a schema
  migration). Highest-risk area in the codebase.
- Schema migration on `processed_payments` needs the standard migration + backup
  considerations.
- Reservation refund behaviour changes (§6) — must be deliberate and tested.

## 11. Rollout

Implement in this PR:

1. Migration: `processed_payments.payment_reference` and `provider_refunded_at`.
2. Persist the reference on booking finalize and balance settle.
3. Refund handler: refund all references; update the "refundable" guard/filter.
4. Ledger: whole-account reversal in `computeAttendeeRefund` + batch path.
5. Tests (§9) + targeted mutation; update the PR title/description.
