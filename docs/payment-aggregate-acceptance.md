# Payment aggregate — accepted safety rules

These seven rules are the safety contract the payment aggregate must satisfy.
Some describe behaviour not yet on `main` (owner-review flow, queued owner
email, aggregate activation) — future aggregate work. They are recorded here so
earlier work does not paint the aggregate into a corner.

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

> **Sales-off recovery.** A site may have no remembered provider. The resolver
> uses the sole provider with stored credentials when that choice is clear. If
> several providers have credentials, the settings page requires the operator to
> choose which one took the existing payments. Saving that choice records the
> provider and keeps new sales off. The system never guesses.

## 1. Failed checkout plus captured money becomes owner review with complete-or-refund choices

A captured charge whose booking cannot be honoured is surfaced for the operator
to either complete or refund.

_On `main` today:_ refunded automatically (`storeRefundedBooking` /
`refundAndFail`). The "complete-or-refund" choice is future aggregate work; the
current path must keep refunding safely so the aggregate can later replace the
automatic refund with a review.

## 2. Completed refunds count immediately while overlapping refunds are blocked until provider totals catch up

A refund that succeeds is recorded at once. A second attempt for the same charge
is treated as done once the provider's own refund total confirms it.

_On `main` today:_ `tryRefund` treats a payment the provider reports as already
refunded as success, and each charge carries a `provider_refunded_at` marker so
a later attempt skips the provider call. This must stay.

> **Provider switching.** M4 closed the gap this rule used to name. A refund now
> loads exactly the adapter its own reference names: the canonical
> `payment_charges` authority carries a provider-tagged identity, and
> `loadRefundProvider` (`src/shared/provider-refunds.ts`) refuses an adapter
> that does not match the tag. The last-active fallback
> (`getPaymentProviderForExistingPayments`) therefore never decides which
> provider takes a refund. An older untagged reference is a typed permanent
> refusal, not a guess — the owner refunds it in the provider's own dashboard.
> See TODO.md, "Historical refund references deliberately remain manual".

## 3. Multiple captured charges require owner review

A buyer with more than one captured charge must have the set surfaced for the
operator to decide, not auto-resolved.

_On `main` today:_ merged attendees carry several references, handled as a batch
without review. Future aggregate work.

## 4. Queued owner email uses the current business address but stored body/buyer facts

The recipient address is read at send time. The body and buyer facts come from
when the case was raised, so the message describes what happened then.

_On `main` today:_ there is no queued owner-email path; notifications are sent
inline. This is future aggregate work.

## 5. Malformed legacy records migrate without invented facts into owner review

A malformed record is carried forward only as far as it can be honestly read and
lands in owner review. `main` copies what is provably there and invents nothing.
This must stay.

## 6. A buyer with a paid booking under review sees "payment received" and gets a stable reload

A buyer must not be offered a way to pay again. A reload must return the same
state. `main` replays as success and never re-processes
(`replaySessionFromLedger`). The "under review" state is future aggregate work.

## 7. Aggregate activation waits for complete owner case pages/actions

The aggregate is only switched on once every owner-case page and action it
depends on exists. No half-enabled state.

_On `main` today:_ there is no aggregate. Future work must clear this gate
before it takes over any payment path.
