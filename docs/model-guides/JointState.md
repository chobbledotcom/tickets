# Deleting a temporary payment row only after its refund work is done

[Read the model](../../verification/JointState.tla).

This page follows one temporary payment row and one durable refund request. A row claim or an existing request needs the payment reference first. Row deletion happens only after the provider cash returns and the local records are complete.

## The bad outcome it rules out

A callback deletes the temporary row while local refund records are still due. Or a row claim or a refund request appears before the payment reference.

## The cast

| Word | Meaning |
| --- | --- |
| **temporary row** | One stored payment row that keeps local work for one checkout attempt. |
| **claim** | One worker's control of a row's work. A claim is not evidence of a refund. |
| **refund authority** | The durable record that controls one refund request. It keeps the request identity and the evidence for the next action. |
| **reference** | The indexed provider payment reference. The model records only its presence. |
| **prunable** | A lifecycle label that permits row deletion because the refund is complete and the local records are done. |
| **fact** | One prepared abstract record from the producer. The fact is not a live customer row. |

## The walkthrough

### Step 1: Start with no reference and no authority

The model starts at the row's free label with no durable refund request and no reference. The producer runs the production row and refund machines to supply the labels and edges. The model holds one implicit request and no money amount.

| Value | This step |
| --- | --- |
| `rowState` | free |
| `authorityState` | absent |
| `referencePresent` | FALSE |
| `rowDeleted` | FALSE |
| `send and replay flags` | all TRUE |

**Model rule: [`Init`](../../verification/JointState.tla#L135)**

```tla
Init ==
  /\ rowState = RowStart
  /\ authorityState = "absent"
  /\ referencePresent = FALSE
  /\ allSendsArmed = TRUE
  /\ allRequestsPreserved = TRUE
  /\ allReplaysSafe = TRUE
  /\ onlyMoneySends = TRUE
  /\ rowDeleted = FALSE
```

**Model rule: [`TypeOK`](../../verification/JointState.tla#L85)**

```tla
TypeOK ==
  /\ rowState \in RowStates
  /\ authorityState \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ allSendsArmed \in BOOLEAN
  /\ allRequestsPreserved \in BOOLEAN
  /\ allReplaysSafe \in BOOLEAN
  /\ onlyMoneySends \in BOOLEAN
  /\ rowDeleted \in BOOLEAN
```

**Production code: [`scripts/verify-models/model.ts#paymentModel`](../../scripts/verify-models/model.ts#L168)**

```ts
export const paymentModel = async (): Promise<PaymentModel> => { ... }
```

Source fingerprint: `sha256:5beaa97fad82a305`

### Step 2: The reference comes before the request or the claim

The model records reference presence as one Boolean. The action has no absence guard, so a repeat attach changes nothing. Production carries the payment identity in the refund request generation, and readyRefund builds the ready state from that generation. The model records presence only and assumes that the index admits one reference for each payment.

| Value | This step |
| --- | --- |
| `referencePresent` | FALSE, then TRUE |
| `request index` | spec-refund-request |
| `row target` | claim |
| `claim result` | Refused while the reference is FALSE. |

**Model rule: [`AttachReference`](../../verification/JointState.tla#L148)**

```tla
AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<rowState, authorityState, allSendsArmed, allRequestsPreserved,
                 allReplaysSafe, onlyMoneySends, rowDeleted>>
```

**Model rule: [`ClaimRequiresReference`](../../verification/JointState.tla#L97)**

```tla
ClaimRequiresReference == rowState \in ClaimedRows => referencePresent
```

**Production code: [`src/shared/payment/refund-authority.ts#readyRefund`](../../src/shared/payment/refund-authority.ts#L52)**

```ts
export const readyRefund = (facts: ReadyRefundFacts): ReadyRefundState => { ... }
```

Source fingerprint: `sha256:999927bd94bfec28`

### Step 3: A row move refuses a claim without the reference

RowStep chooses one edge from the generated row machine. It refuses entry to any claimed label while the reference is absent. The producer takes the claimed labels from the production row nodes. Callback work needs no held claim, and the model does not require a claim.

| Value | This step |
| --- | --- |
| `row move` | free to claim |
| `referencePresent` | TRUE |
| `result` | Accepted. rowState becomes claim. |
| `callback work` | A row move to review needs no claim. |

**Model rule: [`RowStep`](../../verification/JointState.tla#L155)**

```tla
RowStep ==
  \E move \in RowMoves :
    /\ move.sourceState = rowState
    /\ (move.targetState \in ClaimedRows => referencePresent)
    /\ rowState' = move.targetState
    /\ UNCHANGED <<authorityState, referencePresent, allSendsArmed,
                   allRequestsPreserved, allReplaysSafe,
                   onlyMoneySends, rowDeleted>>
```

**Production code: [`scripts/verify-models/model.ts#paymentModel`](../../scripts/verify-models/model.ts#L168)**

```ts
export const paymentModel = async (): Promise<PaymentModel> => { ... }
```

Source fingerprint: `sha256:5beaa97fad82a305`

### Step 4: The authority moves only after the reference

AuthStep chooses one generated authority edge and needs the reference. A replay needs a keyed request, the same request identity and a send time inside the finite window. A non-money event cannot replay or enter send_armed. armRefundSend accepts only a ready state. rearmKeyedRefund refuses a keyless request, a different request index and a time past the window.

| Value | This step |
| --- | --- |
| `ready to send_armed` | arm at 1750000000000. The request identity stays the same. |
| `keyed replay` | armedAt 1750000000000 equals replayUntil. inWindow is TRUE. |
| `expired keyed replay` | replayUntil 1749999999999. A replay at 1750000000000 is outside the window. |
| `keyless replay` | The request is keyless. A rearm has no permission. |
| `observe` | send_armed to observing. The event moves no money. |

**Model rule: [`AuthStep`](../../verification/JointState.tla#L170)**

```tla
AuthStep ==
  \E move \in AuthMoves :
    /\ move.sourceState = authorityState
    /\ referencePresent
    /\ authorityState' = move.targetState
    /\ allSendsArmed' = ChecksStillPass(allSendsArmed, move.armed)
    /\ allRequestsPreserved' = ChecksStillPass(allRequestsPreserved, move.requestKept)
    /\ allReplaysSafe' = ChecksStillPass(allReplaysSafe, ReplaySafe(move))
    /\ onlyMoneySends' = ChecksStillPass(onlyMoneySends, OnlyMoneySends(move))
    /\ UNCHANGED <<rowState, referencePresent, rowDeleted>>
```

**Model rule: [`AuthorityRequiresReference`](../../verification/JointState.tla#L98)**

```tla
AuthorityRequiresReference == authorityState # "absent" => referencePresent
```

**Model rule: [`ReplaySafe`](../../verification/JointState.tla#L104)**

```tla
ReplaySafe(move) ==
  ~move.replay \/ (move.keyed /\ move.requestKept /\ move.inWindow)
```

**Model rule: [`OnlyMoneySends`](../../verification/JointState.tla#L110)**

```tla
OnlyMoneySends(move) ==
  ~move.movesMoney => (~move.replay /\ move.targetState # "send_armed")
```

**Production code: [`src/shared/payment/refund-authority.ts#armRefundSend`](../../src/shared/payment/refund-authority.ts#L70)**

```ts
export const armRefundSend = (
  state: RefundAuthorityState,
  armedAt: number,
  nextActionAt: number,
): SendArmedRefundState => { ... }
```

Source fingerprint: `sha256:290a3c09e4ddb39c`

**Production code: [`src/shared/payment/refund-authority.ts#rearmKeyedRefund`](../../src/shared/payment/refund-authority.ts#L105)**

```ts
export const rearmKeyedRefund = (
  state: RefundAuthorityState,
  requestIndex: string,
  armedAt: number,
  nextActionAt: number,
): SendArmedRefundState => { ... }
```

Source fingerprint: `sha256:8c0f992055ab02b8`

### Step 5: Deletion keeps unfinished local work

Delete runs once and only at a prunable label. Prunable includes absent authority and completed states with local records complete. markRefundCompleted sets the local record to due. markRefundLocalRecorded completes it. A returned refund with local work due cannot delete the row.

| Value | This step |
| --- | --- |
| `returned` | Cash returned at 1750000000000. Local records are due. Prunable is FALSE. |
| `recorded` | Local records complete at 1750000000000. Prunable is TRUE. |
| `rowDeleted` | FALSE, then TRUE for the recorded request. |

**Model rule: [`Delete`](../../verification/JointState.tla#L184)**

```tla
Delete ==
  /\ ~rowDeleted
  /\ Prunable(authorityState)
  /\ rowDeleted' = TRUE
  /\ UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
                 allRequestsPreserved, allReplaysSafe,
                 onlyMoneySends>>
```

**Model rule: [`Prunable`](../../verification/JointState.tla#L116)**

```tla
Prunable(state) == state \in PrunableStates
```

**Production code: [`src/shared/payment/refund-authority.ts#markRefundCompleted`](../../src/shared/payment/refund-authority.ts#L158)**

```ts
export const markRefundCompleted = (
  state: RefundAuthorityState,
  completedAt: number,
  proof: "owner" | "provider",
): CompletedRefundState => { ... }
```

Source fingerprint: `sha256:14f4330328c3319c`

**Production code: [`src/shared/payment/refund-authority.ts#markRefundLocalRecorded`](../../src/shared/payment/refund-authority.ts#L178)**

```ts
export const markRefundLocalRecorded = (
  state: RefundAuthorityState,
  recordedAt: number,
): CompletedRefundState => { ... }
```

Source fingerprint: `sha256:3b5fe9245ccc0fae`

### Step 6: The joined safety claim

Safety joins both reference rules, the four verdict flags and the deletion boundary. Next permits reference, row and authority work before deletion, then only a delay. The counterexample changes the request identity of one money edge. The checker must reject that data, or the clean verdicts prove nothing.

| Value | This step |
| --- | --- |
| `allRequestsPreserved` | TRUE on the clean data. |
| `corrupted edge` | requestKept is FALSE on one money edge. |
| `checker` | Reports a counterexample. |

**Model rule: [`Safety`](../../verification/JointState.tla#L120)**

```tla
Safety ==
  /\ TypeOK
  /\ allSendsArmed
  /\ allRequestsPreserved
  /\ allReplaysSafe
  /\ onlyMoneySends
  /\ ClaimRequiresReference
  /\ AuthorityRequiresReference
  /\ (rowDeleted => Prunable(authorityState))
```

**Model rule: [`Next`](../../verification/JointState.tla#L196)**

```tla
Next ==
  (~rowDeleted /\ (AttachReference \/ RowStep \/ AuthStep)) \/ Delete \/
  UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
              allRequestsPreserved, allReplaysSafe, onlyMoneySends,
              rowDeleted>>
```

**Production code: [`scripts/verify-models/counterexample.ts#corruptOneEdge`](../../scripts/verify-models/counterexample.ts#L10)**

```ts
export const corruptOneEdge = (model: PaymentModel): PaymentModel => { ... }
```

Source fingerprint: `sha256:b07a1dab61f5c883`

## The safety claim

Every accepted step keeps both reference rules, the four send and replay verdicts and the deletion boundary. A deleted row has a prunable request.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The model has one implicit provider-qualified request. It has no amount, actual key, generation number, timestamp or SQL transaction.
- It assumes representative coverage and indexed-reference admission. It does not write a unique index.
- It proves safety of the supplied abstract edges. It does not prove every concrete state, provider truth, a concurrent write or refund completion.
- The row labels combine live work. They do not report provider cash by themselves.

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
