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

## In progress — item 6 + item 3 as one change: the staged-checkout money model

Locked design (from the review discussion). The whole flow is:

1. **Staging (before payment).** Fully validate the order — **real-quantity**
   availability, `active = 1` listing, valid lines. If anything is off, stop and
   tell the customer **before** the provider session is created (reorder
   `createStagedCheckout` so validation precedes session creation). If it is
   plausible, save the whole booking at **quantity 0** with the **owed** (sale)
   ledger legs (reuse the existing owed-only poster in `checkout-complete.ts` —
   sale legs, no payment/fee).
2. **Payment happens.**
3. **Activation (after payment).** Set the real quantities and add the
   **received-funds** (payment) legs. The booking + owed are already saved, so
   this step is small and robust.

The only two failure situations become:
- **Before payment:** the customer is told clearly and is never sent to the
  provider.
- **After payment:** the full booking is already saved and the ledger is
  accurate, so we can complete it or warn the operator.

### We never hold a seat (document in AGENTS.md)

Quantity-0 staging means a checkout **never reserves a seat**. First payment to
land wins; a second person paying for the genuinely-last seat is refunded (rare,
handled by the refund path). We do **not** reserve because holding seats invites
botting and ghost-checkout lockouts on exactly the scarce listings where it
hurts most. This has come up repeatedly — it is policy.

### Staged ledger entries are excluded from sums, and deletable on abandon

Two deliberate ledger-policy points (document in AGENTS.md alongside the
append-only rule):

- **A pending stage's ledger legs do not count in any ledger sum.** The
  exclusion is **derived from the link** — a leg is skipped whenever its
  attendee currently has a pending checkout stage (leg → attendee → pending
  stage). There is **no `staged` boolean** on transfers; the stage state is the
  single source of truth. The instant the stage flips to `booked` (payment
  landed) the leg counts automatically; no separate "confirm the ledger" write.
  Implementation note: the sums are SQL aggregates spread across
  `accounting/projection-sql.ts`, `accounting/queries.ts`,
  `accounting/listing-money-totals.ts`, `db/listing-overview-stats.ts`, and the
  `allBalances` fold in `ledger/project.ts` over rows from `accounting/rows.ts`
  — the "exclude pending-staged attendees" filter must thread through the shared
  sum-SQL, not one place.
- **Pruning an abandoned/expired staged checkout deletes its ledger legs.** This
  is the sanctioned exception to append-only: a pending stage's legs never
  counted, so deleting them alongside the attendee/rows is clean (not a
  reversal), and it keeps the ledger from bloating with the majority-of-checkouts
  that are abandoned.

### This also resolves two Codex findings

- *"paid stage pruned as abandoned"* — the prune only ever deletes stages that
  are still `pending` (never counted); a paid stage has flipped to `booked`, out
  of the prune's reach.
- *(item 8)* *"no-quantity edit strands held conflict cash"* — folded into the
  admin-lifecycle work below.

### Build order (green, committed slices)

1. Staging side: reorder validation before the provider session; full
   real-quantity + `active` check; fail-to-customer. **(self-contained, no
   ledger changes)**
2. Owed legs at staging; received legs only at activation.
3. Exclude pending-staged legs from ledger sums (derived from the link).
4. Delete legs when discarding/pruning an abandoned stage.
5. AGENTS.md: no-seat-holding + the staged-ledger exception.
6. Tests throughout.

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
