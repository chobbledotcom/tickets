# Keeping a payment review case until the right evidence retires it

[Read the model](../../verification/PaymentReview.tla).

This page follows one review case on a payment row. A new case opens unseen with its stated reason. An acknowledgement keeps the same case id and reason. Only evidence for that reason retires the case.

## The bad outcome it rules out

An acknowledgement replaces the case with a new id, or partial-return evidence retires a shared-reference case.

## The cast

| Word | Meaning |
| --- | --- |
| **payment row** | The site's record of money for a reservation. Its optional review slot holds one case. |
| **review case** | A recorded disagreement for the owner. It is not a refund. |
| **reason** | The stated cause. The model uses partially_returned_obligation and shared_reference. |
| **slot state** | No case, an unseen case, or a case that the owner acknowledged. |
| **case id** | The value that distinguishes one disagreement from a later one. |
| **evidence** | The fact that retires a reason. It is supplied to the model, not proved. |

## The walkthrough

### Step 1: Start with no case

The review slot starts empty. The model has five abstract names from three node shapes and two reasons. No database row is created for this start state.

| Value | This step |
| --- | --- |
| `reviewState` | none |
| `allAttemptsSafe` | TRUE |
| `abstract states` | none, open and seen for two reasons |

**Model rule: [`Init`](../../verification/PaymentReview.tla#L135)**

```tla
Init ==
  /\ reviewState = "none"
  /\ allAttemptsSafe = TRUE
```

**Model rule: [`TypeOK`](../../verification/PaymentReview.tla#L63)**

```tla
TypeOK ==
  /\ reviewState \in ReviewStates
  /\ allAttemptsSafe \in BOOLEAN
```

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_NODES`](../../src/shared/payment/review-machine-spec.ts#L54)**

```ts
export const REVIEW_NODES: readonly ReviewNode[] = [
  { id: "none", reps: [rep("empty", undefined)] },
  { id: "open", reps: REVIEW_REASONS.map((kind) => rep(kind, openCase(kind))) },
  {
    id: "seen",
    reps: REVIEW_REASONS.map((kind) =>
      rep(kind, acknowledgePaymentReview(openCase(kind), SEEN_AT)),
    ),
  },
];
```

Source fingerprint: `sha256:98cb76eb6efc89e7`

**Production code: [`src/shared/payment/review-machine-spec.ts#reviewNodeOf`](../../src/shared/payment/review-machine-spec.ts#L40)**

```ts
export const reviewNodeOf = (slot: ReviewSlot): ReviewNodeId => ...
```

Source fingerprint: `sha256:32edc7af7eda7140`

### Step 2: Open a case

A new case opens only on an empty slot. It starts unseen and takes the event reason. SafeAttempt also requires that the event declares no money move. The model selects an attempt that starts at the current state.

| Value | This step |
| --- | --- |
| `event` | open_shared_reference |
| `reviewState` | none changes to open(shared_reference) |
| `seen` | FALSE |
| `event movesMoney` | FALSE |

**Model rule: [`ReviewStep`](../../verification/PaymentReview.tla#L141)**

```tla
ReviewStep ==
  \E attempt \in ReviewAttempts :
    /\ attempt.sourceState = reviewState
    /\ AttemptedEdge(reviewState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Model rule: [`AcceptedReviewAction`](../../verification/PaymentReview.tla#L99)**

```tla
AcceptedReviewAction(before, after, event) ==
  IF event.action = "open"
  THEN OpensUnseenCase(before, after, event)
  ELSE IF event.action = "acknowledge"
       THEN AcknowledgesUnseenCase(before, after)
       ELSE IF event.action = "retire"
            THEN RetiresMatchingCase(before, after, event)
            ELSE FALSE
```

**Model rule: [`OpensUnseenCase`](../../verification/PaymentReview.tla#L76)**

```tla
OpensUnseenCase(before, after, event) ==
  /\ ~before.held
  /\ after.held
  /\ ~after.seen
  /\ after.reason = event.reason
```

**Model rule: [`SafeAttempt`](../../verification/PaymentReview.tla#L120)**

```tla
SafeAttempt(attempt) ==
  \E before \in ReviewNodes, after \in ReviewNodes, event \in ReviewEvents :
    /\ before.state = attempt.sourceState
    /\ after.state = attempt.targetState
    /\ event.eventId = attempt.eventId
    /\ ~event.movesMoney
    /\ IF attempt.accepted
       THEN /\ HeldCaseKeepsIdentity(before, after, attempt)
            /\ AcceptedReviewAction(before, after, event)
       ELSE RefusalKeepsCase(attempt)
```

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_EVENTS`](../../src/shared/payment/review-machine-spec.ts#L96)**

```ts
export const REVIEW_EVENTS: readonly ReviewMachineEvent[] = [
  {
    actor: "system",
    id: "open_partially_returned_obligation",
    labelKey: "schema.review.reason.partially_returned_obligation",
    movesMoney: false,
    run: opensFor({ kind: "partially_returned_obligation" }),
  },
  {
    actor: "system",
    id: "open_shared_reference",
    labelKey: "schema.review.reason.shared_reference",
    movesMoney: false,
    run: opensFor({ kind: "shared_reference" }),
  },
  {
    actor: "owner",
    id: "acknowledge",
    labelKey: "schema.review.edge.acknowledge",
    movesMoney: false,
    run: (slot: ReviewSlot): ReviewSlot => {
      if (slot === undefined || slot.acknowledgedAt !== undefined) {
        throw new Error("Only an unseen case can be acknowledged");
      }
// ...
```

Source fingerprint: `sha256:b4e8ed36de67eb71`

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_REASONS`](../../src/shared/payment/review-machine-spec.ts#L31)**

```ts
export const REVIEW_REASONS = [
  "partially_returned_obligation",
  "shared_reference",
] as const satisfies readonly PaymentReviewReason["kind"][];
```

Source fingerprint: `sha256:35028a06b446e0b4`

### Step 3: Acknowledge keeps the case

The owner acknowledgement changes an unseen case to a seen case. It keeps the same case id and reason and only adds the acknowledged time. HeldCaseKeepsIdentity demands that exact identity. A replacement case id fails the rule.

| Value | This step |
| --- | --- |
| `reviewState` | open(shared_reference) changes to seen(shared_reference) |
| `case id` | One example id keeps the same value before and after. |
| `acknowledgedAt` | 2026-08-16T00:00:00.000Z |
| `reason` | shared_reference, unchanged |

**Model rule: [`AcknowledgesUnseenCase`](../../verification/PaymentReview.tla#L84)**

```tla
AcknowledgesUnseenCase(before, after) ==
  /\ before.held
  /\ ~before.seen
  /\ after.held
  /\ after.seen
```

**Model rule: [`HeldCaseKeepsIdentity`](../../verification/PaymentReview.tla#L69)**

```tla
HeldCaseKeepsIdentity(before, after, attempt) ==
  IF before.held /\ after.held
  THEN attempt.sameCaseId /\ attempt.sameReason
  ELSE TRUE
```

**Model rule: [`AcceptedReviewAction`](../../verification/PaymentReview.tla#L99)**

```tla
AcceptedReviewAction(before, after, event) ==
  IF event.action = "open"
  THEN OpensUnseenCase(before, after, event)
  ELSE IF event.action = "acknowledge"
       THEN AcknowledgesUnseenCase(before, after)
       ELSE IF event.action = "retire"
            THEN RetiresMatchingCase(before, after, event)
            ELSE FALSE
```

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_NODES`](../../src/shared/payment/review-machine-spec.ts#L54)**

```ts
export const REVIEW_NODES: readonly ReviewNode[] = [
  { id: "none", reps: [rep("empty", undefined)] },
  { id: "open", reps: REVIEW_REASONS.map((kind) => rep(kind, openCase(kind))) },
  {
    id: "seen",
    reps: REVIEW_REASONS.map((kind) =>
      rep(kind, acknowledgePaymentReview(openCase(kind), SEEN_AT)),
    ),
  },
];
```

Source fingerprint: `sha256:98cb76eb6efc89e7`

**Production code: [`src/shared/payment/review-machine-spec.ts#reviewNodeOf`](../../src/shared/payment/review-machine-spec.ts#L40)**

```ts
export const reviewNodeOf = (slot: ReviewSlot): ReviewNodeId => ...
```

Source fingerprint: `sha256:32edc7af7eda7140`

### Step 4: Wrong evidence is refused

Retirement requires the stored reason. The producer records a refused attempt with the same state, case id, and reason. A refused attempt does not remove the case. The refusal law also requires the same state before and after.

| Value | This step |
| --- | --- |
| `stored state` | seen(partially_returned_obligation) |
| `event` | retire_shared_reference |
| `accepted` | FALSE |
| `reviewState` | unchanged |
| `case id and reason` | unchanged |

**Model rule: [`RetiresMatchingCase`](../../verification/PaymentReview.tla#L92)**

```tla
RetiresMatchingCase(before, after, event) ==
  /\ before.held
  /\ before.reason = event.reason
  /\ ~after.held
```

**Model rule: [`RefusalKeepsCase`](../../verification/PaymentReview.tla#L111)**

```tla
RefusalKeepsCase(attempt) ==
  /\ RefusedActionKeepsState(attempt)
  /\ attempt.sameCaseId
  /\ attempt.sameReason
```

**Model rule: [`AcceptedReviewAction`](../../verification/PaymentReview.tla#L99)**

```tla
AcceptedReviewAction(before, after, event) ==
  IF event.action = "open"
  THEN OpensUnseenCase(before, after, event)
  ELSE IF event.action = "acknowledge"
       THEN AcknowledgesUnseenCase(before, after)
       ELSE IF event.action = "retire"
            THEN RetiresMatchingCase(before, after, event)
            ELSE FALSE
```

**Model rule: [`HeldCaseKeepsIdentity`](../../verification/PaymentReview.tla#L69)**

```tla
HeldCaseKeepsIdentity(before, after, attempt) ==
  IF before.held /\ after.held
  THEN attempt.sameCaseId /\ attempt.sameReason
  ELSE TRUE
```

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_EVENTS`](../../src/shared/payment/review-machine-spec.ts#L96)**

```ts
export const REVIEW_EVENTS: readonly ReviewMachineEvent[] = [
  {
    actor: "system",
    id: "open_partially_returned_obligation",
    labelKey: "schema.review.reason.partially_returned_obligation",
    movesMoney: false,
    run: opensFor({ kind: "partially_returned_obligation" }),
  },
  {
    actor: "system",
    id: "open_shared_reference",
    labelKey: "schema.review.reason.shared_reference",
    movesMoney: false,
    run: opensFor({ kind: "shared_reference" }),
  },
  {
    actor: "owner",
    id: "acknowledge",
    labelKey: "schema.review.edge.acknowledge",
    movesMoney: false,
    run: (slot: ReviewSlot): ReviewSlot => {
      if (slot === undefined || slot.acknowledgedAt !== undefined) {
        throw new Error("Only an unseen case can be acknowledged");
      }
// ...
```

Source fingerprint: `sha256:b4e8ed36de67eb71`

### Step 5: Matching evidence retires the case

Matching evidence removes the case. The declared retirement for shared_reference is a unique reference. The declared retirement for partially_returned_obligation is all money returned and recorded. The model receives these facts as events.

| Value | This step |
| --- | --- |
| `stored state` | seen(shared_reference) |
| `event` | retire_shared_reference |
| `evidence` | unique_reference |
| `reviewState` | seen(shared_reference) changes to none |

**Model rule: [`RetiresMatchingCase`](../../verification/PaymentReview.tla#L92)**

```tla
RetiresMatchingCase(before, after, event) ==
  /\ before.held
  /\ before.reason = event.reason
  /\ ~after.held
```

**Model rule: [`AcceptedReviewAction`](../../verification/PaymentReview.tla#L99)**

```tla
AcceptedReviewAction(before, after, event) ==
  IF event.action = "open"
  THEN OpensUnseenCase(before, after, event)
  ELSE IF event.action = "acknowledge"
       THEN AcknowledgesUnseenCase(before, after)
       ELSE IF event.action = "retire"
            THEN RetiresMatchingCase(before, after, event)
            ELSE FALSE
```

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_REASONS`](../../src/shared/payment/review-machine-spec.ts#L31)**

```ts
export const REVIEW_REASONS = [
  "partially_returned_obligation",
  "shared_reference",
] as const satisfies readonly PaymentReviewReason["kind"][];
```

Source fingerprint: `sha256:35028a06b446e0b4`

**Production code: [`src/shared/payment/review-machine-spec.ts#REVIEW_EVENTS`](../../src/shared/payment/review-machine-spec.ts#L96)**

```ts
export const REVIEW_EVENTS: readonly ReviewMachineEvent[] = [
  {
    actor: "system",
    id: "open_partially_returned_obligation",
    labelKey: "schema.review.reason.partially_returned_obligation",
    movesMoney: false,
    run: opensFor({ kind: "partially_returned_obligation" }),
  },
  {
    actor: "system",
    id: "open_shared_reference",
    labelKey: "schema.review.reason.shared_reference",
    movesMoney: false,
    run: opensFor({ kind: "shared_reference" }),
  },
  {
    actor: "owner",
    id: "acknowledge",
    labelKey: "schema.review.edge.acknowledge",
    movesMoney: false,
    run: (slot: ReviewSlot): ReviewSlot => {
      if (slot === undefined || slot.acknowledgedAt !== undefined) {
        throw new Error("Only an unseen case can be acknowledged");
      }
// ...
```

Source fingerprint: `sha256:b4e8ed36de67eb71`

### Step 6: Safety joins the review laws

Safety requires valid state names, a clean attempt history, and every accepted or refused review law. ReviewStep applies any prepared attempt and keeps a false verdict. Next permits a pause, so no owner or system action is forced.

| Value | This step |
| --- | --- |
| `safe run` | All attempt checks pass. allAttemptsSafe stays TRUE. |
| `changed case id on acknowledge` | sameCaseId is FALSE. Safety fails. |
| `pause` | Both values stay equal. |

**Model rule: [`Safety`](../../verification/PaymentReview.tla#L132)**

```tla
Safety == TypeOK /\ allAttemptsSafe
```

**Model rule: [`Next`](../../verification/PaymentReview.tla#L148)**

```tla
Next == ReviewStep \/ UNCHANGED <<reviewState, allAttemptsSafe>>
```

**Model rule: [`ReviewStep`](../../verification/PaymentReview.tla#L141)**

```tla
ReviewStep ==
  \E attempt \in ReviewAttempts :
    /\ attempt.sourceState = reviewState
    /\ AttemptedEdge(reviewState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Production code: [`scripts/verify-models/review.ts#reviewModelData`](../../scripts/verify-models/review.ts#L124)**

```ts
export const reviewModelData = modelDataFor(bindFirst(reviewDataFor)(false));
```

Source fingerprint: `sha256:a7cd24193cf952a3`

**Production code: [`scripts/verify-models/review.ts#corruptReviewData`](../../scripts/verify-models/review.ts#L127)**

```ts
export const corruptReviewData = modelDataFor(bindFirst(reviewDataFor)(true));
```

Source fingerprint: `sha256:99c946377d42dd5f`

## The safety claim

An accepted acknowledgement keeps the case id and reason. A new case opens only on an empty slot. Retirement needs the matching reason. A refusal keeps the same case id and reason. No review event moves money.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The model covers two reasons and one representative for each open and seen state.
- The state name omits the concrete case id. The producer compares that id before abstraction.
- Retirement evidence arrives as events. The model does not prove the underlying money facts.
- No amount or currency appears. Provider transfers are outside this model.
- SQL races, eventual review, and the refund path need separate tests.

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
