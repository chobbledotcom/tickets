# Payment aggregate — accepted safety rules

These seven rules are the safety contract the payment aggregate must satisfy.
They describe behaviour that does not all exist on `main` yet: the owner-review
flow, the queued owner email, and "aggregate activation" all belong to the
future aggregate work. They are recorded here as acceptance constraints so the
work that lands first — starting with "keep existing payments refundable when
new sales are off" — does not paint the aggregate into a corner.

Each rule names the current behaviour on `main` where one exists, so a reader
can see what already holds and what is still future work. Nothing here is
implemented ahead of its time; this document is the contract, not scaffolding.

## The separation this PR establishes

New sales and existing payments are now resolved by different questions:

- **New sales** — `getActivePaymentProvider()` / `isPaymentsEnabled()`. Returns
  null when the operator has saved the provider as "none", so no buyer can
  start a new checkout.
- **Existing payments** — `getPaymentProviderForExistingPayments()`. Refunds,
  provider reconciliation, replayed callbacks, and completion of already-started
  payment work use this. When new sales are off, it falls back to the last
  provider the operator activated (whose credentials stay stored), so money
  already captured is never stranded.

The rules below assume that separation holds.

> **Pre-existing `none` sites.** A site that was already on `none` *before*
> this PR landed has neither `payment_provider` set nor a `last_active`
> provider recorded, so the resolver still returns null and existing payments
> stay stranded — the same state as before this PR (no regression). The recovery
> path is a one-click operator action: re-select any provider on the settings
> page, which sets `last_active` and unblocks refunds/completion against it.
> A migration that infers the provider from stored credentials alone would be a
> guess (multiple providers could be configured), so it is deliberately not
> added; the re-select path is the honest repair.

## 1. Failed checkout plus captured money becomes owner review with complete-or-refund choices

A captured charge whose booking cannot be honoured at the charged amount does
not disappear and is not silently refunded. It is surfaced for the operator,
who must be able to either complete it (issue the ticket) or refund it.

*On `main` today:* a signed captured payment that cannot be honoured is kept as
a quantity-0 placeholder and refunded automatically (`storeRefundedBooking` /
`refundAndFail`), or acknowledged as "already handled" when its booking is gone.
There is no owner-review choice yet — the refund is automatic. The
"complete-or-refund" choice is future aggregate work; the current path must
keep refunding safely (covered by this PR's regression tests) so the aggregate
can later replace the automatic refund with a review.

## 2. Completed refunds count immediately while overlapping refunds are blocked until provider totals catch up

A refund that succeeds is recorded at once. A second refund attempt for the same
charge must not pay out twice: it is treated as already-done once the provider's
own refund total confirms it.

*On `main` today:* `tryRefund` treats a payment the provider reports as already
refunded (`isPaymentRefunded`) as success, and each charge carries a
`provider_refunded_at` marker so a later attempt skips the provider call for
charges already returned. This is the current rule and must stay.

> **Known gap (provider switching).** `main` does not record which provider
> captured a charge — only the opaque `payment_reference`. So after an operator
> switches providers (Stripe → Square) and then selects "none", the last-active
> fallback resolves every existing payment through Square, and an older Stripe
> charge cannot be refunded or reconciled. This predates this PR (the old
> code resolved the currently-active provider, which returned null and failed
> outright once sales were switched off). Per-charge provider tracking is the
> reference a charge lives in — it is future aggregate work and is recorded in
> TODO.md.

## 3. Multiple captured charges require owner review

When a buyer has more than one captured charge for the same booking (a deposit
plus a balance, or charges combined by a merge), the system must not pick a
resolution by default. It surfaces the set for the operator to decide.

*On `main` today:* a merged attendee can carry several references, and the
bulk/single refund paths handle them as a batch without a review step. The
"require owner review" choice is future aggregate work.

## 4. Queued owner email uses the current business address but stored body/buyer facts

When an owner notification is queued and sent later, the recipient address is
read at send time (so it reaches the current operator), but the message body
and the buyer facts it describes come from when the case was raised (so it
describes what actually happened, not a later state).

*On `main` today:* there is no queued owner-email path; notifications are sent
inline. This is future aggregate work.

## 5. Malformed legacy records migrate without invented facts into owner review

A legacy or malformed payment record that cannot be interpreted must not have
facts invented for it. It is carried forward only as far as it can be honestly
read and lands in owner review for a person to resolve.

*On `main` today:* legacy migration copies what is provably there (references,
statuses) and invents nothing; an unreadable record is left for the operator
rather than guessed. This must stay true as the aggregate's migration lands.

## 6. A buyer with a paid booking under review sees "payment received / do not pay again" and gets a stable reload

A buyer whose payment was captured but whose booking is not yet resolved must be
told their payment was received and must not be offered a way to pay again. A
reload of the page must return the same state, not re-charge or re-process.

*On `main` today:* a paid session the ledger already records replays as
success ("payment received") and is never re-processed or re-refunded
(`replaySessionFromLedger`). The explicit "under review" state and its stable
messaging are future aggregate work; the replay safety it depends on is
current and must stay.

## 7. Aggregate activation waits for complete owner case pages/actions

The aggregate is only switched on once every owner-case page and action it
depends on exists and works. No half-enabled state where some payments flow
through the aggregate and some do not.

*On `main` today:* there is no aggregate to activate. This is the gate the
future work must clear before it takes over any payment path.
