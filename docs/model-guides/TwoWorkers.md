# Keeping one refund claim safe across two workers and an old lease

[Read the model](../../verification/TwoWorkers.tla).

This page follows one payment claim through two refund runs. A run takes the row only when no claim exists or the claim is stale. A settle needs the exact stored command, write time, and phase. An old run cannot release a replacement claim.

## The bad outcome it rules out

A paused run returns after its lease expires and clears the claim that a second run now holds.

## The cast

| Word | Meaning |
| --- | --- |
| **refund run** | One attempt by the code to return a payment. The examples use w1 and w2. |
| **claim** | The right of one run to work on a payment row until the run settles. |
| **lease** | The time for which the application treats a claim as live. |
| **fence** | The exact command id, write time, and phase that a settle must match. |
| **stale claim** | A claim past the cutoff. Another run can then take over the same attendee work. |
| **settle** | The act of a run that records its result and releases its claim. |

## The walkthrough

### Step 1: Start with no claim

No claim means one owner none and empty fields. The claim fields are model records, not database columns. checkingClaimFor shows the canonical claim shape that a take writes. The start state is before either run obtains a claim, not before payment creation.

| Value | This step |
| --- | --- |
| `storedOwner` | none |
| `storedCommandId` | empty |
| `storedWrittenAt` | empty |
| `storedPhase` | empty |
| `storedClaimStale` | FALSE |
| `worker1Held and worker2Held` | FALSE |

**Model rule: [`Init`](../../verification/TwoWorkers.tla#L126)**

```tla
Init ==
  /\ storedOwner = "none"
  /\ storedCommandId = ""
  /\ storedWrittenAt = ""
  /\ storedPhase = ""
  /\ storedClaimStale = FALSE
  /\ worker1Held = FALSE
  /\ worker2Held = FALSE
```

**Model rule: [`TypeOK`](../../verification/TwoWorkers.tla#L64)**

```tla
TypeOK ==
  /\ storedOwner \in {"none"} \cup Workers
  /\ storedCommandId \in CommandIds \cup {""}
  /\ storedWrittenAt \in WrittenAts \cup {""}
  /\ storedPhase \in Phases \cup {""}
  /\ storedClaimStale \in BOOLEAN
  /\ worker1Held \in BOOLEAN
  /\ worker2Held \in BOOLEAN
```

**Model rule: [`ClaimFieldsConsistent`](../../verification/TwoWorkers.tla#L76)**

```tla
ClaimFieldsConsistent ==
  /\ (storedOwner = "none" =>
        /\ storedCommandId = ""
        /\ storedWrittenAt = ""
        /\ storedPhase = "")
  /\ \A worker \in Workers :
       (storedOwner = worker =>
          \E fence \in WorkerFenceFacts :
            /\ fence.worker = worker
            /\ storedCommandId = fence.commandId
            /\ storedWrittenAt = fence.writtenAt
            /\ storedPhase = fence.phase)
```

**Model rule: [`OwnerHolds`](../../verification/TwoWorkers.tla#L92)**

```tla
OwnerHolds ==
  /\ (storedOwner = "w1" => worker1Held)
  /\ (storedOwner = "w2" => worker2Held)
```

**Production code: [`src/shared/payment/row-transitions.ts#checkingClaimFor`](../../src/shared/payment/row-transitions.ts#L48)**

```ts
export const checkingClaimFor = (
  request: ClaimRequest,
  commandId: string,
  writtenAt: string,
): RefundClaim => ...
```

Source fingerprint: `sha256:67548b079b30d067`

**Production code: [`src/shared/payment/row-transitions.ts#claimHeldBy`](../../src/shared/payment/row-transitions.ts#L61)**

```ts
export const claimHeldBy = (
  claim: RefundClaim | undefined,
  held: HeldRowClaim,
): boolean => ...
```

Source fingerprint: `sha256:53c260dfcb1cfab2`

### Step 2: w1 takes an absent claim

decideClaim returns grant for an absent claim. holdsTheRow turns that decision into admitted TRUE. The take fact supplies the fence fields, and the step writes them to the row. The request uses attendee set [7] with scope attendee_set.

| Value | This step |
| --- | --- |
| `event` | w1 take |
| `existingOwner` | none |
| `decision` | grant |
| `admitted` | TRUE |
| `storedOwner` | w1 |
| `storedCommandId` | refund-run-a |
| `storedWrittenAt` | 2026-01-01T00:00:00.000Z |
| `storedPhase` | checking |
| `worker1Held` | TRUE |

**Model rule: [`TakeStep`](../../verification/TwoWorkers.tla#L140)**

```tla
TakeStep ==
  \E fact \in TakeFacts :
    /\ fact.existingOwner = storedOwner
    /\ fact.existingClaimStale = storedClaimStale
    /\ storedOwner' = IF fact.admitted THEN fact.worker ELSE storedOwner
    /\ storedCommandId' = IF fact.admitted THEN fact.newCommandId ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.admitted THEN fact.newWrittenAt ELSE storedWrittenAt
    /\ storedPhase' = IF fact.admitted THEN fact.newPhase ELSE storedPhase
    /\ storedClaimStale' = IF fact.admitted THEN FALSE ELSE storedClaimStale
    /\ worker1Held' =
         IF fact.admitted /\ fact.worker = "w1" THEN TRUE ELSE worker1Held
    /\ worker2Held' =
         IF fact.admitted /\ fact.worker = "w2" THEN TRUE ELSE worker2Held
```

**Model rule: [`TakeAdmitsOnlyAbsentOrExpired`](../../verification/TwoWorkers.tla#L109)**

```tla
TakeAdmitsOnlyAbsentOrExpired ==
  \A fact \in TakeFacts :
    fact.admitted => (fact.existingOwner = "none" \/ fact.existingClaimStale)
```

**Production code: [`src/shared/payment/claim.ts#decideClaim`](../../src/shared/payment/claim.ts#L108)**

```ts
export const decideClaim = (
  existing: RefundClaim | undefined,
  request: ClaimRequest,
  staleBefore: string,
): ClaimDecision => { ... }
```

Source fingerprint: `sha256:064ece6385ab1b1b`

**Production code: [`src/shared/payment/claim.ts#holdsTheRow`](../../src/shared/payment/claim.ts#L73)**

```ts
export const holdsTheRow = flagOfKind(CLAIMS_THE_ROW);
```

Source fingerprint: `sha256:26212adfdc6dad35`

### Step 3: A live claim refuses w2

A live claim returns held. The take is refused and changes no field. The fence fields stay w1's. A live claim must refuse another take, even from the same run.

| Value | This step |
| --- | --- |
| `event` | w2 take |
| `existingOwner` | w1 |
| `existingClaimStale` | FALSE |
| `decision` | held |
| `admitted` | FALSE |
| `stored fields` | unchanged |

**Model rule: [`TakeStep`](../../verification/TwoWorkers.tla#L140)**

```tla
TakeStep ==
  \E fact \in TakeFacts :
    /\ fact.existingOwner = storedOwner
    /\ fact.existingClaimStale = storedClaimStale
    /\ storedOwner' = IF fact.admitted THEN fact.worker ELSE storedOwner
    /\ storedCommandId' = IF fact.admitted THEN fact.newCommandId ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.admitted THEN fact.newWrittenAt ELSE storedWrittenAt
    /\ storedPhase' = IF fact.admitted THEN fact.newPhase ELSE storedPhase
    /\ storedClaimStale' = IF fact.admitted THEN FALSE ELSE storedClaimStale
    /\ worker1Held' =
         IF fact.admitted /\ fact.worker = "w1" THEN TRUE ELSE worker1Held
    /\ worker2Held' =
         IF fact.admitted /\ fact.worker = "w2" THEN TRUE ELSE worker2Held
```

**Model rule: [`ClaimFieldsConsistent`](../../verification/TwoWorkers.tla#L76)**

```tla
ClaimFieldsConsistent ==
  /\ (storedOwner = "none" =>
        /\ storedCommandId = ""
        /\ storedWrittenAt = ""
        /\ storedPhase = "")
  /\ \A worker \in Workers :
       (storedOwner = worker =>
          \E fence \in WorkerFenceFacts :
            /\ fence.worker = worker
            /\ storedCommandId = fence.commandId
            /\ storedWrittenAt = fence.writtenAt
            /\ storedPhase = fence.phase)
```

**Model rule: [`OwnerHolds`](../../verification/TwoWorkers.tla#L92)**

```tla
OwnerHolds ==
  /\ (storedOwner = "w1" => worker1Held)
  /\ (storedOwner = "w2" => worker2Held)
```

**Production code: [`src/shared/payment/claim.ts#decideClaim`](../../src/shared/payment/claim.ts#L108)**

```ts
export const decideClaim = (
  existing: RefundClaim | undefined,
  request: ClaimRequest,
  staleBefore: string,
): ClaimDecision => { ... }
```

Source fingerprint: `sha256:064ece6385ab1b1b`

**Production code: [`src/shared/payment/row-transitions.ts#checkingClaimFor`](../../src/shared/payment/row-transitions.ts#L48)**

```ts
export const checkingClaimFor = (
  request: ClaimRequest,
  commandId: string,
  writtenAt: string,
): RefundClaim => ...
```

Source fingerprint: `sha256:67548b079b30d067`

### Step 4: Lease expiry lets w2 take over

The lease expiry sets only the stale flag. Both runs request attendee 7 with scope attendee_set, so the stale claim is resumable. grantClaim replaces the claim on purpose. The model keeps worker1Held because expiry changes permission, not the old run's history.

| Value | This step |
| --- | --- |
| `storedClaimStale` | FALSE changes to TRUE |
| `w2 decision` | resume |
| `admitted` | TRUE |
| `storedOwner` | w1 changes to w2 |
| `storedCommandId` | refund-run-a changes to refund-run-b |
| `storedWrittenAt` | 2026-01-01T00:00:00.000Z changes to 2026-01-02T00:00:00.000Z |
| `worker1Held` | TRUE, not cleared |
| `worker2Held` | TRUE |

**Model rule: [`LeaseExpiry`](../../verification/TwoWorkers.tla#L176)**

```tla
LeaseExpiry ==
  /\ ~storedClaimStale
  /\ storedClaimStale' = TRUE
  /\ UNCHANGED <<storedOwner, storedCommandId, storedWrittenAt, storedPhase,
                 worker1Held, worker2Held>>
```

**Model rule: [`TakeStep`](../../verification/TwoWorkers.tla#L140)**

```tla
TakeStep ==
  \E fact \in TakeFacts :
    /\ fact.existingOwner = storedOwner
    /\ fact.existingClaimStale = storedClaimStale
    /\ storedOwner' = IF fact.admitted THEN fact.worker ELSE storedOwner
    /\ storedCommandId' = IF fact.admitted THEN fact.newCommandId ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.admitted THEN fact.newWrittenAt ELSE storedWrittenAt
    /\ storedPhase' = IF fact.admitted THEN fact.newPhase ELSE storedPhase
    /\ storedClaimStale' = IF fact.admitted THEN FALSE ELSE storedClaimStale
    /\ worker1Held' =
         IF fact.admitted /\ fact.worker = "w1" THEN TRUE ELSE worker1Held
    /\ worker2Held' =
         IF fact.admitted /\ fact.worker = "w2" THEN TRUE ELSE worker2Held
```

**Model rule: [`OwnerHolds`](../../verification/TwoWorkers.tla#L92)**

```tla
OwnerHolds ==
  /\ (storedOwner = "w1" => worker1Held)
  /\ (storedOwner = "w2" => worker2Held)
```

**Model rule: [`ClaimFieldsConsistent`](../../verification/TwoWorkers.tla#L76)**

```tla
ClaimFieldsConsistent ==
  /\ (storedOwner = "none" =>
        /\ storedCommandId = ""
        /\ storedWrittenAt = ""
        /\ storedPhase = "")
  /\ \A worker \in Workers :
       (storedOwner = worker =>
          \E fence \in WorkerFenceFacts :
            /\ fence.worker = worker
            /\ storedCommandId = fence.commandId
            /\ storedWrittenAt = fence.writtenAt
            /\ storedPhase = fence.phase)
```

**Production code: [`src/shared/payment/claim.ts#isClaimStale`](../../src/shared/payment/claim.ts#L96)**

```ts
export const isClaimStale = (
  claim: RefundClaim,
  staleBefore: string,
): boolean => ...
```

Source fingerprint: `sha256:9f73bcdfcde94b2f`

**Production code: [`src/shared/payment/row-transitions.ts#grantClaim`](../../src/shared/payment/row-transitions.ts#L73)**

```ts
export const grantClaim = (
  state: PaymentRowState,
  claim: RefundClaim,
): PaymentRowState => ...
```

Source fingerprint: `sha256:99ec14c435a7340c`

### Step 5: w1 returns and tries to settle

claimHeldBy compares command, write time, and phase. The old fence does not match, so settledRowState returns null and changes nothing. w2's exact fence releases the claim. A corrupt fact that accepts w1's fence violates SettleFenceIsExact.

| Value | This step |
| --- | --- |
| `w1 fence command` | refund-run-a |
| `w1 fence write time` | 2026-01-01T00:00:00.000Z |
| `w1 fence phase` | checking |
| `stored command` | refund-run-b |
| `w1 accepted` | FALSE, no change |
| `w2 accepted` | TRUE |
| `after w2 settle` | storedOwner none, worker2Held FALSE, worker1Held stays TRUE |

**Model rule: [`SettleStep`](../../verification/TwoWorkers.tla#L158)**

```tla
SettleStep ==
  \E fact \in SettleFacts :
    /\ fact.storedCommandId = storedCommandId
    /\ fact.storedWrittenAt = storedWrittenAt
    /\ fact.storedPhase = storedPhase
    /\ storedOwner' = IF fact.accepted THEN "none" ELSE storedOwner
    /\ storedCommandId' = IF fact.accepted THEN "" ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.accepted THEN "" ELSE storedWrittenAt
    /\ storedPhase' = IF fact.accepted THEN "" ELSE storedPhase
    /\ storedClaimStale' = storedClaimStale
    /\ worker1Held' =
         IF fact.accepted /\ fact.fenceWorker = "w1" THEN FALSE ELSE worker1Held
    /\ worker2Held' =
         IF fact.accepted /\ fact.fenceWorker = "w2" THEN FALSE ELSE worker2Held
```

**Model rule: [`SettleFenceIsExact`](../../verification/TwoWorkers.tla#L99)**

```tla
SettleFenceIsExact ==
  \A fact \in SettleFacts :
    fact.accepted =>
      /\ fact.storedOwner = fact.fenceWorker
      /\ fact.storedCommandId = fact.fenceCommandId
      /\ fact.storedWrittenAt = fact.fenceWrittenAt
      /\ fact.storedPhase = fact.fencePhase
```

**Production code: [`src/shared/payment/row-transitions.ts#claimHeldBy`](../../src/shared/payment/row-transitions.ts#L61)**

```ts
export const claimHeldBy = (
  claim: RefundClaim | undefined,
  held: HeldRowClaim,
): boolean => ...
```

Source fingerprint: `sha256:53c260dfcb1cfab2`

**Production code: [`src/shared/payment/row-transitions.ts#settledRowState`](../../src/shared/payment/row-transitions.ts#L130)**

```ts
export const settledRowState = (
  state: PaymentRowState,
  change: PaymentRowSettlement,
  held: { readonly commandId: string; readonly heldSince: string },
  returnedAt: string,
): PaymentRowState | null => ...
```

Source fingerprint: `sha256:7919d76ba9e6400b`

### Step 6: Safety joins the claim laws

Safety joins the type, claim field, owner, take, and settle laws. TakeStep and SettleStep apply the chosen prepared fact. LeaseExpiry changes only the stale flag. Next also permits a pause, so no run or provider answer is forced.

| Value | This step |
| --- | --- |
| `accepted w1 settle on w2's claim` | SettleFenceIsExact FALSE. Safety fails. |
| `take with admitted TRUE on a live claim` | TakeAdmitsOnlyAbsentOrExpired FALSE. Safety fails. |
| `pause` | All values stay equal. |

**Model rule: [`Safety`](../../verification/TwoWorkers.tla#L118)**

```tla
Safety ==
  /\ TypeOK
  /\ ClaimFieldsConsistent
  /\ OwnerHolds
  /\ SettleFenceIsExact
  /\ TakeAdmitsOnlyAbsentOrExpired
```

**Model rule: [`Next`](../../verification/TwoWorkers.tla#L185)**

```tla
Next ==
  TakeStep \/ SettleStep \/ LeaseExpiry \/
  UNCHANGED <<storedOwner, storedCommandId, storedWrittenAt, storedPhase,
              storedClaimStale, worker1Held, worker2Held>>
```

**Model rule: [`SettleStep`](../../verification/TwoWorkers.tla#L158)**

```tla
SettleStep ==
  \E fact \in SettleFacts :
    /\ fact.storedCommandId = storedCommandId
    /\ fact.storedWrittenAt = storedWrittenAt
    /\ fact.storedPhase = storedPhase
    /\ storedOwner' = IF fact.accepted THEN "none" ELSE storedOwner
    /\ storedCommandId' = IF fact.accepted THEN "" ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.accepted THEN "" ELSE storedWrittenAt
    /\ storedPhase' = IF fact.accepted THEN "" ELSE storedPhase
    /\ storedClaimStale' = storedClaimStale
    /\ worker1Held' =
         IF fact.accepted /\ fact.fenceWorker = "w1" THEN FALSE ELSE worker1Held
    /\ worker2Held' =
         IF fact.accepted /\ fact.fenceWorker = "w2" THEN FALSE ELSE worker2Held
```

**Model rule: [`TakeStep`](../../verification/TwoWorkers.tla#L140)**

```tla
TakeStep ==
  \E fact \in TakeFacts :
    /\ fact.existingOwner = storedOwner
    /\ fact.existingClaimStale = storedClaimStale
    /\ storedOwner' = IF fact.admitted THEN fact.worker ELSE storedOwner
    /\ storedCommandId' = IF fact.admitted THEN fact.newCommandId ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.admitted THEN fact.newWrittenAt ELSE storedWrittenAt
    /\ storedPhase' = IF fact.admitted THEN fact.newPhase ELSE storedPhase
    /\ storedClaimStale' = IF fact.admitted THEN FALSE ELSE storedClaimStale
    /\ worker1Held' =
         IF fact.admitted /\ fact.worker = "w1" THEN TRUE ELSE worker1Held
    /\ worker2Held' =
         IF fact.admitted /\ fact.worker = "w2" THEN TRUE ELSE worker2Held
```

**Production code: [`scripts/verify-models/two-workers.ts#corruptSettleData`](../../scripts/verify-models/two-workers.ts#L224)**

```ts
export const corruptSettleData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:012881b0388093f8`

**Production code: [`scripts/verify-models/two-workers.ts#twoWorkersModelData`](../../scripts/verify-models/two-workers.ts#L220)**

```ts
export const twoWorkersModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:82a1584b188f112c`

## The safety claim

A stored owner holds a claim. A no-owner row has empty claim fields. Every accepted take sees no claim or a stale claim. Every accepted settle matches the full stored claim fence. An old run's held flag does not authorize a release.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use two runs for attendee set [7] and selected timestamps.
- The model treats the selected cutoffs as live or expired. No clock runs.
- storedOwner and the worker flags are model records, not database columns.
- The steps explore event order. They do not execute SQL races or provider requests.
- The model does not prove that a run finishes or that a refund occurs once.

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
