# Review of the staged-checkout hardening plan

Reviewed against PR #1764 at `4236e09a`.

## Overall assessment

The report found several real defects, especially around pending-stage admin
edits, terminal validation failures, non-pending stage re-entry, quantity-zero
capacity checks, and parent annotation. Its proposed remedies need substantial
changes before implementation, however.

The main problem is P1's default: refunding every staged activation exception
except `DatabaseBusyError` is unsafe. Capacity, stock, price, and listing
availability failures already have typed business outcomes. An exception means
the system does not know what failed. Automatically moving money after an
unknown database, encryption, schema, or invariant error can turn one fault into
a live-ticket-plus-refund incident. Recovery must first recover a proven commit;
otherwise it must rethrow.

The plan should also stop treating a pending stage as something that can be
repointed through an attendee merge. The staged line set belongs to the staged
attendee. Repointing only `checkout_stages.attendee_id` cannot make an arbitrary
merge target match that line set.

Finally, the guarded-batch activation rewrite should not be deferred. The
current activation uses replica-backed preflight reads, does not guard the write
itself with `quantity = 0`, and performs an input-sized interactive transaction.
Those are correctness and bounded-round-trip issues in the new money path, not
optional polish.

## Current branch state

Before this stacked work merges, PR #1764 must be reconciled with current
`main`. Its CI test and deploy jobs pass, but its merge check currently reports
conflicts in six files, including `ticket-payment.ts`, attendee creation, and
their tests. Keep that conflict resolution on #1764 itself so the stacked PR
reviews only the hardening work.

## Item-by-item response

### P1: terminal handling for staged activation errors

**Verdict: the symptom is real, but the proposed policy is rejected.**

Expected capacity and modifier-stock refusals already return structured results
and reach `storeRefundedBooking`. The errors that currently rethrow are stage
identity changes, an already-active row, encryption failure, lost finalization,
and other invariant or infrastructure failures. Those must not all be relabeled
as safe refund decisions.

Replace generic "recover or refund" exception handling with:

1. Recover when primary committed state proves this exact payment finalized to
   the attendee with the prepared ticket token.
2. Return typed business refusals from the activation mechanism for capacity,
   stock, closed listing, and other expected customer outcomes.
3. Rethrow every other exception.

Do not special-case `DatabaseBusyError` in payment recovery. The request
boundary already presents it as retryable, and committed-state recovery must
run before deciding whether any exception is rethrown.

The activation transaction itself should distinguish a capacity/stock guard
miss from an identity/state guard miss. A single `ActivationRefused` covering
both is too broad.

### P2: admin mutation guard

**Verdict: accepted, with a narrower policy.**

Block only mutations that can invalidate checkout-owned state or report a save
that payment completion will overwrite:

- Unified attendee edit.
- Attendee logistics/address edit.
- Merge when either source or target has a pending checkout.

Do not add the guard to servicing. A staged checkout is an ordinary attendee,
while servicing routes load only `kind = "servicing"`.

Do not blanket-gate check-in, resend, refund, refresh-payment, or bulk actions.
Their existing real-quantity/payment-reference guards already reject pending
quantity-zero rows. Notes are safe and should remain available.

Delete needs its own policy:

1. A normal attendee uses normal deletion.
2. An unclaimed pending checkout uses the existing guarded stage discard.
3. A pending checkout already claimed by `processed_payments` cannot be deleted.
4. Never fall back to ordinary deletion when guarded discard returns zero.

Add a batched `attendeeIdsWithPendingStage(ids)` query for the selected guards
and view models. Show **Checkout pending**, not **Payment in progress**: the
customer may simply have abandoned the provider page. Hide edit, logistics,
merge, SMS, email, and resend actions that cannot produce a durable result.
Keep notes visible. Make pending state explicit in attendee CSV output rather
than exporting an indistinguishable no-quantity row.

All copy belongs in the locale catalog.

### P3: merge repoint and hidden stage lookup

**Verdict: reject both proposed mechanisms.**

Do not repoint a pending stage during merge. The target may have extra lines,
conflicting line choices, another stage, or different PII. Merely changing the
attendee id leaves activation unable to prove that the target is the staged
order. Reject pending source and pending target merges atomically. When deleting
a terminal source attendee, delete its obsolete terminal stage with the other
dependent rows.

Do not make `storeRefundedBooking` look up a stage internally. The payment
processor already needs the stage for activation. A hidden second lookup adds a
primary round trip, decrypts the token twice, and lets the refund function
silently discover booked, failed, or dangling stages. Resolve the stage once,
after ledger replay, validate it as pending, and pass that explicit value to
activation or stored-refund handling.

### P4: quantity-zero staging on an overbooked listing

**Verdict: valid, but bare `allowOverbook: true` is rejected.**

The current capacity predicate rejects quantity zero when an active listing is
already over capacity. This is reachable through direct QR checkout. However,
`allowOverbook: true` removes the complete write guard, including the live
listing and `active = 1` checks. That would weaken the existing race protection
for a listing deactivated after provider-session creation.

Add a staging-specific guarded insert, or extend the shared capacity statement
so quantity zero bypasses numeric listing/group capacity while still requiring
the listing to exist and remain active. Tests must use an already-overbooked
listing, not an exactly-full one, and must keep the inactive-listing regression.

### P5: terminal validation failures

**Verdict: valid and should be unified.**

Inactive or registration-closed validation currently refunds before the staged
placeholder path runs. The stage remains pending, lacks its provider payment
reference, and has no placeholder ledger or system-note record.

Make validation return typed data instead of performing a refund itself. The
payment processor can then route a trusted paid staged session through the same
stored-placeholder path used for deleted listings, capacity, stock, and price
failures. The stage must transition pending to failed under a guard, retain the
payment reference, record the payment/refund ledger facts, add the note, and
persist the terminal payment result.

Keep provider side effects out of validation helpers.

### P6: non-pending stage re-entry

**Verdict: the bug is valid; returning an unconditional handled 200 is not.**

After durable ledger/failure replay has returned no result, a `booked` or
`failed` stage is an inconsistent state. The stage alone does not prove whether
a provider refund, ledger write, or booking completion finished. Returning
`alreadyHandledSession` would hide that missing durable fact.

Run ledger replay before loading the stage. Then:

- Load the stage once with an `OrNull` API.
- Allow activation/refund processing only for a pending stage.
- Throw a descriptive invariant error for an unrecorded booked or failed stage.
- Guard pending-to-booked and pending-to-failed transitions by session,
  attendee, current state, and exactly one affected row.

If automatic recovery of a failed stage is later required, it needs durable
refund-intent/provider-outcome state. Do not guess from the stage label.

### P7: parent annotation symmetry

**Verdict: valid latent contract bug.**

Staging eventually runs `annotateOrderParents`; activation currently compares
unannotated `orderBookings` output. Current public parent flows normally carry
allocations, but an internal or future no-allocation parent/child order can
produce mismatched four-part booking keys.

Normalize inside `activateStagedBooking`, not only in
`createAttendeeForSession`, so every activation caller uses one path. Use the
normalized bookings for both comparison and updates. Replace the manually
synchronized test with a real parent/child stage without allocations and
activate it end to end.

### P8: checkout expiry and retention

**Verdict: split by provider; reject a universal 60-minute contract.**

Provider capabilities differ:

- Stripe supports `expires_at` from 30 minutes to 24 hours. A Stripe-specific
  60-minute policy is valid with explicit range validation.
- SumUp Hosted Checkout is available for 30 minutes, while this code currently
  omits the underlying checkout's `valid_until`. Set that deadline explicitly
  to match the hosted page rather than claiming it honors 60 minutes.
- Square Payment Links have no timed-expiry field. Deletion needs the Payment
  Link id, which the current adapter discards in favor of the order id.

Replace the provider interface's single completed-event contract with a
provider-owned lifecycle result:

```ts
type CheckoutLifecycle =
  | { kind: "paid"; session: ValidatedPaymentSession }
  | { kind: "closed"; sessionId: string }
  | { kind: "skip" };
```

Stripe maps completed and expired events. SumUp maps paid and expired status
changes. A closed event runs guarded pending-stage discard. Square continues to
report paid events until Payment Link ids and deletion are implemented.

Adding `checkout.session.expired` to new Stripe endpoints is not enough:
existing endpoints are not reconciled when the stored secret is unchanged. Add
an endpoint update/reconciliation path.

Remote Stripe cancellation is optional but must use safe ordering: expire the
open remote session first, then discard locally. If expiration loses a race to
payment, retain/retrieve the session instead of showing a false cancellation.
`discardPendingCheckoutSessions` cannot by itself see a remote payment whose
webhook has not arrived.

Keep seven-day local pruning as a conservative PII-retention fallback, not as a
promise that provider checkout links expire then.

The free-text string coupling needs a real fix, not only documentation. String
rows are created before the stage, have an independently configurable seven-day
retention, and are pruned independently. A still-valid stage can therefore lose
its answer text silently. Store pending-stage string references in a queryable
relation and exclude them from `pruneUnusedStrings` until the stage closes.

### P9: polish

Classify the listed work as follows.

**Do in this stacked PR:**

- Use the existing `inPlaceholders` helper.
- Rename `getCheckoutStage` to `getCheckoutStageOrNull` and migrate all callers;
  do not keep an alias.
- Run ledger replay before stage lookup/decryption.
- Use update builders for equality-only updates where they preserve the exact
  guard.
- Make activation reads primary-backed or, preferably, remove their authority
  by putting all checks in the guarded write batch.
- Pass already-loaded listing data into staging. All production callers already
  have it; remove the broad post-provider listing re-fetch.
- Batch the failed-stage PII update and pending-to-failed transition.
- Batch email/phone contact-activity writes instead of starting concurrent
  SQLite writers.
- Make the processed-payment test fixture execute the real guarded finalize
  statement rather than reproducing production SQL.
- Decide the stored `provider` field now: either wire it into lifecycle cleanup
  and provider-switch handling, or remove it before the migration ships. Do not
  retain an unread field.

**Do not do:**

- Do not export `DEPENDENT_ROW_TARGETS`. Checkout cleanup intentionally keeps
  the stage row until dependent attendee deletes finish; the generic list also
  includes tables with different lifecycle semantics.
- Do not force `checkout_stages` through `defineTable`. It is a transactional
  lifecycle table with narrow custom reads and guarded writes, not generic CRUD.
- Do not merge cancel and redirect payment-status checks under an "unpaid"
  helper. Their semantics differ. Share only the SQL definition of an
  **unclaimed pending stage** where that condition is duplicated.

**Can follow separately after correctness is green:**

- Extract a neutral attendee-result projection to remove the create/recovery
  import cycle. Do not add aliases and do not force distinct money/date sources
  through a misleading mapper.
- Reuse PR #1775's `createSystemNoteOnce` after that PR lands.

Also fix the existing placeholder-refund note while this flow is being touched:
it renders an owner-only ledger link to managers and editors. Use plain text or
gate the link with the target route's owner permission, and add role-specific
rendering coverage.

## Revised implementation order

1. Reconcile #1764 with current `main` and restore a green merge check.
2. Replace staged activation's input-sized interactive transaction with the
   shared guarded-batch mechanism. Guard quantity zero, exact path identity,
   unresolved payment ownership, capacity/stock, and pending stage transition
   in the write batch.
3. Rewrite unexpected exception recovery as recover-proven-commit-or-rethrow.
4. Centralize one post-ledger stage lookup and guarded stage transitions.
5. Make validation side-effect free and route every typed staged business
   failure through one terminal stored-placeholder path.
6. Add focused pending-checkout admin guards, claim-aware deletion, badges,
   action visibility, and CSV state.
7. Fix quantity-zero staging capacity while preserving active/existence guards.
8. Normalize parent annotation inside activation and replace the synthetic test.
9. Add provider lifecycle results, Stripe/SumUp expiry handling, endpoint
   reconciliation, and protected pending free-text references. Keep strict
   Square expiry as a separate feature unless Payment Link ids are persisted.
10. Apply the accepted cleanup items and remove dead/unread surfaces.

Each step must preserve one path for staged and non-staged payment outcomes
where their persisted inputs are the same. Do not add compatibility aliases or
parallel single-item APIs.

## Regression coverage

At minimum, add direct tests for:

- Typed capacity and stock refusals refund and terminate exactly once.
- Lost committed result recovers the ticket; an unproven exception rethrows and
  does not refund.
- Pending stage state and quantity guards are enforced inside the write batch.
- Closed/inactive staged validation stores one failed placeholder, note, payment
  reference, and refund ledger result.
- Unrecorded booked/failed stage state fails loudly rather than reactivating.
- Pending admin edit, logistics, merge source, merge target, and claimed delete
  mutate nothing; an unclaimed delete discards safely; notes remain allowed.
- An active already-overbooked QR checkout stages quantity zero, while an
  inactive listing still cannot stage and activation still enforces real
  capacity.
- Parent/child no-allocation staging and activation agree end to end.
- Stripe expiry and SumUp closed status discard only unclaimed pending stages;
  existing Stripe endpoint setup is reconciled.
- Pending free-text references survive string pruning and are released when the
  stage closes.
- Manager/editor surfaces never render the owner-only ledger link.

Use focused test files under the existing 400-line limit; do not grow the
already large staging suite further.

## Verification

- Use `deno task test:files` for focused work.
- Finish with `deno task precommit`.
- Do **not** run mutation tests on this branch. This is an explicit user
  instruction and replaces the original plan's `precommit:mutation` step.

## Final recommendation

Proceed with a stacked hardening PR, but do not implement the pasted plan as
written. Keep its bug inventory, replace the broad auto-refund and merge-repoint
policies, pull guarded activation into scope, and split checkout lifecycle by
actual provider capability. Those changes make the plan consistent with the
repository's fail-loud money rules and its one-path, bounded-round-trip design.
