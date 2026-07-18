# Staged checkout follow-up

This file records the remaining staged-checkout review findings and agreed
structural follow-up. Do not fix each retry or replay symptom with another
parallel path; one durable payment-session reconciler owns them.

## Operating model

- Only the latest edge script runs. We do not support mixed versions or
  rollback compatibility.
- A checkout never holds a seat. Pending booking rows have quantity zero.
- Deployments, host moves, and restores need not preserve an open checkout, but
  they must close, reconcile, or refuse unresolved provider work before deleting
  its local recovery state.
- Backups make no consistency promise for an open checkout or refund.
- Operator deletion or merge may discard an involved stage only after
  authoritative unpaid closure or terminal payment reconciliation.
- We do not add checkout revisions, backup certificates, restore rejection,
  payment fence triggers, pending-payment admin UI, or old-version event
  reconciliation.

## Review findings

Recheck each item against the latest branch before changing code. Some source
and test files are being reorganised during mutation hardening.

### Money recovery

- [ ] Process a paid stage found by scheduled cleanup. The current cleanup can
  learn that the provider was paid and then leave the quantity-zero attendee
  untouched. A missed redirect and webhook can therefore leave a paid customer
  with no ticket or refund.
- [ ] Schedule `refunding` stages. A transient or pending refund currently
  depends on another redirect or webhook callback. Refund recovery must continue
  after callback delivery stops.
- [ ] Always use the provider stored on the stage. Changing the active provider
  while a checkout is open must not change which provider retrieves, closes, or
  refunds that checkout.
- [ ] Let a fully refunded Square payment finish local finalisation. If Square
  confirms the refund and the following database write fails, a retry must still
  write the refund ledger result, final payment replay record, and stage cleanup.
- [ ] Distinguish an uncertain refund attempt from a terminally failed attempt.
  Reuse one idempotency key while the provider outcome is unknown. Allocate a
  new durable attempt key after an authoritative failure so Stripe or Square
  does not replay the failed response forever.
- [ ] Poll authoritative refund status after a provider returns `pending`.
  Re-submitting with the same idempotency key may only replay the original
  pending response.
- [ ] Keep SumUp checkout metadata for as long as a live stage references it.
  General metadata pruning must not remove the information needed to inspect or
  refund a pending or refunding stage.
- [ ] Do not offer a new checkout while provider closure is unresolved. A cancel
  request whose close attempt fails must keep the old session payable without
  showing a retry action that can create a second live checkout.
- [ ] Replay a terminal local Square result before interpreting the provider's
  current refund fields. A refund update or refreshed success URL must return
  the stored result instead of treating the original payment as unpaid.
- [ ] Acknowledge Square payment events that do not belong to a ticket order.
  An active account can receive `payment.updated` events with no `order_id`;
  classify those as unrelated work and return the normal successful receipt.

### Queue progress and limits

- [ ] Prevent paid, failing, or slow stages from occupying the oldest cleanup
  slots forever.
- [ ] Drain more than one fixed batch over later requests. A limit of four once
  per day cannot keep up with more than four abandoned checkouts per day.
- [ ] Give every failed attempt a durable `next_attempt_at` so backoff does not
  block unrelated stages.
- [ ] Base each reconciliation batch on the provider's real worst-case
  subrequest cost. Square may read one order, inspect several payments, close a
  link, and re-read state. Four such jobs can exceed Bunny's 50-subrequest
  limit.

### Tests and code shape

- [ ] Repair the committed-result recovery test. It still stubs the old fresh
  booking method instead of staged activation, so it no longer proves recovery
  after activation commits and the result is lost.
- [ ] Remove or prove the mutation equivalence for `packageGroupId ?? 0` versus
  `packageGroupId || 0`. The current TypeScript type permits `NaN`; validate the
  real positive-safe-integer invariant at the boundary if the values are meant
  to be equivalent.
- [ ] Remove production aliases and exports that exist only for tests when no
  production caller needs them.
- [ ] Move pending-refund result text into the message catalog and replace
  `refund(s)` copy with ICU plural messages.
- [ ] Split the touched Square and webhook modules by provider transport,
  checkout operations, refunds, verification, and request routing where they
  remain substantially above the repository's 400-line target.

## Structural decision

Implement the unified design in [STAGED_DESIGN.md](STAGED_DESIGN.md). The
technical questions above are resolved:

- Replace `checkout_stages` and `processed_payments` with one durable
  `payment_sessions` lifecycle for booking and balance checkouts.
- Create the session and its encrypted canonical intent before provider IO. A
  booking session still writes quantity-zero rows and never holds capacity.
- Use explicit `creating`, `pending`, `refunding`, `succeeded`, and `failed`
  states plus an orthogonal tokenised lease and absolute retry time.
- Make one `reconcilePaymentSession(checkoutId)` operation own provider creation,
  inspection, unpaid closure, activation, refunds, terminal replay, and cleanup.
- Move SumUp metadata into the common encrypted session payload and delete the
  separate SumUp metadata table and retention path.
- Bind every session and terminal charge to an immutable payment account, not
  the currently active provider or current credentials.
- Keep a minimal terminal result indefinitely. Prune secrets and PII, never the
  only exact replay answer.
- Commit durable booking-completion work with activation, then resume it through
  the shared completion system after an isolate or delivery failure. Build that
  as its own prerequisite PR for both free and paid bookings.
- Make Square inspection fixed-cost through the payment-link order's
  `Tender.id`; never scan `ListPayments` or guess a tender limit.
- Treat provider success, terminal failure, pending, and transport/parse
  uncertainty as different typed outcomes.
- Require a short session lease. A payment reservation cannot coordinate
  provider creation, unpaid closure, or refund polling and is not retained as a
  parallel lock.
- Register payment work with the declarative maintenance registry delivered by
  the separate scheduler PR.

## Separate scheduler PR

Implement [SCHEDULED_DESIGN.md](SCHEDULED_DESIGN.md) in its own prerequisite PR.
That PR owns endpoint authentication, per-site keys, fan-out removal, task-level
claims, and the generic local maintenance registry. It must not change payment
session, provider, refund, or booking-completion behavior.

The separate completion PR then adds the shared booking-effect task. The later
payment-session PR adds only payment reconciliation to the registry. It keeps
session leases, absolute retry times, provider timeouts, and payment-specific
cost packing in the payment domain.

## Product decisions

- Completion effects use at-least-once delivery when a remote email or webhook
  service cannot prove whether an ambiguous request succeeded. Reuse a stable
  delivery ID and accept that a rare duplicate is safer than silent loss.

## Acceptance tests for the structural change

- [ ] A paid checkout whose redirect and webhook are both missed is eventually
  activated or refunded by scheduled reconciliation.
- [ ] A refund that first fails or stays pending continues without another
  callback. An irreducibly ambiguous SumUp submission remains `refunding`, emits
  one alert, and never risks a second POST without authoritative evidence.
- [ ] A provider switch after checkout creation does not affect that checkout.
- [ ] A provider refund followed by a local database failure finishes on retry
  for Stripe, Square, and SumUp.
- [ ] Uncertain Stripe and Square retries reuse one idempotency key; terminal
  failures use a new key. SumUp inspects durable transaction facts instead of
  claiming provider idempotency it does not have.
- [ ] SumUp metadata survives exactly as long as its live stage.
- [ ] More than one cleanup batch drains over later requests.
- [ ] Four permanently failing rows do not block a later payable or closable
  row.
- [ ] Worst-case provider work stays below the request subrequest budget.
- [ ] Concurrent redirect, webhook, and scheduled reconciliation produce one
  attendee, one ledger result, one refund at most, and one replay result.
- [ ] Fault injection after every provider call and every durable write leaves a
  state that the same reconciler can finish.
- [ ] Model-based transition tests reject every state change not listed above.
- [ ] Payment reconciliation and booking completion use the maintenance registry
  without adding another scheduled route, interval marker, or task claim path.
- [ ] Repeated maintenance triggers cannot pull a session's retry time forward
  or exceed one task's declared provider budget.
- [ ] A provider timeout finishes before the session lease and request deadline,
  and a later run can safely reclaim the work.
- [ ] Stripe, Square, and SumUp provider creation can succeed with a lost local
  response and later recover the same checkout without creating a second one.
- [ ] Booking and balance checkouts use the same durable creation, account
  ownership, reconciliation, refund, and replay lifecycle.
- [ ] Changing the active provider or replacing credentials with another account
  never reroutes an existing session or charge.
- [ ] A token-free terminal status and message replay exactly after its provider
  is disabled, its reference is redacted, its attendee is erased, and the old
  prune age passes. An erased ticket never leaves a dead or retained bearer link.
- [ ] Activation commits its completion plan atomically. Faults between every
  answer, activity, email, webhook, site-assignment, and renewal effect leave
  durable work that can resume safely.
- [ ] Ambiguous email and webhook requests retry with the same delivery ID.
  Idempotent receivers see one delivery; other receivers may see a duplicate but
  never lose the work silently.
- [ ] A Square order with only `Tender.id` is recognised as paid with a bounded
  direct payment lookup. Multiple tenders fail closed without a payment scan.
- [ ] A partial Stripe, Square, or SumUp refund never finalises a full local
  refund.
- [ ] Every invalid payment-session state, stale lease write, account-owner
  change, and refund-attempt transition is rejected by schema or fenced SQL.
- [ ] Deployment and restore migration refuses unresolved provider work instead
  of deleting it, and every supported historical backup reaches the new schema.
- [ ] Webhooks resolve an opaque stored endpoint before verification, use that
  endpoint's account-bound secret, reject oversized bodies, and never log raw
  payloads.
- [ ] Charges retain a blind provider-reference index after secret redaction and
  cannot collide across payment accounts.
- [ ] A browser or API caller can resume one durable `creating` checkout after a
  lost response without starting a second application checkout.
