# Keeping a SumUp checkout recoverable when its callback is lost

[Read the model](../../verification/SumupRecovery.tla).

This page follows one SumUp checkout after the provider callback fails to arrive. A row that can still hold unaccounted money stays. It keeps a check that can ask SumUp again. Age alone never proves that nobody paid.

## The bad outcome it rules out

An old waiting or owed row is deleted, so a paid checkout leaves no row and no later check can find the money.

## The cast

| Word | Meaning |
| --- | --- |
| **checkout** | One attempt to pay for a reservation. Its SumUp checkout id lets the site ask about it. |
| **callback** | A provider message about a checkout. A lost callback does not prove that nobody paid. |
| **recovery row** | A local row that keeps the checkout so a later task can ask SumUp again. |
| **state** | The five row labels: staged, waiting, owed, finished, and unpaid. |
| **money answer** | One label for unaccounted money risk: no, unknown, or yes. It is not an amount. |
| **move** | One prepared row move with the state and checkout id shape on each side. |

## The walkthrough

### Step 1: Start with a staged row

The row starts as staged, before SumUp gives it a checkout id. It is retained and young. The reader agrees that this state carries no id. The producer supplies one row shape for each state.

| Value | This step |
| --- | --- |
| `recoveryState` | staged |
| `hasCheckoutId` | FALSE |
| `rowRetained` | TRUE |
| `pruningAgeReached` | FALSE |
| `firstTerminalState` | none |

**Model rule: [`Init`](../../verification/SumupRecovery.tla#L183)**

```tla
Init ==
  /\ recoveryState = NoCheckoutIdState
  /\ hasCheckoutId = FALSE
  /\ checkoutIdAgrees = TRUE
  /\ rowRetained = TRUE
  /\ pruningAgeReached = FALSE
  /\ riskyDeletionSeen = FALSE
  /\ checkHistorySafe = TRUE
  /\ owedStateSeen = FALSE
  /\ firstTerminalState = "none"
```

**Model rule: [`TypeOK`](../../verification/SumupRecovery.tla#L138)**

```tla
TypeOK ==
  /\ recoveryState \in RecoveryStates
  /\ hasCheckoutId \in BOOLEAN
  /\ checkoutIdAgrees \in BOOLEAN
  /\ rowRetained \in BOOLEAN
  /\ pruningAgeReached \in BOOLEAN
  /\ riskyDeletionSeen \in BOOLEAN
  /\ checkHistorySafe \in BOOLEAN
  /\ owedStateSeen \in BOOLEAN
  /\ firstTerminalState \in TerminalStates \cup {"none"}
```

**Model rule: [`CheckoutIdentityConsistent`](../../verification/SumupRecovery.tla#L151)**

```tla
CheckoutIdentityConsistent ==
  /\ checkoutIdAgrees
  /\ hasCheckoutId = (recoveryState # NoCheckoutIdState)
```

**Model rule: [`RepresentativeFacts`](../../verification/SumupRecovery.tla#L72)**

```tla
RepresentativeFacts ==
  /\ \A fact \in RecoveryNodeFacts :
       /\ fact.state \in RecoveryStates
       /\ fact.moneyOwed \in {"no", "unknown", "yes"}
       /\ (fact.state \in PrunableStates) = fact.prunable
  /\ \A sample \in RecoveryRepresentatives :
       /\ SampleMatchesDeclaredState(sample.declaredState, sample.storedState,
                                      RecoveryStates)
       /\ sample.checkoutIdAgrees
       /\ sample.hasCheckoutId = (sample.storedState # NoCheckoutIdState)
```

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_STATE_WITHOUT_CHECKOUT_ID`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L36)**

```ts
export const RECOVERY_STATE_WITHOUT_CHECKOUT_ID: SumupRecoveryState = "staged";
```

Source fingerprint: `sha256:e5df40a6d96385ef`

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_NODES`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L75)**

```ts
export const RECOVERY_NODES: readonly RecoveryNode[] = [
  {
    id: "staged",
    owesMoney: "no",
    prunable: true,
    reps: [rep("no_checkout_id", rowIn("staged"))],
  },
  {
    id: "waiting",
    owesMoney: "unknown",
    prunable: false,
    reps: [rep("live_checkout", rowIn("waiting"))],
  },
  {
    id: "unpaid",
    owesMoney: "no",
    prunable: true,
    reps: [rep("never_paid", rowIn("unpaid"))],
  },
  {
    id: "finished",
    owesMoney: "no",
    prunable: true,
    reps: [rep("accounted_for", rowIn("finished"))],
// ...
```

Source fingerprint: `sha256:48f636a09450bf41`

### Step 2: Creation gives an id and a check gives an answer

Creation gives the row a provider checkout id and moves it to waiting. A check then supplies an answer. A check must leave the next state checkable or terminal with no money answer. The money labels state risk, not an amount.

| Value | This step |
| --- | --- |
| `checkout_created` | staged changes to waiting |
| `checkout id` | empty changes to sumup-checkout-id |
| `waiting money answer` | unknown |
| `read_paid_unsettled` | waiting changes to owed, money answer yes |
| `read_expired_or_failed` | waiting changes to unpaid, money answer no |
| `read_paid_settled` | waiting changes to finished, money answer no |

**Model rule: [`RecoveryStep`](../../verification/SumupRecovery.tla#L198)**

```tla
RecoveryStep ==
  /\ rowRetained
  /\ \E move \in RecoveryMoves :
       /\ move.sourceState = recoveryState
       /\ move.sourceHasCheckoutId = hasCheckoutId
       /\ recoveryState' = move.targetState
       /\ hasCheckoutId' = move.targetHasCheckoutId
       /\ checkoutIdAgrees' = move.targetCheckoutIdAgrees
       /\ checkHistorySafe' = ChecksStillPass(checkHistorySafe, CheckPreservesWork(move))
       /\ owedStateSeen' =
            (owedStateSeen \/ recoveryState = "owed" \/ move.targetState = "owed")
       /\ firstTerminalState' = FirstTerminalResult(move.targetState)
       /\ UNCHANGED <<rowRetained, pruningAgeReached, riskyDeletionSeen>>
```

**Model rule: [`MoneySemantics`](../../verification/SumupRecovery.tla#L64)**

```tla
MoneySemantics ==
  /\ MoneyStates("unknown") = {"waiting"}
  /\ MoneyStates("yes") = {"owed"}
  /\ MoneyStates("no") = RecoveryStates \ {"waiting", "owed"}
```

**Model rule: [`RiskStates`](../../verification/SumupRecovery.tla#L59)**

```tla
RiskStates == MoneyStates("unknown") \cup MoneyStates("yes")
```

**Model rule: [`TerminalStates`](../../verification/SumupRecovery.tla#L52)**

```tla
TerminalStates == {"finished", "unpaid"}
```

**Model rule: [`MoneyStates`](../../verification/SumupRecovery.tla#L55)**

```tla
MoneyStates(answer) ==
  {fact.state : fact \in {entry \in RecoveryNodeFacts : entry.moneyOwed = answer}}
```

**Model rule: [`CheckPreservesWork`](../../verification/SumupRecovery.tla#L93)**

```tla
CheckPreservesWork(move) ==
  IF move.eventId \in CheckEvents
  THEN move.targetState \in CheckableStates \/
         (move.targetState \in TerminalStates /\ move.targetState \in MoneyStates("no"))
  ELSE TRUE

VARIABLES
  \* This is the abstract recovery_state word on the local checkout row.
  \* Its five labels describe evidence and outstanding work, not an amount.
  \* @type: Str;
  recoveryState,
  \* This records whether sumupId is nonempty, not the concrete provider id.
  \* @type: Bool;
  hasCheckoutId,
  \* This records the production reader's agreement with state/id consistency.
  \* @type: Bool;
  checkoutIdAgrees,
  \* This models whether the checkout row still exists.
  \* @type: Bool;
  rowRetained,
  \* This abstract age flag says the row has reached the cleanup threshold.
  \* It replaces a timestamp. It is not a count of seconds or a payment answer.
  \* @type: Bool;
  pruningAgeReached,
  \* This model-only flag records deletion of a row with money risk.
  \* @type: Bool;
  riskyDeletionSeen,
  \* This model-only flag preserves every failed check-output law.
  \* @type: Bool;
  checkHistorySafe,
  \* This model-only history records whether paid-but-unaccounted evidence arose.
  \* @type: Bool;
  owedStateSeen,
  \* This model-only history keeps the first finished or unpaid result.
  \* none means neither terminal result has occurred.
  \* @type: Str;
  firstTerminalState
```

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#recoveryRowAfter`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L169)**

```ts
export const recoveryRowAfter = (
  row: SumupRecoveryRow,
  event: RecoveryEventId,
  checkoutId: string,
): SumupRecoveryRow => { ... }
```

Source fingerprint: `sha256:0712d6d835682115`

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_MOVES`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L236)**

```ts
export const RECOVERY_MOVES: MachineMoves<RecoveryNodeId, RecoveryEventId> = {
  finished: {},
  owed: {
    read_paid_booked: "finished",
    read_paid_contradiction: "owed",
    read_paid_settled: "finished",
    read_paid_unreadable: "owed",
    read_paid_unsettled: "owed",
    read_unavailable: "owed",
  },
  staged: { checkout_created: "waiting" },
  unpaid: {},
  waiting: {
    read_expired_or_failed: "unpaid",
    read_paid_booked: "finished",
    read_paid_contradiction: "owed",
    read_paid_settled: "finished",
    read_paid_unreadable: "waiting",
    read_paid_unsettled: "owed",
    read_pending: "waiting",
    read_unavailable: "waiting",
  },
};
```

Source fingerprint: `sha256:849bfdd6463a19a3`

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#recoveryMoveTo`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L154)**

```ts
export const recoveryMoveTo = (
  from: RecoveryNodeId,
  event: RecoveryEventId,
): RecoveryNodeId => ...
```

Source fingerprint: `sha256:754bbca64e9b9508`

### Step 3: A risky row stays in the queue

Waiting and owed are the risk states. Each one has at least one supplied check edge with its id shape. The safety rule requires the row to stay retained and the check to stay enabled. The model proves that an option exists, not that a worker takes it.

| Value | This step |
| --- | --- |
| `checkable states` | waiting and owed |
| `waiting with an id` | Retained and has check moves. |
| `owed with an id` | Retained and has check moves. |
| `finished with an id` | Terminal. No check move remains. |

**Model rule: [`HasEnabledCheck`](../../verification/SumupRecovery.tla#L85)**

```tla
HasEnabledCheck(state, hasId) ==
  \E move \in RecoveryMoves :
    /\ move.sourceState = state
    /\ move.sourceHasCheckoutId = hasId
    /\ move.eventId \in CheckEvents
```

**Model rule: [`RiskyMoneyKeepsQueuedWork`](../../verification/SumupRecovery.tla#L156)**

```tla
RiskyMoneyKeepsQueuedWork ==
  /\ (recoveryState \in RiskStates => rowRetained)
  /\ (rowRetained /\ recoveryState \in RiskStates =>
       /\ recoveryState \in CheckableStates
       /\ HasEnabledCheck(recoveryState, hasCheckoutId))
```

**Model rule: [`RiskStates`](../../verification/SumupRecovery.tla#L59)**

```tla
RiskStates == MoneyStates("unknown") \cup MoneyStates("yes")
```

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#recoveryMoveTo`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L154)**

```ts
export const recoveryMoveTo = (
  from: RecoveryNodeId,
  event: RecoveryEventId,
): RecoveryNodeId => ...
```

Source fingerprint: `sha256:754bbca64e9b9508`

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_CHECKABLE_NODES`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L275)**

```ts
export const RECOVERY_CHECKABLE_NODES: readonly RecoveryNodeId[] =
  RECOVERY_DERIVED.movedBy((event) => event.kind === "check");
```

Source fingerprint: `sha256:438851627612bba7`

### Step 4: Money evidence sticks

Paid evidence permits only owed or finished. The first terminal state survives later contradictions. The producer supplies refused cells as no move, so the table cannot return a row to waiting. This rule also keeps the memory of paid but unaccounted money.

| Value | This step |
| --- | --- |
| `owed with read_paid_booked` | finished. owedStateSeen stays TRUE. |
| `first terminal state` | finished stays finished after a later move. |
| `owed with read_pending` | No move. The table has no cell. |
| `finished or unpaid` | No move. The result is closed. |

**Model rule: [`PaidAndTerminalEvidencePreserved`](../../verification/SumupRecovery.tla#L164)**

```tla
PaidAndTerminalEvidencePreserved ==
  /\ (recoveryState = "owed" => owedStateSeen)
  /\ (owedStateSeen => recoveryState \in {"owed", "finished"})
  /\ (recoveryState \in TerminalStates) = (firstTerminalState # "none")
  /\ (firstTerminalState # "none" => recoveryState = firstTerminalState)
```

**Model rule: [`FirstTerminalResult`](../../verification/SumupRecovery.tla#L132)**

```tla
FirstTerminalResult(targetState) ==
  IF firstTerminalState = "none" /\ targetState \in TerminalStates
  THEN targetState
  ELSE firstTerminalState
```

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_MOVES`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L236)**

```ts
export const RECOVERY_MOVES: MachineMoves<RecoveryNodeId, RecoveryEventId> = {
  finished: {},
  owed: {
    read_paid_booked: "finished",
    read_paid_contradiction: "owed",
    read_paid_settled: "finished",
    read_paid_unreadable: "owed",
    read_paid_unsettled: "owed",
    read_unavailable: "owed",
  },
  staged: { checkout_created: "waiting" },
  unpaid: {},
  waiting: {
    read_expired_or_failed: "unpaid",
    read_paid_booked: "finished",
    read_paid_contradiction: "owed",
    read_paid_settled: "finished",
    read_paid_unreadable: "waiting",
    read_paid_unsettled: "owed",
    read_pending: "waiting",
    read_unavailable: "waiting",
  },
};
```

Source fingerprint: `sha256:849bfdd6463a19a3`

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#recoveryMoveTo`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L154)**

```ts
export const recoveryMoveTo = (
  from: RecoveryNodeId,
  event: RecoveryEventId,
): RecoveryNodeId => ...
```

Source fingerprint: `sha256:754bbca64e9b9508`

### Step 5: Age and cleanup

Age only marks the cleanup threshold. Prune deletes a retained row only in a declared prunable state. Staged, unpaid, and finished are prunable. Waiting and owed are not. A bad label becomes visible because Prune does not use money safety as a precondition.

| Value | This step |
| --- | --- |
| `prunable states` | staged, unpaid, and finished |
| `staged and old` | rowRetained FALSE. No money risk. |
| `waiting or owed and old` | No delete. The state is not prunable. |

**Model rule: [`Age`](../../verification/SumupRecovery.tla#L214)**

```tla
Age ==
  /\ pruningAgeReached' = TRUE
  /\ UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, rowRetained,
                 riskyDeletionSeen, checkHistorySafe, owedStateSeen, firstTerminalState>>
```

**Model rule: [`Prune`](../../verification/SumupRecovery.tla#L222)**

```tla
Prune ==
  /\ rowRetained
  /\ pruningAgeReached
  /\ recoveryState \in PrunableStates
  /\ rowRetained' = FALSE
  /\ riskyDeletionSeen' = (riskyDeletionSeen \/ recoveryState \in RiskStates)
  /\ UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, pruningAgeReached,
                 checkHistorySafe, owedStateSeen, firstTerminalState>>
```

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_PRUNABLE_NODES`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L280)**

```ts
export const RECOVERY_PRUNABLE_NODES: readonly RecoveryNodeId[] = nodeIdsWhere(
  RECOVERY_NODES,
  (node) => node.prunable,
);
```

Source fingerprint: `sha256:057670087a906833`

**Production code: [`src/shared/payment/sumup-recovery-machine-spec.ts#RECOVERY_NODES`](../../src/shared/payment/sumup-recovery-machine-spec.ts#L75)**

```ts
export const RECOVERY_NODES: readonly RecoveryNode[] = [
  {
    id: "staged",
    owesMoney: "no",
    prunable: true,
    reps: [rep("no_checkout_id", rowIn("staged"))],
  },
  {
    id: "waiting",
    owesMoney: "unknown",
    prunable: false,
    reps: [rep("live_checkout", rowIn("waiting"))],
  },
  {
    id: "unpaid",
    owesMoney: "no",
    prunable: true,
    reps: [rep("never_paid", rowIn("unpaid"))],
  },
  {
    id: "finished",
    owesMoney: "no",
    prunable: true,
    reps: [rep("accounted_for", rowIn("finished"))],
// ...
```

Source fingerprint: `sha256:48f636a09450bf41`

### Step 6: Safety joins the rules

Safety joins the money meaning, representative facts, identity agreement, work retention, and evidence histories. A pause is permitted. The model checks every supplied move from any safe state, so it covers any finite order of these events.

| Value | This step |
| --- | --- |
| `safe run` | checkoutIdAgrees TRUE and riskyDeletionSeen FALSE. |
| `lost identity` | checkoutIdAgrees FALSE. Safety fails. |
| `deleted risky row` | riskyDeletionSeen TRUE. Safety fails. |

**Model rule: [`Safety`](../../verification/SumupRecovery.tla#L172)**

```tla
Safety ==
  /\ TypeOK
  /\ MoneySemantics
  /\ RepresentativeFacts
  /\ CheckoutIdentityConsistent
  /\ ~riskyDeletionSeen
  /\ checkHistorySafe
  /\ RiskyMoneyKeepsQueuedWork
  /\ PaidAndTerminalEvidencePreserved
```

**Model rule: [`Next`](../../verification/SumupRecovery.tla#L233)**

```tla
Next == RecoveryStep \/ Age \/ Prune \/
        UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, rowRetained,
                    pruningAgeReached, riskyDeletionSeen, checkHistorySafe,
                    owedStateSeen, firstTerminalState>>
```

**Production code: [`scripts/verify-models/sumup.ts#sumupModelData`](../../scripts/verify-models/sumup.ts#L112)**

```ts
export const sumupModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:96bc8d373eabfc34`

**Production code: [`scripts/verify-models/sumup.ts#corruptSumupData`](../../scripts/verify-models/sumup.ts#L115)**

```ts
export const corruptSumupData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:031eed885f088b9f`

## The safety claim

Every row with unknown or owed money stays retained and keeps an enabled check. A checkout id is present in every state except staged. Paid evidence ends in owed or finished. A terminal result never changes. No row with money risk is deleted.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The model uses five states and one representative id or empty id for each state.
- Provider event truth and the money labels are assumptions.
- Refused table cells supply no move. The model does not check each refusal result.
- SQL races, real task clocks, provider truth, and eventual work need separate tests.
- No amount, currency, or balance appears in this model.

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
