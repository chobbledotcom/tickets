# Plan: staged-checkout hardening (PR #1802)

This branch (`claude/branch-review-comparison-pcwbvd`, PR #1802) targets `main`
and contains the whole staged-checkout system: the original P1–P9 hardening
(see git history / the PR description) plus the review items and every Codex
finding worked through below. Everything ships with regression tests that fail
before the fix (repo rule) and a green `deno task precommit`.

---

## Shipped

- **P1–P9** — the original hardening of the staged flow (terminal paths,
  pending-stage guards, expiry/retention, polish).
- **Item 1 — a gone stage is an impossible state, not a recovery** (37492fb).
  `findStageProblem` (zero rows) and `getCheckoutStageOrNull` (dangling pending
  stage) throw instead of booking fresh around a missed cascade. Earned by
  blocking admin delete of a mid-payment record, blocking listing deletion
  while it has a pending checkout, and cascading `checkout_stages` in the
  orphan purge.
- **Item 6 — validate before the provider** (7a60e5c). `createStagedCheckout`
  checks real-quantity availability and `active = 1` BEFORE creating the
  provider session; an unbookable order is refused with
  `public.checkout_unavailable` and never reaches the provider. The dead
  balance-attendee branch was removed (only new bookings run through here).
- **Item 3 — money model DECISION: keep all legs at activation** (0f95fb1).
  The "owed legs at staging" design was dropped by the operator's call:
  an event group is immutable once posted (no growing it with a later payment
  leg), per-row `price_paid` is sale-scoped to one stamped event group, and —
  decisively — a pending stage with NO legs is excluded from every ledger sum
  for free, so the totals are identical with none of the rework. Activation is
  already atomic. The no-seat-holding policy is documented in AGENTS.md.
- **Item 2 (core) — the activation `booked` flip is a compare-and-set**
  (d73c4f0): only this attendee's still-pending stage may flip, exactly one
  row, or the whole activation rolls back.
- **Codex: delete/stage race** (5818fbb). `deleteListing` no longer cascades a
  pending-staged attendee's rows, so a delete slipping past the preflight guard
  leaves the paid order whole.
- **Codex: record money before exposing it** (21ed057). Both terminal
  staged-refund paths post the held-payment leg BEFORE stamping the provider
  payment reference; a failed placeholder post on a staged order throws (stage
  stays pending, redelivery retries) instead of going terminal unrecorded.
- **Codex: held-conflict-cash guards** (99a13da, 6f49011). A `stage_active`
  conflict leaves a `payment` leg with no sale ("held cash").
  `attendeeIdsHoldingUnreturnedCash` (primary-pinned, batch) now blocks
  no-quantity edits, deletes, and merges until the cash is refunded.
- **Codex: heal path stamps the payment reference** (26ccc4e). The
  orphan-ledger heal rebuilds the stored payment details a crash lost, so the
  kept record's payment panel and refund path always resolve.
- **Codex: paid-stage prune — ACCEPTED EDGE, no code change** (fa8b15d, by the
  owner's call). A paid-but-stuck stage (3+ days of failing
  refunds/processing) can be pruned at 7 days; the money stays captured at the
  provider and the operator is alerted on every failing delivery, so they
  reconcile long before the prune. Documented with the future hard-fix paths
  in TODO.md.

Every Codex review thread on the PR is answered.

---

## In progress — the remaining review items, in order

### #8 admin lifecycle (NEXT)

How a mid-payment (pending-staged) record and its unusual siblings surface in
the operator UI. Server-side blocks exist; the UI still renders dead controls:

- Hide/disable edit, logistics, merge, resend, SMS, email, and delete for a
  pending record (delete is blocked server-side but the button still renders —
  "never render a dead or forbidden link").
- "Checkout pending" wording: a clear state indicator on the record page and
  in the attendee tables/CSV.
- Owner-gate the ledger link in refund notes.
- A renderable "deleted listing" placeholder line in the bookings table
  (recorded in TODO.md — a deleted-listing booking row currently disappears
  from the table while its data stays intact).

### #9 provider lifecycle

- Expire the remote provider session before a local discard.
- Handle SumUp EXPIRED.
- Reconcile existing Stripe webhook endpoints.
- A queryable stage relation for operator visibility.

### #10 repo cleanup

- Stop exporting raw `DEPENDENT_ROW_TARGETS`.
- Split files over ~400 lines that this work grew.
- Remove any remaining alias/test-only exports.
- Keep this file current; rewrite the PR title/description in plain language
  when the work lands.

### Not picked up (deliberately)

- **#5** batch `activateStagedBooking`'s interactive transaction — recorded in
  TODO.md ("Batch activateStagedBooking's interactive transaction"): a
  substantive money-path rework wanting its own focused mutation run.
- **#7** side-effect-free validation — partially superseded by item 6 (the
  preflight refusal is already a returned value); the remaining
  refund-inside-validateAllItems reshaping can ride with #9's provider work.

## Verification

- Per slice: targeted `deno task test:files` on the touched suites.
- Per commit: full `deno task precommit` (typecheck incl. tests, strict lint,
  full suite, 0% duplication, 100% coverage).
- `deno task precommit:mutation` before merge.
