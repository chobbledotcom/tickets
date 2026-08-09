# M4: one diagnosis for settled money — behavior contract

## Status

Draft for human review. No implementation has started. This contract follows
PR_WORKFLOW.md: it must be explicitly approved before tests or code are written.
Milestone source: PLAN.md M4 (lines 190–211), fault rows F3 and F51, and the
binding decided behaviors on refunds and multiple captures.

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
single and bulk refund routes through `refundReferenceAtProvider`).

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

| Area                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                          | Consequence                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback judge                 | `classifySession` returns `trusted`/`mismatch`/`ignore` from price-proof, currency, and amount equality (`src/features/api/payment-processing/classify.ts:97-113`); no free-checkout predicate exists — a paid charge against a signed total of 0 falls out of amount inequality                                                                                                                                  | This verdict logic is the displaced callback classifier; `outcomeOf` replaces it and names `paid_without_charge` explicitly                                                                       |
| Boundary constructor           | `validatedPaymentSession` rejects unvouched money as `malformed_charge` with `refundable`, and a paid session without a resource id as `blank_reference` (`src/shared/payment/validated-session.ts:17-113`)                                                                                                                                                                                                       | Stays. It is M3's observation boundary, not a settled-money judge; its rejections feed the same refund path the judge uses                                                                        |
| Mismatch refunds               | `refuseMismatch` (balance path) and `chargeMismatchSpec` (booking path) refund on verdict `mismatch` (`src/features/api/payment-processing/refunds.ts:239-250,308-312`; consumed at `index.ts:238-250`)                                                                                                                                                                                                           | These actions stay; their trigger becomes a judge outcome instead of the inline verdict                                                                                                           |
| Refund re-attempt surface (F3) | On `refunded === false` the reservation is released so the next redelivery re-attempts the refund; the comment asserts this "CANNOT double-pay" on the strength of provider-side rejection (`src/features/api/payment-processing/index.ts:350-366`)                                                                                                                                                               | True for Stripe/Square only because of idempotency keys; unguarded for SumUp. The judge fronts every attempt with the overlap refusal                                                             |
| Refund state today             | `RefundState` is `none \| completed \| unknown` — no pending state exists on the live path (`src/shared/payment/refund-state.ts:10-23`); derived from `processed_payments.provider_refunded_at` (`src/shared/db/payment-references.ts:130-161`)                                                                                                                                                                   | A pending provider refund reads as `none` everywhere today; nothing compares refunded-so-far against captured money                                                                               |
| Single-charge refund judge     | `tryRefund`: blank-id guard, attempt, then `isPaymentRefunded` fallback treating already-refunded as success (`src/features/api/payment-processing/refunds.ts:120-160`)                                                                                                                                                                                                                                           | The ordering is ad-hoc judgment; it becomes: observe → `outcomeOf`/`resolveRefund` → act                                                                                                          |
| Bulk refund judge              | `refundReferenceAtProvider`: `completed` short-circuit, attempt, `isPaymentRefunded` fallback (`src/features/admin/refunds/provider.ts:40-68`); waves of 5, wave count unbounded (`:167-211`), caller caps batch at `BULK_REFUND_LIMIT` (`src/features/admin/attendee-refunds.ts:303`)                                                                                                                            | Same cutover as `tryRefund`. The unbounded wave shape itself is M7 (F53), not M4                                                                                                                  |
| Idempotency                    | Deterministic `refundIdempotencyKey` used by Stripe (`src/shared/stripe.ts:109`) and Square (`src/shared/square.ts:688`); SumUp passes none (`src/shared/sumup.ts:222-229`), and the SumUp refund API supports none                                                                                                                                                                                               | SumUp replay defence must come from the judge plus full-refund semantics; the contract records this as a per-provider fact                                                                        |
| Square refund facts            | `retrievePayment` already selects `refundedMoney` — a genuine provider cumulative (`src/shared/square.ts` retrievePayment; `square-provider.ts:44-53` uses `refunded >= charged`); `refundPayment` returns false for PENDING (`CONFIRMED_REFUND_STATUSES = ["COMPLETED"]`, `square.ts:587`) and throws on wrong `payment_id` or partial amounts (`:712,721-728`)                                                  | Square legs get a real `confirmedRefunded`. A PENDING answer is a real in-flight refund the current code treats as failure — the F3 trigger                                                       |
| Stripe refund facts            | Current schema picks only `latest_charge.refunded` (boolean) (`src/shared/stripe/schemas.ts:43,51`); the locked Stripe types document `amount_refunded` on the charge                                                                                                                                                                                                                                             | Widening the pick to `amount_refunded` gives Stripe a documented cumulative. Owner question 2                                                                                                     |
| SumUp refund facts             | `isPaymentRefunded` is `getTransactionStatus === "REFUNDED"` (`src/shared/sumup-provider.ts:103-107`) — full-refund only, no partial, no pending                                                                                                                                                                                                                                                                  | SumUp legs derive `confirmedRefunded` as all-or-nothing from status; pending is unobservable                                                                                                      |
| Multiple captures              | Square: `paymentReference = paidPaymentId ?? order.tenders?.[0]?.paymentId ?? ""` silently takes the first tender (`src/shared/square-provider.ts:124-125`); nothing counts captures per order. SumUp: `paidChildVerdict` already rejects extra children as `unrecorded_child` (`src/shared/sumup-observation.ts:143-151`). Stripe: a session names one `payment_intent`; no list read exists on the current path | Square `tenders[]` is present evidence: two paid tenders become a detectable `multiple_charges` conflict. Stripe multiple-capture detection has no current-path evidence and is out of scope (M6) |
| Wrong parent                   | Square throws on `payment.orderId !== order.id` (`square-provider.ts:145-153`) and on refund `payment_id` mismatch (`square.ts:712`); SumUp reference/id/merchant checks are classifier verdicts (`sumup-observation.ts:208-239`); Stripe has none                                                                                                                                                                | Existing checks keep their behavior but report through the one conflict vocabulary; no new Stripe check is invented                                                                               |
| Error and alert classes        | `logError` fans out to ntfy (`src/shared/logger.ts:335`); the mismatch pager is `WEBHOOK_PRICE_SIGNATURE` (`refunds.ts:244,275`); the "money moved but records did not" incident class is `reportRefundNotRecorded` (`src/shared/invariant-errors.ts:37-39`)                                                                                                                                                      | Owner-review conflicts alert through these existing classes; no new alert channel                                                                                                                 |
| Money of record                | Ledger `transfers` (capture via `checkout-complete.ts:42-56`; refunds via `refund-ledger.ts:197,228,305`); `processed_payments.provider_refunded_at` marks completed provider refunds (`payment-references.ts:260-273`)                                                                                                                                                                                           | These are the durable "our completed records" input to the judge. M4 writes no new tables                                                                                                         |
| Dormant aggregate schema       | `payment_charges` already declares `captured_amount`, `refunded_amount`, `refund_state`, `pending_refund_id`, `pending_refund_idempotency_key` — schema-only, no readers or writers (`src/shared/db/migrations/schema/payments/charges.ts:29-53`)                                                                                                                                                                 | Stays dormant. M4 must not write it (delivery rule 1; M6/M7 activate it)                                                                                                                          |

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
| `conflict.ts` (15-kind `PaymentConflict` variant + `IS_THE_READING_ITSELF`)        | 55    | Port. Reconcile `invalid_provider_data`'s reason type against main's `ProviderInvalidReason` (plain union, includes `unrecorded_child`; branch has `mismatched_parent`)                                                                                    |
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
  `latest_charge.amount_refunded` (after the schema widening, question 2); SumUp
  all-or-nothing from transaction status `REFUNDED`.
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

| Conflict kind                                                                 | Meaning                                                                                                                                                                           | Remedy in M4                                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `currency_mismatch`                                                           | Any observed currency differs from the expected currency                                                                                                                          | Refuse-and-record: today's mismatch refund path                                                                             |
| `provider_total_mismatch`                                                     | Provider session total ≠ signed expected total                                                                                                                                    | Refuse-and-record: mismatch refund path                                                                                     |
| `partial_charge`                                                              | Captured sum < expected                                                                                                                                                           | Refuse-and-record: mismatch refund path                                                                                     |
| `capture_total_mismatch`                                                      | Captured sum ≠ expected (over-capture)                                                                                                                                            | Owner review: detect, record, alert                                                                                         |
| `paid_without_charge`                                                         | Money on a free checkout: expected total is 0 and a charge is present                                                                                                             | Refuse-and-record: mismatch refund path (the charge has a resource to refund)                                               |
| `resource_mismatch`                                                           | Charge/refund parent or provider disagrees with its session/charge                                                                                                                | Refuse-and-record: refuse retryably (callback) / refuse attempt (refund path); keeps Square's current throw-behavior, named |
| `duplicate_charge`                                                            | Two charge legs share one resource id                                                                                                                                             | Refuse-and-record                                                                                                           |
| `duplicate_refund`                                                            | Two refund resources share one id                                                                                                                                                 | Refuse-and-record (refund path refuses the attempt)                                                                         |
| `multiple_charges`                                                            | More than one captured charge on one payment (Square: >1 paid tender)                                                                                                             | Owner review: detect, record, alert; automatic work proceeds on the signed total as today                                   |
| `refund_exceeds_capture`                                                      | Returned + returning money would exceed captured (`Math.max(providerCumulative, ourCompleted) + pending > captured`, or any single refund > captured, or refund currency differs) | Refuse-and-record: the refund attempt is refused                                                                            |
| `multiple_pending_refunds`                                                    | More than one refund in flight                                                                                                                                                    | Refuse-and-record: the refund attempt is refused                                                                            |
| `failed_refund`                                                               | Provider answered a refund attempt with failure                                                                                                                                   | Refuse-and-record: today's failed-refund handling (release/retry or recorded failure)                                       |
| `partial_refund`                                                              | Cumulative shows part of the money returned                                                                                                                                       | Owner review: detect, record, alert (no current-path action can safely finish it; the balance-refund engine is M7)          |
| The branch's two read-level kinds (`invalid_provider_data`,                   |                                                                                                                                                                                   |                                                                                                                             |
| `missing_resource`) are NOT ported in M4: no `outcomeOf` path emits them, and |                                                                                                                                                                                   |                                                                                                                             |
| read failures remain M3's `ProviderRead` boundary outcomes. Porting them now  |                                                                                                                                                                                   |                                                                                                                             |
| would land unreachable union arms (dead code). They arrive with M5's          |                                                                                                                                                                                   |                                                                                                                             |
| `resolve.ts`, which is what emits them.                                       |                                                                                                                                                                                   |                                                                                                                             |

A paid session with no charge reference never reaches the judge either: the
retained `validatedPaymentSession` boundary already rejects it as
`blank_reference` (retryable, unrefundable by construction — there is no
resource to refund). `paid_without_charge` is reserved for the refundable
free-checkout case.

`fully_refunded` means the attempt-side answer is "already done, count it as
success" — exactly `tryRefund`'s current fallback, now a named verdict.
`refund_pending` refuses a new attempt without treating the charge as refunded.

### Evidence tiers — no invented facts

The judge's refund gate uses the richest evidence the provider exposes for that
reference, and never more:

- **Square** (session and legacy references alike): `retrievePayment` states
  captured `amountMoney` and cumulative `refundedMoney` — the full arithmetic
  applies.
- **Stripe**: the widened `amount_refunded` pick (question 2) gives the
  cumulative; the charge amount is documented on the same object — the full
  arithmetic applies.
- **SumUp** (including every legacy reference): the transaction read states only
  a status. The judge's verdict degenerates honestly to the tri-state the
  evidence supports: `REFUNDED` → `fully_refunded`; otherwise the attempt
  proceeds and SumUp's full-refund-only semantics carry the overlap safety (a
  second refund of a refunded transaction is provider-refused). No captured
  amount is invented, and no previously supported refund — legacy references
  included — stops working.

Legacy admin references (`legacyReference`, no session id) are judged the same
way: by whatever their provider's read genuinely answers for the stored payment
reference.

## Commands and events

| Starting state                                                         | Command or event                                         | Required result                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid session observed, judge says `ready`                              | Callback/redirect processing                             | Booking proceeds exactly as today (trusted path)                                                                                                                                                                                                                                                                                                                 |
| Paid session observed, refuse-and-record conflict                      | Callback/redirect processing                             | Today's mismatch/rejection refund path runs; outcome recorded with the existing `REFUND_REASONS` vocabulary; buyer answer unchanged                                                                                                                                                                                                                              |
| Paid session observed, owner-review conflict                           | Callback/redirect processing                             | Booking proceeds on the signed total as today; one alert through existing error classes with the conflict kind and resource ids; no payload echo                                                                                                                                                                                                                 |
| Charge with no completed/pending refund facts, judge says attempt fits | Refund attempt (`tryRefund` / admin single / admin bulk) | Provider refund attempted with the provider's idempotency key (Stripe/Square); success records completion as today                                                                                                                                                                                                                                               |
| Charge where returned + returning ≥ captured                           | Refund attempt                                           | Attempt refused before any provider call; recorded/answered through the caller's existing failure shape (callback: retryable; admin: failed row with reason)                                                                                                                                                                                                     |
| Charge already fully refunded (provider cumulative or our records)     | Refund attempt                                           | `fully_refunded`: success without a provider refund call, as `tryRefund`'s fallback does today                                                                                                                                                                                                                                                                   |
| Provider answers PENDING to a refund attempt (Square)                  | Refund attempt                                           | No completion write, exactly as today. Within the request that observed it, the judge answers `refund_pending` and no further attempt starts. A later redelivery has no durable pending record (that is M7's `pending_refund_id`); its re-attempt reuses the same deterministic idempotency key, so it lands on the SAME provider refund — one payout, never two |
| Free checkout (expected 0), provider shows money                       | Callback processing                                      | `paid_without_charge` → refuse-and-record refund path                                                                                                                                                                                                                                                                                                            |

Every command keeps one authoritative implementation; the judge is consulted,
never duplicated.

## Failure table

| Work completed                 | Failure                                   | Required result                                                                                                                                                                                                                                                                                                                                                                         | Retry owner                                                                |
| ------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Nothing                        | Provider read unavailable before judgment | No verdict; caller's existing unavailable handling (callback 503 retryable; admin row fails with reason)                                                                                                                                                                                                                                                                                | Provider redelivery / operator                                             |
| Judge refused refund           | — (refusal is the outcome)                | No provider call, no local mutation beyond the recorded answer                                                                                                                                                                                                                                                                                                                          | Provider redelivery / operator re-runs later; cumulative catch-up unblocks |
| Provider refund succeeded      | Local completion write fails              | Same as today: next attempt's fresh read sees the provider cumulative (Square/Stripe) or REFUNDED status (SumUp) → `fully_refunded`, success without a second payout                                                                                                                                                                                                                    | Next redelivery / operator                                                 |
| Provider refund PENDING        | Request ends                              | No completion write; Stripe/Square replay lands on the same idempotency key; SumUp: a full refund of an already-refunded transaction is provider-refused and the fresh status read answers `fully_refunded`                                                                                                                                                                             | Provider redelivery                                                        |
| Owner-review conflict detected | Alert delivery fails                      | The durable record survives: the conflict is written to the activity log in the same transaction as the processing outcome, so it is admin-visible regardless of alert delivery. The ntfy/log alert itself is best-effort, stated as such — terminal replays do not re-observe, so a lost alert is not retried on this path. Retryable owner alerting is M5's unsent-revision machinery | Operator (activity log today; M5 cases)                                    |

## Retry and replay

- Stable identity: the provider payment reference (unchanged), plus the
  deterministic `refundIdempotencyKey(provider, reference)` for Stripe and
  Square provider calls. SumUp has no provider idempotency parameter — its
  replay safety is: full-refund-only semantics, the provider's own rejection of
  a second refund, and the judge's `fully_refunded` short-circuit from a fresh
  status read.
- Exact replay of a callback returns the same terminal outcome (existing
  `processed_payments` replay), and a replay that reaches the refund path gets
  the judge's verdict from fresh evidence — an already-completed refund answers
  success, never a second payout.
- Retries stay owned by provider redelivery and the operator, as today. M4 adds
  no scheduler.
- Permanent failures: a provider's explicit refund rejection records the failed
  outcome as today; `partial_refund` and `capture_total_mismatch` park as
  owner-review alerts (no automatic retry can fix them).
- One failed item cannot block later work: bulk refund rows already record
  per-reference results; a refused row records its reason and the wave
  continues.

## Concurrency

| Operation A                                 | Operation B                                       | Required result                                                             | Protection                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Callback refund attempt                     | Redelivered callback refund attempt               | One payout                                                                  | Existing reservation lock (`processed_payments`), provider idempotency key (Stripe/Square), judge's fresh-read `fully_refunded`/`refund_pending` verdicts, SumUp provider-side second-refund rejection |
| Admin refund                                | Callback refund of the same charge                | One payout                                                                  | Same as above — both paths front the same judge, then the same provider idempotency key                                                                                                                |
| Two admin bulk waves touching one reference | —                                                 | One payout per reference                                                    | `refundState === "completed"` short-circuit, judge verdict, idempotency key                                                                                                                            |
| Judgment read                               | Provider state changes after read, before attempt | Provider-side rejection or idempotent landing; never a silent double payout | Provider guarantees (documented full-refund rejection) + next read converges                                                                                                                           |

M4 adds no new locks and no revision columns; it narrows what the existing
protections must carry by refusing attempts that today would be fired blindly.

## Owner choices

Genuine conflicts the system must not decide:

- **`multiple_charges`** (a second captured charge on one payment): the record
  (activity log) and alert name the payment reference, every provider resource
  id, and the per-tender amounts. The owner refunds the extra charge in the
  provider dashboard (the in-app path cannot act on a charge it has no record
  slot for until M6). Automatic work is not stopped: the booking stands on the
  signed total. This is PLAN.md's approved M4 text applied ("one handler maps
  these outcomes onto today's behavior: detect, record, and alert … no automatic
  work is stopped or stranded before an owner can act") — failing the callback
  closed instead would 503 until provider redelivery exhausts, leaving taken
  money with no booking, no buyer answer, and no case tooling until M5, which is
  precisely the stranding the plan forbids. No money moves automatically either
  way; the extra charge sits untouched for the owner. Question 1 puts this
  remedy to the owner explicitly.
- **`capture_total_mismatch` / `partial_refund`**: same detect-record-alert
  handling; the evidence names expected vs observed amounts. Resolution today is
  the provider dashboard plus existing admin tools; case pages arrive in M5.

No money-moving automation is added for any owner-review kind.

## Security and privacy

- No new routes, roles, or links. Alerts and logs carry conflict kinds, resource
  ids, and amounts — never buyer PII, never raw provider payloads (M3's
  fixed-refusal discipline is unchanged).
- The judge runs on evidence already fetched by the current path; the only new
  provider data crossing a boundary is Stripe's documented `amount_refunded`
  field (question 2) and Square's documented tender `amount_money` field — both
  money figures, neither personal.
- Untrusted inputs cannot reach the judge without passing M3's ownership
  boundary first; forged callbacks still cost zero provider calls.

## What is deleted (F51)

In the same merges that wire `outcomeOf` in:

- `classifySession` / `classifySessionIntent`'s verdict arithmetic and the
  `SessionClass` type (`classify.ts:97-132`) — the callback-side judge.
- `tryRefund`'s ad-hoc attempt/fallback ordering and
  `refundReferenceAtProvider`'s duplicate of it — both become observe → judge →
  act.
- No alias, wrapper, or re-export bridges the old names.

`validatedPaymentSession` (M3 boundary), `refund-state.ts` (a record-derived
display fact, not a judge), and the ledger stay.

## Vertical PR slices

Two PRs, each standing alone, hardest invariant first. Both fit the M4 budget
(400–700 src lines total; pure closure ≈ 500 after slimming against main's
merged modules, cutovers net small after deletions).

**PR A — "No refund attempt can exceed the captured money" (≈ 350–450 src)**

- Ports the pure closure: `outcomeOf`, conflict kinds, refund legs and
  arithmetic, `resolveRefund`, `kindObject`, the words subsets.
- Builds the per-provider refund-evidence adapters (Square cumulative + PENDING
  answer, Stripe widened `amount_refunded`, SumUp status-derived) and fronts
  `tryRefund` and `refundReferenceAtProvider` with the judge.
- Deletes the displaced attempt/fallback ordering in both.
- Completes: F3 (classification half). Regression tests: the pinned arithmetic
  rows; a Square PENDING answer followed by a redelivery produces exactly one
  provider refund (the re-attempt reuses the same idempotency key and lands on
  the same refund — asserted by key equality, one payout); pending + completed
  exceeding captured is refused; completed counts immediately while cumulative
  lags.
- Budgets: per reference, 1 provider evidence read + at most 1 refund call — the
  read's result IS the judgment input, never a separate call. Callback refunds
  add zero reads (the judge reuses the session evidence already fetched). Admin
  bulk worst case: `BULK_REFUND_LIMIT` (5) × 2 = 10 provider calls plus the
  existing fixed database work — far inside the ≤40 database / 50 total
  subrequest rule. Database calls: unchanged from today.
- Standalone value: the live system stops repeat and over-refunds.

**PR B — "One judge for callback money, and alerts for what it finds" (≈ 250–350
src)**

- Builds the callback-side observation (expected facts from the signed proof,
  charges from the session evidence per provider) and replaces
  `classifySession`'s verdicts with the judge's outcomes mapped by the
  exhaustive remedy `Record`; deletes `SessionClass` and the inline arithmetic.
- Adds the owner-review record + alert arm (activity-log write in the processing
  transaction; existing error classes for the best-effort alert) and the Square
  multiple-tender detection: the raw tender pick widens to the documented
  `amount_money` field, so per-tender captured amounts come from the order read
  the path already makes — no extra provider calls.
- Budgets: zero additional provider or database calls beyond today's callback
  path, plus the one activity-log statement inside the existing processing
  transaction.
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
  sees the provider cumulative or REFUNDED status → `fully_refunded` → success
  without a second payout. Unchanged from today, now named.
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
- _Same resource on another record?_ `duplicate_charge`/`duplicate_refund`
  within one payment's evidence refuse; cross-payment duplicates are F8 (M6,
  needs the aggregate unique index) and out of scope — stated, not silently
  dropped.
- _One queued item fails permanently?_ Bulk rows record per-reference results; a
  refused reference cannot block the wave.
- _What does the buyer see?_ Byte-identical answers to today in every flow: the
  judge changes which internal verdict fires, not the response catalog. The only
  new user-visible artifact is owner alerts.
- _SumUp double-refund without idempotency?_ A second full refund of a refunded
  transaction is provider-rejected, and the judge's fresh status read answers
  `fully_refunded` first. The unguarded window is a crash after a SumUp refund
  succeeded and before any later read — the next read converges; no window
  produces a second payout because SumUp refunds are full-amount only.

## Open questions for the owner

1. **Owner-review remedy for `multiple_charges`** — confirm: booking proceeds on
   the signed total, with a durable activity-log record and a best-effort alert
   naming every charge; no automatic refund of the extra charge. This is
   PLAN.md's approved M4 text applied. The alternative — failing the callback
   closed until an owner acts — means 503s until provider redelivery exhausts:
   money taken, no booking, no buyer answer, and no case tooling until M5.
   Confirm proceed-and-alert, or choose the fail-closed alternative knowing that
   cost.
2. **Stripe `amount_refunded` widening** — the current schema deliberately picks
   only `latest_charge.refunded`. Widening to the documented `amount_refunded`
   gives Stripe a real cumulative for the arithmetic. Approve the read-shape
   widening?
3. **Blocked-refund copy** — an admin bulk/single refund refused by the overlap
   rule reports through the existing failed-row shape. Proposed reason wording:
   "A refund for this payment is still settling. Try again after it completes."
   Approve or reword.
4. **Slicing** — two PRs as above, or one ≈ 700-line PR? Two is recommended
   (each stands alone; hardest first).
