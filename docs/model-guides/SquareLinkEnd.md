# Keeping a Square cancel handle while a payment link can still take payment

[Read the model](../../verification/SquareLinkEnd.tla).

This page follows one unpaid Square checkout from a missing handle to a deleted handle. A success reply without a cancelled order id proves nothing. The site keeps the handle until conclusive evidence or the retention cutoff.

## The bad outcome it rules out

A 200 reply with no cancelled order id deletes the only handle, and the Square link stays payable.

## The cast

| Word | Meaning |
| --- | --- |
| **checkout** | One attempt to pay for a reservation. Its payment link opens at Square. |
| **handle** | The local row with the data needed to end the link. The stored labels are pending and ending. |
| **claim** | A background task and the temporary right that it holds on one row. |
| **reply** | Square's answer to one delete request. |
| **webhook** | A separate provider message about a payment. It can arrive late. |
| **age** | A named time interval in the model, not a real timestamp. |

## The walkthrough

### Step 1: Start with no handle

Before checkout creation there is no stored row. The age starts at zero, which is below native expiry. The history flags start TRUE. TypeOK checks these shapes and ties row existence to checkoutCreated.

| Value | This step |
| --- | --- |
| `handleState` | unwritten |
| `sampledAge` | zero |
| `checkoutCreated` | FALSE |
| `linkEndEstablished` | FALSE |
| `handleRemovalSeen` | FALSE |

**Model rule: [`Init`](../../verification/SquareLinkEnd.tla#L263)**

```tla
Init ==
  /\ handleState = "unwritten"
  /\ sampledAge = AgeStart
  /\ checkoutCreated = FALSE
  /\ linkEndEstablished = FALSE
  /\ handleRemovalSeen = FALSE
  /\ attemptHistorySafe = TRUE
  /\ replyHistorySafe = TRUE
  /\ removalHistorySafe = TRUE
```

**Model rule: [`TypeOK`](../../verification/SquareLinkEnd.tla#L223)**

```tla
TypeOK ==
  /\ handleState \in LinkStates
  /\ sampledAge \in AgeStates
  /\ checkoutCreated \in BOOLEAN
  /\ linkEndEstablished \in BOOLEAN
  /\ handleRemovalSeen \in BOOLEAN
  /\ attemptHistorySafe \in BOOLEAN
  /\ replyHistorySafe \in BOOLEAN
  /\ removalHistorySafe \in BOOLEAN
```

**Model rule: [`CheckoutHistoryConsistent`](../../verification/SquareLinkEnd.tla#L235)**

```tla
CheckoutHistoryConsistent ==
  /\ checkoutCreated = (handleState # "unwritten")
  /\ (linkEndEstablished => checkoutCreated)
  /\ (~checkoutCreated => sampledAge = AgeStart)
  /\ handleRemovalSeen = (handleState = "gone")
```

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#LINK_END_NODES`](../../src/shared/payment/square-link-end-machine-spec.ts#L56)**

```ts
export const LINK_END_NODES: readonly SquareLinkEndNode[] = [
  {
    id: "unwritten",
    reps: [rep("no_row_yet", { state: "unwritten" })],
    takesPayment: "no",
  },
  {
    id: "pending",
    reps: [rep("unclaimed", { state: "pending" })],
    takesPayment: "yes",
  },
  {
    // A worker holds the lease and asked Square to end the link. Until
    // Square answers, the page behind it can still be paid.
    id: "ending",
    reps: [rep("lease_held", { state: "ending" })],
    takesPayment: "until_square_answers",
  },
  {
    id: "gone",
    reps: [rep("row_deleted", { state: "gone" })],
    takesPayment: "no",
  },
];
```

Source fingerprint: `sha256:a8a2bd0a23b53a5f`

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#SquareLinkEndStateSchema`](../../src/shared/payment/square-link-end-machine-spec.ts#L27)**

```ts
export const SquareLinkEndStateSchema = v.picklist(["ending", "pending"]);
```

Source fingerprint: `sha256:162dfb67915a99b4`

### Step 2: A checkout creates a pending handle

Checkout creation writes the initial handle. A due task claims it and takes a lease, so the row shows ending. A payment completion can remove a pending handle, but no later creation can recreate a deleted one. Coverage rules require a representative and an attempt for each prepared pair.

| Value | This step |
| --- | --- |
| `checkout_created` | unwritten changes to pending |
| `claim_due` | pending changes to ending |
| `payment_completed` | pending changes to gone |
| `second creation` | A gone row refuses checkout_created. |

**Model rule: [`LocalStep`](../../verification/SquareLinkEnd.tla#L294)**

```tla
LocalStep ==
  \E attempt \in LinkAttempts :
    /\ attempt.sourceState = handleState
    /\ attempt.eventId \in LocalEvents
    /\ ApplyAttempt(attempt, checkoutCreated /\ attempt.eventId = "payment_completed")
    /\ UNCHANGED replyHistorySafe
```

**Model rule: [`LocalEvents`](../../verification/SquareLinkEnd.tla#L58)**

```tla
LocalEvents ==
  {"checkout_created", "claim_due", "payment_completed", "lease_expired"}
```

**Model rule: [`CreationDoesNotRecreate`](../../verification/SquareLinkEnd.tla#L178)**

```tla
CreationDoesNotRecreate(attempt) ==
  IF attempt.accepted /\ attempt.eventId = "checkout_created"
  THEN attempt.sourceState = "unwritten"
  ELSE TRUE
```

**Model rule: [`RepresentativeCoverage`](../../verification/SquareLinkEnd.tla#L116)**

```tla
RepresentativeCoverage ==
  /\ \A sample \in LinkRepresentatives :
       SampleMatchesDeclaredState(sample.declaredState, sample.storedState, LinkStates)
  /\ \A state \in LinkStates :
       \E sample \in LinkRepresentatives : sample.declaredState = state
```

**Model rule: [`AttemptCoverage`](../../verification/SquareLinkEnd.tla#L124)**

```tla
AttemptCoverage ==
  /\ \A attempt \in LinkAttempts :
       /\ \E sample \in LinkRepresentatives :
            /\ sample.declaredState = attempt.sourceState
            /\ sample.sampleTag = attempt.sampleTag
       /\ \E event \in LinkEvents : event.eventId = attempt.eventId
  /\ \A sample \in LinkRepresentatives, event \in LinkEvents :
       \E attempt \in LinkAttempts :
         /\ attempt.sourceState = sample.declaredState
         /\ attempt.eventId = event.eventId
         /\ attempt.sampleTag = sample.sampleTag
```

**Model rule: [`EventCoverage`](../../verification/SquareLinkEnd.tla#L138)**

```tla
EventCoverage ==
  /\ LocalEvents \subseteq {event.eventId : event \in LinkEvents}
  /\ \A reply \in ReplyFacts :
       \E event \in LinkEvents : event.eventId = reply.eventId
  /\ \A event \in LinkEvents : ~event.movesMoney
  /\ \A event \in LinkEvents :
       event.eventId \in LocalEvents \/
         \E reply \in ReplyFacts : reply.eventId = event.eventId
```

**Model rule: [`InputFacts`](../../verification/SquareLinkEnd.tla#L148)**

```tla
InputFacts ==
  /\ LinkStates = HandleStates \cup {"unwritten", "gone"}
  /\ HandleStates \cap {"unwritten", "gone"} = {}
  /\ RepresentativeCoverage
  /\ AttemptCoverage
  /\ EventCoverage
```

**Model rule: [`Next`](../../verification/SquareLinkEnd.tla#L335)**

```tla
Next == LocalStep \/ ReplyStep \/ Age \/ Prune \/
        UNCHANGED <<handleState, sampledAge, checkoutCreated, linkEndEstablished,
                    handleRemovalSeen, attemptHistorySafe, replyHistorySafe,
                    removalHistorySafe>>
```

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#squareLinkEndMoveTo`](../../src/shared/payment/square-link-end-machine-spec.ts#L105)**

```ts
export const squareLinkEndMoveTo = (
  from: SquareLinkEndNodeId,
  event: SquareLinkEndEventId,
): SquareLinkEndNodeId => ...
```

Source fingerprint: `sha256:e3d4f8622ecd323f`

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#LINK_END_MOVES`](../../src/shared/payment/square-link-end-machine-spec.ts#L163)**

```ts
export const LINK_END_MOVES: MachineMoves<
  SquareLinkEndNodeId,
  SquareLinkEndEventId
> = {
  ending: {
    delete_answered_cancelled: "gone",
    delete_answered_missing: "gone",
    delete_inconclusive: "pending",
    delete_refused_paid: "gone",
    lease_expired: "pending",
  },
  gone: {},
  pending: {
    claim_due: "ending",
    payment_completed: "gone",
  },
  unwritten: { checkout_created: "pending" },
};
```

Source fingerprint: `sha256:70e982f92d1e8f98`

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#LINK_END_CHECKABLE_NODES`](../../src/shared/payment/square-link-end-machine-spec.ts#L194)**

```ts
export const LINK_END_CHECKABLE_NODES: readonly SquareLinkEndNodeId[] =
  LINK_END_DERIVED.movedBy((event) => event.kind === "check");
```

Source fingerprint: `sha256:4df824b2f4e7ba16`

### Step 3: Square's answer picks the event

The classifier maps the HTTP result to one event. A reply that proves nothing returns the row to pending. A paid refusal also ends the row because completion belongs to the payment path. ReplyStep applies the attempt and records whether the classifier agrees with the independently labelled reply.

| Value | This step |
| --- | --- |
| `200 with cancelled_order_id` | delete_answered_cancelled. ending changes to gone. |
| `200 with id only` | delete_inconclusive. ending changes to pending. |
| `409 with PAID` | delete_refused_paid. ending changes to gone. |
| `404` | delete_answered_missing. ending changes to gone. |

**Model rule: [`ReplyStep`](../../verification/SquareLinkEnd.tla#L303)**

```tla
ReplyStep ==
  /\ handleState = "ending"
  /\ \E reply \in ReplyFacts, attempt \in LinkAttempts :
       /\ attempt.sourceState = handleState
       /\ attempt.eventId = reply.eventId
       /\ ApplyAttempt(attempt, reply.expectedEvidence \in ConclusiveEvidence)
       /\ replyHistorySafe' = ChecksStillPass(replyHistorySafe, ReplyAgrees(reply))
```

**Model rule: [`ApplyAttempt`](../../verification/SquareLinkEnd.tla#L278)**

```tla
ApplyAttempt(attempt, conclusive) ==
  LET createdAfter == (checkoutCreated \/
        (attempt.accepted /\ attempt.eventId = "checkout_created"))
      endedAfter == (linkEndEstablished \/ conclusive)
  IN /\ handleState' = attempt.targetState
     /\ checkoutCreated' = createdAfter
     /\ linkEndEstablished' = endedAfter
     /\ handleRemovalSeen' = (handleRemovalSeen \/ attempt.targetState = "gone")
     /\ attemptHistorySafe' = ChecksStillPass(attemptHistorySafe, SafeAttempt(attempt))
     /\ removalHistorySafe' =
          ChecksStillPass(removalHistorySafe,
            PayableLinkKeepsHandle(createdAfter, endedAfter, attempt.targetState))
     /\ UNCHANGED sampledAge
```

**Model rule: [`ReplyAgrees`](../../verification/SquareLinkEnd.tla#L158)**

```tla
ReplyAgrees(reply) ==
  CASE reply.expectedEvidence = "none" -> reply.eventId = "delete_inconclusive"
    [] reply.expectedEvidence = "cancelled" -> reply.eventId = "delete_answered_cancelled"
    [] reply.expectedEvidence = "missing" -> reply.eventId = "delete_answered_missing"
    [] reply.expectedEvidence = "paid" -> reply.eventId = "delete_refused_paid"
    [] OTHER -> FALSE
```

**Model rule: [`SafeAttempt`](../../verification/SquareLinkEnd.tla#L185)**

```tla
SafeAttempt(attempt) ==
  /\ RefusedActionKeepsState(attempt)
  /\ (attempt.sourceState = "gone" => attempt.targetState = "gone")
  /\ RetryReturnsToQueue(attempt)
  /\ CreationDoesNotRecreate(attempt)

VARIABLES
  \* This is the handle's row state. pending has no worker lease and ending
  \* has a lease. unwritten and gone have no row, before creation or after deletion.
  \* @type: Str;
  handleState,
  \* This is a model age interval name, not a stored clock or timestamp.
  \* AgeFacts supplies the payment and cleanup limits for that interval.
  \* @type: Str;
  sampledAge,
  \* This model-only flag remembers that checkout creation occurred.
  \* It distinguishes a deleted handle from a handle that never existed.
  \* @type: Bool;
  checkoutCreated,
  \* This model-only flag remembers conclusive end or payment evidence.
  \* It records the supplied evidence, not an independent provider enquiry.
  \* @type: Bool;
  linkEndEstablished,
  \* This model-only flag remembers that the handle was deleted at least once.
  \* @type: Bool;
  handleRemovalSeen,
  \* This model-only flag stays false after any failed transition law.
  \* @type: Bool;
  attemptHistorySafe,
  \* This model-only flag stays false after any reply classifier mismatch.
  \* @type: Bool;
  replyHistorySafe,
  \* This model-only flag stays false after an unsafe handle removal.
  \* Removal is unsafe while payment is possible and no end evidence exists.
  \* @type: Bool;
  removalHistorySafe
```

**Model rule: [`ConclusiveEvidence`](../../verification/SquareLinkEnd.tla#L61)**

```tla
ConclusiveEvidence == {"cancelled", "missing", "paid"}
```

**Model rule: [`RetryEvents`](../../verification/SquareLinkEnd.tla#L60)**

```tla
RetryEvents == {"delete_inconclusive", "lease_expired"}
```

**Model rule: [`RetryReturnsToQueue`](../../verification/SquareLinkEnd.tla#L168)**

```tla
RetryReturnsToQueue(attempt) ==
  IF attempt.eventId \in RetryEvents
  THEN /\ (attempt.sourceState = "ending" => attempt.accepted)
       /\ (attempt.accepted =>
            /\ attempt.sourceState = "ending"
            /\ attempt.targetState = "pending")
  ELSE TRUE
```

**Production code: [`src/shared/square/link-end.ts#squareLinkEndEventOf`](../../src/shared/square/link-end.ts#L74)**

```ts
/** The one event Square's delete answer proves. */
export const squareLinkEndEventOf = (
  answer: FetchResult,
): SquareLinkEndEventId => {
  if (answer.status === 404) return "delete_answered_missing";
  const body = jsonOrNull(answer.text);
  if (answer.ok) {
    return body !== null && cancelledOrderIdOf(body) !== null
      ? "delete_answered_cancelled"
      : "delete_inconclusive";
  }
  const errors =
    body !== null && Array.isArray(body.errors)
      ? (body.errors as readonly Record<string, unknown>[])
      : [];
  return refusalNamesPaidOrder(errors)
    ? "delete_refused_paid"
    : "delete_inconclusive";
};
```

Source fingerprint: `sha256:9b415b9c83e17e1d`

**Production code: [`src/shared/square/link-end.ts#endSquareLink`](../../src/shared/square/link-end.ts#L29)**

```ts
export const endSquareLink = async (
  getClient: () => Promise<LinkEndSquareClient | null>,
  linkId: string,
): Promise<FetchResult> => { ... }
```

Source fingerprint: `sha256:d63fcc2eb95fbbaf`

### Step 4: Time crosses two limits

The producer places samples just before, at, and after each cutoff. Native expiry stops possible payment. The retention cutoff permits cleanup. The model requires the margin to be after native expiry. The supplied age moves never go backwards, and a passed boundary never reverses. Every age name has one fact.

| Value | This step |
| --- | --- |
| `native lifetime` | 180 days |
| `retention and margin` | 183 days |
| `native_before` | 180 days minus 1 ms. mayPay TRUE. |
| `native_at` | 180 days. mayPay FALSE. |
| `retention_at` | 183 days. Not prunable. |
| `retention_after` | 183 days plus 1 ms. Prunable and margin elapsed. |

**Model rule: [`Age`](../../verification/SquareLinkEnd.tla#L313)**

```tla
Age ==
  /\ checkoutCreated
  /\ \E move \in AgeMoves :
       /\ move.sourceAge = sampledAge
       /\ sampledAge' = move.targetAge
  /\ UNCHANGED <<handleState, checkoutCreated, linkEndEstablished, handleRemovalSeen,
                 attemptHistorySafe, replyHistorySafe, removalHistorySafe>>
```

**Model rule: [`AgeMatches`](../../verification/SquareLinkEnd.tla#L65)**

```tla
AgeMatches(ageState, samples) ==
  \E sample \in samples : sample.ageState = ageState
```

**Model rule: [`MayPay`](../../verification/SquareLinkEnd.tla#L69)**

```tla
MayPay(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.mayPay})
```

**Model rule: [`Prunable`](../../verification/SquareLinkEnd.tla#L73)**

```tla
Prunable(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.prunable})
```

**Model rule: [`RequiredMargin`](../../verification/SquareLinkEnd.tla#L77)**

```tla
RequiredMargin(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.requiredMarginElapsed})
```

**Model rule: [`AgeStartIsFresh`](../../verification/SquareLinkEnd.tla#L81)**

```tla
AgeStartIsFresh ==
  /\ AgeStart \in AgeStates
  /\ MayPay(AgeStart)
  /\ ~Prunable(AgeStart)
  /\ ~RequiredMargin(AgeStart)
```

**Model rule: [`AgeSamplesCoverStates`](../../verification/SquareLinkEnd.tla#L89)**

```tla
AgeSamplesCoverStates ==
  /\ \A ageState \in AgeStates :
       \E fact \in AgeFacts : fact.ageState = ageState
  /\ \A fact \in AgeFacts :
       /\ fact.ageState \in AgeStates
       /\ (fact.prunable => fact.requiredMarginElapsed)
       /\ (fact.requiredMarginElapsed => ~fact.mayPay)
  /\ \A left, right \in AgeFacts :
       left.ageState = right.ageState => left = right
```

**Model rule: [`TimePreservesPassedBoundaries`](../../verification/SquareLinkEnd.tla#L100)**

```tla
TimePreservesPassedBoundaries ==
  \A move \in AgeMoves :
    /\ move.sourceAge \in AgeStates
    /\ move.targetAge \in AgeStates
    /\ (~MayPay(move.sourceAge) => ~MayPay(move.targetAge))
    /\ (Prunable(move.sourceAge) => Prunable(move.targetAge))
    /\ (RequiredMargin(move.sourceAge) => RequiredMargin(move.targetAge))
```

**Model rule: [`AgeData`](../../verification/SquareLinkEnd.tla#L109)**

```tla
AgeData ==
  /\ AgeStartIsFresh
  /\ AgeSamplesCoverStates
  /\ TimePreservesPassedBoundaries
```

**Production code: [`scripts/verify-models/square.ts#squareModelData`](../../scripts/verify-models/square.ts#L221)**

```ts
export const squareModelData = modelDataFor(bindFirst(squareDataFor)(false));
```

Source fingerprint: `sha256:2d5e9ba0e0c9273c`

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#LINK_END_NODES`](../../src/shared/payment/square-link-end-machine-spec.ts#L56)**

```ts
export const LINK_END_NODES: readonly SquareLinkEndNode[] = [
  {
    id: "unwritten",
    reps: [rep("no_row_yet", { state: "unwritten" })],
    takesPayment: "no",
  },
  {
    id: "pending",
    reps: [rep("unclaimed", { state: "pending" })],
    takesPayment: "yes",
  },
  {
    // A worker holds the lease and asked Square to end the link. Until
    // Square answers, the page behind it can still be paid.
    id: "ending",
    reps: [rep("lease_held", { state: "ending" })],
    takesPayment: "until_square_answers",
  },
  {
    id: "gone",
    reps: [rep("row_deleted", { state: "gone" })],
    takesPayment: "no",
  },
];
```

Source fingerprint: `sha256:a8a2bd0a23b53a5f`

### Step 5: Cleanup needs age past retention

Prune deletes a stored handle only when the age is prunable. The rule does not ask for end evidence, because Safety catches an unsafe cutoff by a separate margin check. Cleanup cannot delete at the exact cutoff, since the comparison is strict.

| Value | This step |
| --- | --- |
| `retention_at` | 183 days exactly. Prunable FALSE. No delete. |
| `retention_after` | 183 days plus 1 ms. Prunable TRUE. handleState becomes gone. |

**Model rule: [`Prune`](../../verification/SquareLinkEnd.tla#L324)**

```tla
Prune ==
  /\ handleState \in HandleStates
  /\ Prunable(sampledAge)
  /\ handleState' = "gone"
  /\ handleRemovalSeen' = TRUE
  /\ UNCHANGED <<sampledAge, checkoutCreated, linkEndEstablished, attemptHistorySafe,
                 replyHistorySafe, removalHistorySafe>>
```

**Model rule: [`Prunable`](../../verification/SquareLinkEnd.tla#L73)**

```tla
Prunable(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.prunable})
```

**Model rule: [`RequiredMargin`](../../verification/SquareLinkEnd.tla#L77)**

```tla
RequiredMargin(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.requiredMarginElapsed})
```

**Production code: [`scripts/verify-models/square.ts#squareModelData`](../../scripts/verify-models/square.ts#L221)**

```ts
export const squareModelData = modelDataFor(bindFirst(squareDataFor)(false));
```

Source fingerprint: `sha256:2d5e9ba0e0c9273c`

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#LINK_END_CHECKABLE_NODES`](../../src/shared/payment/square-link-end-machine-spec.ts#L194)**

```ts
export const LINK_END_CHECKABLE_NODES: readonly SquareLinkEndNodeId[] =
  LINK_END_DERIVED.movedBy((event) => event.kind === "check");
```

Source fingerprint: `sha256:4df824b2f4e7ba16`

### Step 6: A payable link keeps a handle

ApplyAttempt checks the proposed target against the current age. Before native expiry, a created link with no end evidence must land on pending or ending. Safety also requires every retained handle to stay in the checkable set and requires the checkout history to match the row. Next permits a pause, so the model does not force a reply.

| Value | This step |
| --- | --- |
| `created, no end evidence, age zero, target gone` | removalHistorySafe becomes FALSE. |
| `created, no end evidence, age zero, target pending` | allowed |
| `retained handle target` | pending or ending |

**Model rule: [`Safety`](../../verification/SquareLinkEnd.tla#L250)**

```tla
Safety ==
  /\ TypeOK
  /\ InputFacts
  /\ AgeData
  /\ attemptHistorySafe
  /\ replyHistorySafe
  /\ removalHistorySafe
  /\ CheckoutHistoryConsistent
  /\ PayableLinkKeepsHandle(checkoutCreated, linkEndEstablished, handleState)
  /\ (handleState \in HandleStates => handleState \in CheckableStates)
  /\ (Prunable(sampledAge) => RequiredMargin(sampledAge))
```

**Model rule: [`PayableLinkKeepsHandle`](../../verification/SquareLinkEnd.tla#L243)**

```tla
PayableLinkKeepsHandle(created, ended, targetState) ==
  IF created /\ ~ended /\ MayPay(sampledAge)
  THEN targetState \in HandleStates
  ELSE TRUE
```

**Model rule: [`CheckoutHistoryConsistent`](../../verification/SquareLinkEnd.tla#L235)**

```tla
CheckoutHistoryConsistent ==
  /\ checkoutCreated = (handleState # "unwritten")
  /\ (linkEndEstablished => checkoutCreated)
  /\ (~checkoutCreated => sampledAge = AgeStart)
  /\ handleRemovalSeen = (handleState = "gone")
```

**Model rule: [`Next`](../../verification/SquareLinkEnd.tla#L335)**

```tla
Next == LocalStep \/ ReplyStep \/ Age \/ Prune \/
        UNCHANGED <<handleState, sampledAge, checkoutCreated, linkEndEstablished,
                    handleRemovalSeen, attemptHistorySafe, replyHistorySafe,
                    removalHistorySafe>>
```

**Production code: [`scripts/verify-models/square.ts#corruptSquareData`](../../scripts/verify-models/square.ts#L224)**

```ts
export const corruptSquareData = modelDataFor(bindFirst(squareDataFor)(true));
```

Source fingerprint: `sha256:4ae5bc02c5900911`

**Production code: [`src/shared/payment/square-link-end-machine-spec.ts#LINK_END_MOVES`](../../src/shared/payment/square-link-end-machine-spec.ts#L163)**

```ts
export const LINK_END_MOVES: MachineMoves<
  SquareLinkEndNodeId,
  SquareLinkEndEventId
> = {
  ending: {
    delete_answered_cancelled: "gone",
    delete_answered_missing: "gone",
    delete_inconclusive: "pending",
    delete_refused_paid: "gone",
    lease_expired: "pending",
  },
  gone: {},
  pending: {
    claim_due: "ending",
    payment_completed: "gone",
  },
  unwritten: { checkout_created: "pending" },
};
```

Source fingerprint: `sha256:70e982f92d1e8f98`

## The safety claim

A created link with no end evidence keeps a handle while the native lifetime permits payment. A delete reply moves the row only by its classified event. A cleanup deletion needs age beyond the retention cutoff. A deleted handle never returns.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- Ages are names for intervals. The model does not read a real clock.
- Native lifetime, the retry margin, and provider evidence are assumptions.
- The age facts rebuild the cutoffs. They do not execute the prune SQL.
- The reply examples cover eight shapes, not every possible message.
- SQL races, requests still in flight, and eventual completion need separate tests.

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
