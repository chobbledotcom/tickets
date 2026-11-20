# Splitting whole units without a lost penny or a broken cap

[Read the model](../../verification/LargestRemainderSplit.tla).

This page follows one whole-unit allocation after the floor shares. Every leftover unit goes to one eligible part. The awarded units plus the units still owed equal the original leftover. No part goes past its cap.

## The bad outcome it rules out

One unit disappears in the award loop, or a part takes a unit past its cap, or units remain with no eligible part to take them.

## The cast

| Word | Meaning |
| --- | --- |
| **part** | One recipient, such as one ticket unit or one tax line. |
| **floor** | The proportional share of one part, rounded down. |
| **leftover** | The whole units still owed after every part takes its floor. |
| **eligible** | The caller's guard permits one extra unit for that part. A part at its cap is not eligible. |
| **cap** | The maximum allocation for one part, such as its full price. |
| **bumped** | The set of parts that received one extra unit. |
| **stranded** | A model fault flag. It means that units remain but no eligible part can receive one. |

## The walkthrough

### Step 1: Start after the floor shares

Init selects one supplied case after every part takes its floor share. CaseTags holds the case names. TypeOK bounds the case, the leftover count, the awarded set and the fault flag. The producer computes the floors from the raw weights with JavaScript arithmetic, and the model receives no answer.

| Value | This step |
| --- | --- |
| `current` | a part at its cap receives no more |
| `capped` | TRUE |
| `leftover` | 1 |
| `remaining` | 1 |
| `bumped` | {} |
| `stranded` | FALSE |

**Model rule: [`Init`](../../verification/LargestRemainderSplit.tla#L120)**

```tla
Init ==
  \E caseFact \in SplitCases :
    /\ current' = caseFact.caseTag
    /\ capped' = caseFact.capped
    /\ leftover' = caseFact.leftover
    /\ remaining' = caseFact.leftover
    /\ bumped' = {}
    /\ stranded' = FALSE
```

**Model rule: [`TypeOK`](../../verification/LargestRemainderSplit.tla#L75)**

```tla
TypeOK ==
  /\ current \in CaseTags
  /\ capped \in BOOLEAN
  /\ leftover \in Int
  /\ remaining \in Int
  /\ bumped \in SUBSET (1..MaxParts)
  /\ stranded \in BOOLEAN
```

**Model rule: [`CaseTags`](../../verification/LargestRemainderSplit.tla#L67)**

```tla
CaseTags == {caseFact.caseTag : caseFact \in SplitCases}
```

**Production code: [`scripts/verify-models/largest-remainder-split.ts#splitFacts`](../../scripts/verify-models/largest-remainder-split.ts#L201)**

```ts
export const splitFacts = (): SplitFacts => { ... }
```

Source fingerprint: `sha256:44c4337e824a3e9b`

### Step 2: Award one unit to an eligible part

CurrentCaseFactsHold ties the cap flag and the leftover count to the supplied case. AwardStep gives one unit to one eligible part that has no unit yet. The model allows any eligible choice, not the production sort order. largestRemainderAllocation ranks the parts by remainder and tie-break value in production.

| Value | This step |
| --- | --- |
| `case` | a part at its cap receives no more |
| `part 1` | floor 666, cap 666, eligible FALSE |
| `part 2` | floor 1333, cap 1334, eligible TRUE |
| `remaining` | 1, then 0 |
| `bumped` | {} then {2} |

**Model rule: [`CurrentCaseFactsHold`](../../verification/LargestRemainderSplit.tla#L100)**

```tla
CurrentCaseFactsHold ==
  \E caseFact \in SplitCases :
    /\ caseFact.caseTag = current
    /\ capped = caseFact.capped
    /\ leftover = caseFact.leftover
```

**Model rule: [`AwardStep`](../../verification/LargestRemainderSplit.tla#L132)**

```tla
AwardStep ==
  \E partFact \in SplitParts :
    /\ partFact.caseTag = current
    /\ partFact.eligible
    /\ partFact.partIndex \notin bumped
    /\ remaining >= 1
    /\ bumped' = bumped \cup {partFact.partIndex}
    /\ remaining' = remaining - 1
    /\ UNCHANGED <<current, capped, leftover, stranded>>
```

**Production code: [`src/shared/largest-remainder.ts#largestRemainderAllocation`](../../src/shared/largest-remainder.ts#L36)**

```ts
export const largestRemainderAllocation = (
  weights: readonly number[],
  amount: number,
  options: LargestRemainderAllocationOptions = {},
): number[] => { ... }
```

Source fingerprint: `sha256:5a4765f2ecfcd6e6`

### Step 3: The awards stay inside the caps

UnitsStayAccounted requires the remaining units plus the awarded parts to equal the leftover count. AwardStaysWithinCap requires each awarded part to stay at or below its cap. allocateReservationDeposit passes the capacity guard and the cart-order tie-break to the production allocator. In the reservation case, parts 2 and 3 take the two leftover units and reach their capacities.

| Value | This step |
| --- | --- |
| `leftover` | 1 |
| `remaining` | 0 |
| `bumped` | {2} |
| `accounting` | 0 + 1 = 1 |
| `part 2` | 1333 + 1 = 1334, cap 1334 |
| `reservation case` | floors [3, 0, 0], awards {2, 3}, result [3, 1, 1]. |

**Model rule: [`UnitsStayAccounted`](../../verification/LargestRemainderSplit.tla#L86)**

```tla
UnitsStayAccounted ==
  /\ remaining >= 0
  /\ remaining + Cardinality(bumped) = leftover
```

**Model rule: [`AwardStaysWithinCap`](../../verification/LargestRemainderSplit.tla#L93)**

```tla
AwardStaysWithinCap ==
  \A partFact \in PartsOf(current) :
    partFact.partIndex \in bumped =>
      ~capped \/ partFact.floor + 1 <= partFact.cap
```

**Production code: [`src/shared/reservation-amount.ts#allocateReservationDeposit`](../../src/shared/reservation-amount.ts#L140)**

```ts
export const allocateReservationDeposit = (
  raw: string,
  items: readonly ReservationAllocationItem[],
): ReservationDepositAllocation => { ... }
```

Source fingerprint: `sha256:4a78c38bb276fe2b`

**Production code: [`src/shared/largest-remainder.ts#largestRemainderAllocation`](../../src/shared/largest-remainder.ts#L36)**

```ts
export const largestRemainderAllocation = (
  weights: readonly number[],
  amount: number,
  options: LargestRemainderAllocationOptions = {},
): number[] => { ... }
```

Source fingerprint: `sha256:5a4765f2ecfcd6e6`

### Step 4: Units with no eligible part are a fault

PartsOf keeps the parts of each case apart, so an award cannot cross cases. StrandStep exposes a fault when units remain and every eligible part already has a unit. The unconserved accounting control adds one owed unit to this case. The model then reaches the fault step, and the checker must reject the data.

| Value | This step |
| --- | --- |
| `case` | a part at its cap receives no more |
| `leftover` | 2 after the corrupted fact. |
| `remaining` | 1 |
| `bumped` | {2} |
| `eligible parts without a unit` | 0 |
| `stranded` | TRUE. Safety fails. |

**Model rule: [`PartsOf`](../../verification/LargestRemainderSplit.tla#L70)**

```tla
PartsOf(tag) == {partFact \in SplitParts : partFact.caseTag = tag}
```

**Model rule: [`StrandStep`](../../verification/LargestRemainderSplit.tla#L145)**

```tla
StrandStep ==
  /\ remaining >= 1
  /\ \A partFact \in PartsOf(current) :
       partFact.eligible => partFact.partIndex \in bumped
  /\ stranded' = TRUE
  /\ UNCHANGED <<current, capped, leftover, remaining, bumped>>
```

**Production code: [`scripts/verify-models/largest-remainder-split.ts#corruptSplitData`](../../scripts/verify-models/largest-remainder-split.ts#L290)**

```ts
export const corruptSplitData = async (
  corruption: Corruption,
  facts: SplitFacts = splitFacts(),
): Promise<string> => { ... }
```

Source fingerprint: `sha256:b162aa418d8fd365`

### Step 5: Six parts and the joined claim

MaxParts bounds one case at six parts, and the tax case uses all six. Safety joins the type, case, accounting and cap rules and refuses a stranded flag. Next permits an award, the fault step or no change. No fairness rule forces awards, so the model does not prove that the loop finishes.

| Value | This step |
| --- | --- |
| `case` | tax across lines and modifiers |
| `amount` | 267 |
| `floors` | [118, 79, 44, 14, 7, 2] |
| `leftover` | 3 |
| `awards` | {1, 3, 4} |
| `result` | [119, 79, 45, 15, 7, 2] |
| `MaxParts` | 6 |

**Model rule: [`MaxParts`](../../verification/LargestRemainderSplit.tla#L40)**

```tla
MaxParts == 6

VARIABLES
  \* The identity of the selected allocation case, not a production row id.
  \* @type: Str;
  current,
  \* Whether this case requires a per-part price cap.
  \* @type: Bool;
  capped,
  \* The original number of whole units left after the floors.
  \* A unit can be a minor currency unit or one reserved place.
  \* @type: Int;
  leftover,
  \* The units still owed after the model's awards.
  \* @type: Int;
  remaining,
  \* One-based indexes of parts that received one extra unit.
  \* @type: Set(Int);
  bumped,
  \* A model-only fault flag: units remain but no eligible part can receive one.
  \* @type: Bool;
  stranded
```

**Model rule: [`Safety`](../../verification/LargestRemainderSplit.tla#L110)**

```tla
Safety ==
  /\ TypeOK
  /\ CurrentCaseFactsHold
  /\ UnitsStayAccounted
  /\ AwardStaysWithinCap
  /\ ~stranded
```

**Model rule: [`Next`](../../verification/LargestRemainderSplit.tla#L154)**

```tla
Next ==
  AwardStep \/ StrandStep \/
  UNCHANGED <<current, capped, leftover, remaining, bumped, stranded>>
```

**Production code: [`scripts/verify-models/largest-remainder-split.ts#splitFacts`](../../scripts/verify-models/largest-remainder-split.ts#L201)**

```ts
export const splitFacts = (): SplitFacts => { ... }
```

Source fingerprint: `sha256:44c4337e824a3e9b`

**Production code: [`src/shared/reservation-amount.ts#allocateReservationDeposit`](../../src/shared/reservation-amount.ts#L140)**

```ts
export const allocateReservationDeposit = (
  raw: string,
  items: readonly ReservationAllocationItem[],
): ReservationDepositAllocation => { ... }
```

Source fingerprint: `sha256:4a78c38bb276fe2b`

## The safety claim

Every accepted award keeps the unit count, the per-part caps and the case facts. A stranded unit is a fault, so the model refuses it.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The model starts after the floors. It does not validate the floor arithmetic or the production recipient order.
- The facts must supply enough eligible parts and correct floors. Direct tests must check those facts and the production arithmetic.
- Selected cases do not establish arithmetic correctness for all inputs. Fractional amounts stay outside this integer model.
- No fairness rule forces awards. The model checks safety, not eventual completion.

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
