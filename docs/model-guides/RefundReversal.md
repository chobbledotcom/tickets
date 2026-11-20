# Reversing a returned refund once and never twice

[Read the model](../../verification/RefundReversal.tla).

This page follows one attendee's provider refund through the first ledger plan and a replay. A plan posts only inverse legs for groups with provider cash, no operator money, and a settled or payment-only account. A replay never reverses a group that the first plan recorded.

## The bad outcome it rules out

A repeated callback posts a second refund for the same order. Or a refund reverses a group with an operator adjustment or an unpaid balance.

## The cast

| Word | Meaning |
| --- | --- |
| **refund plan** | The inverse ledger legs that one returned provider refund proposes. |
| **account refund group** | One booking and its tax corrections. It is the unit that the refund guards decide on. |
| **settled** | Zero net balance on the attendee account for the group. It is not a provider success status. |
| **payment-only** | A group whose legs are only provider cash, with no sale and no operator entry. |
| **inverse** | A leg with the same amount as an original and with source and destination swapped. |
| **round** | The first plan or the plan after the first plan posts. |

## The walkthrough

### Step 1: Start before the first plan

The model starts at the first round with no remembered reversal and no failed verdict. The fixture ledger already exists outside the model. The producer derives every fact from the production plan and ledger functions.

| Value | This step |
| --- | --- |
| `round` | first |
| `recorded` | {} |
| `allPlansSafe` | TRUE |
| `legsSafe` | TRUE |

**Model rule: [`Init`](../../verification/RefundReversal.tla#L133)**

```tla
Init ==
  /\ round = "first"
  /\ recorded = {}
  /\ allPlansSafe = TRUE
  /\ legsSafe = TRUE
```

**Model rule: [`TypeOK`](../../verification/RefundReversal.tla#L73)**

```tla
TypeOK ==
  /\ round \in RoundNames
  /\ recorded \in SUBSET GroupLabels
  /\ allPlansSafe \in BOOLEAN
  /\ legsSafe \in BOOLEAN
```

**Production code: [`scripts/verify-models/refund-reversal.ts#refundReversalModelData`](../../scripts/verify-models/refund-reversal.ts#L271)**

```ts
export const refundReversalModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:362df20291016483`

### Step 2: A fully paid group can reverse

CanReverse needs provider cash, no operator money and either payment-only legs or a settled account. refundGroupFacts derives those facts from the attendee account and the group legs. The unsafe group fails the settled test. The operator group fails the operator-money test. A refusal needs no eligibility.

| Value | This step |
| --- | --- |
| `safe group` | Payment 5000 and sale 5000. Net balance 0. Settled. |
| `unsafe group` | Payment 1000 and sale 3000. 2000 is still owed. Not settled. |
| `operator group` | Payment 2000, sale 2000 and adjustment 500. Operator money is present. |
| `reversal` | safe is TRUE. unsafe and operator are FALSE. |

**Model rule: [`CanReverse`](../../verification/RefundReversal.tla#L90)**

```tla
CanReverse(fact) ==
  /\ fact.hasProviderPayment
  /\ ~fact.hasOperatorMoney
  /\ (fact.paymentOnly \/ fact.settled)
```

**Model rule: [`SafeReversal`](../../verification/RefundReversal.tla#L99)**

```tla
SafeReversal(fact) ==
  /\ ~((fact.group \in recorded) /\ fact.reverses)
  /\ fact.reverses => CanReverse(fact)
```

**Production code: [`src/shared/refund-ledger/plan.ts#refundGroupFacts`](../../src/shared/refund-ledger/plan.ts#L275)**

```ts
export const refundGroupFacts = (
  account: ReturnType<typeof attendeeAccount>,
  group: AccountRefundGroup,
): RefundGroupFacts => ...
```

Source fingerprint: `sha256:c6efd05331d058f7`

**Production code: [`src/shared/refund-ledger/plan.ts#computeAttendeeRefunds`](../../src/shared/refund-ledger/plan.ts#L370)**

```ts
export const computeAttendeeRefunds = async (
  inputs: readonly RefundPlanInput[],
): Promise<ComputedRefund[]> => { ... }
```

Source fingerprint: `sha256:109defaca6928c7b`

### Step 3: Each refund leg inverts one stored leg

SafeLeg needs an exact inverse and a stored original. isInverseOf supplies the comparison of amount and accounts. The producer finds the original in the ledger before it accepts a posted leg. It throws when no stored original pairs, so a bad link never becomes a clean fact.

| Value | This step |
| --- | --- |
| `safe-sale` | 5000 from the attendee account to revenue account 1. |
| `refund leg` | 5000 from revenue account 1 to the attendee account. exactInverse is TRUE. |
| `unpaired leg` | Reference no-recorded-original is not a stored leg. The producer throws. |

**Model rule: [`SafeLeg`](../../verification/RefundReversal.tla#L107)**

```tla
SafeLeg(leg) == leg.exactInverse /\ leg.original \in OriginalLegs
```

**Production code: [`src/shared/ledger/reverse.ts#isInverseOf`](../../src/shared/ledger/reverse.ts#L22)**

```ts
export const isInverseOf = (
  leg: DirectedAmount,
  original: DirectedAmount,
): boolean => ...
```

Source fingerprint: `sha256:67979851cd7b0129`

### Step 4: The first plan records the safe group

FirstPlan applies the per-group rule to every first-round fact. PlanRound keeps any failure and, after the first round, records every reversed group and moves to replay. The safe group posts an inverse of its payment and of its sale. The unsafe group posts nothing and waits for review.

| Value | This step |
| --- | --- |
| `round` | first, then replay |
| `recorded` | {} then {safe} |
| `safe legs` | 2 inverse legs post. |
| `unsafe legs` | 0 legs post. |

**Model rule: [`FirstPlan`](../../verification/RefundReversal.tla#L161)**

```tla
FirstPlan ==
  /\ round = "first"
  /\ recorded = {}
  /\ PlanRound("first")
```

**Model rule: [`PlanRound`](../../verification/RefundReversal.tla#L145)**

```tla
PlanRound(r) ==
  /\ allPlansSafe' = ChecksStillPass(allPlansSafe,
       \A fact \in ReversalFacts : fact.round = r => SafeReversal(fact))
  /\ legsSafe' = ChecksStillPass(legsSafe,
       \A leg \in LegFacts : leg.round = r => SafeLeg(leg))
  /\ IF r = "first"
     THEN
       /\ recorded' = {reversal.group :
           reversal \in {fact \in ReversalFacts :
             fact.round = r /\ fact.reverses}}
       /\ round' = "replay"
     ELSE
       UNCHANGED <<round, recorded>>
```

**Production code: [`src/shared/refund-ledger/plan.ts#computeAttendeeRefunds`](../../src/shared/refund-ledger/plan.ts#L370)**

```ts
export const computeAttendeeRefunds = async (
  inputs: readonly RefundPlanInput[],
): Promise<ComputedRefund[]> => { ... }
```

Source fingerprint: `sha256:109defaca6928c7b`

**Production code: [`scripts/verify-models/refund-reversal.ts#refundReversalModelData`](../../scripts/verify-models/refund-reversal.ts#L271)**

```ts
export const refundReversalModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:362df20291016483`

### Step 5: Every reference has one outcome

ReferencePartition requires one outcome for each expected round and reference. accountRefundGroups joins each booking to its tax corrections. The producer marks a reference recorded only when it lies wholly in an eligible group. It marks review when the reference names a group with an unsettled obligation. A reference to a missing booking stays unrecorded.

| Value | This step |
| --- | --- |
| `pi-safe` | recorded |
| `pi-unsafe` | review |
| `pi-missing` | unrecorded |
| `coverage` | One outcome for each round and reference pair. |

**Model rule: [`ReferencePartition`](../../verification/RefundReversal.tla#L114)**

```tla
ReferencePartition ==
  /\ \A fact \in ReferenceFacts : fact.outcome \in ReferenceOutcomes
  /\ \A expected \in ExpectedReferences :
       Cardinality({fact \in ReferenceFacts :
         fact.round = expected.round /\ fact.reference = expected.reference}) = 1
```

**Production code: [`scripts/verify-models/refund-reversal.ts#refundReversalModelData`](../../scripts/verify-models/refund-reversal.ts#L271)**

```ts
export const refundReversalModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:362df20291016483`

**Production code: [`src/shared/refund-ledger/plan.ts#accountRefundGroups`](../../src/shared/refund-ledger/plan.ts#L77)**

```ts
export const accountRefundGroups = (
  legs: Transfer[],
  assessments: readonly StoredTaxAssessment[] = [],
): AccountRefundGroup[] => { ... }
```

Source fingerprint: `sha256:07fd5b80e6c667fb`

### Step 6: A replay must not reverse a recorded group

ReplayPlan checks the grown ledger. SafeReversal refuses any replay fact that claims a reversal of a group in the recorded set. Production posts no second credit because the plan finds the existing refund legs for that group. The control marks the replay plan as reversing safe again. Safety keeps the failed verdict, and Next permits a repeat replay or no change. No rule requires the first plan or a final outcome.

| Value | This step |
| --- | --- |
| `round` | replay |
| `recorded` | {safe} |
| `safe reversal` | FALSE in the clean replay plan. |
| `control` | doubleRecordData sets it TRUE. The checker rejects the data. |

**Model rule: [`ReplayPlan`](../../verification/RefundReversal.tla#L169)**

```tla
ReplayPlan ==
  /\ round = "replay"
  /\ PlanRound("replay")
```

**Model rule: [`Safety`](../../verification/RefundReversal.tla#L122)**

```tla
Safety ==
  /\ TypeOK
  /\ allPlansSafe
  /\ legsSafe
  /\ ReferencePartition
```

**Model rule: [`Next`](../../verification/RefundReversal.tla#L176)**

```tla
Next == FirstPlan \/ ReplayPlan \/
  UNCHANGED <<round, recorded, allPlansSafe, legsSafe>>
```

**Production code: [`scripts/verify-models/refund-reversal.ts#doubleRecordData`](../../scripts/verify-models/refund-reversal.ts#L304)**

```ts
export const doubleRecordData: ModelDataSource = reversalControl(
  (reversal) => reversal.round === "replay" && reversal.group === "safe",
);
```

Source fingerprint: `sha256:7ebdaba1f54cf128`

## The safety claim

Every accepted plan keeps the per-group reversal rule, pairs every posted leg with a stored original, and gives every returned reference exactly one outcome. A replay never reverses a recorded group.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The fixtures cover four small ledgers. They do not cover every account, amount or refund path.
- The law is per group. Production also has a whole-account path that this model does not prove.
- The model checks extracted facts, not money arithmetic itself, provider truth, concurrent plans, SQL atomicity or a crash gap between writes.
- The model checks safety. It does not prove that a plan eventually completes.

## How to read the model text

| Symbol | Meaning |
| --- | --- |
| `==` | This line defines a rule. It does not assign a value. |
| `x'` | The value of `x` after the step. |
| `/\` | Both conditions must hold. |
| `\/` | One of the conditions must hold. |
| `\A` | Every supplied value must satisfy the rule. |
| `\E` | At least one supplied value must satisfy the rule. |
| `\in` | The value belongs to the set. |
| `=>` | If the left condition holds, the right condition must hold. |

Read [the model verification guide](../model-verification.md) for the
method and its limits.
