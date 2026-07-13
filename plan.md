# Plan: staged-checkout money model

This branch (`claude/branch-review-comparison-pcwbvd`, PR #1802) now targets
`main` directly and already contains the whole staged-checkout system: the
original P1–P9 hardening (see git history / the PR description) **plus** the
post-review work below. Everything here ships with regression tests that fail
before the fix (repo rule) and a green `deno task precommit`.

---

## Shipped

- **P1–P9** — the original hardening of the staged flow (terminal paths,
  pending-stage guards, expiry/retention, polish). Merged into this branch.
- **Review item 1 — a gone stage is an impossible state, not a recovery.**
  `findStageProblem` (zero rows) and `getCheckoutStageOrNull` (dangling pending
  stage) now throw instead of booking fresh around a missed cascade. Dropped
  `stage_gone` and the `createFresh` recovery (kept `createFresh` for the
  genuine no-stage path). To earn the throw: admin delete of a mid-payment
  record is blocked, listing deletion is blocked while it has a pending checkout
  (`listingDeleteError` on all three delete paths), and the orphan purge
  cascades `checkout_stages`. Fixed the "or delete the record" copy.

---

## Item 6 — validate before the provider (shipped, slice 1)

`createStagedCheckout` now fully validates the order **before** creating the
provider session: the real quantities must fit and every listing must be on sale
(`checkBatchAvailability`), or the customer is told up front
(`public.checkout_unavailable`) and never sent to pay. It is the single
chokepoint every new-booking entry point routes through, so no sold-out or
off-sale order can reach the provider. The dead balance-attendee branch was
removed (only new bookings run through here). Committed with refuse tests for an
overbooked and an off-sale listing.

## Item 3 — staged money model: DECISION (keep legs at activation)

The locked design was "owed legs at staging, received legs at activation." On
deep inspection this conflicted with the ledger's core invariant and bought
nothing, so **the operator chose to keep all legs at activation** — no
owed-legs-at-staging, no two-group split. Why:

- **The ledger posts an event group as one immutable set.** `assertEventMatches`
  rejects a replay that adds or omits a leg, so you cannot post owed legs at
  staging and grow that group with the payment leg later. Owed-at-staging would
  have to be **two** event groups (the balance-payment pattern).
- **Per-row `price_paid` is sale-scoped to the row's single stamped
  `ledger_event_group`** (`select.ts` `pricePaidFromLedger`), and the
  "incomplete sale" detection assumes the payment leg shares that group
  (`listing-overview-stats.ts`). A two-group split needs careful handling to
  avoid misreading paid bookings.
- **A pending stage is excluded from sums for free.** Because activation posts
  every leg and staging posts none, a pending staged booking has **zero** ledger
  legs — it contributes nothing to any sum, and its quantity-0 rows claim no
  capacity and show no money. So the totals are identical to the owed-at-staging
  design, with none of the rework.
- **Activation is already atomic** (one transaction: set quantities + post all
  legs + finalize payment + flip stage), so there is no partial-state bug to fix.

Consequences: slices 2–4 (owed-at-staging, exclude-pending-from-sums,
delete-legs-on-abandon) are **unnecessary** and dropped. A pruned/abandoned
pending stage just deletes its quantity-0 attendee + rows (no legs to delete).

### We never hold a seat (still document in AGENTS.md)

Quantity-0 staging means a checkout **never reserves a seat**. First payment to
land wins; a second person paying for the genuinely-last seat is refunded (rare,
handled by the refund path). We do **not** reserve because holding seats invites
botting and ghost-checkout lockouts on exactly the scarce listings where it
hurts most. This has come up repeatedly — it is policy.

### Remaining item-3 Codex findings

- *"paid stage pruned as abandoned"* — the prune only ever deletes stages still
  `pending`; a paid stage has flipped to `booked`, out of the prune's reach.
  Verify a direct test covers this.
- *"deleted-listing refund reuses an empty staged attendee"* (store-refund.ts) —
  the delete/stage race can strand a paid order on a staged attendee whose rows
  were cascaded away. Restore the signed ghost rows (or close the race).

---

## Remaining review items (not yet started)

- **#2** stage transitions as compare-and-set (session id + attendee id +
  `state='pending'` + exactly-one-affected-row).
- **#5** rewrite `activateStagedBooking`'s input-sized interactive transaction as
  a guarded batch (create-batch.ts pattern).
- **#7** make validation side-effect free (return a typed refusal).
- **#8** admin lifecycle: hide edit/logistics/merge/resend/SMS/email while
  pending (delete now joins this list — it's blocked server-side but the button
  is still rendered); "Checkout pending" wording; pending state in tables/CSV;
  owner-gate the ledger link in refund notes; the no-quantity-edit-strands-cash
  fix.
- **#9** provider lifecycle: expire remotely before local discard; SumUp
  EXPIRED; reconcile existing Stripe endpoints; queryable stage relation.
- **#10** repo cleanup: don't export raw `DEPENDENT_ROW_TARGETS`; split large
  files; remove any remaining Stripe alias/test-only exports; keep this file
  current.

## Verification

- Per slice: targeted `deno task test:files` on the touched suites.
- Per commit: full `deno task precommit` (typecheck incl. tests, strict lint,
  full suite, 0% duplication, 100% coverage).
- Rewrite the PR description in plain language when the money-model change lands.
