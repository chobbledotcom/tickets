# Payment aggregate — lessons from the closed rewrite

The payment-aggregate rewrite (PRs #1962 and #1973) was closed without merging.
Origin: `TODO.md` at the time it was retired; the file is deleted, and this
document keeps the record. Before it closed, the branch went through repeated
adversarial review and a coverage audit. The full record — around forty-five
findings, each tied to a file and line on that branch — is in `TODO.md` at
commit `3cf6929b` on `base/payment-aggregate` (also reachable as
`refs/pull/1962/head`). The table-hardening slice is at `369977cf`
(`refs/pull/1973/head`). None of that branch's code is on main, so the findings
are not jobs here — they are the failure map for the redo that PLAN.md plans.

The one finding that applied to main's current code — `performListingDelete`
removing the stored attachment file before the database delete, so a failed
delete batch left a live listing with a dead attachment link — is fixed: the
database delete now runs first, pinned by a fault-injected regression test in
`test/shared/listings-actions.test.ts`.

## Failure shapes the redo must design out

Each of these was found, and most were confirmed, on the rewrite. They are worth
reading in full at the commit above before re-attempting the aggregate; in one
line each:

- One stuck item must never block the queue behind it: a saved owner decision
  the provider kept refusing halted every checkout, completion and refund; one
  unredactable payment halted all payment-history redaction and the pruning
  behind it.
- "Cannot reach the provider" and "the provider said no" must be different
  outcomes. Collapsing them turned permanent refusals into forever-retries — on
  checkout creation, on refund reads, and on unmapped refund states.
- Deferred work must run from facts saved when the money moved, not from live
  rows an owner may have edited since — quantity, currency, recipient, and the
  booking itself all drifted between capture and completion.
- Every migration copy path needs an answer for imperfect history: a payment
  whose listing was deleted, whose reference lives only on the attendee, or
  whose two provider ids split across pages either failed the whole upgrade or
  silently lost evidence.
- Money-adjacent actions must be exact about their targets: a "refresh" that
  could refund, a refund list that included charge-less payments, and a
  confirmed refund that never reached the ledger all moved or lost money on
  paper.

## Checked against main and not applicable

Recorded so nobody re-raises them here: SumUp amounts convert once at checkout
creation (no stored retry); emails send inline reading the config at send time
(no queue to go stale); the attendee merge already fences live payment rows
(`assertRowsFreeToMove`); Square's `order_id` is already optional in
`src/shared/square/payment-outcomes.ts`; the success redirect already clears
session tokens, and a revisit renders without them.

## Process lessons for the redo

- Build coverage with each slice, not after. The gate wants every line and
  branch covered, guards usually sit in functions the module does not export,
  and CI forbids exports that only tests use — so a guard is only reachable
  through the public entry points, and retrofitting that across twenty-six files
  at once is what kept the rewrite red.
- Keep each PR under about three hundred changed files, or the automated
  reviewer skips it entirely. The other reviewer re-reviews every push and opens
  a fresh thread per finding each time, so answer the newest thread per finding
  and batch pushes.
- The two wording tables in the rewrite's `format.tsx` — every case reason and
  every resource kind keyed to catalog words, so a new one cannot be added
  silently — are the pattern to reuse for payment-case copy.
