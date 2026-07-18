# Durable booking completion PR

This is the application PR between scheduled-maintenance infrastructure and
durable payment sessions. It replaces every post-booking side-effect path with
one durable completion mechanism for free and paid bookings.

## PR boundary

This PR includes:

- one schema-driven completion plan created inside every booking transaction
- durable, independently leased effects and absolute retry times
- database effects committed with their completion markers
- one target per email and webhook effect
- stable external delivery IDs and at-least-once retry
- durable site-assignment and renewal targets
- attendee erasure of queued PII and contact work
- migration of free, folded, API, and current paid booking paths
- one scheduled-only completion task in the shared maintenance registry

This PR excludes:

- payment-account, unified payment-session, charge, or refund-attempt schemas
- checkout creation or provider reconciliation
- scheduler endpoint, task-claim, or key-lifecycle changes
- a paid-only outbox beside direct free-booking work

The later payment-session PR uses this existing mechanism during terminal
activation and stores only its immutable completion ID.

## Current failure

Paid activation commits before answers, promo activity, registration activity,
emails, webhooks, site assignment, and renewal. Free and folded booking paths
also commit first and notify through separate calls. A dead isolate after booking
commit leaves no durable record of what remains.

Current pending-work, email, and webhook helpers settle or catch delivery errors.
That makes failure look complete. Site assignment may choose a different site on
retry, and renewal calculates a relative extension that can be applied twice.

## One completion plan

Define a versioned Valibot schema for a booking completion snapshot. Build it
before the booking transaction from purchase-time facts that cannot safely be
reconstructed later:

- attendee and listing IDs
- answers and promo-use inputs
- purchase-time display and contact data needed by messages
- ticket delivery data
- registration webhook targets
- site-assignment units and constraints
- absolute renewal target
- locale and message-template version where required for stable output

Write `booking_completions` in the same transaction that makes a booking live.
Use one row for the encrypted shared snapshot and terminal timestamps. The
booking record links to its immutable completion ID.

Derive a typed list of `completion_effects` from the snapshot with a unique
`(completion_id, effect_key)` constraint. Each effect stores:

- exhaustive kind
- pending, running, succeeded, failed, or cancelled state
- lease token and expiry
- absolute `next_attempt_at`
- attempt count and last-attempt time
- stable delivery ID
- small effect-specific encrypted data only when the shared snapshot is not
  enough
- final remote ID or terminal error when meaningful

Use one pure transition function and database checks. A stale lease holder cannot
mark, retry, or deliver after a successor or erasure cancellation wins.

## Database effects

Move deterministic database-only work into the booking transaction when doing so
keeps the transaction short:

- attendee answers
- promo-code activity
- registration activity
- other small replay-safe local facts

If an effect must remain separate, its data write and succeeded marker share one
transaction. Never write the marker before the effect or infer success from a
duplicate insert that could represent different work.

Current free/public, folded/API, and paid booking writers all call one completion
plan builder inside their existing booking transaction. Remove direct
post-commit notification calls after every caller is migrated.

## External effects

Create one effect per independent remote target:

- attendee confirmation email
- admin email
- each registration webhook URL
- each site assignment/provision operation
- site-assignment email after its assignments finish
- renewal application
- any required alert

The effect adapter returns typed success, terminal rejection, pending, or
transport/parse uncertainty. Do not use helpers that catch errors or
`Promise.allSettled` as the effect success contract.

Use at-least-once delivery when the remote system cannot prove an ambiguous
result. Retry with the same stable delivery ID or provider idempotency key. A
receiver without deduplication may rarely deliver twice; silent loss is worse.
Webhook payloads include the delivery ID and send it as `Idempotency-Key`.

Do not claim physical exactly-once email or webhook delivery when the remote
service lacks idempotency and status lookup.

## Site assignment

Choose and reserve the exact built site in a durable local transaction before
provider provisioning. The effect stores that site ID and always retries the
same assignment. It cannot search again after an ambiguous provider result.

Split provisioning into inspect, ensure, and terminal-rejection outcomes where
the hosting provider permits. Persist each returned hosting ID before proceeding
to the next effect. The assignment email depends on all required assignment
effects and never chooses or provisions a site itself.

## Renewal

Calculate one absolute purchased expiry target from the booking snapshot and
store it before external IO. Retries set or reconcile that same target; they
never add the purchased duration to current time again.

Where a provider only exposes a non-idempotent relative extension and cannot be
inspected, an ambiguous result remains pending and alerts the operator rather
than risking a second entitlement extension. The general at-least-once delivery
choice does not permit duplicate money or entitlement changes.

## Privacy and erasure

Encrypt the shared snapshot and effect data with the unattended runtime key.
Select only fields each effect needs and clear its private data after success.
Delete the shared snapshot when every effect is terminal.

Attendee erasure wins over pending delivery:

1. Atomically cancel every unfinished contact or ticket effect.
2. Delete completion PII and ticket data.
3. Clear the booking link where required.
4. Retain only non-PII terminal bookkeeping.

A stale worker whose remote request returns after erasure cannot mark success or
load the erased payload. Tests acknowledge that an already accepted remote
request cannot be recalled.

## Scheduling and direct wake-up

Register completion as a scheduled-only task using the shared maintenance task
type. It owns effect-level leases and due times; the generic task lease is only a
bounded wake-up.

After a booking commits, the same request may directly run due completion work
within a reserved post-response budget. Failure does not change booking success
because the durable task remains. Unrelated organic requests do not run external
completion tasks.

Pack effects by declared database and external cost. Stop claiming before the
deadline and retain enough budget for one final fenced write.

## Migration

No migration can prove whether old post-booking messages were delivered. Mark
existing bookings as `legacy_unknown` or complete and never resend them
automatically. Full durability starts with bookings that atomically create a
completion plan under this schema.

Migrate every production booking writer in one change. A test-only caller or an
old direct notify helper is dead code and is removed, not exempted.

## Acceptance tests

- Every free, folded, API, and paid booking commits one completion plan inside
  its booking transaction.
- A fault while inserting the plan rolls the booking back.
- A crash after booking commit leaves all unfinished effects durable.
- Model tests reject every invalid effect state transition.
- Two workers claim an effect once; expired work is reclaimable; stale tokens
  cannot write.
- Database effect and succeeded marker commit or roll back together.
- Each email and webhook target succeeds or retries independently.
- Definite rejection, timeout, remote acceptance with lost response, and crash
  after success use the correct typed transition and stable delivery ID.
- No catch or settled promise converts a failed target into success.
- Site-assignment retry uses the same reserved site and hosting operation.
- Renewal retry applies one stored absolute target and never extends twice.
- Erasure removes queued PII and prevents stale workers from later delivery.
- The last terminal effect deletes the shared private snapshot.
- Scheduled task claims and effect leases do not duplicate one another.
- Exact call counters stay within the declared request budget.
- Full coverage and exhaustive mutation tests kill state, lease, due-time,
  delivery-ID, target-selection, expiry, and erasure mutants.
