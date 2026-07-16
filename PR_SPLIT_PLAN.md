# Staged-checkout branch split plan

## Goal

Rebuild staged checkout as small changes from current `main`. The monolithic
reference branch remains useful for behavior and tests, but it must never be
merged or cherry-picked as a whole.

The final checkout flow must still obey the core product rule: starting a
checkout never reserves capacity. Staged listing rows have quantity zero. The
real quantity is written only after payment, with the capacity check in the
same atomic database operation. First completed payment to claim the last seat
wins. A later completed payment that cannot fit is refunded.

## Operating assumptions

These assumptions are part of the product design, not temporary omissions:

- Only the latest edge script runs. We do not support overlapping script
  versions or an older script continuing to write after a deployment.
- Deployments and host moves happen when no checkout or payment needs to
  survive the change. We do not support rolling back application code around
  an open payment.
- Backups are restored only during a quiet host migration or another deliberate
  recovery while the site is not busy. An open checkout or refund does not need
  to survive backup and restore.
- Restoring an unexpected open checkout is allowed to discard its stage and
  quantity-zero attendee. Completed bookings and completed payment records
  remain ordinary durable data and must still restore normally.

If any of these assumptions changes, mixed-version payment fences and stable
backup certification must be designed again before relying on that new
operating model.

## Why checkout stages remain

`checkout_stages` is still needed during a normal checkout on the current
version. It gives redirects, webhooks, retries, and crash recovery one durable
mapping from a provider payment session to the quantity-zero attendee that the
payment may activate.

The stage is application workflow state, not a seat hold and not a second
payment idempotency system. `processed_payments` continues to decide whether a
provider session has already reached a terminal result.

Keep a stage only while work remains:

- `pending`: the provider may still complete the payment and activate it.
- `refunding`: payment completed, activation failed, and the refund still has
  to finish.

Once booking or refund handling reaches a durable terminal result, delete the
stage. The attendee and `processed_payments` record then carry the lasting
booking or replay result.

## Current state

The monolithic branch remains a committed reference. Do not merge it into
`main`. New work starts from current `main` and ports only the behavior named by
the active pull request.

The independent foundations already merged include:

- #1821 through #1827: attendee purge, refund, checkout error, Stripe setup,
  and role-safe note prerequisites.
- #1829: canonical signed paid-booking rows and date fields.
- #1833: atomic booking writes and completed-payment recovery.
- #1836 and #1837: snapshot/export and backup-storage module splits without a
  staged-checkout behavior change.
- #1840: dormant `checkout_stages` storage. It also added revision storage that
  is no longer needed under the backup assumptions above.

PR #1844 must not merge. Its `processed_payments.checkout_stage_attendee_id`
column, reservation lookup, and three payment fence triggers protect mixed
application versions and rollback-era writes. Those are not supported states.
The current runtime can load the stage and use its attendee directly.

PR #1844 also contains answer-count trigger cleanup found while resolving a
concurrent merge. That independent cleanup is not a reason to merge payment
rollback machinery. Rebuild it separately only if it is still useful on
current `main`.

## Removed work

Do not build any of the following for staged checkout:

- A staged-attendee claim column on `processed_payments`.
- Insert or update triggers that fence payments against checkout stages.
- Compatibility for an old edge script writing after the new runtime deploys.
- `checkout_stage_revisions` or checkout-stage revision triggers.
- Backup start/end revision reads, retry loops, snapshot certificates, or
  restore rejection for changing checkout stages.
- Preservation of `pending` or `refunding` stages through backup and restore.
- Admin held-payment locks, merge conflict choices, pending-stage CSV columns,
  or pending-stage UI whose only purpose is protecting an in-flight payment
  from an operator action.
- First-request reconciliation whose only purpose is repairing events missed by
  an older deployed script.

The consequence is deliberate: if the operating assumptions are broken, an
open checkout may be discarded rather than recovered.

## Next pull request

### Simplify dormant checkout-stage storage

Start from current `main` after closing #1844.

Primary scope:

- Remove `checkout_stage_revisions` from the declarative schema.
- Drop the revision table and its three triggers through a normal migration.
- Remove revision-only tests.
- Add `checkout_stages` to the shared attendee dependent-row deletion
  mechanism.
- When an attendee is deleted or merged, delete its checkout stage instead of
  preserving, moving, or asking the operator to resolve it.
- Leave generic backup/export behavior unchanged. Do not add stage-specific
  reads, certificates, retries, filtering, or restore checks.

Acceptance:

- No production revision writer or reader remains.
- Deleting or merging an attendee cannot leave a stage pointing at it.
- Existing attendee, orphan, backup, and restore behavior remains green.
- No payment or checkout runtime is enabled.

## Final runtime pull request

### Current-version staged checkout

Ship stage creation, payment activation, refund recovery, and cleanup together.
Do not deploy a stage creator before the current runtime can finish every stage
it creates.

Primary behavior:

- Run the ordinary availability preflight without holding capacity.
- Create the provider session and one durable stage tied to quantity-zero
  attendee and listing rows before returning the payment URL.
- If writing the stage fails after creating the provider session, expire that
  session before returning the error. A crash before the URL is returned may
  leave only an unreachable provider session, which the provider may expire.
- On redirect or webhook, reserve the provider session through the existing
  `processed_payments` idempotency path and load the attendee directly from
  `checkout_stages`.
- Build the real rows through the canonical paid-booking representation from
  #1829.
- Activate every listing row, enforce capacity, write ledger effects, store
  ticket tokens, and finalize the processed payment atomically.
- If a completed payment cannot activate, durably enter `refunding` before the
  provider refund and keep retrying until the provider confirms success.
- After a booked or refunded terminal result is durable, delete the stage. Also
  remove the quantity-zero attendee after a terminal refund.
- Expire and delete abandoned pending stages through one bounded cleanup path.
- Keep stage rows out of ordinary attendee, ticket, CSV, and admin projections.

The runtime does not add a second single-item path. A checkout with one listing
uses the same collection-based staging and activation code as a checkout with
many listings.

Acceptance:

- A pending checkout contributes zero booked quantity and holds no seat.
- A failed stage write never returns a usable payment URL.
- Concurrent completed payments cannot exceed listing capacity.
- The winning payment activates the exact staged attendee and rows.
- Redirect and webhook retries replay one processed result without duplicate
  attendees, ledger entries, refunds, or ticket tokens.
- A failed activation cannot leave a completed provider payment without a
  durable refunding path.
- Pending cleanup never deletes a refund still owed to the customer.
- Terminal stages and their sensitive stage-only tokens are removed.
- No rollback fence, stage revision, backup certification, or pending admin UI
  is introduced.

## Deployment and restore

Deploy the final runtime during a quiet period. There is no mixed-version handoff
and no requirement to carry an open stage across the deployment.

Backups may run while the site is active, but they make no consistency promise
for an open checkout or refund. Restore only during a quiet recovery or host
migration, then run the latest script. If an unexpected open stage is present,
the supported recovery is to discard it through the same stage cleanup
mechanism, not to resume or certify the old payment.
