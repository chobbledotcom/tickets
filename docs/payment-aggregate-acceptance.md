# Payment aggregate — accepted safety rules

These seven rules are the safety contract the payment aggregate must satisfy.
Some describe behaviour not yet on `main` (owner-review flow, queued owner
email, aggregate activation) — future aggregate work. They are recorded here
so earlier work does not paint the aggregate into a corner.

Each rule names the current behaviour where one exists. Nothing here is
implemented ahead of its time; this document is the contract, not scaffolding.

## The separation this PR establishes

- **New sales** — `getActivePaymentProvider()` / `isPaymentsEnabled()`. Null
  when the provider is saved as "none".
- **Existing payments** — `getPaymentProviderForExistingPayments()`. Refunds,
  reconciliation, replayed callbacks, and completion use this. When new sales
  are off, it falls back to the last activated provider (whose credentials stay
  stored), so payments captured by that provider stay refundable.

The rules below assume that separation holds.

> **Pre-existing `none` sites.** A site that was already on `none` *before*
> this PR landed has neither `payment_provider` set nor a `last_active`
> provider recorded. The resolver falls back to the sole provider with stored
> credentials when exactly one is configured — unambiguous evidence of which
> provider captured prior payments. When zero or multiple providers have
> credentials, the resolver returns null and the operator must re-select a
> provider on the settings page (which sets `last_active` and unblocks
> refunds/completion). The system never guesses among multiple configured
> providers.

## 1. Failed checkout plus captured money becomes owner review with complete-or-refund choices

A captured charge whose booking cannot be honoured is surfaced for the
operator to either complete or refund.

*On `main` today:* refunded automatically (`storeRefundedBooking` /
`refundAndFail`). The "complete-or-refund" choice is future aggregate work;
the current path must keep refunding safely so the aggregate can later
replace the automatic refund with a review.

## 2. Completed refunds count immediately while overlapping refunds are blocked until provider totals catch up

A refund that succeeds is recorded at once. A second attempt for the same
charge is treated as done once the provider's own refund total confirms it.

*On `main` today:* `tryRefund` treats a payment the provider reports as
already refunded as success, and each charge carries a `provider_refunded_at`
marker so a later attempt skips the provider call. This must stay.

> **Known gap (provider switching).** `main` does not record which provider
> captured a charge — only the opaque `payment_reference`. So after an operator
> switches providers (Stripe → Square) and then selects "none", the last-active
> fallback resolves every existing payment through Square, and an older Stripe
> charge cannot be refunded. This predates this PR. Per-charge provider
> tracking is future aggregate work; recorded in TODO.md.

## 3. Multiple captured charges require owner review

A buyer with more than one captured charge must have the set surfaced for
the operator to decide, not auto-resolved.

*On `main` today:* merged attendees carry several references, handled as a
batch without review. Future aggregate work.

## 4. Queued owner email uses the current business address but stored body/buyer facts

The recipient address is read at send time; the body and buyer facts come
from when the case was raised.
and the buyer facts it describes come from when the case was raised (so it
describes what actually happened, not a later state).

*On `main` today:* there is no queued owner-email path; notifications are sent
inline. This is future aggregate work.

## 5. Malformed legacy records migrate without invented facts into owner review

A malformed record is carried forward only as far as it can be honestly read
and lands in owner review. `main` copies what is provably there and invents
nothing. This must stay.

## 6. A buyer with a paid booking under review sees "payment received" and gets a stable reload

A buyer must not be offered a way to pay again. A reload must return the same
state. `main` replays as success and never re-processes (`replaySessionFromLedger`).
The "under review" state is future aggregate work.

## 7. Aggregate activation waits for complete owner case pages/actions

The aggregate is only switched on once every owner-case page and action it
depends on exists. No half-enabled state.

*On `main` today:* there is no aggregate. This is the gate future work must
clear.
future work must clear before it takes over any payment path.
