# M4: one diagnosis for settled money — behavior contract

## Status

All five owner decisions are recorded below: proceed-and-alert for
`multiple_charges`, the Stripe `amount_refunded` read widening, both new copy
strings, the two-PR slicing (2026-08-09), and owner review for every
multi-charge observation — automatic refunds act on single-charge observations
only (2026-08-10). No implementation has started. Per PR_WORKFLOW.md the final
sign-off is explicit approval of this latest version (merging PR #2063 or saying
"approved"); tests and code start only after that. Milestone source: PLAN.md M4
(lines 190–211), fault rows F3 and F51, and the binding decided behaviors on
refunds and multiple captures.

## Current-system value

Today the live system will start a second refund while a first one is still
settling, because a pending refund is invisible to every record and guard on the
current path. It also cannot see a second captured charge on one Square order —
the code silently takes the first tender. After M4, one pure judge (`outcomeOf`)
decides what settled money means everywhere on the current path: it refuses any
refund attempt that would exceed the captured money, counts a completed refund
immediately even while the provider's total lags, and detects captured-money
combinations the system currently misses. The displaced classification logic is
deleted in the same merges, so two judges can never disagree about the same
money (F51).

Production callers that receive the change: the callback and redirect processing
path (`src/features/api/payment-processing/*`, `src/features/api/webhooks.ts`)
and every refund entry point (`tryRefund`, `refundRejectedCharge`, the admin
single and bulk refund routes through `refundReferenceAtProvider`, and the admin
refresh-payment route in `src/features/admin/attendees-edit.ts`, whose
`refunded ? "completed" : "none"` mapping is a second settled-money judge today
— it reads a pending or partial provider refund as plain "none").

## Honest guarantee

> Before any refund attempt, the money already returned plus the money still
> returning is computed from the provider's own cumulative total and our durable
> completed records, whichever knows more, and the attempt is refused when it
> would exceed the money captured. Every settled-money verdict on the current
> path comes from the one pure `outcomeOf` judge over observed provider facts
> and the signed expected facts. Facts a provider does not expose on the current
> read shape are not invented; where pending refunds are unobservable, replay
> safety comes from provider idempotency keys and full-refund semantics, and the
> contract says so per provider.

This is narrower than M7's durable refund engine: M4 ships no refund jobs, no
cursor, no aggregate-table writes, and no owner case pages. M4 owns F3's
classification half (refusing the overlap); M7 owns its persistence half.

## Current production evidence

Verified against the working tree at `4879ae0d` (post-#2062 main).

| Area                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback judge                 | `classifySession` returns `trusted`/`mismatch`/`ignore` from price-proof, currency, and amount equality (`src/features/api/payment-processing/classify.ts:97-113`); no free-checkout predicate exists — a paid charge against a signed total of 0 falls out of amount inequality                                                                                                                                  | This verdict logic is the displaced callback classifier; `outcomeOf` replaces it and names `paid_without_charge` explicitly                                                                                                       |
| Boundary constructor           | `validatedPaymentSession` rejects unvouched money as `malformed_charge` with `refundable`, and a paid session without a resource id as `blank_reference` (`src/shared/payment/validated-session.ts:17-113`)                                                                                                                                                                                                       | Stays. It is M3's observation boundary, not a settled-money judge; its rejections feed the same refund path the judge uses                                                                                                        |
| Mismatch refunds               | `refuseMismatch` (balance path) and `chargeMismatchSpec` (booking path) refund on verdict `mismatch` (`src/features/api/payment-processing/refunds.ts:239-250,308-312`; consumed at `index.ts:238-250`)                                                                                                                                                                                                           | These actions stay; their trigger becomes a judge outcome instead of the inline verdict                                                                                                                                           |
| Refund re-attempt surface (F3) | On `refunded === false` the reservation is released so the next redelivery re-attempts the refund; the comment asserts this "CANNOT double-pay" on the strength of provider-side rejection (`src/features/api/payment-processing/index.ts:350-366`)                                                                                                                                                               | True for Stripe/Square only because of idempotency keys; unguarded for SumUp. The judge fronts every attempt with the overlap refusal                                                                                             |
| Refund state today             | `RefundState` is `none \| completed \| unknown` — no pending state exists on the live path (`src/shared/payment/refund-state.ts:10-23`); derived from `processed_payments.provider_refunded_at` (`src/shared/db/payment-references.ts:130-161`)                                                                                                                                                                   | A pending provider refund reads as `none` everywhere today; nothing compares refunded-so-far against captured money                                                                                                               |
| Single-charge refund judge     | `tryRefund`: blank-id guard, attempt, then `isPaymentRefunded` fallback treating already-refunded as success (`src/features/api/payment-processing/refunds.ts:120-160`)                                                                                                                                                                                                                                           | The ordering is ad-hoc judgment; it becomes: observe → `outcomeOf`/`resolveRefund` → act                                                                                                                                          |
| Bulk refund judge              | `refundReferenceAtProvider`: `completed` short-circuit, attempt, `isPaymentRefunded` fallback (`src/features/admin/refunds/provider.ts:40-68`); waves of 5, wave count unbounded (`:167-211`), caller caps batch at `BULK_REFUND_LIMIT` (`src/features/admin/attendee-refunds.ts:303`)                                                                                                                            | Same cutover as `tryRefund`. The unbounded wave shape itself is M7 (F53), not M4                                                                                                                                                  |
| Idempotency                    | Deterministic `refundIdempotencyKey` used by Stripe (`src/shared/stripe.ts:109`) and Square (`src/shared/square.ts:688`); SumUp passes none (`src/shared/sumup.ts:222-229`), and the SumUp refund API supports none                                                                                                                                                                                               | SumUp replay defence must come from the judge plus full-refund semantics; the contract records this as a per-provider fact                                                                                                        |
| Square refund facts            | `retrievePayment` already selects `refundedMoney` — a genuine provider cumulative (`src/shared/square.ts` retrievePayment; `square-provider.ts:44-53` uses `refunded >= charged`); `refundPayment` returns false for PENDING (`CONFIRMED_REFUND_STATUSES = ["COMPLETED"]`, `square.ts:587`) and throws on wrong `payment_id` or partial amounts (`:712,721-728`)                                                  | Square legs get a real `confirmedRefunded`. A PENDING answer is a real in-flight refund the current code treats as failure — the F3 trigger                                                                                       |
| Stripe refund facts            | Current schema picks only `latest_charge.refunded` (boolean) (`src/shared/stripe/schemas.ts:43,51`); the locked Stripe types document `amount_refunded` on the charge                                                                                                                                                                                                                                             | Widening the pick to `amount_refunded` gives Stripe a documented cumulative. Approved as decision 2                                                                                                                               |
| SumUp refund facts             | `isPaymentRefunded` is `getTransactionStatus === "REFUNDED"` (`src/shared/sumup-provider.ts:103-107`) — full-refund only, no partial, no pending                                                                                                                                                                                                                                                                  | Refund authority moves to the same read's `transaction_events[]` (PR3's verified sandbox contract — status stayed `SUCCESSFUL` after a full refund, so the status check can miss even full refunds); pending remains unobservable |
| Multiple captures              | Square: `paymentReference = paidPaymentId ?? order.tenders?.[0]?.paymentId ?? ""` silently takes the first tender (`src/shared/square-provider.ts:124-125`); nothing counts captures per order. SumUp: `paidChildVerdict` already rejects extra children as `unrecorded_child` (`src/shared/sumup-observation.ts:143-151`). Stripe: a session names one `payment_intent`; no list read exists on the current path | Square `tenders[]` is present evidence: two paid tenders become a detectable `multiple_charges` conflict. Stripe multiple-capture detection has no current-path evidence and is out of scope (M6)                                 |
| Wrong parent                   | Square throws on `payment.orderId !== order.id` (`square-provider.ts:145-153`) and on refund `payment_id` mismatch (`square.ts:712`); SumUp reference/id/merchant checks are classifier verdicts (`sumup-observation.ts:208-239`); Stripe has none                                                                                                                                                                | Existing checks keep their behavior but report through the one conflict vocabulary; no new Stripe check is invented                                                                                                               |
| Error and alert classes        | `logError` fans out to ntfy (`src/shared/logger.ts:335`); the mismatch pager is `WEBHOOK_PRICE_SIGNATURE` (`refunds.ts:244,275`); the "money moved but records did not" incident class is `reportRefundNotRecorded` (`src/shared/invariant-errors.ts:37-39`)                                                                                                                                                      | Owner-review conflicts alert through these existing classes; no new alert channel                                                                                                                                                 |
| Money of record                | Ledger `transfers` (capture via `checkout-complete.ts:42-56`; refunds via `refund-ledger.ts:197,228,305`); `processed_payments.provider_refunded_at` marks completed provider refunds (`payment-references.ts:260-273`)                                                                                                                                                                                           | These are the durable "our completed records" input to the judge. M4 writes no new tables                                                                                                                                         |
| Dormant aggregate schema       | `payment_charges` already declares `captured_amount`, `refunded_amount`, `refund_state`, `pending_refund_id`, `pending_refund_idempotency_key` — schema-only, no readers or writers (`src/shared/db/migrations/schema/payments/charges.ts:29-53`)                                                                                                                                                                 | Stays dormant. M4 must not write it (delivery rule 1; M6/M7 activate it)                                                                                                                                                          |

## Reference modules and the adaptation rule

Source: `origin/claude/great-fermi-l2n29f`, `src/shared/payment-state/`. The
branch's modules are fully pure (no IO imports; `diagnose.ts` imports nothing
outside the folder). They have no production callers on that branch; M4 wires
them into main's live path. Adaptations land in `src/shared/payment/`, beside
the already-merged `money.ts`, `resource-id.ts`, `refund-state.ts`,
`validated-session.ts` (PLAN.md target architecture: one directory).

| Branch module                                                                      | Lines | M4 fate                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnose.ts` (`outcomeOf`, `hasSettled`, `SettledReading`)                        | 196   | Port. The judge                                                                                                                                                                                                                                            |
| `conflict.ts` (15-kind `PaymentConflict` variant + `IS_THE_READING_ITSELF`)        | 55    | Port minus the four M4-unreachable kinds (see the conflict table's note). Reconcile `invalid_provider_data`'s reason type against main's `ProviderInvalidReason` (plain union, includes `unrecorded_child`; branch has `mismatched_parent`)                |
| `refund.ts` (`resolveRefund`)                                                      | 72    | Port                                                                                                                                                                                                                                                       |
| `resources.ts` (charge/refund legs, `refundMoneyMatchesCapture`, resource schemas) | 246   | Port slimmed: reuse main's `money.ts` and `resource-id.ts` instead of restating `MoneySchema`/`ResourceIdSchema`. Keep main's stricter resource-id rule (`/^\S+$/u`, no inner whitespace) — the branch's looser rule accepts `"pi_1 2"` and is not adopted |
| `words.ts`                                                                         | 87    | Port only the subsets M4 needs (refund states, resource-kind map); the case/decision/ticket vocabularies are M5+                                                                                                                                           |
| `validation/kind.ts` (`kindObject`)                                                | 11    | Port (the one missing compile dependency)                                                                                                                                                                                                                  |
| `observation.ts` (`PaymentObservation`, ownership proof)                           | 219   | Adapt minimally: M4 needs the observation shape as `outcomeOf` input; ownership proof semantics already live in M3's staging/signature checks. No duplicate vocabulary is kept                                                                             |
| `resolve.ts`, `lifecycle.ts`, `decision.ts`, `operator.ts`, `record/*.ts`          | —     | Not M4. `resolve.ts`/`lifecycle.ts` are M5 (stored-evidence re-validation); `record/*` are aggregate-table row rules (M5/M6). `lifecycle.ts` will call back into the `outcomeOf` M4 lands                                                                  |

The branch's test files (`test/shared/payment-state/diagnose.test.ts`,
`refund.test.ts`, `conflict.test.ts`, `resources/refunds.test.ts`) are the
ported behavioral spec, including the pinned arithmetic cases (80 confirmed + 50
pending out of 100 refused; 100 confirmed + 100 completed not double-counted).

## Trusted facts and observed facts

Trusted (expected) facts — never substituted for observed facts:

- The signed price proof carries the expected total and metadata (`price_proof`,
  verified per M1/M3). The site currency is `settings.currency` at judgment
  time.
- Our durable completed-refund records: a ledger `refund_cash` leg and
  `processed_payments.provider_refunded_at`. These are our own writes, performed
  only after a provider confirmed a refund.
- The staged/signed ownership facts from M3 (SumUp sealed staging, Stripe
  signatures, Square order metadata proof).

Observed facts — from the provider at judgment time:

- The session/checkout resource and status (existing M3 reads).
- Captured money per charge: SumUp vouched `amountMinor` + `transactionId`;
  Square `payment.amountMoney` per tender with `payment.orderId` parentage;
  Stripe session totals and `payment_intent`.
- The provider's cumulative refunded total: Square `refundedMoney`; Stripe
  `latest_charge.amount_refunded` (after the schema widening, decision 2); SumUp
  the sum of successful `REFUND` events in the transaction read's
  `transaction_events[]` — PR3's verified sandbox contract (PR3_PLAN.md) shows
  the events are the refund authority on that response, and no top-level status
  or field is (status stayed `SUCCESSFUL` after a full refund).
- A provider's direct answer to a refund attempt (succeeded / PENDING /
  rejected).

An unavailable read is never treated as "no refund exists". A missing documented
field is a malformed read (M3 boundary), never a zero.

## Valid states

The judge's output is the ported four-kind union — no nulls, no defaults:

```typescript
type ObservationOutcome =
  | { kind: "ready" }
  | { kind: "fully_refunded" }
  | { kind: "refund_pending" }
  | { issue: PaymentConflict; kind: "conflict" };
```

Every conflict kind is mapped exhaustively (a `Record<kind, Remedy>` in code, so
a new kind is a compile error) onto exactly one of two remedies:

| Conflict kind             | Meaning                                                                                                                                                                           | Remedy in M4                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `currency_mismatch`       | Any observed currency differs from the expected currency                                                                                                                          | Refuse-and-record: today's mismatch refund path                                                                             |
| `provider_total_mismatch` | Provider session total ≠ signed expected total                                                                                                                                    | Refuse-and-record: mismatch refund path                                                                                     |
| `partial_charge`          | Captured sum < expected                                                                                                                                                           | Refuse-and-record: mismatch refund path                                                                                     |
| `capture_total_mismatch`  | Captured sum ≠ expected (over-capture)                                                                                                                                            | Owner review: detect, record, alert                                                                                         |
| `paid_without_charge`     | Money on a free checkout: expected total is 0 and a charge is present                                                                                                             | Refuse-and-record: mismatch refund path (the charge has a resource to refund)                                               |
| `resource_mismatch`       | Charge/refund parent or provider disagrees with its session/charge                                                                                                                | Refuse-and-record: refuse retryably (callback) / refuse attempt (refund path); keeps Square's current throw-behavior, named |
| `duplicate_charge`        | Two charge legs share one resource id                                                                                                                                             | Refuse-and-record                                                                                                           |
| `multiple_charges`        | More than one captured charge on one payment (Square: >1 paid tender)                                                                                                             | Owner review: detect, record, alert; automatic work proceeds on the signed total as today                                   |
| `refund_exceeds_capture`  | Returned + returning money would exceed captured (`Math.max(providerCumulative, ourCompleted) + pending > captured`, or any single refund > captured, or refund currency differs) | Refuse-and-record: the refund attempt is refused                                                                            |
| `failed_refund`           | Provider answered a refund attempt with failure                                                                                                                                   | Refuse-and-record: today's failed-refund handling (release/retry or recorded failure)                                       |
| `partial_refund`          | Cumulative shows part of the money returned                                                                                                                                       | Owner review: detect, record, alert (no current-path action can safely finish it; the balance-refund engine is M7)          |

Four of the branch's fifteen kinds are NOT ported in M4, because no M4
observation can produce them and unreachable union arms are dead code. The two
read-level kinds (`invalid_provider_data`, `missing_resource`) belong to M5's
`resolve.ts`, which is what emits them — M4 read failures remain M3's
`ProviderRead` boundary outcomes. And two refund-shape kinds (`duplicate_refund`
— two refund resources sharing one id — and `multiple_pending_refunds` — more
than one refund in flight) need evidence M4 never holds: no provider read on
this path returns a per-refund resource list, and the only pending refund an
observation can carry is the direct answer to its own single attempt — durable
pending-refund records are M7's `pending_refund_id`. Both kinds return with M7's
engine, from the reference branch.

A paid session with no charge reference never reaches the judge either: the
retained `validatedPaymentSession` boundary already rejects it as
`blank_reference` (retryable, unrefundable by construction — there is no
resource to refund). `paid_without_charge` is reserved for the refundable
free-checkout case.

`fully_refunded` is path-dependent by design. On a refund attempt it means
"already done, count it as success" — exactly `tryRefund`'s current fallback,
now a named verdict. On the booking path (a delayed callback arriving after the
charge was fully refunded externally) it must NOT issue a paid booking: the
session takes the stored-refused arm with the refund step short-circuited to
already-complete — quantity-0 placeholder, payment + `refund_cash` ledger,
system note — and the buyer sees the existing refunded answer. This outcome is
reachable only where the observation in hand carries refund evidence: Square's
payment read carries it at booking judgment, and the Stripe/SumUp rejection arms
gain it from the read each buys before a refund attempt. On the Stripe and SumUp
booking tiers it cannot fire — those reads carry no refund facts, and M4 does
not buy a refund-facts read for every trusted booking, so an externally refunded
charge that still reads as a clean paid session books today and keeps booking in
M4. That exposure is stated, unchanged from today, bounded to
externally-refunded-then-completed checkouts, and closes with M6's aggregate.
`refund_pending` refuses a new attempt without treating the charge as refunded.

### One conflict per observation — the evaluation order is binding

An observation can match several conflict kinds at once (two captured tenders in
a wrong currency match both `multiple_charges` and `currency_mismatch`).
`outcomeOf` reports exactly one, chosen by its fixed evaluation order, which is
part of this contract: expected-vs-observed currency, provider total vs
expected, resource parentage, per-leg currency, over-refund, duplicate charge,
partial charge, money on a free checkout, failed refund — every
refuse-and-record kind — and only then the owner-review kinds: multiple charges,
capture total, partial refund. The port makes two adaptations explicit. First: a
zero-expected observation with captured money is judged by the free-checkout arm
FIRST, so `paid_without_charge` (refund path) is reachable and the capture-sum
kinds never swallow it (equivalently: `partial_charge` and
`capture_total_mismatch` exclude expected 0). Second: the ported order placed
`multiple_charges` mid-list, ahead of `partial_charge` — kept, two under-paying
tenders would emit `multiple_charges` and proceed-and-alert an underpaid
booking; the adaptation moves every owner-review kind after every
refuse-and-record validation kind, so that observation emits `partial_charge`
and (being multi-charge) parks with no booking per decision 5. The principle the
adapted order encodes: every refuse-and-record validation kind is evaluated
before the owner-review kinds, so an observation matching both always takes the
safer refuse path — condition ordering can never quietly upgrade a refusable
observation into a proceed-with-alert one. Decision 5 does not weaken this: a
multi-charge observation matching a refuse kind still refuses the booking — the
rule below only changes whether the refusal's refund is automatic.

Picking one kind never discards the rest of the evidence. The emitted conflict
carries the observation's full captured-charge list (resource ids, amounts,
currencies), so the durable record and the operator always see every charge no
matter which kind won the order.

How a refuse-and-record remedy then acts depends on how many captured charges
the observation carries (decision 5), and the rule below is the CALLBACK side's
— what to do about invalid money that arrived. A refuse-and-record kind emitted
on the refund-attempt side is the opposite action: it refuses the attempt itself
(`refund_exceeds_capture`, an attempt's `resource_mismatch`, a provider-answered
`failed_refund`) and makes zero provider calls beyond its evidence read, per the
commands and failure tables — a verdict that exists to prevent a payout can
never route back into one. On the callback side, with exactly one captured
charge — structurally every Stripe and SumUp observation, and virtually every
Square one — the remedy is today's refund path, unchanged: one charge, one
refund call. With more than one, no automatic refund runs at all: the session
parks to owner review — no booking, no provider refund calls, a terminal
outcome, the activity record naming the winning conflict kind and every charge,
the code-only alert, and the decision-3 manual-check copy for the buyer. The
owner returns the money from the provider dashboard. This is the boundary
decision 1 already draws: the in-app path cannot safely move money on charges it
has no record slot for — per-charge refund evidence, ledger legs, and retry
state are exactly M7's durable engine, and imitating it inside one callback
would mean invented facts (an unread tender's refund state) and an unbounded
provider fan-out. Regression cases: two captured tenders in a wrong currency
yield `currency_mismatch` whose remedy makes zero refund calls, books nothing,
records both resource ids under the winning kind, and answers the manual-check
copy; two captured tenders whose sum is below the signed total yield
`partial_charge` (never `multiple_charges` — the adapted order above) and, being
multi-charge, park the same way with no booking; one captured charge in a wrong
currency refunds exactly as today; a free checkout with captured money yields
`paid_without_charge` and reaches the refund path.

### Owner-review conflicts survive downstream booking failures

A `multiple_charges` / `capture_total_mismatch` observation that proceeds and
then fails to book (sold out, capacity, price drift) must NOT fall into today's
automatic single-reference refund — that would move one tender's money on a
conflicted payment and strand the rest in a different state. When the judge
flagged owner review, every downstream automatic refund is suppressed: the
session records a terminal owner-review outcome, the activity-log record names
both the conflict and the failed booking (the alert is the code-only pointer
described under Owner choices), and replays return the same stable answer. The
buyer sees new plain-language copy: "We received your payment. Your booking
needs a manual check. Do not pay again — we will contact you." The owner
resolves it with the provider dashboard (every leg named in the activity record
— the alert stays the code-only pointer), matching the decided behavior "a
failed checkout that shows captured money stops automatic work". Regression
case: a sold-out booking on an order with two captured tenders makes zero
provider refund calls and records the owner-review outcome.

### Evidence tiers — no invented facts

The judge's refund gate uses the richest evidence the provider exposes for that
reference, and never more:

- **Square** (session and legacy references alike): `retrievePayment` states
  captured `amountMoney` and cumulative `refundedMoney` — the full arithmetic
  applies. Order tenders are captured money only when they SAY so: today's
  tender pick carries only ids (`square.ts:55-59`), and Square documents that an
  order's tender list can lag and can hold non-captured states, so the widened
  pick takes each tender's `amount_money` AND its documented capture status
  (`card_details.status`). Only a tender whose status reads captured counts in
  the captured sum or toward `multiple_charges`; authorized/voided/failed
  tenders are named in the evidence but never counted as money; a tender
  carrying money with a missing or unrecognized status is a malformed read — it
  refuses at M3's provider-read boundary (retryable callback / failed admin
  row), the same rule as any missing documented field, because no ported
  conflict kind represents an unreadable reading and `outcomeOf` must not invent
  one. The webhook-named payment keeps its independent COMPLETED check from the
  payments read — the tender sweep only detects EXTRA captured money.
- **Stripe**: two tiers by path. A webhook-parsed session carries only
  session-level facts (`amount_total`, currency) — the callback BOOKING judgment
  uses exactly those, the same facts today's verdicts use, with zero new reads.
  Refund attempts judge on charge-tier evidence — the widened `amount_refunded`
  pick (decision 2) plus the documented charge amount. The admin/refresh paths
  already make that payment-intent read; a Stripe CALLBACK refund attempt (the
  rejection arm) does not, so it buys the same read before its refund call — one
  added provider call on that rare arm, budgeted in PR A; the full arithmetic
  then applies everywhere charge-tier evidence exists.
- **SumUp** (including every legacy reference): refund authority is the
  transaction read's `transaction_events[]`, per PR3's verified sandbox contract
  (PR3_PLAN.md) — the cumulative refunded is the sum of that response's
  successful `REFUND` events, compared against the documented `amount`
  (captured). The sandbox proof: after a full refund the transaction's top-level
  `status` and `simple_status` both stayed `SUCCESSFUL`, and `refunded_amount`
  appeared only on separate transaction-history items — so no top-level status
  or field is refund authority, and the locked SDK's `REFUNDED` note (refunded
  "in full or in part") makes status insufficient in the other direction too.
  The full arithmetic applies over the event sum — a dashboard partial refund
  becomes `partial_refund` (owner review), not a silently skipped remainder. A
  transaction response missing the documented `amount` is a malformed read at
  M3's provider-read boundary (retryable callback / failed admin row); an absent
  or empty event list is zero refunded — the genuinely expected shape of a
  never-refunded transaction, not a malformed read. Same single read as today;
  no call count increases. Our own refund calls remain full-amount (no amount
  body), and legacy references keep working — the same read answers them. A
  SumUp CALLBACK refund attempt (the rejection arm) starts from the checkout
  observation, which carries `amountMinor` and `transactionId` but no refund
  events — so, exactly like Stripe's rejection arm, it buys the one transaction
  read before its refund call; the arithmetic never runs on an invented zero.

Legacy admin references (`legacyReference`, no session id) are judged the same
way: by whatever their provider's read genuinely answers for the stored payment
reference.

## Commands and events

| Starting state                                                                                                                                                                                                                                  | Command or event                                         | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid session observed, judge says `ready`                                                                                                                                                                                                       | Callback/redirect processing                             | Booking proceeds exactly as today (trusted path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Paid session observed, refuse-and-record conflict                                                                                                                                                                                               | Callback/redirect processing                             | Single captured charge: today's mismatch/rejection refund path runs unchanged — at most one refund call (the judged attempt runs only when it fits; the refusal rows below make zero), buyer answer unchanged, outcome recorded with the existing `REFUND_REASONS` vocabulary. More than one captured charge: zero refund calls — the session parks to owner review with the manual-check copy (decision 5)                                                                                                                                                   |
| Paid session observed, owner-review conflict                                                                                                                                                                                                    | Callback/redirect processing                             | Booking proceeds on the signed total as today; the durable activity-log record carries the conflict kind, every resource id, and the amounts; the best-effort alert is the existing code-only ntfy ping (`sendNtfyError` sends an error code and nothing else) pointing the owner at the log; no payload echo                                                                                                                                                                                                                                                 |
| Owner-review conflict flagged, booking then fails (sold out, capacity, price)                                                                                                                                                                   | Callback/redirect processing                             | No automatic refund on the conflicted payment; terminal owner-review outcome recorded; buyer sees the manual-check copy; replays return the same answer                                                                                                                                                                                                                                                                                                                                                                                                       |
| Charge with no completed/pending refund facts, judge says attempt fits                                                                                                                                                                          | Refund attempt (`tryRefund` / admin single / admin bulk) | Provider refund attempted with the provider's idempotency key (Stripe/Square); success records completion as today                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Charge where returned + returning would exceed captured (> captured)                                                                                                                                                                            | Refund attempt                                           | Attempt refused before any provider call; recorded/answered through the caller's existing failure shape (callback: retryable; admin: failed row with reason). One boundary everywhere: accounted-for ≤ captured passes; exact equality means nothing is left and routes to the `fully_refunded`/`refund_pending` rows, never to refusal                                                                                                                                                                                                                       |
| Charge already fully refunded (provider cumulative or our records)                                                                                                                                                                              | Refund attempt                                           | `fully_refunded`: success without a provider refund call, as `tryRefund`'s fallback does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Provider answers in-flight to a refund attempt (Square PENDING; Stripe refund `status` `"pending"` or `"requires_action"` — in flight, not settled, not a rejection; today Stripe collapses both to a false failure at `stripe-provider.ts:81`) | Refund attempt                                           | No completion write, exactly as today. Within the request that observed it, the judge answers `refund_pending` and no further attempt starts. A later redelivery has no durable pending record (that is M7's `pending_refund_id`); its re-attempt reuses the same deterministic idempotency key, so within the provider's key-retention window (~24 hours for Stripe) it lands on the SAME provider refund — one payout. Past the window the overlap guard's fresh pre-attempt read protects, with the stale-cumulative residual named under Retry and replay |
| Free checkout (expected 0), provider shows money                                                                                                                                                                                                | Callback processing                                      | `paid_without_charge` → refuse-and-record refund path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Paid session observed, judge says `fully_refunded` (money already returned)                                                                                                                                                                     | Callback/redirect processing                             | No paid booking. The stored-refused arm runs with the refund short-circuited to already-complete: quantity-0 placeholder, payment + `refund_cash` ledger, system note; the buyer sees the existing refunded answer; terminal, and replays return the same outcome                                                                                                                                                                                                                                                                                             |

Every command keeps one authoritative implementation; the judge is consulted,
never duplicated.

## Failure table

| Work completed                 | Failure                                                        | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Retry owner                                                                |
| ------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Nothing                        | Provider read unavailable before judgment                      | No verdict; caller's existing unavailable handling (callback 503 retryable; admin row fails with reason)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Provider redelivery / operator                                             |
| Judge refused refund           | — (refusal is the outcome)                                     | No provider call, no local mutation beyond the recorded answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Provider redelivery / operator re-runs later; cumulative catch-up unblocks |
| Provider refund succeeded      | Local completion write fails                                   | A next attempt's fresh read sees the provider cumulative (Square/Stripe) or the amount evidence (SumUp) → `fully_refunded`, success without a second payout. On the callback placeholder-refund path the outcome stays TERMINAL even when `recordPlaceholderRefund` reports `posted: false`: the attendee insert precedes the ledger write and has no replay identity, so a retryable answer would re-enter booking and insert a second placeholder — the current docstring's "a retry must NOT re-create it" is kept. PR B fixes the silent half instead: `posted: false` stops being ignored — it writes an activity-log entry and a system note on the attendee naming the unrecorded money (session id and amount), so the miss is operator-visible and repairable with existing tools (the refresh-payment route re-posts what provider state supports; otherwise the manual ledger correction `reportRefundNotRecorded` already words). Both evidence writes are non-throwing best-effort — the same discipline as the ledger write they report on: their own failure logs a classified error and never prevents the terminal finalize, so the replay identity always lands and redelivery cannot re-book the placeholder. Durable automated re-posting is M7's persistence half | Next redelivery / operator                                                 |
| Refund call sent               | Answer lost (transport error or timeout — no provider verdict) | Not recorded as failed blindly: one post-call evidence re-read re-judges. A cumulative that now covers the charge records completion — the money moved, and the idempotency key or the provider's second-refund rejection keeps it one payout. Anything else records the honest failure — including when the re-read itself is stale (cumulative totals lag): that recorded failure is the row above wearing a different cause, repaired the same way — a later judged read (the refresh-payment route or an operator re-run) observes the caught-up cumulative, answers `fully_refunded`, and records completion, while the idempotency key (Stripe/Square) or full-refund rejection (SumUp) keeps any interim re-attempt at one payout. A definitive rejection that names its reason (Stripe's explicit failure statuses, Square's typed errors) skips the re-read: the verdict is the answer. SumUp's generic 409 state-conflict is NOT definitive — it does not say which state conflicted, so it is never assumed to mean already-refunded: it takes the same one bounded re-read, and the evidence answers (a cumulative covering the charge records `fully_refunded`; anything else records the honest failure)                                                                 | Same caller; operator re-runs                                              |
| Provider refund PENDING        | Request ends                                                   | No completion write; Stripe/Square replay lands on the same idempotency key; SumUp: a re-attempt's fresh amount read answers `fully_refunded` before any call when the cumulative covers the charge, and a provider 409 on the call itself is classified by the bounded re-read, never assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Provider redelivery                                                        |
| Owner-review conflict detected | Alert delivery fails                                           | The durable record survives: the conflict is written to the activity log in the same transaction as the processing outcome, so it is admin-visible regardless of alert delivery. The ntfy/log alert itself is best-effort, stated as such — terminal replays do not re-observe, so a lost alert is not retried on this path. Retryable owner alerting is M5's unsent-revision machinery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Operator (activity log today; M5 cases)                                    |

## Retry and replay

- Stable identity: the provider payment reference (unchanged), plus the
  deterministic `refundIdempotencyKey(provider, reference)` for Stripe and
  Square provider calls. Stripe prunes idempotency keys after ~24 hours, so a
  re-attempt beyond that window is a genuinely new provider operation; its
  protection is the overlap guard's fresh pre-attempt read — after 24 hours the
  cumulative reflects any committed refund (provider lag is seconds to minutes,
  not days), so the guard refuses. The residual — a cumulative still stale a day
  after a committed refund — is a provider data fault, not lag; the durable
  per-attempt records that close it completely are M7's, and M4 states the
  boundary instead of writing new tables for it. SumUp has no provider
  idempotency parameter — its replay safety is: our refunds are full-amount
  only, a second refund of a refunded transaction is provider-rejected (its
  generic 409 state conflict, classified by the bounded evidence re-read, never
  assumed), and the judge short-circuits from a fresh read of the documented
  transaction evidence (`amount` against the summed refund events).
- Exact replay of a callback returns the same terminal outcome (existing
  `processed_payments` replay), and a replay that reaches the refund path gets
  the judge's verdict from fresh evidence — an already-completed refund answers
  success, never a second payout. Exact means every captured resource the fresh
  observation carries matches the payment resource the terminal record stored —
  the comparison sweeps the whole observation (Square: the named payment plus
  every captured order tender; Stripe/SumUp: the single resource), so a
  redelivery naming the original resource but carrying a caught-up tender list
  with a second capture is new evidence, not a replay. All post-terminal
  deliveries take one total rule, whether they carry new money (that caught-up
  second capture) or changed settled facts on the same resources (a Square
  redelivery of the same payment now showing a higher cumulative `refundedMoney`
  after an external partial refund): the fresh observation — already validated
  and in hand, zero extra provider calls — runs through the pure judge for
  detection only, any owner-review kind it emits is recorded as the owner-review
  activity record (the stored reference plus every observed charge) with the
  code-only alert, and the recorded terminal outcome is returned unchanged. A
  redelivery whose observation matches the stored facts detects nothing and
  simply replays the stored answer. The terminal outcome stands because no
  automatic remedy — booking or refund — can safely re-run after settlement:
  re-judging stored terminal evidence is M5's `resolve.ts`, and moving the new
  money is the owner's dashboard call per decisions 1 and 5. No provider re-read
  is needed: the observation was validated before the reservation check.
  Once-ness is carried by the acknowledgement, not by a durable per-resource
  key, because no M4 surface can hold one (`payment_charges` stays dormant; the
  activity log has no unique key): the record is written before the terminal
  answer is returned, and that answer acks the callback, so the provider stops
  redelivering it. Concurrent duplicate deliveries can therefore each write the
  record — the failure direction is a duplicate operator-visible record, never a
  lost one — and the durable per-resource slot that makes this exactly-once is
  M6's aggregate row. PR B also makes the reference comparison total for new
  terminal rows: `markSessionFailed` stores the observed payment reference
  beside `failure_data` — the `processed_payments.payment_reference` column
  already exists, but today only success finalization writes it
  (`processed-payments.ts:190-203`), never the failure write (`:213-226`) — so a
  second capture after a terminal failure is detected exactly like one after a
  success. Only legacy failure rows from before PR B carry no reference; for
  those the comparison is vacuous and the replay stands — stated.
- Retries stay owned by provider redelivery and the operator, as today. M4 adds
  no scheduler.
- Permanent failures: a provider's explicit refund rejection records the failed
  outcome as today; `partial_refund` and `capture_total_mismatch` park as
  owner-review alerts (no automatic retry can fix them).
- One failed item cannot block later work: bulk refund rows already record
  per-reference results; a refused row records its reason and the wave
  continues.

## Concurrency

| Operation A                                 | Operation B                                       | Required result                                                             | Protection                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback refund attempt                     | Redelivered callback refund attempt               | One payout                                                                  | Reservation lock (`processed_payments`) — PR B extends it to the rejection arm, which today refunds before reserving — plus provider idempotency key (Stripe/Square), judge's fresh-read `fully_refunded`/`refund_pending` verdicts, SumUp provider-side second-refund rejection |
| Admin refund                                | Callback refund of the same charge                | One payout                                                                  | Same as above — both paths front the same judge; Stripe/Square then land on the same idempotency key, and SumUp on the provider's own rejection of a second refund (its generic 409 state conflict, classified by the evidence re-read) plus the fresh amount read               |
| Two admin bulk waves touching one reference | —                                                 | One payout per reference                                                    | `refundState === "completed"` short-circuit, judge verdict, idempotency key                                                                                                                                                                                                      |
| Judgment read                               | Provider state changes after read, before attempt | Provider-side rejection or idempotent landing; never a silent double payout | Provider guarantees (documented full-refund rejection) + next read converges                                                                                                                                                                                                     |

M4 adds no new locks and no revision columns; it narrows what the existing
protections must carry by refusing attempts that today would be fired blindly.
The SumUp cells are a narrowing, not a proof: with no idempotency parameter, two
truly simultaneous refund calls are serialized only by the provider, and SumUp
documents 409 as a state conflict, not a concurrency guarantee. The pre-attempt
read and the 409-classifying re-read shrink the window today's blind attempts
leave open; the residual simultaneous window is unchanged from today, stated
here, and closes with M7's durable pending-attempt gate. PR A's concurrency
regression exercises our side of this (the second attempt answers provider
rejection or a fresh `fully_refunded` read) — provider-side serialization is the
stated assumption, not something a mocked test can prove. The table's "one
payout" answers carry the same conditions: for SumUp they hold on that
serialization assumption, and for Stripe/Square they hold unconditionally within
the key-retention window and past it on the fresh-read guard, whose
stale-cumulative residual is the M7 boundary named under Retry and replay.

## Owner choices

Genuine conflicts the system must not decide:

- **`multiple_charges`** (a second captured charge on one payment): the record
  (activity log) names the payment reference, every provider resource id, and
  the per-tender amounts; the alert is the existing best-effort ntfy ping, which
  by its privacy contract carries only an error code (`sendNtfyError(code)` — no
  ids, no amounts), so a conflict-specific code points the owner at the activity
  log rather than carrying the evidence itself. The owner refunds the extra
  charge in the provider dashboard (the in-app path cannot act on a charge it
  has no record slot for until M6). Automatic work is not stopped: the booking
  stands on the signed total. This is PLAN.md's approved M4 text applied ("one
  handler maps these outcomes onto today's behavior: detect, record, and alert …
  no automatic work is stopped or stranded before an owner can act") — failing
  the callback closed instead would 503 until provider redelivery exhausts,
  leaving taken money with no booking, no buyer answer, and no case tooling
  until M5, which is precisely the stranding the plan forbids. No money moves
  automatically either way; the extra charge sits untouched for the owner.
  Decision 1 records the owner's explicit choice of this remedy.
- **`capture_total_mismatch` / `partial_refund`**: same detect-record-alert
  handling; the evidence names expected vs observed amounts. Resolution today is
  the provider dashboard plus existing admin tools; case pages arrive in M5.
- **A multi-charge observation that also fails validation** (decision 5): parks
  to owner review instead of any automatic refund — no booking, no provider
  calls, the record names the winning conflict kind and every charge, and the
  buyer sees the manual-check copy. Single-charge observations keep the
  automatic refund remedy unchanged.

No money-moving automation is added for any owner-review kind.

## Security and privacy

- No new routes, roles, or links. Alerts and logs carry conflict kinds, resource
  ids, and amounts — never buyer PII, never raw provider payloads (M3's
  fixed-refusal discipline is unchanged).
- The judge runs on evidence already fetched by the current path; the only new
  provider data crossing a boundary is Stripe's documented `amount_refunded` and
  refund `status` fields (decision 2) Square's documented tender `amount_money`
  and capture-status fields, and SumUp's documented transaction `amount` and
  `transaction_events[]` refund events — money figures and money states, none
  personal.
- Untrusted inputs cannot reach the judge without passing M3's ownership
  boundary first. Forged SumUp callbacks with unknown, oversized, empty, or
  missing ids still cost zero provider calls; a forger replaying a REAL staged
  checkout id costs exactly one bounded read — that read IS the authenticity
  check, by M3's design — answered with the fixed refusal on any mismatch. The
  bound is per request — an amplification factor of at most one — with exactly
  one stated exception: the single delivery that genuinely processes the
  session. That one request does the session's real work (a rejection arm's
  evidence read and possibly one refund call), work the system performs exactly
  once whoever delivered the callback — provider or forger — because the
  reservation lock serializes it and the terminal record plus acknowledgement
  end it. Every later replay of that checkout id, forged or not, costs the one
  authenticity read and nothing more. Regression (PR B): a replayed callback for
  a terminally processed session costs exactly one provider read and zero refund
  calls. Bounding request volume itself is the platform's rate limiting,
  unchanged — M4 adds no new unauthenticated read surface.

## What is deleted (F51)

In the same merges that wire `outcomeOf` in:

- `classifySession` / `classifySessionIntent`'s verdict arithmetic and the
  `SessionClass` type (`classify.ts:97-132`) — the callback-side judge.
- `tryRefund`'s ad-hoc attempt/fallback ordering and
  `refundReferenceAtProvider`'s duplicate of it — both become observe → judge →
  act. The fallback's one real protection — confirming a refund whose response
  was lost in transit — survives as the failure table's narrow
  indeterminate-answer re-read, run only when no provider verdict arrived
  instead of after every false.
- The refresh-payment route's `refunded ? "completed" : "none"` boolean mapping
  (`attendees-edit.ts:98-102`) — a third judge. Its provider poll becomes the
  same charge-tier evidence read, judged by `outcomeOf`: `fully_refunded` →
  completed as today; `refund_pending` → stays unrefunded with the pending
  answer surfaced; `partial_refund` → an owner-review record, never a silent
  "none".
- No alias, wrapper, or re-export bridges the old names.

`validatedPaymentSession` (M3 boundary), `refund-state.ts` (a record-derived
display fact, not a judge), and the ledger stay.

## Vertical PR slices

Two PRs, each standing alone, hardest invariant first (decision 4). PLAN.md's
400–700 src figure is the milestone target; the hard rule is delivery rule 3's
800 changed src lines PER PR. Six review rounds added real closures
(owner-review carry-through, the ledger-swallow fix, the SumUp amount widening,
the terminal-replay sweep), and decision 5 removed the multi-charge refund
machinery a middle revision had grown. The estimates are PR A ≈ 350–500 and PR B
≈ 250–350 — a 600–850 total that can still run past the milestone target's top
while each PR stays well under its own cap; the overage buys review-found
correctness, not scope creep.

**PR A — "No refund attempt can exceed the captured money" (≈ 350–500 src)**

- Ports the pure closure: `outcomeOf`, conflict kinds, refund legs and
  arithmetic, `resolveRefund`, `kindObject`, the words subsets.
- Builds the per-provider refund-evidence adapters (Square cumulative + PENDING
  answer; Stripe widened `amount_refunded` plus refund `status`, mapped totally
  — `succeeded` → completed; `pending` and `requires_action` → `refund_pending`
  (in flight: re-attempts land on the same idempotency key, and the operator's
  answer names the status); `failed` and `canceled` → `failed_refund` (settled
  as not-happening; a fresh operator attempt is legitimate — noting, unchanged
  from today's use of the same deterministic key, that a re-attempt inside
  Stripe's ~24-hour idempotency window replays the original failed answer, and a
  genuinely new attempt exists once the window lapses; per-attempt identity is
  M7's `pending_refund_idempotency_key`); and a `null` status — a shape the
  production schema accepts (`StripeRefundSchema`, `schemas.ts:64-72`) — is no
  verdict at all, so it takes the failure table's lost-answer arm: the one
  bounded evidence re-read decides, nothing is recorded from the null itself —
  instead of today's collapse of everything non-succeeded to failure; SumUp
  widened to the documented `amount` plus `transaction_events[]`) and fronts
  `tryRefund`, `refundReferenceAtProvider`, and the admin refresh-payment
  route's provider poll with the judge.
- Carries the observed charge evidence through the callback rejection flow: the
  rejection handed to `refundRejectedCharge` keeps the observation's charge
  facts (per its tier), so Square callback refunds are judged with zero extra
  reads. Stripe's session tier and SumUp's checkout tier carry no refund facts,
  so those rejection arms each buy one read before the refund call
  (payment-intent for Stripe, transaction for SumUp) — one added provider call
  on those rare arms, and the trusted booking path stays zero-read. The refund
  rules are enforced everywhere; no arm is left vacuous.
- Moves the rejection arm behind the same reservation the booking path holds.
  Today `refundRejectedCharge` runs before `processPaymentSession` ever reaches
  `reserveSession` (`webhooks.ts:423-435`), so two concurrent deliveries of one
  rejected session are serialized by nothing — and with no SumUp idempotency
  key, both can issue the refund. In PR B the rejection arm claims the
  `processed_payments` reservation keyed by the observed payment reference
  BEFORE any provider call, writes the terminal rejected outcome once the refund
  settles, and answers a concurrent duplicate with the in-flight retry (503) or
  the stored terminal answer — never a second payout. This is what makes the
  security section's amplification exception and the concurrency table's first
  row true for rejections, not just bookings. Regression: two concurrent
  deliveries of one rejected SumUp session make at most one provider refund
  call; a delivery after the terminal write makes zero.
- Lands the shared owner-review recorder — the activity-log write and the
  code-only alert helper — because PR A's own judge already makes an
  owner-review outcome reachable (`partial_refund` on the refresh-payment route)
  and each slice must carry the remedies for the outcomes it makes reachable. PR
  B reuses this recorder for the callback-side owner-review arms.
- Refactors Square's refund call to act on the already-observed payment: today
  `squareApi.refundPayment` re-reads the payment internally for its amounts
  (`square.ts:664`), so without the refactor a judged attempt would cost three
  provider calls. The judge's read becomes THE read; the refund call takes the
  observed amounts, which also removes the read-then-refund gap inside the
  provider call.
- Deletes the displaced attempt/fallback ordering in both.
- Completes: F3 (classification half). Regression tests: the pinned arithmetic
  rows; a Square PENDING answer followed by a redelivery produces exactly one
  provider refund (the re-attempt reuses the same idempotency key and lands on
  the same refund — asserted by key equality, one payout); pending + completed
  exceeding captured is refused; completed counts immediately while cumulative
  lags; two concurrent SumUp refund attempts make at most one payout on our side
  — the second answers provider rejection or a fresh `fully_refunded` read
  (application-side behavior; provider serialization of truly simultaneous calls
  is the concurrency section's stated assumption); a Stripe refund answering a
  `null` status records nothing until the bounded evidence re-read answers; a
  SumUp transaction whose successful refund events sum above zero and below
  `amount` reads as `partial_refund`, never `fully_refunded` — an empty or
  absent event list stays `ready`, and events summing to `amount` read
  `fully_refunded` even while top-level status still says `SUCCESSFUL` (the
  sandbox-observed shape); a Stripe refund answering `pending` writes no
  completion, reports the pending answer (not failure), and a re-run lands on
  the same idempotency key; a refund whose transport answer is lost but which
  committed at the provider records completion after the reconcile read — one
  payout; a partially-refunded reference on the refresh-payment route records
  owner review instead of silently reading as unrefunded.
- Budgets: at most 2 provider calls per admin reference on the normal arms — 1
  evidence read (its result IS the judgment input, never a separate call) plus
  at most 1 refund call — and at most 3 when a sent refund's answer is lost (the
  indeterminate re-read in the failure table). Per outcome: refusal and
  `fully_refunded` cost 1 (the read alone; 0 when our own records already
  refuse); a normal attempt costs 2. A callback refund costs its refund call
  plus evidence: 0 extra reads for Square (the carried payment evidence judges),
  1 read on the Stripe and SumUp rejection arms (the payment-intent /
  transaction read each buys). Today the same reference costs 1–2 (the refund,
  plus the fallback read on failure), so M4 moves the read up front without
  raising the normal ceiling, and the 3-call arm spends its extra read exactly
  where today's blind fallback also spent one. The admin bulk cap is
  `BULK_REFUND_LIMIT` (5) **attendees**, and one attendee can carry several
  references (deposit plus balance; merges): R total references cost 2R provider
  calls on the normal arms and 3 per reference when a sent refund's answer is
  lost (the reconciling re-read above), typically R ≤ 10 for a full batch.
  Because the worst case must fit Bunny's 50-subrequest allowance even if every
  answer is lost, PR A adds a batch pre-flight: before ANY provider call, the
  run counts its still-unrefunded references, and a batch whose recovery worst
  case — 3R plus the batch's database writes — cannot fit is refused whole —
  zero provider calls, every row failed with the plain reason "This run has too
  many payments to refund at once. Refund fewer attendees at a time." A batch
  can no longer abort mid-flight with some refunds committed and unrecorded; the
  arithmetic is static, so the refusal is exact, not a guess. Regression: an
  oversized batch makes zero provider calls and fails every row with that
  reason. The paged engine that processes arbitrarily large batches is still F53
  / M7 — this slice only refuses what one request cannot safely hold. Database
  calls: unchanged from today.
- Standalone value: the live system stops repeat and over-refunds.

**PR B — "One judge for callback money, and alerts for what it finds" (≈ 300–400
src)**

- Builds the callback-side observation (expected facts from the signed proof,
  charges from the session evidence per provider) and replaces
  `classifySession`'s verdicts with the judge's outcomes mapped by the
  exhaustive remedy `Record`; deletes `SessionClass` and the inline arithmetic.
- Wires the callback outcomes through the shared owner-review recorder landed in
  PR A (the activity-log write joins the processing transaction) and adds the
  Square multiple-tender detection: the raw tender pick widens to the documented
  `amount_money` and capture-status fields, and a tender counts as captured
  money only when its status says so (authorized/voided/failed tenders are named
  in evidence, never counted; money with an unreadable status refuses at the
  read boundary as a malformed read) — all from the order read the path already
  makes, no extra provider calls.
- Carries owner review through downstream booking failures (no automatic refund
  on a conflicted payment; terminal owner-review outcome; the new buyer copy
  above), and surfaces a failed placeholder-refund ledger write instead of
  swallowing it: the outcome stays terminal (a retryable answer would re-book
  the placeholder — the attendee insert has no replay identity), and
  `posted: false` now writes the activity-log entry and attendee note named in
  the failure table, closing the TODO.md gap's silent half; durable automated
  re-posting is M7's. Regression tests: the sold-out-with-two-tenders case makes
  zero refund calls; a failed placeholder ledger write books exactly one
  placeholder across redeliveries and leaves the miss visible in the activity
  log and the attendee's notes.
- Separates exact terminal replays from new money, and settles the remaining
  callback arms: the terminal-replay comparison sweeps every captured resource
  in the fresh observation against the stored reference, and any extra captured
  resource writes the owner-review record with the code-only alert before
  returning the recorded outcome (the acked answer stops redelivery, and
  `markSessionFailed` now stores the observed reference so failure rows compare
  too); a callback judged `fully_refunded` books nothing and takes the
  stored-refused arm with no refund call; a single-charge refuse remedy refunds
  as today; and a multi-charge refuse remedy parks to owner review (decision 5).
  Regression tests: a post-terminal callback carrying a second captured tender —
  under the original resource name or a new one — records the conflict, never
  re-books or refunds, and once acked its redeliveries write nothing more; a
  second capture arriving after a terminal failure is detected the same way (the
  failure row now carries the reference); a delayed callback for an externally
  fully-refunded charge issues no paid booking and no refund call; a
  wrong-currency two-tender observation makes zero refund calls, books nothing,
  records both resource ids, and answers the manual-check copy.
- Budgets: zero additional provider or database calls beyond today's callback
  path on the trusted arm, plus the one activity-log statement inside the
  existing processing transaction; the refuse arm makes at most one provider
  refund call (single-charge observations; a multi-charge observation makes zero
  and parks to owner review), so the callback's provider-call ceiling is fixed
  and can never be chased upward by a provider-controlled tender list; the
  new-evidence replay arm adds one durable write, no provider calls.
- Completes: F51. Regression tests: every conflict kind maps to exactly one
  remedy (exhaustiveness compile test + table-driven behavior tests); money on a
  free checkout refunds; two paid tenders alert without stopping the booking;
  verdict parity cases proving byte-identical buyer answers for today's
  trusted/mismatch flows.

Both PRs run targeted mutation on every changed payment module
(`deno task mutation --harness`) and the branch gate (`precommit:mutation`)
before merge, per delivery rule 4.

## Adversarial review

- _External refund succeeds, local write fails?_ The next judgment's fresh read
  sees the provider cumulative (Square/Stripe) or the summed refund events
  (SumUp) → `fully_refunded` → success without a second payout. Unchanged from
  today, now named.
- _Callback replayed?_ Terminal outcomes replay from `processed_payments`;
  pre-terminal replays re-judge fresh evidence; refunds land on idempotency keys
  (Stripe/Square) or provider full-refund rejection (SumUp).
- _Follow-up read fails after a signed success?_ No verdict is invented; the
  caller's existing unavailable handling answers (retryable/failed row).
- _Wrong amount, currency, parent, id?_ Each is a named conflict with one
  remedy; parents/ids keep M3's per-provider evidence checks.
- _Two requests race?_ See the concurrency table: the judge narrows what the
  existing lock + idempotency protections must carry; no new interleaving is
  introduced because the judge is pure and takes no locks.
- _Stale evidence between read and attempt?_ Provider-side idempotency or
  rejection converts the race to an idempotent landing; the next read converges.
  Fresh-evidence-per-attempt is the rule (no cached verdicts).
- _Same resource on another record?_ `duplicate_charge` within one payment's
  evidence refuses; duplicated refund resources need the per-refund identities
  only M7's records hold (see the conflict table's note); cross-payment
  duplicates are F8 (M6, needs the aggregate unique index) and out of scope —
  stated, not silently dropped.
- _One queued item fails permanently?_ Bulk rows record per-reference results; a
  refused reference cannot block the wave.
- _What does the buyer see?_ Byte-identical answers for the trusted flow and
  every existing mismatch/rejection flow — the judge changes which internal
  verdict fires, not those responses. The decided exceptions are new: the
  manual-check copy where a payment parks to owner review — an owner-review
  conflict whose booking later fails (decision 3), or a multi-charge observation
  failing validation (decision 5) — and the stored-refused answer (existing
  copy) where a callback judged `fully_refunded` would today have booked. Owner
  alerts are the only other new user-visible artifact, and PR B's parity tests
  cover exactly the unchanged flows.
- _SumUp double-refund without idempotency?_ A second full refund of a refunded
  transaction is provider-rejected (the generic 409, classified by the bounded
  evidence re-read rather than assumed), and the judge's fresh amount read
  answers `fully_refunded` first when the cumulative equals captured — a
  dashboard partial refund instead reads as `partial_refund` and parks for the
  owner. The unguarded window is a crash after a SumUp refund succeeded and
  before any later read — the next read converges; our own refund calls are
  full-amount only.

## Owner decisions (answered 2026-08-09 and 2026-08-10)

1. **Owner-review remedy for `multiple_charges` — DECIDED: proceed-and-alert.**
   Booking proceeds on the signed total, with a durable activity-log record
   naming every charge and a best-effort code-only alert pointing at it (the
   ntfy ping carries an error code and nothing else); no automatic refund of the
   extra charge. This is PLAN.md's approved M4 text applied. The fail-closed
   alternative was offered and declined: 503s until provider redelivery exhausts
   would mean money taken, no booking, no buyer answer, and no case tooling
   until M5.
2. **Stripe `amount_refunded` widening — DECIDED: approved.** The read schema
   widens from `latest_charge.refunded` alone to also pick the documented
   `latest_charge.amount_refunded`, giving Stripe a real cumulative for the
   refund arithmetic.
3. **Copy approvals — DECIDED: both strings approved verbatim.** Blocked refund
   (admin failed-row reason): "A refund for this payment is still settling. Try
   again after it completes." Conflicted payment whose booking failed (buyer
   page): "We received your payment. Your booking needs a manual check. Do not
   pay again — we will contact you."
4. **Slicing — DECIDED: two PRs.** PR A (refund-overlap guard) first, then PR B
   (callback cutover); each stands alone, hardest first.
5. **Multi-charge refunds — DECIDED: owner review, never automatic
   (2026-08-10).** An observation carrying more than one captured charge never
   receives automatic refunds. When it also fails validation (wrong currency,
   wrong total — any refuse-shaped conflict), the session parks to owner review:
   no booking, no provider refund calls, a terminal outcome, the activity record
   naming every charge, the code-only alert, and the decision-3 manual-check
   copy for the buyer. Single-charge observations — structurally all of Stripe
   and SumUp, and virtually all of Square — keep today's automatic refund remedy
   unchanged. Reason: per-charge refund evidence, ledger legs, and retry state
   are M7's durable engine; inside one M4 callback they would mean invented
   facts (an unread tender's refund state), an unbounded provider fan-out
   against the edge subrequest budget, and a ledger shape with no slot for a
   partly-returned batch.
