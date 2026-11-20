# Parent and child pairs sold from a shared group pool

[Read the model](../../verification/SharedGroupCapacity.tla).

This page follows one parent listing and one required child that share a capped group. One pair uses two group places. The sale loop never reports more pairs than the pool holds. A static cap below two refuses the pair even when no date value exists.

## The bad outcome it rules out

A pool reports more pairs than its free places hold. Or a sold-out date-less pair passes the allow gate.

## The cast

| Word | Meaning |
| --- | --- |
| **listing** | One item that a customer can book, such as an event or a session. |
| **place** | One unit of bookable capacity. Every count here counts places. |
| **pair** | One parent listing and its one required child. The pair uses two places from every group that both listings share. |
| **group** | A common capacity limit that both listings share, such as a shared room. |
| **static cap** | The group total limit independent of date. A present zero allows no place. |
| **free places** | The free-place count in the caller's date context. A missing value gives a dummy zero, not a full pool. |
| **sold** | Whole pairs that this abstract sale loop sells. One pair consumes two group places. |
| **fact** | One pure function output from the producer. The fact is not a database read. |

## The walkthrough

### Step 1: Start with a pool of five free places

The producer calls the capacity functions over fixed group maps. Init selects any supplied fact and starts its sale loop with zero pairs sold. The example starts on a shared group with five free places and a static cap of ten.

| Value | This step |
| --- | --- |
| `group 11 free places` | 5 |
| `group 11 static cap` | 10 |
| `date-less` | FALSE |
| `static cap present` | TRUE |
| `sold` | 0 |

**Model rule: [`Init`](../../verification/SharedGroupCapacity.tla#L108)**

```tla
Init ==
  \E fact \in GroupFacts :
    /\ remaining = fact.remaining
    /\ staticCap = fact.staticCap
    /\ dateLess = fact.dateLess
    /\ hasStaticCap = fact.hasStaticCap
    /\ sold = 0
```

**Model rule: [`TypeOK`](../../verification/SharedGroupCapacity.tla#L67)**

```tla
TypeOK ==
  /\ remaining \in 0..MaxRemaining
  /\ staticCap \in 0..MaxStaticCap
  /\ dateLess \in BOOLEAN
  /\ hasStaticCap \in BOOLEAN
  /\ sold \in 0..MaxSold
```

**Production code: [`scripts/verify-models/shared-group-capacity.ts#sharedGroupCapacityModelData`](../../scripts/verify-models/shared-group-capacity.ts#L119)**

```ts
export const sharedGroupCapacityModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(FACTS),
);
```

Source fingerprint: `sha256:14c5e18948b2ba3c`

**Production code: [`src/shared/group-capacity.ts#sharedGroupCapacity`](../../src/shared/group-capacity.ts#L67)**

```ts
export const sharedGroupCapacity = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  staticCapByGroupId: ReadonlyMap<number, number>,
  remainingByGroupId: ReadonlyMap<number, number>,
): SharedGroupCapacity => { ... }
```

Source fingerprint: `sha256:08d553c034f4f4a5`

### Step 2: One pair consumes two places

The remaining function takes the smallest value over the shared groups. One pair needs two places. The sell step checks the allow gate, at least two free places, and a sold count below the fit count. It then removes two places and adds one pair.

| Value | This step |
| --- | --- |
| `free places before` | 5 |
| `free places after` | 3 |
| `sold before` | 0 |
| `sold after` | 1 |
| `pairs that fit` | 2 |

**Model rule: [`SellStep`](../../verification/SharedGroupCapacity.tla#L123)**

```tla
SellStep ==
  \E fact \in GroupFacts :
    /\ fact.dateLess = dateLess
    /\ fact.staticCap = staticCap
    /\ fact.hasStaticCap = hasStaticCap
    /\ fact.remaining = remaining + PARENT_CHILD_GROUP_UNITS * sold
    /\ fact.allowed
    /\ remaining >= PARENT_CHILD_GROUP_UNITS
    /\ sold < fact.fits
    /\ remaining' = remaining - PARENT_CHILD_GROUP_UNITS
    /\ sold' = sold + 1
    /\ UNCHANGED <<staticCap, dateLess, hasStaticCap>>
```

**Production code: [`src/shared/group-capacity.ts#sharedGroupRemaining`](../../src/shared/group-capacity.ts#L26)**

```ts
export const sharedGroupRemaining = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  remainingByGroupId: ReadonlyMap<number, number>,
): number | undefined => { ... }
```

Source fingerprint: `sha256:65a6672cc20e3e82`

**Production code: [`src/shared/group-capacity.ts#PARENT_CHILD_GROUP_UNITS`](../../src/shared/group-capacity.ts#L13)**

```ts
export const PARENT_CHILD_GROUP_UNITS = 2;
```

Source fingerprint: `sha256:abd6598485ff303c`

### Step 3: The pool stops at two pairs

The fit function divides five free places by two and reports two whole pairs. A second sale leaves one free place. A third sale fails, because the loop already sold two pairs and one place cannot hold a pair.

| Value | This step |
| --- | --- |
| `free places before` | 3 |
| `free places after` | 1 |
| `sold before` | 1 |
| `sold after` | 2 |
| `pairs that fit` | 2 |

**Model rule: [`SellStep`](../../verification/SharedGroupCapacity.tla#L123)**

```tla
SellStep ==
  \E fact \in GroupFacts :
    /\ fact.dateLess = dateLess
    /\ fact.staticCap = staticCap
    /\ fact.hasStaticCap = hasStaticCap
    /\ fact.remaining = remaining + PARENT_CHILD_GROUP_UNITS * sold
    /\ fact.allowed
    /\ remaining >= PARENT_CHILD_GROUP_UNITS
    /\ sold < fact.fits
    /\ remaining' = remaining - PARENT_CHILD_GROUP_UNITS
    /\ sold' = sold + 1
    /\ UNCHANGED <<staticCap, dateLess, hasStaticCap>>
```

**Production code: [`src/shared/booking/model.ts#ticketsThatFitInPool`](../../src/shared/booking/model.ts#L99)**

```ts
export const ticketsThatFitInPool = (
  remaining: number,
  spotsNeeded: number,
): number => ...
```

Source fingerprint: `sha256:6cf7128b0a562a96`

### Step 4: Every fact must fit its pool

NoOverfill reads every supplied fact with a free-place value. It multiplies the reported pair count by two and compares the result to the free places. It also requires a non-negative loop balance. A pool with one free place reports zero pairs.

| Value | This step |
| --- | --- |
| `group 24` | 1 free place, 0 pairs |
| `group 25` | 2 free places, 1 pair |
| `group 11` | 5 free places, 2 pairs |

**Model rule: [`NoOverfill`](../../verification/SharedGroupCapacity.tla#L77)**

```tla
NoOverfill ==
  /\ (\A fact \in GroupFacts :
        ~fact.dateLess =>
          fact.fits * PARENT_CHILD_GROUP_UNITS <= fact.remaining)
  /\ (~dateLess => remaining >= 0)
```

**Production code: [`src/shared/booking/model.ts#ticketsThatFitInPool`](../../src/shared/booking/model.ts#L99)**

```ts
export const ticketsThatFitInPool = (
  remaining: number,
  spotsNeeded: number,
): number => ...
```

Source fingerprint: `sha256:6cf7128b0a562a96`

**Production code: [`scripts/verify-models/shared-group-capacity.ts#FACTS`](../../scripts/verify-models/shared-group-capacity.ts#L107)**

```ts
export const FACTS: readonly GroupFact[] = SCENARIOS.map(factFor);
```

Source fingerprint: `sha256:66ff5c9e56ab4ca4`

### Step 5: A cap below two refuses a date-less pair

A static cap below two refuses the pair even when no date value exists. The allow function treats a missing cap as unknown, not as zero. Group 28 has no static cap and five free places, so it still allows a pair. A date-less fact has a dummy free count of zero, so the sale loop sells no pair.

| Value | This step |
| --- | --- |
| `group 23 static cap` | 1 |
| `group 23 date-less` | TRUE |
| `group 23 allowed` | FALSE |
| `group 23 sold` | 0 |
| `group 28 static cap` | absent |
| `group 28 allowed` | TRUE |

**Model rule: [`NoDateLessSoldOutPair`](../../verification/SharedGroupCapacity.tla#L86)**

```tla
NoDateLessSoldOutPair ==
  /\ (\A fact \in GroupFacts :
        fact.dateLess /\ fact.hasStaticCap =>
          (fact.allowed => fact.staticCap >= PARENT_CHILD_GROUP_UNITS))
  /\ (dateLess /\ hasStaticCap /\ staticCap < PARENT_CHILD_GROUP_UNITS =>
        sold = 0)
```

**Production code: [`src/shared/group-capacity.ts#sharedGroupCapacity`](../../src/shared/group-capacity.ts#L67)**

```ts
export const sharedGroupCapacity = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  staticCapByGroupId: ReadonlyMap<number, number>,
  remainingByGroupId: ReadonlyMap<number, number>,
): SharedGroupCapacity => { ... }
```

Source fingerprint: `sha256:08d553c034f4f4a5`

**Production code: [`src/shared/booking/model.ts#parentAndChildFitGroup`](../../src/shared/booking/model.ts#L90)**

```ts
export const parentAndChildFitGroup = (
  capacity: SharedGroupCapacity,
): boolean => ...
```

Source fingerprint: `sha256:9327052e1b5c0668`

### Step 6: Safety holds for every allowed sale

The sell step matches the fact context and requires the allow gate, two free places, and a sold count below the fit count. The fact free count must equal the loop balance plus two places for each pair already sold. Next also permits no change. Safety joins TypeOK, NoOverfill, and NoDateLessSoldOutPair. The loop can stop at any point, so the model does not prove that a sale finishes.

| Value | This step |
| --- | --- |
| `free places` | Never below 0 |
| `sold` | Never above the fit count |
| `context` | The cap and the date-less flags stay fixed |

**Model rule: [`Next`](../../verification/SharedGroupCapacity.tla#L139)**

```tla
Next ==
  SellStep \/ UNCHANGED <<remaining, staticCap, dateLess, hasStaticCap, sold>>
```

**Model rule: [`Safety`](../../verification/SharedGroupCapacity.tla#L98)**

```tla
Safety ==
  /\ TypeOK
  /\ NoOverfill
  /\ NoDateLessSoldOutPair
```

**Production code: [`scripts/verify-models/shared-group-capacity.ts#sharedGroupCapacityModelData`](../../scripts/verify-models/shared-group-capacity.ts#L119)**

```ts
export const sharedGroupCapacityModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(FACTS),
);
```

Source fingerprint: `sha256:14c5e18948b2ba3c`

**Production code: [`src/shared/booking/model.ts#ticketsThatFitInPool`](../../src/shared/booking/model.ts#L99)**

```ts
export const ticketsThatFitInPool = (
  remaining: number,
  spotsNeeded: number,
): number => ...
```

Source fingerprint: `sha256:6cf7128b0a562a96`

## The safety claim

Every allowed state keeps each reported pair count within the free places, keeps the loop balance non-negative, and keeps a date-less pool with a cap below two at zero sales.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use fixed group maps with caps and free counts from zero to ten.
- The model has one parent and one child, not a whole child-choice search.
- It does not prove group map completeness, SQL writes, or concurrent sales.
- It checks safety. It does not prove that stock sells out or that a buyer completes an order.

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
