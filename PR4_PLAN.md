# M4: one diagnosis for settled money — behavior contract

## Status

All five owner decisions are recorded below: proceed-and-alert for
`multiple_charges`, the Stripe `amount_refunded` read widening, both new copy
strings, the two-PR slicing (2026-08-09), and owner review for every
multi-charge observation — automatic refunds act on single-charge observations
only (2026-08-10). No implementation has started. Per PR_WORKFLOW.md the final
sign-off is explicit approval of this latest version (merging PR #2063 or saying
"approved"); tests and code start only after that. Milestone source: PLAN.md's
M4 section, fault rows F3 and F51 (with M4 slices of F6, F12, F13, and F53), and
the binding decided behaviors on refunds and multiple captures; this PR carries
the matching PLAN.md sync (the M4 section, the M6 provider note, and those fault
rows).

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
  verified per M1/M3). An expected CURRENCY exists only on this booking tier: a
  session was signed under the site currency of its checkout, and M4 keeps
  today's comparison against the live `settings.currency` — the exposure is a
  mid-checkout currency change, refusal-safe (the mismatch refuses and the money
  returns), closed when M6 stores the currency per charge (F12). A STORED
  reference carries no expected currency and never borrows today's (law 4,
  frozen facts): its judgment makes no expected-vs-observed currency comparison
  at all, and the only currency rule on a refund-only input is observed-internal
  — a refund leg in a different currency from its captured leg refuses as
  `refund_exceeds_capture`.
- Our durable completed-refund records: a ledger `refund_cash` leg and
  `processed_payments.provider_refunded_at`. These are our own writes, performed
  only after a provider confirmed a refund.
- The staged/signed ownership facts from M3 (SumUp sealed staging, Stripe
  signatures, Square order metadata proof).
- A stored refund reference's PROVIDER IDENTITY. A reference must carry every
  fact its future judgment needs, and the provider that captured it is chief
  among them — the currently selected provider is ambient state, never evidence
  about an old charge. New writes tag the reference with its provider inside the
  same owner-key-encrypted value (a callback knows its provider from its own
  route and signatures; an anchor row minted by an admin claim is tagged by the
  terminal write that records a provider-VALIDATED outcome, so a stored tag
  always records proof, never a resolution guess). A reference from before the
  tag has its provider DISCOVERED, never assumed: the deployed existing-payments
  rule (`existingPaymentProviderState`,
  `src/shared/existing-payment-provider.ts`) prefers the currently configured
  provider without ever inspecting the reference, so it can only ORDER the
  search, never decide it (law 4 — ambient state may order a search, never
  decide a fact). Discovery runs the reference's evidence read against each
  credentialed provider in turn — the deployed rule's answer first, so a
  single-provider site pays exactly today's one read and no reference resolves
  worse than today — and exactly one read that finds the payment and passes that
  provider's M3 validation is the proof, recorded as the row's tag by the
  terminal write so discovery runs once per reference ever. A reference NO
  credentialed provider validates is an honest UNRESOLVED failure naming what
  was tried and the fix ("No configured payment provider recognizes this
  payment. Add the provider it was taken with, or refund it from that provider's
  dashboard.") — it never names a guessed provider as the reference's own, and
  no refund is ever dispatched to an adapter that did not validate the payment.

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

| Conflict kind             | Meaning                                                                                                                                                                                                           | Remedy in M4                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency_mismatch`       | Any observed currency differs from the signed expected currency (booking tier only — a stored reference carries no expected currency and never borrows today's; law 4)                                            | Refuse-and-record: today's mismatch refund path                                                                                                                                                                                                                                                                                                                                                 |
| `provider_total_mismatch` | Provider session total ≠ signed expected total                                                                                                                                                                    | Refuse-and-record: mismatch refund path                                                                                                                                                                                                                                                                                                                                                         |
| `partial_charge`          | Captured sum < expected                                                                                                                                                                                           | Refuse-and-record: mismatch refund path                                                                                                                                                                                                                                                                                                                                                         |
| `capture_total_mismatch`  | Captured sum ≠ expected (over-capture)                                                                                                                                                                            | Owner review: detect, record, alert                                                                                                                                                                                                                                                                                                                                                             |
| `paid_without_charge`     | Money on a free checkout: expected total is 0 and a charge is present                                                                                                                                             | Refuse-and-record: mismatch refund path (the charge has a resource to refund)                                                                                                                                                                                                                                                                                                                   |
| `resource_mismatch`       | Charge/refund parent or provider disagrees with its session/charge                                                                                                                                                | Refuse-and-record: refuse retryably (callback) / refuse attempt (refund path); keeps Square's current throw-behavior, named                                                                                                                                                                                                                                                                     |
| `duplicate_charge`        | Two charge legs share one resource id                                                                                                                                                                             | Refuse-and-record                                                                                                                                                                                                                                                                                                                                                                               |
| `multiple_charges`        | More than one captured charge on one payment (Square: >1 paid tender)                                                                                                                                             | Owner review: detect, record, alert; automatic work proceeds on the signed total as today                                                                                                                                                                                                                                                                                                       |
| `refund_exceeds_capture`  | Returned + returning money would exceed captured (`Math.max(providerCumulative, ourCompleted) + pending > captured`, or any single refund > captured, or a refund leg's currency differs from its captured leg's) | Refuse-and-record: the refund attempt is refused                                                                                                                                                                                                                                                                                                                                                |
| `failed_refund`           | Provider answered a refund attempt with failure                                                                                                                                                                   | Refuse-and-record: today's failed-refund handling (release/retry or recorded failure)                                                                                                                                                                                                                                                                                                           |
| `partial_refund`          | Cumulative shows part of the money returned                                                                                                                                                                       | Owner review. On the BOOKING path it PARKS — no ticket, buyer retained, alert — because the provider retaining less than the signed total is an operator choice (a dashboard discount? a cancellation underway?), never an automatic booking. On a refund attempt or the refresh route it is detect-record-alert (no current-path action can safely finish it; the balance-refund engine is M7) |

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
already-complete — in the session's own path shape (new booking: quantity-0
placeholder, payment + `refund_cash` ledger, system note; balance payment: no
placeholder, the existing attendee's balance stays unpaid, and the same
idempotent payment + `refund_cash` pair posts against the existing attendee —
the commands table row states both) — and the buyer sees the existing refunded
answer. This outcome is reachable only where the observation in hand carries
refund evidence: Square's payment read carries it at booking judgment, and the
Stripe/SumUp rejection arms gain it from the read each buys before a refund
attempt. On the Stripe and SumUp booking tiers it cannot fire — those reads
carry no refund facts, and M4 does not buy a refund-facts read for every trusted
booking, so an externally refunded charge that still reads as a clean paid
session books today and keeps booking in M4. That exposure is stated, unchanged
from today, bounded to externally-refunded-then-completed checkouts, and closes
with M6's aggregate. `refund_pending` refuses a new attempt without treating the
charge as refunded.

### One conflict per observation — the evaluation order is binding

An observation can match several conflict kinds at once (two captured tenders in
a wrong currency match both `multiple_charges` and `currency_mismatch`).
`outcomeOf` reports exactly one, chosen by its fixed evaluation order, which is
part of this contract: expected-vs-observed currency, provider total vs
expected, resource parentage, per-leg currency, over-refund, duplicate charge,
partial charge, money on a free checkout, failed refund — every
refuse-and-record kind — and only then the owner-review kinds, in this order:
partial refund FIRST, then capture total, then multiple charges. Within the
owner-review group the ordering principle is the global one applied again:
park-shaped kinds evaluate before proceed-shaped kinds, so condition ordering
can never quietly upgrade an observation into a booking. `partial_refund` leads
because it is the only owner-review kind that parks the booking path: a split
payment whose two legs sum to the signed total but whose first leg was already
part-refunded must park as `partial_refund` — the provider retains less than the
signed total — never book as `multiple_charges`. Then `capture_total_mismatch`
before `multiple_charges`: a multi-leg sum exceeding the signed total names the
money discrepancy, not merely the leg count. `multiple_charges` therefore fires
only when the captured sum equals the signed total AND no refund evidence
reduces what the provider retains (regressions: two £60 tenders on a £100 signed
order emit `capture_total_mismatch`, never `multiple_charges`; two £50 tenders
on a £100 order with £20 already refunded emit `partial_refund` and park). The
port makes two adaptations explicit. First: a zero-expected observation with
captured money is judged by the free-checkout arm FIRST — before every
expected-vs-observed amount check, `provider_total_mismatch` included, which the
enumerated order would otherwise reach first (a free checkout with a positive
provider session total matches it) — so `paid_without_charge` (refund path) is
the one diagnosis for money on a free checkout (equivalently:
`provider_total_mismatch`, `partial_charge`, and `capture_total_mismatch` all
exclude expected 0). Second: the ported order placed `multiple_charges`
mid-list, ahead of `partial_charge` — kept, two under-paying tenders would emit
`multiple_charges` and proceed-and-alert an underpaid booking; the adaptation
moves every owner-review kind after every refuse-and-record validation kind, so
that observation emits `partial_charge` and (being multi-charge) parks with no
booking per decision 5. The principle the adapted order encodes: every
refuse-and-record validation kind is evaluated before the owner-review kinds, so
an observation matching both always takes the safer refuse path — condition
ordering can never quietly upgrade a refusable observation into a
proceed-with-alert one. Decision 5 does not weaken this: a multi-charge
observation matching a refuse kind still refuses the booking — the rule below
only changes whether the refusal's refund is automatic.

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
charge — structurally every Stripe observation (a session names one
`payment_intent`), and virtually every Square and SumUp one — the remedy is
today's refund path, unchanged: one charge, one refund call. One check gates
that arm at the ACTION level, not by kind: before any callback automatic refund,
every observed charge must cohere with the signed session — the parentage facts
the observation carries must agree. A contradiction forces the retryable
no-refund refusal with zero provider calls REGARDLESS of which conflict kind won
the evaluation order: a payment with a wrong parent AND a wrong currency is
labelled `currency_mismatch` by the binding order, but the refund is still
withheld, because refunding a payment whose parent disagrees could return money
for a DIFFERENT order — most plausibly provider consistency lag. A kind-keyed
carve-out would be bypassed by exactly that observation; the gate is on the
action, so another winning label can never hide contradictory parentage.
Provider redelivery with coherent evidence, or the operator, resolves it; no
automatic money moves on evidence that contradicts itself. Regression: one
captured payment with both a wrong parent order and a wrong currency refuses
retryably, zero provider calls, never a refund. With more than one, no automatic
refund runs at all: the session parks to owner review — no booking, no provider
refund calls, a terminal outcome, the activity record naming the winning
conflict kind and every charge, the code-only alert, and the decision-3
manual-check copy for the buyer. Every park RETAINS the buyer: a new-booking
session persists the same quantity-0 placeholder attendee `storeRefundedBooking`
creates today — name and contact details kept, no ticket, no refund run —
atomically with the terminal outcome, plus a system note naming the conflict; a
balance session notes the existing attendee, who already carries contact
details. Without that record the promised "we will contact you" would be a
promise the owner cannot keep — the activity log holds only resource ids and
amounts. The owner returns the money from the provider dashboard. This is the
boundary decision 1 already draws: the in-app path cannot safely move money on
charges it has no record slot for — per-charge refund evidence, ledger legs, and
retry state are exactly M7's durable engine, and imitating it inside one
callback would mean invented facts (an unread tender's refund state) and an
unbounded provider fan-out. Regression cases: two captured tenders in a wrong
currency yield `currency_mismatch` whose remedy makes zero refund calls, books
nothing, records both resource ids under the winning kind, and answers the
manual-check copy; two captured tenders whose sum is below the signed total
yield `partial_charge` (never `multiple_charges` — the adapted order above) and,
being multi-charge, park the same way with no booking; one captured charge in a
wrong currency refunds exactly as today; a free checkout with captured money
yields `paid_without_charge` and reaches the refund path.

### Owner-review conflicts survive downstream booking failures

A `multiple_charges` / `capture_total_mismatch` observation that proceeds and
then fails to book (sold out, capacity, price drift) must NOT fall into today's
automatic single-reference refund — that would move one tender's money on a
conflicted payment and strand the rest in a different state. When the judge
flagged owner review, every downstream automatic refund is suppressed: the
session records a terminal owner-review outcome, the activity-log record names
both the conflict and the failed booking (the alert is the code-only pointer
described under Owner choices), and replays return the same stable answer. The
buyer is retained here exactly as in the park above — the quantity-0 placeholder
(new booking) or the system note on the existing attendee (balance), written
atomically with the terminal outcome — so the owner holds the contact details
the buyer copy promises to use. The buyer sees new plain-language copy: "We
received your payment. Your booking needs a manual check. Do not pay again — we
will contact you." The owner resolves it with the provider dashboard (every leg
named in the activity record — the alert stays the code-only pointer), matching
the decided behavior "a failed checkout that shows captured money stops
automatic work". Regression case: a sold-out booking on an order with two
captured tenders makes zero provider refund calls and records the owner-review
outcome.

### Evidence tiers — no invented facts

The judge's refund gate uses the richest evidence the provider exposes for that
reference, and never more:

- **Square** (session and legacy references alike): `retrievePayment` states
  captured `amountMoney` and cumulative `refundedMoney` — the full arithmetic
  applies. The DECLARED Square observation for any money decision is that
  payment read PLUS its order's captured-tender sweep (law 6, total evidence):
  the callback path already holds the order read; the admin single and bulk
  preflights and the refresh route buy the one order read their path lacks — the
  order id rides the payment read — so no path judges Square money on
  payment-only evidence, and a sibling tender captured before booking is seen at
  the first attempt to move money even when no redelivery ever revealed it. What
  no read can see is a tender Square has not yet propagated into the order at
  that instant — that lag residual is the same provider-data-fault class as the
  stale cumulative (closed by M7's per-attempt records), a bounded propagation
  window where the pre-sweep blind spot was unbounded. `refunded_money` is a
  DOCUMENTED-OPTIONAL field: Square omits it on a never-refunded payment, so its
  absence means a cumulative refund of zero in the captured money's currency —
  the genuinely-expected-absence case the house rules name, already modelled
  optional at the boundary (`square.ts:463-476`) and pinned by the existing
  missing-means-not-refunded test. The malformed-field refusal is for money that
  is present but incoherent (an amount without a currency), never for this
  documented absence — an ordinary never-refunded payment judges `ready`, it
  does not retry forever. Order tenders are captured money only when they SAY
  so: today's tender pick carries only ids (`square.ts:55-59`), and Square
  documents that an order's tender list can lag and can hold non-captured
  states, so the widened pick reads each tender's `amount_money` AND its capture
  state by the tender's documented TYPE. A card tender counts per
  `card_details.status` — captured only when the status says so;
  authorized/voided/failed card tenders are named in the evidence but never
  counted as money; a CARD tender carrying money with a missing or unrecognized
  `card_details.status` is a malformed read — it refuses at M3's provider-read
  boundary (retryable callback / failed admin row), the same rule as any missing
  documented field, because no ported conflict kind represents an unreadable
  reading and `outcomeOf` must not invent one. A non-card tender (Square
  documents cash, wallet, gift-card, and other types, none of which carry
  `card_details`) that states `amount_money` counts as observed captured money
  in the sweep, its type named in the evidence — these types document no
  order-level pending state, and counting them errs toward detection (an
  owner-review record), never toward validity: the webhook-named payment keeps
  its independent COMPLETED check from the payments read, which alone gates
  booking — the tender sweep only detects EXTRA captured money. A valid order
  carrying a cash tender must never wedge as an eternally retrying malformed
  read. Before any duplicate or multiple-charge check, the observation coalesces
  the named payment with its own tender: the tender whose payment id IS the
  webhook-named payment is excluded from the sweep (its facts come from the
  richer payments read), so a caught-up tender list on an ordinary one-payment
  order can never read as `duplicate_charge` against the payment itself;
  `duplicate_charge` remains for two genuinely distinct legs sharing one
  resource id. The observation also carries `order.totalMoney` as the provider
  SESSION total, a separate observed fact from the per-tender charges — today
  `retrieveSession` stands the named payment's own amount in as `amountTotal`
  when the payment is COMPLETED (`square-provider.ts:154-166`), which would make
  a valid split payment (a £100 signed order paid by two captured £50 tenders)
  fire `provider_total_mismatch` (50 ≠ 100) and refuse before `multiple_charges`
  could park it for owner review as decision 1 decided. With the order total
  carried separately, that observation reads: session total 100 = expected,
  captured sum 100 = expected, two captured tenders → `multiple_charges`,
  proceed-and-alert. The existing code comment's guard stays honored — a short
  or unreadable charge still cannot book by matching the order total, because
  booking validity remains the named payment's COMPLETED check and the
  captured-sum comparison, never the session total alone. Regressions: an
  ordinary Square callback whose caught-up order lists exactly the named
  payment's own tender judges `ready` — never `duplicate_charge`, never
  `multiple_charges`; a £100 signed order paid by two captured £50 tenders emits
  `multiple_charges` (proceed-and-alert), never `provider_total_mismatch`.
- **Stripe**: two tiers by path. A webhook-parsed session carries only
  session-level facts (`amount_total`, currency) — the callback BOOKING judgment
  uses exactly those, the same facts today's verdicts use, with zero new reads.
  Refund attempts judge on charge-tier evidence. Today's
  `StripeExpandedPaymentIntentSchema` picks only the intent id and
  `latest_charge.refunded` (`stripe/schemas.ts:42-52`) — no captured amount, no
  currency — so the decision-2 widening is stated completely: the pick gains the
  charge's documented `amount`, `currency`, and `amount_refunded` together.
  Without the first two the refund gate could not compute returned-vs-captured
  for a Stripe reference — legacy/admin references included, which carry no
  signed proof — without copying an expected or ledger amount into the observed
  slot, which the refund-only input above forbids. All three are documented
  charge money fields: the same read, more money figures, nothing personal —
  decision 2's scope, stated explicitly. The admin/refresh paths already make
  that payment-intent read; a Stripe CALLBACK refund attempt (the rejection arm)
  does not, so it buys the same read before its refund call — one added provider
  call on that rare arm, budgeted in PR A; the full arithmetic then applies
  everywhere charge-tier evidence exists.
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
  never-refunded transaction, not a malformed read. The transaction read is not
  the whole declared shape, though: a paid checkout can carry more than one
  SUCCESSFUL child (below), the replay contract treats a later-visible child as
  possible, and a stored row names only ITS child — so for any money decision on
  a row that names its checkout, the declared SumUp observation is the
  transaction read PLUS the checkout's vouched-children sweep (law 6, the same
  children pick the callback path validates), exactly as Square's order sweep:
  the admin single and bulk preflights and the refresh route buy the one
  checkout read, and a sibling SUCCESSFUL child is a multi-charge observation —
  the whole attendee refuses with zero refund calls and the detection records.
  On any MULTI-child observation — callback booking and admin preflight alike —
  the sweep alone is not the whole shape either: the checkout names a sibling's
  identity, amount, and status but not its refund events, and the binding
  evaluation order needs those events to park a part-refunded split as
  `partial_refund` instead of booking it as `multiple_charges` — so the
  multi-child arm buys one transaction read per additional SUCCESSFUL child
  before judging (the single-child common case pays nothing extra; the rare
  multi-child cost is one read per sibling, counted in admission; regression: a
  two-child checkout whose sibling was part-refunded before the callback parks
  as `partial_refund`, never books). A checkout read that fails is M3's
  no-verdict boundary — money never moves on the narrower read. A legacy
  reference that names no checkout has the transaction read as its whole
  declared shape — stated, the same M6/M7 residual as its other unknowns
  (regressions: an admin refund of a SumUp booking whose checkout carries a
  second SUCCESSFUL child — booked before the child was visible, no redelivery
  since — is refused whole with zero refund calls and the detection recorded;
  the refresh twin refuses its ledger completion the same way). Our own refund
  calls remain full-amount (no amount body), and legacy references keep working
  — the same reads answer them. A SumUp CALLBACK refund attempt (the rejection
  arm) starts from the checkout observation, which carries `amountMinor` and
  `transactionId` but no refund events — so, exactly like Stripe's rejection
  arm, it buys the one transaction read before its refund call; the arithmetic
  never runs on an invented zero. SumUp is NOT structurally single-charge: a
  paid checkout can carry more than one SUCCESSFUL child transaction, and today
  `paidChildVerdict` refuses ANY extra child as `unrecorded_child`
  (`sumup-observation.ts:143-150`), which the provider turns into a retryable
  refusal (`sumup-provider.ts:133-139`) — an eternal 503 with captured money,
  never a judged observation, no buyer record, no owner alert. PR B's cutover
  carries the vouched SUCCESSFUL children into the observation's captured-charge
  list instead (each child's documented amount and transaction id), and the
  COMMON remedy map applies — no SumUp-specific arm: children summing to the
  signed total emit `multiple_charges` and proceed-and-alert per decision 1 (the
  buyer books, the owner-review marker and alert land), exactly as Square's two
  £50 tenders do; the park is decision 5's, reserved for a multi-charge
  observation that also wins a refuse-shaped validation kind. A SumUp buyer who
  paid correctly in two captures gets a ticket, not a quantity-0 manual-review
  placeholder. `unrecorded_child` remains for a child that fails validation (a
  bad id, a wrong merchant code), not for extra settled money. Regressions: a
  paid SumUp checkout bearing two SUCCESSFUL children summing to the signed
  total BOOKS with the owner-review record and alert — never a 503, never a
  park; one whose children also fail validation (wrong currency, short sum)
  parks with both charges named.

Legacy admin references (`legacyReference`, no session id) are judged the same
way: by whatever their provider's read genuinely answers for the stored payment
reference. "Their provider" is the reference's own, per the trusted-facts rule:
the stored provider tag when the row carries one, else the discovery that rule
defines — the validated read is the proof, tagged onto the row by the terminal
write. Dispatch is per REFERENCE, never per attendee — a merged attendee whose
references were captured under different providers has each reference judged and
refunded at its own provider (`refundCandidateAtProvider` resolves the provider
per reference; provider clients are already cached factories, so two providers
in one run cost no extra reads) — and a TAGGED reference whose provider has no
stored credentials, or whose read fails that provider's validation, is an honest
failed row naming the provider and the fix (restore that provider's credentials,
or refund from its dashboard), never a call to the wrong adapter. Regressions:
after a site switches from Stripe to SumUp with the Stripe credentials retained,
one bulk run refunds an old untagged Stripe reference at Stripe — discovery's
SumUp read does not validate it, its Stripe read does, and the terminal write
tags the row — beside a new SumUp reference refunded at SumUp; with the Stripe
credentials removed, a tagged Stripe row fails naming Stripe with zero provider
calls, and an untagged one fails UNRESOLVED after discovery finds no validating
provider — naming what was tried, dispatching no refund anywhere. A legacy
reference carries no signed price proof, so its judgment is a refund-only input
by definition: observed captured money, the observed cumulative (or summed
refund events), and our completed records. The overlap arithmetic compares
returned money against CAPTURED money, so it needs no expected total — and none
is synthesized: the observed capture is never copied into the expected slot, and
the booking-tier expected-vs-observed kinds (`currency_mismatch`,
`provider_total_mismatch`, `partial_charge`, `capture_total_mismatch`) are
simply not evaluable for these references — stated, not defaulted. No expected
currency is borrowed from today's `settings.currency` (law 4 — the site may have
sold in a different currency when the charge was captured, and F12's
live-currency fault names exactly this class); the only currency rule here is
the observed-internal one — a refund leg in a different currency from its
captured leg refuses as `refund_exceeds_capture`. Regression: a legacy reference
captured while the site sold in one currency refunds cleanly after the site
switches to another — the judgment never reads the live currency setting.

## Commands and events

| Starting state                                                                                                                                                                                                                                  | Command or event                                         | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid session observed, judge says `ready`                                                                                                                                                                                                       | Callback/redirect processing                             | Booking proceeds exactly as today (trusted path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Paid session observed, refuse-and-record conflict                                                                                                                                                                                               | Callback/redirect processing                             | Single captured charge WITH COHERENT PARENTAGE: today's mismatch/rejection refund path runs unchanged — at most one refund call (the judged attempt runs only when it fits; the refusal rows below make zero), buyer answer unchanged, outcome recorded with the existing `REFUND_REASONS` vocabulary. Coherent parentage is a PREREQUISITE of this row, never overridden by whichever kind won the evaluation order: a single charge whose parent facts disagree with the signed session takes the action-level gate's retryable zero-call refusal even when `currency_mismatch` or another kind won. More than one captured charge: zero refund calls — the session parks to owner review with the manual-check copy (decision 5)                                                                                                                                                                 |
| Paid session observed, owner-review conflict                                                                                                                                                                                                    | Callback/redirect processing                             | Booking proceeds on the signed total as today; the durable activity-log record carries the conflict kind, every resource id, and the amounts; the best-effort alert is the existing code-only ntfy ping (`sendNtfyError` sends an error code and nothing else) pointing the owner at the log; no payload echo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Owner-review conflict flagged, booking then fails (sold out, capacity, price)                                                                                                                                                                   | Callback/redirect processing                             | No automatic refund on the conflicted payment; terminal owner-review outcome recorded; buyer sees the manual-check copy; replays return the same answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Charge with no completed/pending refund facts, judge says attempt fits                                                                                                                                                                          | Refund attempt (`tryRefund` / admin single / admin bulk) | Provider refund attempted with the provider's idempotency key (Stripe/Square); success records completion as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Charge where returned + returning would exceed captured (> captured)                                                                                                                                                                            | Refund attempt                                           | Attempt refused before any provider call; recorded/answered through the caller's existing failure shape (callback: retryable; admin: failed row with reason). One boundary everywhere: accounted-for ≤ captured passes; exact equality means nothing is left and routes to the `fully_refunded`/`refund_pending` rows, never to refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Charge already fully refunded (provider cumulative or our records)                                                                                                                                                                              | Refund attempt                                           | `fully_refunded`: success without a provider refund call, as `tryRefund`'s fallback does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Provider answers in-flight to a refund attempt (Square PENDING; Stripe refund `status` `"pending"` or `"requires_action"` — in flight, not settled, not a rejection; today Stripe collapses both to a false failure at `stripe-provider.ts:81`) | Refund attempt                                           | No completion write, exactly as today. Within the request that observed it, the judge answers `refund_pending` and no further attempt starts. A later redelivery has no durable pending record (that is M7's `pending_refund_id`); its re-attempt reuses the same deterministic idempotency key, so within the provider's key-retention window (~24 hours for Stripe) it lands on the SAME provider refund — one payout. Past the window the overlap guard's fresh pre-attempt read protects, with the stale-cumulative residual named under Retry and replay                                                                                                                                                                                                                                                                                                                                       |
| Free checkout (expected 0), provider shows money                                                                                                                                                                                                | Callback processing                                      | `paid_without_charge` → refuse-and-record refund path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Paid session observed, judge says `fully_refunded` (money already returned)                                                                                                                                                                     | Callback/redirect processing                             | No paid booking, and the refusal takes the session's own path shape. A new-booking session runs the stored-refused arm with the refund short-circuited to already-complete: quantity-0 placeholder, payment + `refund_cash` ledger, system note. A balance session (`balanceAttendeeId` names an existing attendee) creates NO placeholder and no new attendee: the balance stays unpaid, the terminal refused outcome and a system note on the existing attendee name the externally refunded charge, and the money round trip still reaches the ledger — the same idempotent payment + `refund_cash` pair, keyed by the session, posts against the existing attendee (net zero), so the captured-and-returned cash shows on the attendee statement and in ledger reporting instead of vanishing. Both: the buyer sees the existing refunded answer; terminal, and replays return the same outcome |

Every command keeps one authoritative implementation; the judge is consulted,
never duplicated.

## Failure table

| Work completed                 | Failure                                                                                                                                                                                                                                    | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Retry owner                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Nothing                        | Provider read unavailable before judgment                                                                                                                                                                                                  | No verdict; caller's existing unavailable handling (callback 503 retryable; admin row fails with reason)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Provider redelivery / operator                                             |
| Judge refused refund           | — (refusal is the outcome)                                                                                                                                                                                                                 | No provider call, no local mutation beyond the recorded answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Provider redelivery / operator re-runs later; cumulative catch-up unblocks |
| Provider refund succeeded      | Local completion write fails                                                                                                                                                                                                               | A next attempt's fresh read sees the provider cumulative (Square/Stripe) or the amount evidence (SumUp) → `fully_refunded`, success without a second payout. On the callback placeholder-refund path the outcome stays TERMINAL even when `recordPlaceholderRefund` reports `posted: false`: the attendee insert precedes the ledger write, and today it carries no replay identity, so a retryable answer would re-enter booking and insert a second placeholder — the current docstring's "a retry must NOT re-create it" is kept. PR B gives the insert that identity and closes the re-creation window structurally, on EVERY path that persists a buyer record and then refunds — the boundary rejection arm (`refundRejectedCharge`) and the stored-refused booking failures alike (`storeRefundedBooking` inserts its placeholder before refunding, `store-refund.ts:167-185`, called from `payment-processing/index.ts:208-249,291-298` — the same crash window): the arm claims the reservation, then ONE batch persists the buyer record and writes its id plus a staged refund-in-flight marker onto the reservation row (`failure_data` with a distinct staged kind, naming the deterministic idempotency key, the batch's written-at time, and its `callback` owner scope per Concurrency) plus the session's payment reference — the charge being refunded, encrypted as today, so a stale resume knows exactly what to refund — and only then calls the provider (the staged batch also sets the `protected_state` mirror, so no retention arm can reach the row mid-flight). The buyer record follows the session's shape: a new-booking session inserts the quantity-0 placeholder; a balance session inserts NOTHING — it binds the existing attendee whose balance was being paid, and the payment/refund pair posts against that attendee per the commands table, because a placeholder would attach the money to a spurious record. `blank_reference` never enters this lifecycle: it is retryable and unrefundable by construction — no resource to refund — so its reservation releases and the callback answers retryably until a delivery carries a usable reference; it is never stored as a terminal rejection. A worker death between that batch and the terminal batch leaves the staged row — neither an unresolved reservation (the reaper never deletes it: `attendee_id` is set) nor a finalized answer — so a redelivery reads it and re-creates nothing (the buyer-record identity is on the row). Whether it RESUMES is decided by the staged row's age against the edge request lifetime bound: a FRESH row means the original worker may still be awaiting the provider, so the duplicate answers retryably without touching the provider — Stripe/Square would dedupe a concurrent resume under the stored idempotency key, but SumUp has no key, and the age gate is what keeps two live workers from racing full refunds — while a STALE row is a crashed worker, and the redelivery resumes at the refund step: Stripe/Square under the stored idempotency key, SumUp behind its fresh pre-attempt evidence read (a cumulative covering the charge answers `fully_refunded` with no second call). The staged state is routed BEFORE the finalized-success branch: today's conflict handler answers success for any row with `attendee_id` set before it ever reads `failure_data` (`payment-processing/index.ts:69-74`), which would replay a staged row as a completed booking while the buyer's money sat captured — PR B's handler checks `failure_data` for the CALLBACK-scope staged kind FIRST, so a staged rejection-arm row resumes at the refund step and only a genuinely finalized row replays success — an `attendee_set` claim is invisible to this routing, per Concurrency (regression: a redelivery against a staged callback-scope row answers the refund resume, never `alreadyProcessedResult`). PR B fixes the silent half too: `posted: false` stops being ignored — the unposted-money fact rides the terminal write itself, stored in the terminal record's outcome data (`failure_data`, the same env-key-encrypted slot `markSessionFailed` writes, naming the session and amount) in the SAME batch as the finalize, so the durable marker and the replay identity land atomically: even if every other write fails, the terminal row itself names the money the ledger is missing. The activity-log entry and the attendee system note are layered on top as operator surfacing, non-throwing best-effort — their failure logs a classified error and never prevents the finalize, so redelivery cannot re-book the placeholder. Repair stays with existing tools (the refresh-payment route re-posts what provider state supports; the manual ledger correction `reportRefundNotRecorded` covers the rest); durable automated re-posting is M7's persistence half | Next redelivery / operator                                                 |
| Refund call sent               | No validated provider verdict (transport error, timeout, or a response body that fails its schema — `StripeRefundSchema` / the Square refund response shape; a 2xx with an unreadable body moves money just as invisibly as a lost packet) | Not recorded as failed blindly: the malformed body is surfaced loudly (a classified error naming the provider and reference — never parsed leniently), and one post-call evidence re-read re-judges. A cumulative that now covers the charge records completion — the money moved, and the idempotency key or the provider's second-refund rejection keeps it one payout. Anything else records the honest failure — including when the re-read itself is stale (cumulative totals lag): that recorded failure is the row above wearing a different cause, repaired the same way — a later judged read (the refresh-payment route or an operator re-run) observes the caught-up cumulative, answers `fully_refunded`, and records completion, while the idempotency key (Stripe/Square) or full-refund rejection (SumUp) keeps any interim re-attempt at one payout. A definitive rejection that names its reason (Stripe's explicit failure statuses, Square's typed errors) skips the re-read: the verdict is the answer. SumUp's generic 409 state-conflict is NOT definitive — it does not say which state conflicted, so it is never assumed to mean already-refunded: it takes the same one bounded re-read, and the evidence answers (a cumulative covering the charge records `fully_refunded`; anything else records the honest failure). What that recorded failure RELEASES is concurrency law 3's capability rule: a KEYED claim (Stripe/Square) releases with the record — a re-run lands on the same idempotency key, one payout — while a KEYLESS claim (SumUp) stays standing IN DOUBT: the sent call may have committed while its answer was lost, and with no key a released claim would let an immediate re-run race the first call's settlement. The in-doubt failed row answers the approved settling copy ("A refund for this payment is still settling. Try again after it completes."); a re-run against the FRESH claim repeats that answer with zero provider calls; once the claim is STALE (the first call's request is certainly dead, and an accepted refund has had the whole staleness window to reach the evidence read) a scope-preserving re-claim resumes behind the fresh pre-attempt read, and at any time a read whose cumulative covers the charge resolves the claim to `fully_refunded` with no call. The residual — an accepted refund still invisible to evidence past the staleness bound — is the same named provider-data-fault class as the stale cumulative under Retry and replay, closed by M7's per-attempt records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Same caller; operator re-runs                                              |
| Provider refund PENDING        | Request ends                                                                                                                                                                                                                               | No completion write; Stripe/Square replay lands on the same idempotency key; SumUp: a re-attempt's fresh amount read answers `fully_refunded` before any call when the cumulative covers the charge, and a provider 409 on the call itself is classified by the bounded re-read, never assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Provider redelivery                                                        |
| Owner-review conflict detected | Alert delivery fails                                                                                                                                                                                                                       | The durable record survives: the conflict is written to the activity log in the same transaction as the processing outcome, so it is admin-visible regardless of alert delivery. The ntfy/log alert itself is best-effort, stated as such — terminal replays do not re-observe, so a lost alert is not retried on this path. Retryable owner alerting is M5's unsent-revision machinery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Operator (activity log today; M5 cases)                                    |

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
  every captured order tender; SumUp: every vouched SUCCESSFUL child the
  checkout carries — the same sweep the initial judgment makes, so a
  later-visible second child is never mistaken for a replay; Stripe: the single
  named resource), so a redelivery naming the original resource but carrying a
  caught-up tender list or a newly visible SumUp child with a second capture is
  new evidence, not a replay. All post-terminal deliveries take one total rule,
  whether they carry new money (that caught-up second capture) or changed
  settled facts on the same resources (a Square redelivery of the same payment
  now showing a higher cumulative `refundedMoney` after an external partial
  refund): the fresh observation — already validated and in hand, zero extra
  provider calls — runs through the pure judge for detection only. What gets
  recorded is total, not a whitelist: EVERY conflict kind the fresh judge emits
  — owner-review kinds and refuse-and-record kinds alike, because after
  settlement no automatic remedy is safe, so a new tender in a wrong currency
  (`currency_mismatch`) or with a wrong parent (`resource_mismatch`) maps to the
  same durable owner-review record rather than to a refund or a refusal — and
  equally a `fully_refunded` verdict on a session whose terminal answer booked
  the money as kept: an external refund reaching 100% must not be quieter than
  one reaching 60%. EXTERNAL is the boundary of that rule: a delivery whose only
  change from the committed evidence is refund progress the app's OWN durable
  facts already record — the named reference's completed in-app refund
  (`provider_refunded_at` with its ledger reversal), or a terminal record whose
  outcome names the refund the rejection arm itself issued — is a CONFIRMATION,
  not a detection: the fingerprint advances in the same batch so the next
  identical redelivery replays silently, and nothing else is written — no
  owner-review record, no alert — because alerting the owner that the provider
  now shows the refund the app performed would bury the real alerts under one
  false alarm per refunded booking. Any fact beyond the app's recorded refund —
  progress past the refunded amount, a resource the committed evidence lacks, a
  changed currency or parent — records and alerts per the total rule
  (regressions: an admin-refunded booking's caught-up Square redelivery advances
  the fingerprint with no record and no alert, and its replay writes nothing; an
  overpay rejection's redelivery now showing the arm's own refund is equally
  silent; a redelivery showing refund progress beyond the app's recorded refund
  still records and alerts). Every record names the stored reference plus every
  observed charge and goes through the same recorder, and the recorded terminal
  outcome is returned unchanged. A redelivery whose observation matches the
  stored facts detects nothing and simply replays the stored answer. The
  terminal outcome stands because no automatic remedy — booking or refund — can
  safely re-run after settlement: re-judging stored terminal evidence is M5's
  `resolve.ts`, and moving the new money is the owner's dashboard call per
  decisions 1 and 5. No provider re-read is needed: the observation was
  validated before the reservation check. Both the replay comparison and
  once-ness hang off one mechanism, because neither existing surface is
  comparable from a webhook: the activity log's `message` is owner-key-encrypted
  ciphertext (`activity-log.ts` — a webhook can write it, never search it), and
  `processed_payments.payment_reference` is `OwnerKeyEncrypted` — randomized
  ciphertext the webhook writes but cannot read back or compare. PR B therefore
  adds an `evidence_index` column to `processed_payments`: a deterministic
  one-way code (the existing `hmacHash` pattern behind `ticket_token_index` and
  friends) over ONE canonical representation used everywhere — the CODED
  canonical summary defined below. There are not two serializations: a fresh
  delivery derives the coded summary from its judged observation (a total
  derivation, so every fact that can change the verdict or the recorded evidence
  — a future observation field included — lands in a leg's identity code, its
  settled-facts code, or its numbers by construction) and hashes THAT; the
  stored fingerprint is the hash of the stored coded summary; equal input, equal
  hash, so an unchanged delivery always compares equal. Each leg's IDENTITY code
  is its STABLE identity — provider plus resource id, nothing else — while
  parent linkage, currency, and capture state live in the leg's separate
  settled-facts code: a provider correcting a leg's parent linkage is a
  settled-facts change on the SAME leg (recorded, newest reading kept), never a
  phantom second leg that would hold the sibling-capture gates closed forever.
  The summary also carries the outcome kind and the session-total number.
  Canonical includes ORDER: legs sort by identity code, ties broken by the full
  coded representation — because provider array order is not evidence: Square
  and SumUp may return the same tenders or children permuted, and an
  order-sensitive hash would record and alert an identical observation as new
  money. The tiebreak matters precisely where ids repeat — a reachable
  `duplicate_charge` observation carries two legs with one id, and an id-only
  sort would leave their relative order the provider's (regressions: a
  redelivery whose only difference is tender order hashes equal and writes
  nothing; so does one permuting two same-id legs). Comparable in plaintext,
  revealing nothing (a one-way code over provider resource ids and money
  figures, no PII). This is what keeps the changed-settled-facts guarantee above
  real in every direction: a grown cumulative refund (still `partial_refund`,
  same resources), a currency that changed while staying wrong, or a parent that
  changed while staying mismatched each change the fingerprint and record,
  rather than masquerading as an exact replay. Columns on an existing table, not
  a new table; `payment_charges` stays dormant. Every terminal write stores it —
  success finalization and `markSessionFailed` alike (`markSessionFailed` also
  gains the owner-readable `payment_reference` write it lacks today:
  `processed-payments.ts:190-203` writes it on success, `:213-226` never on
  failure). A redelivery hashes its fresh observation and compares: an equal
  fingerprint is an exact replay — nothing written, the stored answer returned;
  a different fingerprint is new evidence — the total detection rule above
  records it (a third tender on a payment whose first two were already recorded
  changes the fingerprint, so later money is never suppressed by an earlier
  record) and the committed evidence advances by MERGE, never replacement (the
  monotone law below). Identical redeliveries therefore write nothing more even
  after a lost acknowledgement — and truly concurrent duplicates are serialized
  too: the detection write is a COMPARE-AND-SET in one interactive transaction,
  the `evidence_index` update conditioned on the index still holding the value
  this delivery compared against, and the owner-review record committing only
  when that condition held. Two deliveries in flight with the same new evidence
  yield exactly one record and one alert — the loser's condition fails, it
  writes nothing and alerts nothing. A losing delivery is not discarded blind:
  it reloads the committed index, and only an index EQUAL to its own fingerprint
  is a true duplicate (answer the stored outcome). A differing index means the
  contenders carried DIFFERENT evidence — a clean observation seeding a legacy
  row's index while a simultaneous delivery carries the caught-up second tender
  — so the loser retries the compare-and-detect cycle against the committed
  index instead of suppressing real money that may never be redelivered; the
  retry is bounded by the transaction retry budget and convergent because each
  round compares against a strictly newer index. The retry writes only what the
  loser's own observation justifies, and "beyond the committed evidence" is
  DECIDABLE FROM THE ROW ALONE: every write that sets or advances
  `evidence_index` — a detection, a legacy seed, a confirmation — stores the
  judged observation's CODED canonical summary as its own field of the row's
  `failure_data` record, in the same batch as the index, so a losing retry
  compares CONTENT, never a one-way hash it cannot decompose — on terminal
  failure rows exactly as on booked ones. CODED, because the env-key slot must
  not weaken the owner-key boundary: stored payment references are deliberately
  owner-key encrypted (`src/shared/db/payment-references.ts` — checkout and
  webhook code writes them, only an authenticated admin request reads them
  back), so a summary holding raw provider resource ids would re-expose under
  the weaker env key exactly what that boundary protects. The summary therefore
  stores, per leg: a one-way identity code over the leg's STABLE identity —
  provider plus resource id, nothing mutable (the existing `hmacHash`
  blind-index pattern behind `ticket_token_index`) — a one-way settled-facts
  code over its mutable facts (parent linkage, currency, capture state), the
  observed count, and the money numbers (captured amount and currency,
  cumulative refunded) — plus the session-total number and the outcome kind (one
  representation, the fingerprint's own input above). No raw provider resource
  or parent id ever enters env-key data; the human-readable evidence — the real
  ids and amounts the owner acts on — is the owner-key activity-log record the
  same detection batch already writes. Every comparison the summary serves works
  on codes: a losing retry codes its own fresh observation's legs the same way
  and set-compares; the refresh and refund gates code the named reference
  (decrypted in their authenticated context) and check the summary for captured
  legs beyond it; a webhook can compute every code from the fresh observation it
  holds, and none can be reversed from a database dump. Advances are MONOTONE
  (concurrency law 2): an advancing write stores the MERGE of the committed
  summary with the judged observation — legs united by their STABLE identity
  code (provider plus resource id), so a committed leg never leaves the summary
  (identical legs keep the larger observed count, preserving `duplicate_charge`
  multiplicity); each leg's cumulative refunded keeps its maximum; a leg's
  settled-facts code takes the provider's newest reading, that change itself
  being a recordable fact ON THE SAME LEG — a provider correcting a leg's parent
  linkage updates the leg, records the change, and never mints a phantom sibling
  that would hold the extra-capture gates closed forever (regression: a
  redelivery whose only change is a corrected parent on the named payment
  records the settled change and the refresh gate still permits its
  single-charge completion) — and the stored fingerprint is the hash of that
  MERGED coded summary. Committed evidence can therefore only grow, even when
  the advancing observation is a lagging SUBSET carrying one genuinely new fact:
  a committed two-tender summary receiving a one-tender observation with newer
  refund progress advances to a summary still naming BOTH tenders plus the
  progress, so the gates below never un-learn a capture, and the caught-up
  two-tender redelivery after it hashes equal to the merged summary and replays
  silently. An observation whose merge ADDS NOTHING — every leg already present
  with the same settled facts, no refund progress past the summary's — is a
  STALE snapshot (Square serving one delivery a lagging tender list) and writes
  NOTHING, never regressing the index to an older observation that would make
  already-recorded money look new and alert again; only a merge that adds a fact
  — a leg the summary lacks, a changed settled fact, refund progress past it —
  records and advances the index, the added delta classified as detection or
  confirmation by the total rule above (regressions: after a clean loser retries
  against a committed second-capture index, a redelivery of that second capture
  writes nothing more; a stale two-tender loser that lost to a committed
  three-tender record finds both its tenders in the summary, writes nothing, and
  the next three-tender redelivery fingerprints equal and replays silently — one
  record, one alert; a lagging one-tender delivery bearing newer refund progress
  on a two-tender record advances a summary still naming both tenders, and the
  refresh gate still refuses ledger completion on the sibling capture). The
  equal-fingerprint replay path never reads the summary; that decrypt is paid
  only on the rare differing-index retry. An interruption between the two writes
  can neither make the next identical delivery record twice (fingerprint
  advanced with the record) nor suppress a record that never landed (neither
  write happened). Regressions: two simultaneous identical post-terminal
  deliveries produce one record, one alert; a legacy row's clean seed racing a
  second-capture delivery ends with the conflict recorded exactly once. When the
  fresh judge's outcome on a BOOKED session is an owner-review CONFLICT — a
  first callback finalized `ready` before Square's tender list caught up, a
  later delivery revealing the second capture — that same batch also writes the
  owner-review marker into the session row's `failure_data`: the conflict KIND,
  beside the same batch's committed observation summary — the captured-resource
  evidence lives ONCE, in the summary, serving the loser retries and the gates
  alike, so the marker's charges can never drift from the fingerprint's, and
  picking one kind never discards the rest of the evidence (nor can the summary
  later forget a capture: advances merge per law 2, so a committed leg never
  leaves the summary) — and the gates read CONTENT, not just kind: every marker
  hides the Refund action (its handler could only refuse — the dead-link rule),
  while the refresh route's ledger-completion writes are refused whenever the
  committed summary names any captured charge beyond the named reference —
  REGARDLESS of which kind won the evaluation order, because an extra capture
  can hide behind a higher-priority diagnosis: a replay revealing a second
  tender AND a partial refund on the named tender emits `partial_refund`, yet
  completing the ledger when that tender later fully refunds would reverse the
  whole booking order while the sibling stays captured (regression: such a
  marker refuses completion even though its kind is `partial_refund`).
  Refund-progress evidence is deliberately NOT gate-closing beyond that: a
  dashboard FULL refund of the named single charge judges `fully_refunded` —
  recorded and alerted precisely because NO local fact explains it (the app
  performed no refund; that is the external-change test above), fingerprint
  advanced, NO marker — so the refresh route's unambiguous
  `fully_refunded → completed` ledger write stays open and the provider refund
  reaches the ledger; a dashboard PARTIAL refund judges `partial_refund`, whose
  marker (the committed summary: the named charge alone) hides the Refund action
  but leaves the refresh route free to observe later settlement and complete
  what provider state supports. Without the marker, the attendee would keep a
  live Refund action whose use reverses the full ledger order while the newly
  detected sibling stays captured (regressions: a session booked clean whose
  redelivery reveals a second tender loses its Refund action and refuses legacy
  refunds immediately; one whose charge was dashboard-refunded in full completes
  its ledger through the refresh route with no marker written). Legacy rows from
  before PR B carry no fingerprint, and a RETENTION-PRUNED row is the same shape
  wearing a different cause: today's ledger preflight
  (`replaySessionFromLedger`, `payment-processing/index.ts:183-194`) answers a
  pruned session from the ledger BEFORE any validation runs, which under law 1
  is a consumer skipping the state machine — so PR B's cutover judges the
  in-hand observation FIRST on both: any conflict records per the total rule,
  detection against a row-less session MINTS the anchor row (the same
  claiming-write mint) carrying the seed evidence and marker, and only then is
  the ledger replay answered (regression: a redelivery after the payment row was
  retention-pruned whose order now carries a second captured tender records the
  detection on a freshly minted anchor row before replaying the ledger answer; a
  clean post-prune redelivery replays writing nothing). A first post-upgrade
  redelivery of a fingerprint-less row takes the same detection path, not a
  blind replay: the fresh observation — validated and in hand — is judged, any
  conflict records per the total rule (a legacy multi-tender session whose
  sibling tenders today's code never saw is a REAL first detection), and
  `evidence_index` is seeded from that observation in the same batch either way;
  a clean observation seeds silently — the fingerprint and its committed
  summary, nothing else. From then on the row compares like any other — only
  unchanged legacy evidence replays silently, so the total post-terminal rule
  holds for existing production rows too.
- Retries stay owned by provider redelivery and the operator, as today. M4 adds
  no scheduler.
- Permanent failures: a provider's explicit refund rejection records the failed
  outcome as today; `partial_refund` and `capture_total_mismatch` park as
  owner-review alerts (no automatic retry can fix them).
- One failed item cannot block later work: bulk refund rows already record
  per-reference results; a refused row records its reason and the wave
  continues.

## Concurrency

### The reference row is one state machine

Every rule in this section — and every consumer of a `processed_payments` row
anywhere in this contract — derives from one declaration, so no consumer can
carry its own private reading of the row. A row holds four durable facts: its
RESOLUTION (open reservation → booked success or terminal failure —
`attendee_id` plus the terminal outcome data), its CLAIM (none, or one live
claim: owner scope `callback`/`attendee_set`, the claiming batch's written-at
time, and whether the claimed call carries a provider idempotency key), its
OWNER-REVIEW MARKER (none, or the conflict kind), and its COMMITTED EVIDENCE
(the fingerprint plus the coded canonical summary). All but the resolution live
as distinct fields of the ONE env-key-encrypted `failure_data` record described
above, and the row's LIVE WORK STATE — claim, staged refund, or owner-review
marker, else empty — is mirrored in the plaintext `protected_state` column,
written by the same statement that writes the record it mirrors, so a consumer
that cannot decrypt still routes on the real state machine. Six laws — PLAN.md's
data laws instantiated for this row — bind every consumer, current and future;
the rules in this section and the failure table are instances of them, and a new
consumer or state must say which law admits it:

1. **Total routing — readers and writers alike.** Every reader routes on the
   same precedence — a claim in the reader's OWN scope first, then the
   resolution, then open — and leaves untouched any state it does not own (a
   callback never consumes an `attendee_set` claim; an admin run never resumes a
   `callback` staged row). Every consumer routes on a DISCRIMINANT, never a
   proxy: a reader that can decrypt the record routes on the record's own
   discriminant, and the one reader that cannot — the prune's SQL — routes on
   the plaintext `protected_state` mirror above. Non-emptiness of the encrypted
   slot is NOT a state: committed evidence and terminal outcome data ride the
   same slot without protecting the row, so refund evidence alone never exempts
   a row from its normal retention (the prune design under Owner choices).
   Routing is total over WRITERS too: an operation that relocates or removes
   rows — the attendee merge's reference move, the attendee delete's cascade —
   is a consumer of every state on them, so its admission reads each affected
   row's record inside the same interactive transaction that would move or
   remove it and FAILS CLOSED against any live claim or staged marker, fresh or
   stale (the answer names the fix: finish or re-run the refund, then retry).
   The two writers differ on OWNER-REVIEW markers, by what each destroys: a
   MERGE relocates — the marker and terminal outcomes ride the moved row
   unchanged, and the per-attendee marker check then gates the merged person
   whole — while a DELETE destroys, and a park's marker guards a RETAINED BUYER
   (the quantity-0 placeholder or balance note whose contact details are the "we
   will contact you" promise), so the attendee delete also fails closed on a
   live owner-review marker: the owner resolves the review first (regressions: a
   delete against an attendee whose reference carries an owner-review marker is
   refused naming the review; a merge of the same attendee succeeds and gates
   the target whole). The write lock makes the check race-free — a claim lands
   before the admission and blocks it, or after the transaction commits and sees
   the moved world.
2. **Monotone evidence.** Committed evidence only grows: every advance stores
   the merge of committed and observed, never the raw observation (the merge is
   defined under Retry and replay). No consumer can ever read a summary that
   lost a leg or regressed a refund cumulative.
3. **Capability-derived claim release.** What releases a claim depends on the
   provider capability the claim recorded, never on a per-provider arm: a KEYED
   claim (Stripe/Square — deterministic idempotency key) releases on any
   recorded outcome, because a re-run lands on the same key; a KEYLESS claim
   (SumUp) releases only on a validated verdict or covering evidence — a sent
   call whose answer was lost keeps the claim standing in doubt (failure table,
   lost-answer row), and a crashed worker's claim resolves by the same
   staleness-plus-fresh-read rule either way. A future provider adapter declares
   the capability and inherits the discipline.
4. **Frozen facts.** Every fact a judgment consumes is signed, stored, or proven
   — never ambient. A stored reference carries every fact its future judgment
   needs — its provider identity above all (trusted facts; the legacy-references
   rule). A fact the reference lacks is either DISCOVERED from
   provider-validated evidence (the provider discovery: a read that finds and
   validates the payment is proof, recorded as the tag) or NOT EVALUABLE (a
   stored reference's expected currency, and with it every booking-tier
   expected-vs-observed kind) — stated, never borrowed from live settings.
   Ambient state — the currently selected provider, today's site currency — may
   order a search; it never decides a fact.
5. **States never straddle slices.** The PR that first WRITES a state ships
   every consumer that must recognize it — prune arms, routing, resume rules,
   the merge and delete admissions — in the same slice. PR A writes the first
   claims, so PR A ships the `protected_state` mirror with its prune gate and
   the merge/delete admissions; PR B's staged markers and owner-review markers
   land on a prune that already routes on the mirror.
6. **Total evidence.** Each provider declares ONE observation shape for money
   decisions — Square: the payment plus its order's captured-tender sweep;
   Stripe: the charge tier; SumUp: the transaction's documented amount plus its
   refund events, plus the checkout's vouched-children sweep where the row names
   its checkout — and every path that moves or reverses money (a callback
   remedy, an admin single or bulk refund, the refresh route's ledger
   completion) supplies the complete shape before acting. No path judges money
   on a narrower read than the declared observation; a path that cannot afford
   the reads does not move the money.

| Operation A                                 | Operation B                                       | Required result                                                                                | Protection                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback refund attempt                     | Redelivered callback refund attempt               | One payout                                                                                     | Reservation lock (`processed_payments`) — PR B extends it to the rejection arm, which today refunds before reserving — plus provider idempotency key (Stripe/Square), judge's fresh-read `fully_refunded`/`refund_pending` verdicts, SumUp provider-side second-refund rejection |
| Admin refund                                | Callback refund of the same charge                | One payout                                                                                     | Same as above — both paths front the same judge; Stripe/Square then land on the same idempotency key, and SumUp on the provider's own rejection of a second refund (its generic 409 state conflict, classified by the evidence re-read) plus the fresh amount read               |
| Two admin bulk waves touching one reference | —                                                 | One payout per reference                                                                       | The all-or-none claim (laws 1 and 3) serializes the waves; `refundState === "completed"` short-circuit, judge verdict, and idempotency key back it up                                                                                                                            |
| Refund run holding a live claim             | Attendee merge or delete of a claimed attendee    | Rows never move or vanish under live refund work; the merge/delete answers the settling reason | Law 1's writer admission: the merge/delete transaction reads every affected row's record and fails closed on any live claim or staged marker                                                                                                                                     |
| Judgment read                               | Provider state changes after read, before attempt | Provider-side rejection or idempotent landing; never a silent double payout                    | Provider guarantees (documented full-refund rejection) + next read converges                                                                                                                                                                                                     |

M4 adds no new tables and exactly TWO new columns, both on `processed_payments`
with one schema migration: `evidence_index`, the replay fingerprint above, and
`protected_state`, the plaintext live-work mirror law 1 requires for the one
consumer that cannot decrypt (empty on every row that exists today, so current
pruning behavior is unchanged until a claim, staged refund, or marker actually
lands). The durable refund serialization needs nothing further — the staged
refund-in-flight marker rides in `failure_data`, and the provider tag rides
inside the owner-key-encrypted reference value, not a third column. That slot is
ONE env-key-encrypted record with a distinct field per concern — the staged
claim, the owner-review marker kind, the committed observation summary, the
terminal outcome data — and every writer rewrites the whole record with the
other fields preserved, conditioned on the exact value it read (the same
compare-and-set shape as everything below), so a claim lands beside a terminal
record (an operator retrying a reference whose recorded refund failed) and a
detection lands while a claim is in flight, neither clobbering the other.
Throughout this contract, PLAN.md's atomicity law is the standing default: facts
that must agree — a marker and its mirror, a summary and its fingerprint, a
buyer record and its staged state, a retirement and its completion — change in
ONE statement, batch, or interactive transaction, and the only fences that exist
(the claim's staleness rule, the judged- fingerprint condition on money writes)
each span a gap atomicity cannot close: a provider call or a concurrent request
in the middle. Before ANY provider refund call, every entry point — the callback
arm, the admin single route, a bulk wave — claims the reference's
`processed_payments` row by compare-and-set: the staged field written where the
record it read carried NO live claim, with the batch's written-at time and the
claim's OWNER SCOPE — the callback rejection arm claims `callback` scope for its
own session; the admin single route and a bulk wave claim `attendee_set` scope
naming the claiming run's attendee — affected-rows deciding the winner. The
claim is per ATTENDEE REQUEST and all-or-none: a route refunding an attendee
claims the attendee's complete reference set in one interactive transaction —
every row claimed or the transaction rolls back whole — so two concurrent
requests can never split a merged attendee's references between them, each
winning some rows and moving only part of the money; admission (the subrequest
pre-flight) runs BEFORE the claim, since it is pure arithmetic with no writes,
so a refused request never leaves claims behind, and a request that dies after
claiming recovers via the stale rule. The run's ORDER is fixed and total:
admission, then the claim transaction over the stored reference set (known from
our rows alone — no provider call decides membership), then every provider read
— discovery and the order/checkout sweeps run UNDER the claim, so the identity
and evidence a run acts on cannot be re-resolved by a concurrent run mid-flight
— then the whole-set judgment, and only then any refund call; a park-shaped
verdict releases the claim with the recorded answer and zero refund calls. A
capture a sweep reveals beyond the stored references is DETECTION-ONLY: it has
no row, no route ever refunds it (multi-charge is owner review), and its
detection and marker land under the claim on rows the run holds — nothing a
sweep discovers is claimable or dispatchable by a concurrent run. The verdict a
run acts on is FENCED to the evidence it judged: the claim records the
fingerprint the judgment ran against, and both the provider call and the
finalize are conditioned — the same compare-and-set shape — on the row's
`evidence_index` still equal to it; a detection that lands mid-run (a concurrent
callback writing a sibling-capture marker beside the live claim) fails that
condition, and the run re-judges from the merged summary before any money moves,
parking or refusing per the fresh verdict (regression: a callback detection
landing between an admin run's judgment and its refund call forces the re-judge
— no refund is issued on the stale verdict). The lost-answer recovery read obeys
law 6 like every money-authorizing read: it re-fetches the provider's COMPLETE
declared observation — Square's payment plus order sweep, SumUp's transaction
plus checkout sweep where named — never the named payment alone, so a sibling
that became visible during the lost-answer window parks the completion instead
of letting the named cumulative answer `fully_refunded` (regression: a
lost-answer recovery whose re-read reveals a new captured sibling refuses the
ledger completion and records the detection). The loser answers "a refund for
this payment is already in progress" without touching the provider; a stale
claim (older than the edge request lifetime bound) is a crashed worker and may
be re-claimed — but only SCOPE-PRESERVING: a stale `callback` claim resumes on
the callback path per the staged lifecycle, while a stale `attendee_set` claim
is re-claimable only by an admin run that claims the attendee's complete current
reference set again, all-or-none, re-judging the whole set before any money
moves. A callback never consumes a claim it did not write: the staged-first
routing in the callback handler keys on `callback` scope alone, so a session
carrying a fresh or stale `attendee_set` claim replays its finalized answer and
runs replay detection without touching the claim or the provider — the callback
holds one session's context and can neither decrypt nor judge a merged
attendee's other references (payment references are owner-key-encrypted; a
webhook writes them, never reads them back), so letting it resume an
attendee-set claim would refund one reference outside the whole-set judgment the
claim exists to enforce (regression: an admin claim of a merged attendee's two
references dies before the provider call; a redelivered callback for one
reference replays the booked answer and moves no money; a later admin retry
re-claims the complete set and finishes the refund). Regression: two concurrent
single-attendee refunds of one merged attendee — one claims every reference and
refunds, the other claims nothing and answers in-progress. A legacy reference
with no `processed_payments` row does not escape the claim: the claiming write
MINTS the row — an INSERT-OR-IGNORE keyed by the reference's one-way index,
carrying the attendee id, the encrypted reference, and the claim in
`failure_data`; same table, no new columns, and the insert-or-ignore IS the
winner-decider for row-less references — so the previously open legacy
simultaneous window closes with the same one mechanism instead of waiting for
M7. The refresh route's marker writes mint the same anchor row for a legacy-only
attendee, so a detected `partial_refund` durably hides the Refund action there
too — the marker never depends on a row the reference happens to lack
(regression: a legacy-reference attendee whose refresh detects a partial refund
loses the Refund action, and two concurrent legacy SumUp refunds make exactly
one provider call). This claim is what makes the SumUp cells above real: with no
idempotency parameter, two truly simultaneous refund calls are serialized only
by the provider, and SumUp documents 409 as a state conflict, not a concurrency
guarantee — so the local claim is the serialization, for every provider one
mechanism (regression: two concurrent admin refunds of one SumUp reference make
exactly one provider call; the loser answers in-progress). The claim also binds
the operator writes that move rows between attendees (law 1's writer half):
today `applyAttendeeMerge` moves every source reference row and its ledger legs
unconditionally (`src/shared/merge/attendee-merge.ts` —
`UPDATE processed_payments SET attendee_id …`) and the attendee delete removes
the rows outright (`src/shared/db/attendees/delete.ts`), so either could
relocate or destroy a claimed row mid-refund — provider money moving while the
finalize's account is merged away or deleted, or a moved `refund_cash` leg
making a target's unrefunded charge read as returned. Per law 1 both admissions
read every affected reference row's record inside the same interactive
transaction that would move or remove it and fail closed on any live claim or
staged marker, fresh or stale, with the plain answer ("A refund is still
settling for this person. Finish or re-run it, then try again."); a stale
claim's cure is re-running the refund — the scope-preserving re-claim finishes
and releases it — never merging around it. The delete admission additionally
refuses on a live owner-review marker per law 1's writer rule — the marker
guards a retained buyer the owner promised to contact, so the review resolves
first — while a merge carries markers across, gating the target whole.
Regressions: a merge submitted while a bulk refund's claim is live on one source
reference moves nothing and answers the settling reason, and the refund's
finalize lands intact; an attendee delete against a staged callback row is
refused the same way; a merge after the claim releases succeeds and carries the
rows' markers and terminal outcomes unchanged. Release follows law 3: a keyed
claim releases with any recorded outcome, while a keyless claim whose call went
unanswered stays standing until evidence or staleness resolves it — so
stale-behind-the-fresh-read is the only door back into a keyless reference, sent
and crashed alike. The table's "one payout" answers rest on that claim for EVERY
reference — the row-less legacy case is minted by the claiming write above, so
no reference falls back to provider-side serialization: SumUp's cells hold on
the claim itself, with the provider's second-refund rejection and the fresh
pre-attempt evidence read as the backstop a stale-reclaim resume still gets;
Stripe/Square's hold on the idempotency key within its retention window and on
the fresh-read guard past it, whose stale-cumulative residual is the M7 boundary
named under Retry and replay.

## Owner choices

Genuine conflicts the system must not decide:

- **`multiple_charges`** (a second captured charge on one payment): the record
  (activity log) names the payment reference, every provider resource id, and
  the per-tender amounts; the alert is the existing best-effort ntfy ping, which
  by its privacy contract carries only an error code (`sendNtfyError(code)` — no
  ids, no amounts), so a conflict-specific code points the owner at the activity
  log rather than carrying the evidence itself. The record PRESENTS the observed
  tenders; it never prescribes a refund. By the binding evaluation order this
  kind fires only when the captured sum EQUALS the signed total (a larger sum
  wins `capture_total_mismatch`, a smaller one `partial_charge`), so the usual
  reading is a valid split payment where NO money is owed back — instructing the
  owner to "refund the extra charge" would return £50 of a correctly-paid £100
  booking and leave it underpaid while the ledger still says paid in full.
  Whether anything needs returning is the owner's judgment from the presented
  tenders, made in the provider dashboard (the in-app path cannot act on sibling
  charges it has no record slot for until M6). Several in-app doors are closed
  to keep that true. The proceed-and-alert finalize stores the owner-review
  conflict in the session row's `failure_data` slot (a discriminated
  owner-review kind beside the existing failure kinds — the row stays a booked
  success, `attendee_id` set), and every legacy money action on such a session
  fails closed until M6's per-charge reconciliation: the single and bulk admin
  refund actions check per ATTENDEE, before any provider call — if ANY of the
  attendee's references carries the marker the whole attendee is rejected up
  front, because `refundCandidateAtProvider` runs a merged attendee's references
  concurrently and a per-reference refusal would land only after a sibling
  reference's money had already moved, leaving `recordAttendeeRefund` skipped
  and the states inconsistent. The same attendee-whole rule governs FRESH
  verdicts, not just markers an earlier request recorded: the run reads and
  judges the COMPLETE reference set first — evidence reads only, no provider
  refunds — and only when every reference judges refundable does it issue any
  refund call; a park-shaped fresh verdict (`partial_refund`, `refund_pending`,
  an owner-review kind) on ANY reference refuses the whole attendee with zero
  refund calls (regression: a merged attendee with one clean reference and one
  part-refunded reference is refused whole — the clean sibling's money does not
  move); the refresh-payment route likewise refuses the `fully_refunded` →
  completed ledger write for a marked session — the named tender's dashboard
  refund does not mean the BOOKING's money came back, and
  `recordConfirmedRefund` would reverse the whole ledger order while a sibling
  tender stays captured — recording the observed provider fact in the activity
  log instead; and the Refund action is not RENDERED for a gated attendee
  (`canRefundAttendee` in `attendee-page-data.ts:74-80` and the bulk-action
  candidate set gain the same owner-review condition — the house rule that a
  link the target refuses must not be shown), the attendee page showing the
  owner-review indicator with the dashboard pointer in its place. Without these
  guards the admin route could refund the webhook-named tender while
  `recordAttendeeRefund` reverses the booking's FULL ledger amount — a £50
  provider payout the ledger books as a £100 return, with £50 still captured at
  Square. The guard reads in PR A's refund cutover and is written by PR B's
  callback finalize (vacuously true between them); and because the admin
  preflight and the refresh route judge the DECLARED Square observation (law 6 —
  the payment plus its order's captured-tender sweep), a multi-tender booking
  that predates the judge, or one booked clean before Square's tender list
  caught up with no redelivery since, is caught by the fresh sweep at the first
  attempt to move its money — marker or no marker (regression: an admin refund
  against a Square booking whose order carries a second captured tender, booked
  clean with no redelivery and no marker, is refused whole with zero refund
  calls and the detection recorded). M6's backfill remains for surfacing
  (aggregates, display), not for the money gate. The marker also outlives
  payment pruning: today's prune deletes ANY aged row with non-empty
  `failure_data` (`prune.ts:50-77`, retention configurable as low as days),
  which would silently drop the guard while the attendee and refundable
  reference live on (`getRefundPaymentReferences` falls back to the attendee's
  legacy `payment_id`, re-opening the dangerous refund). But non-empty
  `failure_data` cannot be the protection predicate either, in the other
  direction: committed evidence and terminal outcome data ride the same slot, so
  once every terminal write stores its summary, "non-empty means protected"
  would exempt every ordinary row from the configured retention forever —
  provider references and money evidence retained indefinitely with no live work
  on the row. Law 1's plaintext mirror is the answer for both directions: PR A
  adds the `protected_state` column (law 5: PR A writes the FIRST claims, and a
  claim landing on a row already older than the payment retention — an old
  booking or legacy anchor being refunded — would otherwise make that row
  deletable the moment the claim lands, letting a concurrent request mint a
  fresh row, claim it, and reach a second keyless provider call while the first
  still runs), every writer sets it in the same statement as the record it
  mirrors (claim/staged/marker, cleared again by the release that removes the
  state), and the prune's payment statement becomes: a row with an empty
  `protected_state` takes today's arms byte-identical — aged failure rows,
  reference-empty, attendee-gone, and refund-history prune exactly as they do
  now, whether or not the slot holds evidence — while a row with a live
  protected state prunes ONLY via the attendee-gone arm, living exactly as long
  as its attendee (a marked booked row whose attendee carries an earlier refund
  transfer survives pruning; a claim written onto a row older than the retention
  survives a concurrent prune run; an evidence-only booked row past the
  retention with refund history prunes exactly as today; a released claim's row
  resumes its normal schedule; a SumUp in-doubt claim's failed row survives
  retention while the claim stands). Regressions: an admin single refund against
  a proceed-and-alert multi-tender booking is refused with the owner-review
  reason and makes zero provider calls; a merged attendee holding one marked and
  one normal reference is rejected whole, before either reference's provider
  call; a refresh-payment run against a marked session whose named tender was
  dashboard-refunded records the observation and leaves the ledger untouched;
  the attendee page for a gated attendee renders the owner-review indicator and
  no Refund action. Automatic work is not stopped: the booking stands on the
  signed total. This is PLAN.md's approved M4 text applied ("one handler maps
  these outcomes onto today's behavior: detect, record, and alert … no automatic
  work is stopped or stranded before an owner can act") — failing the callback
  closed instead would 503 until provider redelivery exhausts, leaving taken
  money with no booking, no buyer answer, and no case tooling until M5, which is
  precisely the stranding the plan forbids. No money moves automatically either
  way; the tenders sit untouched for the owner. Decision 1 records the owner's
  explicit choice of this remedy.
- **`capture_total_mismatch`**: same detect-record-alert handling — the buyer
  over-paid, so their claim to the booking is valid and the surplus is named for
  the owner; the evidence names expected vs observed amounts. Resolution today
  is the provider dashboard plus existing admin tools; case pages arrive in M5.
- **`partial_refund` on the booking path**: PARKS, exactly as decision 5's park
  (buyer retained via placeholder or balance note, no ticket, no refund call,
  terminal outcome, alert). The provider retains LESS than the signed total, and
  an alert cannot choose among the intents that could explain it — a dashboard
  discount, a cancellation underway, a correction — so booking automatically
  would hide a real decision behind a guess; the operator's required choice
  decides. On the refund and refresh paths it stays detect-record-alert (the
  booking already exists there). Regression: a callback whose charge was
  externally part-refunded before delivery parks — no ticket, both amounts
  recorded.
- **A multi-charge observation that also fails validation** (decision 5): parks
  to owner review instead of any automatic refund — no booking, no provider
  calls, the record names the winning conflict kind and every charge, and the
  buyer sees the manual-check copy. Single-charge observations keep the
  automatic refund remedy unchanged.

No money-moving automation is added for any owner-review kind.

## Security and privacy

- No new routes or roles, and no new links. One existing action disappears where
  its handler now refuses: the Refund action is not rendered for an
  owner-review-gated attendee (the dead-link rule — the owner-review indicator
  shows in its place). The encrypted activity log carries conflict kinds,
  resource ids, and amounts; the ntfy alert carries the fixed error code only,
  per the commands table's alert boundary. Neither carries buyer PII or raw
  provider payloads (M3's fixed-refusal discipline is unchanged).
- The judge runs on evidence already fetched by the current path; the only new
  provider data crossing a boundary is Stripe's documented `amount_refunded` and
  refund `status` fields (decision 2) Square's documented tender `amount_money`
  and capture-status fields, and SumUp's documented transaction `amount` and
  `transaction_events[]` refund events — money figures and money states, none
  personal.
- The owner-key boundary on stored payment references is preserved: the
  env-key-encrypted `failure_data` record never holds a raw provider resource or
  parent id — the committed summary stores one-way leg codes and money numbers
  (Retry and replay), and the raw ids live only where they always have, in the
  owner-key-encrypted `payment_reference` and activity log. The plaintext
  `protected_state` mirror carries a state word alone — never an id, an amount,
  or a key.
- Untrusted inputs cannot reach the judge without passing M3's ownership
  boundary first. Forged SumUp callbacks with unknown, oversized, empty, or
  missing ids still cost zero provider calls; a forger replaying a REAL staged
  checkout id costs exactly one bounded read — that read IS the authenticity
  check, by M3's design — answered with the fixed refusal on any mismatch. The
  bound is per request — an amplification factor of at most one — with exactly
  one stated exception: the deliveries that genuinely process the session. Once
  a terminal record exists, every later replay of that checkout id, forged or
  not, costs the one authenticity read and nothing more — the reservation lock
  serializes the work and the terminal record plus acknowledgement end it. The
  honest bound BEFORE the terminal record differs in one case: while a refund
  answer stays provider-PENDING there is deliberately no terminal record (F3's
  core rule — pending is neither failed nor complete). Each redelivery in that
  window costs the authenticity read, then the staged AGE GATE decides — the
  same fresh/stale rule as the staged lifecycle, one mechanism: against a FRESH
  staged claim the delivery answers retryably with ZERO further provider calls
  (the original worker or the provider is still settling); only against a STALE
  claim does the resume re-do the evidence read and one refund re-attempt under
  the SAME stored idempotency key (one payout regardless). That window is real,
  provider-ended (it closes when the refund settles, typically one redelivery
  cycle), and its per-delivery cost is a fixed ceiling — stated and budgeted
  rather than claimed away; a forger replaying a real staged checkout id during
  it buys bounded idempotent work, never a second payout. Regressions (PR B): a
  replayed callback for a terminally processed session costs exactly one
  provider read and zero refund calls; a replay against a FRESH staged row makes
  zero provider calls beyond authenticity; a replay against a STALE staged row
  re-attempts under the same idempotency key and never moves a second payout.
  Bounding request volume itself is the platform's rate limiting, unchanged — M4
  adds no new unauthenticated read surface.

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
  provider's DECLARED money-decision observation (law 6 — for Square the payment
  plus its order's captured-tender sweep; the charge tier for Stripe; for SumUp
  the transaction read plus its checkout's child sweep where the row names its
  checkout), judged by `outcomeOf`: `fully_refunded` → completed as today —
  EXCEPT on a session carrying an extra-captured-money marker kind, or whose
  fresh sweep itself reveals a captured sibling, where the ledger write is
  refused and the observation recorded instead (the named tender's refund is not
  the booking's; see the `multiple_charges` owner choice; regression: a refresh
  whose named tender is fully refunded but whose order sweep shows a captured
  sibling refuses the completion write with the detection recorded, even when no
  marker existed before the run); `refund_pending` → stays unrefunded with the
  pending answer surfaced; `partial_refund` → a PERSISTED owner-review record
  (the marker with its kind), never a silent "none" or a bare activity entry:
  the marker durably hides the attendee's Refund action from that moment — a
  rendered action whose handler could only re-read the same partial state and
  refuse would be a dead link — while the refresh action itself remains
  available to observe later settlement (a marker whose kind is `partial_refund`
  does not refuse refresh completion writes). Every marker kind carries its
  RETIREMENT rule, and the write that satisfies it retires the marker and its
  `protected_state` mirror in the same batch: `partial_refund`'s condition — the
  provider retains less than the total — dissolves exactly when a later refresh
  judges the single-charge observation `fully_refunded` and posts the ledger
  completion, so that completion write also retires the marker and the row
  resumes its normal lifecycle (regression: a part-refunded reference whose
  dashboard refund later completes loses its owner-review indicator and its
  retention exemption in the same refresh that posts the completion). The
  extra-capture kinds (`multiple_charges`, `capture_total_mismatch`) have no
  in-app resolving write — their condition is money the app has no slot for — so
  they retire only through M6's reconciliation, stated.
- No alias, wrapper, or re-export bridges the old names.

`validatedPaymentSession` (M3 boundary), `refund-state.ts` (a record-derived
display fact, not a judge), and the ledger stay.

## Vertical PR slices

Two PRs, each standing alone, hardest invariant first (decision 4). PLAN.md's
400–700 src figure is the milestone target; the hard rule is delivery rule 3's
800 changed src lines PER PR. The review rounds added real closures
(owner-review carry-through, the ledger-swallow fix, the SumUp amount widening,
the terminal-replay sweep, the six-law state machine with provider discovery,
the admin-side tender sweep, and the merge/delete admissions), and decision 5
removed the multi-charge refund machinery a middle revision had grown. The
estimates are PR A ≈ 400–550 and PR B ≈ 250–350 — a 650–900 total that can run
past the milestone target's top while each PR stays well under its own cap; the
overage buys review-found correctness, not scope creep.

**PR A — "No refund attempt can exceed the captured money" (≈ 400–550 src)**

- Ports the pure closure: `outcomeOf`, conflict kinds, refund legs and
  arithmetic, `resolveRefund`, `kindObject`, the words subsets.
- Builds the per-provider refund-evidence adapters (Square: cumulative + PENDING
  answer, plus the widened order-tender pick — each tender's documented
  `amount_money` and capture state — so the admin and refresh evidence read
  judges the payment PLUS its order's captured-tender sweep per law 6, the same
  pick PR B's callback detection reuses; Stripe widened to the charge's
  documented `amount`, `currency`, AND `amount_refunded` — the full decision-2
  pick, because an admin or legacy Stripe reference carries no signed expected
  total, so without the first two the overlap guard has no captured-money
  denominator and no currency check (the evidence-tiers section states this; the
  slice must not narrow it) — plus refund `status`, mapped totally — `succeeded`
  → completed; `pending` and `requires_action` → `refund_pending` (in flight:
  re-attempts land on the same idempotency key, and the operator's answer names
  the status); `failed` and `canceled` → `failed_refund` (settled as
  not-happening; a fresh operator attempt is legitimate — noting, unchanged from
  today's use of the same deterministic key, that a re-attempt inside Stripe's
  ~24-hour idempotency window replays the original failed answer, and a
  genuinely new attempt exists once the window lapses; per-attempt identity is
  M7's `pending_refund_idempotency_key`); and a `null` status — a shape the
  production schema accepts (`StripeRefundSchema`, `schemas.ts:64-72`) — is no
  verdict at all, so it takes the failure table's lost-answer arm: the one
  bounded evidence re-read decides, nothing is recorded from the null itself —
  instead of today's collapse of everything non-succeeded to failure; SumUp
  widened to the documented `amount` plus `transaction_events[]`, and — where
  the row names its checkout — the checkout's vouched-children sweep per law 6,
  reusing the children pick the callback path already validates) and fronts
  `tryRefund`, `refundReferenceAtProvider`, and the admin refresh-payment
  route's provider poll with the judge.
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
- Resolves each reference's provider per law 4: `refundCandidateAtProvider`
  dispatches per REFERENCE — the stored provider tag when the row carries one,
  else the discovery the trusted-facts rule defines (the evidence read runs
  against each credentialed provider, ordered by the deployed existing-payments
  resolution first; exactly one validating read is the proof, recorded as the
  row's tag by the terminal write; no validating provider ⇒ the honest
  unresolved failure, no refund dispatched anywhere). The provider tag rides
  inside the owner-key-encrypted reference value (no new column), new callback
  writes tag at write time, and an admin-minted anchor row is tagged by the
  terminal write that records a provider-validated outcome.
- Adds the `protected_state` mirror and its prune gate (the Owner-choices
  analysis; laws 1 and 5): every writer of a claim, staged refund, or marker
  sets the plaintext column in the same statement, releases clear it, and the
  payment prune keeps today's arms byte-identical for rows whose mirror is empty
  — evidence and terminal outcome data never exempt a row from its retention —
  while a row with a live protected state prunes only through the attendee-gone
  arm.
- Guards the row-moving writers (laws 1 and 5, shipped with the first claims):
  the attendee merge and attendee delete admissions read every affected
  reference row's `failure_data` inside their own interactive transaction and
  fail closed on any live claim or staged marker with the settling answer, fresh
  or stale.
- Completes: F3 (classification half). Regression tests: the pinned arithmetic
  rows; a Square PENDING answer followed by a redelivery produces exactly one
  provider refund (the re-attempt reuses the same idempotency key and lands on
  the same refund — asserted by key equality, one payout); pending + completed
  exceeding captured is refused; completed counts immediately while cumulative
  lags; two concurrent SumUp refund attempts make exactly ONE provider call —
  the loser of the all-or-none CAS claim answers in-progress without touching
  the provider (the claim transaction ships in THIS slice, before any provider
  call on every refund route, per the concurrency section); a lost-answer SumUp
  refund leaves its claim standing — an immediate second run answers the
  settling copy with zero provider calls, a stale claim re-claims behind the
  fresh evidence read, and a covering read resolves it with no call (law 3); a
  claim written onto a row older than the payment retention survives a
  concurrent prune run, while an evidence-only booked row past the retention
  with refund history prunes exactly as today (the `protected_state` gate ships
  in this slice, law 5); a merged attendee carrying references from two
  providers judges and refunds each at its own provider — an untagged pre-switch
  reference discovered by the validated read and tagged on its terminal write —
  while a tagged reference whose provider has no stored credentials fails its
  row naming that provider with zero provider calls, and an untagged reference
  no credentialed provider validates fails unresolved, dispatching no refund
  (law 4); a legacy reference captured under a previous site currency refunds
  cleanly after the currency switch — its judgment never reads
  `settings.currency` (law 4); an admin refund against a Square booking whose
  order carries a second captured tender — no marker, no redelivery — is refused
  whole with zero refund calls (law 6); a merge submitted while a refund claim
  is live on a source reference moves nothing and answers the settling reason,
  an attendee delete against a staged row is refused the same way, and a merge
  after release carries markers and terminal outcomes unchanged (law 1); a
  Stripe refund answering a `null` status records nothing until the bounded
  evidence re-read answers; a SumUp transaction whose successful refund events
  sum above zero and below `amount` reads as `partial_refund`, never
  `fully_refunded` — an empty or absent event list stays `ready`, and events
  summing to `amount` read `fully_refunded` even while top-level status still
  says `SUCCESSFUL` (the sandbox-observed shape); a Stripe refund answering
  `pending` writes no completion, reports the pending answer (not failure), and
  a re-run lands on the same idempotency key; a refund whose transport answer is
  lost but which committed at the provider records completion after the
  reconcile read — one payout; a partially-refunded reference on the
  refresh-payment route records owner review instead of silently reading as
  unrefunded.
- Budgets: on the normal arms, 2 provider calls per admin Stripe reference and
  per checkout-less legacy SumUp reference (1 evidence read — its result IS the
  judgment input, never a separate call — plus at most 1 refund call) and 3 per
  Square or checkout-linked SumUp reference (the declared observation is two
  reads — the payment then its order's tender sweep, or the transaction then its
  checkout's child sweep, per law 6 — plus the refund call); when a sent
  refund's answer is lost, the recovery re-read is the COMPLETE declared
  observation again (law 6 — it authorizes a completion write), so the
  lost-answer arm adds 1 read for Stripe and checkout-less SumUp and 2 for
  Square and checkout-linked SumUp, and a multi-child SumUp observation adds one
  transaction read per additional SUCCESSFUL child wherever it is judged.
  Discovery adds reads only for an UNTAGGED reference whose earlier candidate
  fails to validate: worst case one evidence read per credentialed provider (at
  most three exist), the validating read doubling as the judgment input. Per
  outcome: refusal and `fully_refunded` cost the evidence reads alone (1; 2 for
  Square and checkout-linked SumUp; 0 when our own records already refuse); a
  normal attempt adds the refund call. A callback refund costs its refund call
  plus evidence: 0 extra reads for a Square rejection carrying valid money (the
  carried payment evidence judges; one whose money fields were the malformed
  part buys the one re-read, like the other arms), 1 read on the Stripe and
  SumUp rejection arms (the payment-intent / transaction read each buys). Today
  the same reference costs 1–2 (the refund, plus the fallback read on failure),
  so M4 moves the read up front, the lost-answer arm spends its extra read
  exactly where today's blind fallback also spent one, and Square's second
  normal-arm read buys the sibling-capture check no path makes today. The admin
  bulk cap is `BULK_REFUND_LIMIT` (5) **attendees**, and one attendee can carry
  several references (deposit plus balance; merges): R total references cost 2R
  (Stripe; checkout-less SumUp) to 3R (Square; checkout-linked SumUp) provider
  calls on the normal arms, plus 1 per reference whose sent refund's answer is
  lost (the reconciling re-read above) and the discovery reads of any untagged
  reference, typically R ≤ 10 for a full batch. Because the worst case must fit
  Bunny's 50-subrequest allowance even if every answer is lost, PR A adds a
  batch pre-flight: before ANY provider call, the run counts its
  still-unrefunded references, and a batch whose recovery worst case cannot fit
  the request's REMAINING subrequest budget is refused whole — zero provider
  calls, every row failed with the plain reason "This run has too many payments
  to refund at once. Refund fewer attendees at a time." The admission counts
  provider calls at each adapter's PHYSICAL fetch worst case, not its logical
  call count: Stripe's transport makes up to three fetches per logical call
  (`STRIPE_MAX_NETWORK_RETRIES = 2` in `stripe/request.ts`, each attempt counted
  by the guard via `countExternalSubrequest`), so a Stripe batch's three logical
  calls per tagged reference admit as 9R; the Square and SumUp adapters make
  exactly one fetch per call today, so their factor is 1 (a tagged Square or
  checkout-linked SumUp reference admits as 5 — two evidence reads, the refund,
  and the two-read lost-answer recovery; a checkout-less SumUp as 3; a
  multi-child SumUp checkout adds one read per additional SUCCESSFUL child) —
  each factor read from the adapter's own retry constant, so a future retry
  change moves the admission with it. An untagged reference admits with its
  discovery worst case on top: one evidence read per credentialed provider, each
  priced at that provider's own factor. The admission compares that physical
  provider worst case plus the batch's own database calls at the client's retry
  worst case — every post-provider write costed at the bounded maximum of four
  attempts (`TRANSIENT_ERROR_BACKOFF_MS` in `db/client.ts` allows three retries,
  and the round-trip guard counts each attempt separately), so a `SQLITE_BUSY`
  streak after money has moved cannot push the request over the limit — plus a
  failure reserve PROPORTIONAL to R, not a constant: the worst case is every
  admitted reference failing, and each failed reference spends its own error
  fan-out (`logError`'s ntfy and Sentry subrequests plus the per-row activity
  record, database writes at the retry multiplier), on top of one batch-level
  error report — R × the per-failure fan-out cost plus the batch constant, every
  term still static at admission — against the allowance MINUS the subrequests
  the request has already spent before the pre-flight (the db client's call
  counter is the source — the route's auth and attendee loads are not free). A
  batch can no longer abort mid-flight with some refunds committed and
  unrecorded; every term is known at pre-flight time, so the refusal is exact,
  not a guess. Regression: an oversized batch makes zero provider calls and
  fails every row with that reason. The same admission fronts EVERY route that
  attempts provider refunds in one request — not just the bulk route: the
  single-attendee refund (`POST /admin/attendees/:attendeeId/refund` calls
  `refundCandidateAtProvider` directly, `attendee-refunds.ts:120-140`, bypassing
  the bulk batch) runs the identical pre-flight over the one attendee's
  reference count, because a merged attendee can carry many references — six
  Stripe references admit as 54 physical fetches on the lost-answer path, over
  the allowance on their own. Its refusal is the single-attendee shape of the
  same plain reason ("This attendee has too many payments to refund in one go.
  Refund them from the provider dashboard.") — refused whole before any provider
  call, never a partial pass through the references (regression: a merged
  attendee whose reference count cannot fit the remaining budget gets that error
  and zero provider calls). The paged engine that processes arbitrarily large
  batches is still F53 / M7 — this slice only refuses what one request cannot
  safely hold. Database calls: one NEW cost beside today's — the all-or-none
  claim transaction per refund run (claim before any provider call, minting
  anchor rows for row-less legacy references; finalize/release after), counted
  in the admission's own arithmetic; everything else unchanged.
- Standalone value: the live system stops repeat and over-refunds on the admin
  and attempt side. The callback rejection arm keeps today's behavior until PR B
  cuts it over with its reservation — PR A claims nothing about that arm.

**PR B — "One judge for callback money, and alerts for what it finds" (≈ 250–350
src)**

- Builds the callback-side observation (expected facts from the signed proof,
  charges from the session evidence per provider) and replaces
  `classifySession`'s verdicts with the judge's outcomes mapped by the
  exhaustive remedy `Record`; deletes `SessionClass` and the inline arithmetic.
- Cuts the callback rejection arm (`refundRejectedCharge`) over to the judge,
  behind the same reservation the booking path holds. Today the arm runs before
  `processPaymentSession` ever reaches `reserveSession` (`webhooks.ts:423-435`),
  so two concurrent deliveries of one rejected session are serialized by nothing
  — with no SumUp idempotency key, both can issue the refund. PR B widens
  `SessionRejection` to carry the session identity the webhook already resolved,
  and the rejection arm claims the `processed_payments` reservation under that
  SAME session id the valid booking path reserves — one key, so a redelivery
  whose provider read has since become valid collides with the rejection's
  terminal record and replays the stored rejected answer instead of booking a
  charge that was already refunded. The reservation is claimed BEFORE any
  provider call; the terminal rejected outcome is written once the refund
  settles; a concurrent duplicate answers the in-flight retry (503) or the
  stored terminal answer — never a second payout. This is what makes the
  security section's amplification exception and the concurrency table's first
  row true for rejections, not just bookings. The rejection handed to
  `refundRejectedCharge` keeps the observation's charge facts (per its tier): a
  Square rejection whose observation carries valid captured money is judged with
  zero extra reads; a refundable Square rejection whose money fields were the
  malformed part (a `COMPLETED` payment missing `amountMoney` or its currency)
  buys the same one payment re-read the other arms buy, and if the re-read still
  lacks the documented fields the refusal stays retryable with NO refund call —
  an unreadable amount is never invented, not even to return it. Stripe's
  session tier and SumUp's checkout tier carry no refund facts, so those arms
  each buy one read before the refund call (payment-intent for Stripe,
  transaction for SumUp) — one added provider call on those rare arms; the
  trusted booking path stays zero-read. Regressions: two concurrent deliveries
  of one rejected SumUp session make at most one provider refund call; a
  delivery after the terminal write makes zero; a rejected-then-valid redelivery
  lands on the rejection's reservation and books nothing; a Square rejection
  with unreadable money makes zero refund calls and stays retryable after the
  re-read.
- Wires the callback outcomes through the shared owner-review recorder landed in
  PR A (the activity-log write joins the processing transaction) and adds the
  callback-side Square multiple-tender detection using the widened order-tender
  pick PR A built (law 6): a tender counts as captured money only when its
  status says so (authorized/voided/failed tenders are named in evidence, never
  counted; money with an unreadable status refuses at the read boundary as a
  malformed read) — all from the order read the path already makes, no extra
  provider calls.
- Carries owner review through downstream booking failures (no automatic refund
  on a conflicted payment; terminal owner-review outcome; the new buyer copy
  above), and implements the staged placeholder lifecycle the failure table
  requires: the rejection arm claims the reservation, then ONE batch inserts the
  buyer record — new booking: the quantity-0 placeholder; balance: a binding to
  the existing attendee whose balance was being paid, never a placeholder — and
  writes its id plus the staged refund-in-flight marker, the batch's written-at
  time, and the session's payment reference onto the reservation row BEFORE the
  provider call, on every persist-then-refund path (`refundRejectedCharge` and
  `storeRefundedBooking`'s stored-refused failures alike). That gives the
  persist its replay identity: a redelivery against a FRESH staged row answers
  retryably — the original worker may still be in flight, and SumUp has no
  idempotency key to dedupe a race — while a STALE row resumes the refund;
  `blank_reference` stays retryable outside this lifecycle entirely (no resource
  to refund, never a stored rejection). The staged state is routed before the
  finalized-success branch — keyed on `callback` scope, so an admin
  `attendee_set` claim never routes here (per Concurrency) — and the terminal
  batch lands the outcome, fingerprint, and — on `posted: false` — the
  unposted-money fact in `failure_data`, atomic with the finalize, with the
  activity-log entry and attendee note layered on top as best-effort surfacing;
  durable automated re-posting is M7's. Regression tests: the
  sold-out-with-two-tenders case makes zero refund calls; a worker death between
  the staged batch and the provider call resumes at the refund step on
  redelivery with exactly one placeholder; a duplicate delivery racing a live
  staged worker makes zero provider calls; a balance-session rejection posts
  against the existing attendee and inserts no placeholder; a failed placeholder
  ledger write books exactly one placeholder across redeliveries, names the
  money durably in the terminal row, and leaves the miss visible in the activity
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
  re-books or refunds, and an identical redelivery writes nothing more (the
  `evidence_index` fingerprint comparison, exercised by redelivering after a
  lost acknowledgement), while a THIRD tender arriving after the two-tender
  record changes the fingerprint and records again; a lagging one-tender
  redelivery bearing newer refund progress on a two-tender record advances a
  merged summary still naming both tenders, and the caught-up two-tender
  redelivery after it replays silently (law 2); a second capture arriving after
  a terminal failure is detected the same way (the failure row now carries the
  fingerprint and reference); a delayed callback for an externally
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
  before any later read — the next read converges, and law 3 keeps every re-run
  out of that window: the keyless claim stays standing until evidence or
  staleness resolves it; our own refund calls are full-amount only.

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
   copy for the buyer. Single-charge observations — structurally all of Stripe,
   and virtually all of Square and SumUp — keep today's automatic refund remedy
   unchanged. Reason: per-charge refund evidence, ledger legs, and retry state
   are M7's durable engine; inside one M4 callback they would mean invented
   facts (an unread tender's refund state), an unbounded provider fan-out
   against the edge subrequest budget, and a ledger shape with no slot for a
   partly-returned batch.
