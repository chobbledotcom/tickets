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
- **Codex: deleted-listing + held-cash + refund-retry round** (ecb5f81,
  db71893, 0ffd541). Seven more findings from the delete/mid-payment race and
  the held-cash model, all with fail-before regression tests:
  - The owner-only Ledger tab and the standalone `/admin/ledger/:type/:ref/add`
    write both hide/refuse while a checkout is pending, so a manual leg can't
    combine with activation's own legs into a surprise balance.
  - The Edit tab renders a locked "Deleted listing" row (never throws) for a
    kept record whose listing was deleted mid-payment, and the Actions tab
    hides for it (its routes 404 when the home listing is gone).
  - Deleting a listing is refused while any attendee on it holds unreturned
    conflict cash (the delete would cascade the booking line the refund needs).
  - The held-cash no-quantity guard only blocks a save that removes the active
    home line the in-app refund needs, not every no-quantity edit.
  - A staged order whose provider refund fails stays retryable (no ledger
    legs, stage pending) so the next delivery re-attempts it, instead of going
    terminal and stranding the money.

Every Codex review thread on the PR is answered.

---

## Review items #8–#10 — shipped

### #8 admin lifecycle — shipped (880ac8e, 4c8aeff)

- The attendee page hides the Edit, Logistics, and Actions tabs (and the
  send-email button) while a checkout is pending; a hidden tab's URL 404s and
  a banner alert explains the locked state. A raced edit or logistics save
  redirects to the always-visible overview with the refusal as a flash.
- Every attendee row carries a `pending_checkout` flag (projected per row in
  the one shared attendee SELECT), so tables say "Payment in progress"
  instead of "No quantity", and the CSV exports gain a conditional "Checkout
  pending" column.
- A note's owner-only ledger link renders as plain text for non-owner admins
  (`withoutLinksTo`), across the banner, the list summaries, and the
  delete-note page.
- A booking row that outlives its listing shows as a plain "Deleted listing"
  placeholder in the bookings table instead of disappearing — no dead link.

### #9 provider lifecycle — resolved

- **Remote expiry on local discard: in place, and the order is deliberate.**
  The cancel path discards locally FIRST (the discard's "no payment claimed
  this session" guard is what makes closing the remote session safe), then
  best-effort `expireCheckoutSession` (Stripe implements it). Every gap — a
  failed expire, a provider with no expiry API, a pruned stage paid weeks
  later (Square links never lapse) — lands on the designed no-stage
  fresh-booking path. Reordering would lose the claim guard for no safety
  gain, so this stays as is.
- **SumUp EXPIRED: handled.** EXPIRED maps to the terminal `failed` status,
  which the redirect/validate path answers with discard-the-staged-details +
  the friendly cancel page (same as a declined card). Locked with a direct
  provider-mapping test.
- **Stripe webhook endpoints: reconciled on setup.** Setup now lists the
  account's endpoints and removes every one on OUR webhook url (plus the
  recorded id, which may point at an old url) before recreating — a stray
  left by a lost-id setup (e.g. a database restore) would otherwise fail
  verification on every delivery forever.
- **Queryable stage relation: shipped with #8** (`pending_checkout` per-row
  projection, `attendeeIdsWithPendingStage`, `listingHasPendingCheckout`,
  `hasPendingCheckout`).

### #10 repo cleanup — shipped

- `DEPENDENT_ROW_TARGETS` is no longer exported. The three parallel purge
  implementations (single-attendee delete, orphaned-attendee purge, and the
  pending-checkout discard) now all build from one mechanism in `delete.ts`:
  `attendeePurgeStatements` (internal) run through `runAttendeePurge` — a new
  dependent table is cleaned by every purge path automatically, and the
  orphan purge gained the `service_costs` parity it previously special-cased.
- No file this branch touched exceeds the grandfathered limits, and every
  helper added here has production callers (no alias/test-only exports).
- The PR title/description are rewritten in plain language as the final step.

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
