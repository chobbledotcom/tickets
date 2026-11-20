# Subscription plans through edits, deletes, merges, and reads

[Read the model](../../verification/SubscriptionRecords.tla).

This page follows edits, deletes, and merges of subscription booking rows, and the subscriber list. A live plan survives every drop. A permitted write keeps the exact plan columns, and a refused write changes no row and no money.

## The bad outcome it rules out

An edit, delete, or merge discards a plan that can still charge, a copied plan loses a column, a refusal leaves a partial write, or the subscriber list drops or invents a row.

## The cast

| Word | Meaning |
| --- | --- |
| **attendee** | One person record. |
| **booking row** | One stored link between a person and one listing. It holds a place quantity and possibly a plan. |
| **plan** | The provider id, status, period amount, VAT amount, and interval on one booking row. |
| **drop** | An edit, a delete, or a merge that removes a booking row or its plan. |
| **merge** | An operator action that combines two people. |
| **projection** | The subscriber list read from the stored booking rows. |
| **slot** | One result position in the projection. Two equal provider ids do not collapse into one slot. |
| **fact** | One prepared record from the producer. It is not a live database or Stripe observation. |

## The walkthrough

### Step 1: Start with the prepared record domain

The model starts with one Boolean. Init sets it from the two coverage rules, so a missing fact makes the first state unsafe. Statuses names eight Stripe words and one empty word for an ordinary row. Operations names eight normal operations. MergeOperations adds a deliberate late merge fault. Drops names the five operations that remove a row or a plan. The empty status word keeps the ordinary row in the same operation table.

| Value | This step |
| --- | --- |
| `Statuses` | active, canceled, incomplete, incomplete_expired, past_due, paused, trialing, unpaid, and the empty word for an ordinary row. |
| `Operations` | edit-drop, edit-preserve, delete, merge-drop-source, merge-drop-target, merge-move, merge-take-source, merge-preserve-target. |
| `MergeOperations` | The five merge words above plus the deliberate late word merge-fault. |
| `Drops` | edit-drop, delete, delete-race, merge-drop-source, merge-drop-target. |
| `safe` | TRUE when both coverage rules pass. |

**Model rule: [`Init`](../../verification/SubscriptionRecords.tla#L167)**

```tla
Init == safe = (OperationCoverage /\ ProjectionCoverage)
```

**Model rule: [`Statuses`](../../verification/SubscriptionRecords.tla#L27)**

```tla
Statuses == LiveStatuses \cup EndedStatuses \cup {""}
```

**Model rule: [`Operations`](../../verification/SubscriptionRecords.tla#L28)**

```tla
Operations == {"edit-drop", "edit-preserve", "delete", "merge-drop-source",
               "merge-drop-target", "merge-move", "merge-take-source", "merge-preserve-target"}
```

**Model rule: [`MergeOperations`](../../verification/SubscriptionRecords.tla#L30)**

```tla
MergeOperations == {"merge-drop-source", "merge-drop-target", "merge-move",
                    "merge-take-source", "merge-preserve-target", "merge-fault"}
```

**Model rule: [`Drops`](../../verification/SubscriptionRecords.tla#L32)**

```tla
Drops == {"edit-drop", "delete", "delete-race", "merge-drop-source", "merge-drop-target"}

\* This flag remembers a failed business check. It is model evidence, not a
\* stored payment state. A later good attempt cannot erase a bad attempt.
VARIABLE
  \* @type: Bool;
  safe
```

**Production code: [`scripts/verify-models/subscriptions/records-operations.ts#recordScenarios`](../../scripts/verify-models/subscriptions/records-operations.ts#L63)**

```ts
export const recordScenarios = (): RecordScenario[] => ...
```

Source fingerprint: `sha256:0c73af8d1aaa6f95`

**Production code: [`scripts/verify-models/subscriptions/records-facts.ts#RECORD_TABLES`](../../scripts/verify-models/subscriptions/records-facts.ts#L21)**

```ts
export const RECORD_TABLES = {
  expected: ["ExpectedProjection", projectionFields],
  invalid: [
    "InvalidPlans",
    {
      attempt: "Int",
      listThrows: "Bool",
      pass: "Int",
      scenario: "Str",
      singleThrows: "Bool",
    },
  ],
  observed: ["ObservedProjection", projectionFields],
  operations: [
    "OperationFacts",
    {
      accepted: "Bool",
      afterQuantity: "Int",
      afterStatus: "Str",
      applyRan: "Bool",
      attempt: "Int",
      attendee: "Int",
      booking: "Int",
      deletePreview: "Str",
// ...
```

Source fingerprint: `sha256:0e84eaf82926e863`

### Step 2: Every status, place count, and operation occurs

The operation coverage rule requires 218 facts. Eight statuses plus the empty word give nine status words. Three place counts and eight operations give 216 combinations. A stale delete preview and a late merge fault add two more facts. Each combination must appear with attempt one. One combination cannot stand in for another. The producer makes each scenario name from its operation, status, and quantity.

| Value | This step |
| --- | --- |
| `combinations` | 9 status words times 3 place counts times 8 operations. |
| `base facts` | 216 |
| `extra facts` | delete-race:active:0 and merge-fault:active:1. |
| `OperationFactsCount` | 218 |
| `attempt` | 1 for every fact. |

**Model rule: [`OperationCoverage`](../../verification/SubscriptionRecords.tla#L45)**

```tla
OperationCoverage ==
  /\ OperationFactsCount = 218
  /\ \A status \in Statuses, quantity \in {0, 1, 3}, operation \in Operations :
       \E fact \in OperationFacts :
         /\ fact.status = status /\ fact.quantity = quantity
         /\ fact.operation = operation /\ fact.attempt = 1
  /\ \E fact \in OperationFacts : fact.operation = "delete-race"
  /\ \E fact \in OperationFacts : fact.operation = "merge-fault"
```

**Production code: [`scripts/verify-models/subscriptions/records.ts#collectRecordFacts`](../../scripts/verify-models/subscriptions/records.ts#L15)**

```ts
export const collectRecordFacts = async (): Promise<RecordFacts> => { ... }
```

Source fingerprint: `sha256:83d88e97cc8cd701`

**Production code: [`scripts/verify-models/subscriptions/records-operations.ts#recordScenarios`](../../scripts/verify-models/subscriptions/records-operations.ts#L63)**

```ts
export const recordScenarios = (): RecordScenario[] => ...
```

Source fingerprint: `sha256:0c73af8d1aaa6f95`

### Step 3: A drop must refuse a live plan

The permitted rule reads one operation and one status. A drop is an edit, a delete, or a merge drop. A live status makes that drop refused. A canceled or incomplete_expired status makes it permitted. An ordinary row is also permitted. The operation law checks the observed decision, the live read, the listing refusal, the row count, and the exact plan columns. A refused write must leave every record and every money row unchanged. The delete check reads the live subscription inside the writer transaction.

| Value | This step |
| --- | --- |
| `edit-drop:active:0` | Live TRUE, accepted FALSE, present TRUE, row count 3, plan still sub_protected. |
| `edit-drop:canceled:0` | Live FALSE, accepted TRUE, present FALSE, row count 2. |
| `delete:active:0` | Accepted FALSE with PaymentRowsBusyError. Money unchanged TRUE. |
| `delete:incomplete_expired:0` | Accepted TRUE, row count 1. |
| `delete-race:active:0` | A stale preview says available. The row turns active again before the writer reads. Delete refused, records unchanged TRUE. |
| `edit-preserve:active:0` | Accepted TRUE. Quantity becomes 1. Row count stays 3, and the plan stays exact. |

**Model rule: [`Permitted`](../../verification/SubscriptionRecords.tla#L69)**

```tla
Permitted(fact) ==
  fact.operation /= "merge-fault" /\
    ~(fact.operation \in Drops /\ fact.status \in LiveStatuses)
```

**Model rule: [`OperationLaw`](../../verification/SubscriptionRecords.tla#L131)**

```tla
OperationLaw(fact) ==
  /\ fact.live = (fact.status \in LiveStatuses)
  /\ fact.liveRead = fact.live
  /\ fact.listingRefused = fact.live
  /\ fact.accepted = Permitted(fact)
  /\ fact.expectedAccepted = Permitted(fact)
  /\ fact.validationUnchanged
  \* The selected overlap starts with an admitted preview, not a second live refusal.
  /\ fact.deletePreview = IF fact.operation = "delete-race" THEN "available" ELSE ""
  /\ fact.operation \in MergeOperations =>
       /\ fact.validationAccepted = (Permitted(fact) \/ fact.operation = "merge-fault")
       /\ fact.applyRan = fact.validationAccepted
  /\ ~fact.accepted => fact.recordsUnchanged /\ fact.moneyUnchanged
  /\ fact.moneyCorrect
  /\ fact.rowCount = fact.expectedRowCount
  /\ ExpectedShape(fact)
  /\ PreservedPlan(fact)
```

**Production code: [`src/shared/db/attendees/atomic-update.ts#applyAttendeeAtomicEdit`](../../src/shared/db/attendees/atomic-update.ts#L361)**

```ts
export const applyAttendeeAtomicEdit = async (
  attendeeId: number,
  pii: UpdateAttendeePIIInput,
  desired: DesiredListingLine[],
  allowOverbook = false,
  work: AttendeeEditWork = EMPTY_EDIT_WORK,
): Promise<UpdateAttendeeAtomicResult> => { ... }
```

Source fingerprint: `sha256:032ab5adb9de5662`

**Production code: [`src/shared/db/attendees/delete.ts#deleteAttendee`](../../src/shared/db/attendees/delete.ts#L168)**

```ts
export const deleteAttendee = async (
  attendeeId: number,
  { releaseBookings = true }: DeleteAttendeeOptions = {},
): Promise<void> => { ... }
```

Source fingerprint: `sha256:6a22cf61bb8421a8`

**Production code: [`src/shared/db/subscriptions.ts#liveListingRefusal`](../../src/shared/db/subscriptions.ts#L211)**

```ts
export const liveListingRefusal: ListingCheck = async (listingId, tx) => { ... }
```

Source fingerprint: `sha256:391d05951be10969`

**Production code: [`src/shared/db/payment-admit-move.ts#PaymentRowsBusyError`](../../src/shared/db/payment-admit-move.ts#L119)**

```ts
export class PaymentRowsBusyError extends namedError("PaymentRowsBusyError") { ... }
```

Source fingerprint: `sha256:640809d3630be726`

### Step 4: A merge keeps the whole plan or changes nothing

The expected shape rule states every column for each operation. A kept row keeps listing 11 and its person. A real merge copy gets a new database id, which the model writes as zero. The preserved plan rule compares all five plan columns and the row identity. Validation refuses a merge that drops a live plan. Apply alone has no such guard, so the model also runs a late fault after the row copies and the person write. That fault must roll every write back. A permitted merge can repoint a money leg, but each original amount stays exact.

| Value | This step |
| --- | --- |
| `seed plan` | Provider sub_protected, amount 731, VAT 113, interval month, listing 11. |
| `merge-move:active:0` | Attendee 2, present TRUE, new booking id above 0, quantity 0. The plan stays 731, 113, month, active. |
| `merge-preserve-target:active:1` | Attendee 2, booking 1, quantity 1, plan exact. |
| `merge-drop-source:active:1` | Accepted FALSE. Validation names listing 11 and the live subscription. Row count 4. |
| `merge-fault:active:1` | Apply ran TRUE, accepted FALSE, records unchanged TRUE, money unchanged TRUE. |

**Model rule: [`ExpectedShape`](../../verification/SubscriptionRecords.tla#L77)**

```tla
ExpectedShape(fact) ==
  /\ fact.expectedPresent = ~(Permitted(fact) /\ fact.operation \in Drops)
  /\ fact.expectedSubscription = IF fact.status = "" THEN "" ELSE "sub_protected"
  /\ fact.expectedPrice = IF fact.status = "" THEN 0 ELSE 731
  /\ fact.expectedTax = IF fact.status = "" THEN 0 ELSE 113
  /\ fact.expectedInterval = IF fact.status = "" THEN "" ELSE "month"
  /\ fact.expectedStatus = fact.status
  /\ fact.expectedListing = 11
  /\ fact.expectedQuantity = fact.quantity +
       (IF fact.operation = "edit-preserve" THEN 1 ELSE 0)
  /\ fact.expectedAttendee =
       IF (Permitted(fact) /\ fact.operation \in MergeOperations) \/
          fact.operation \in {"merge-drop-target", "merge-preserve-target"}
       THEN 2 ELSE 1
  /\ fact.expectedBooking =
       IF Permitted(fact) /\ fact.operation \in {"merge-move", "merge-take-source"}
       THEN 0 ELSE 1
  /\ fact.expectedRowCount =
       IF Permitted(fact)
       THEN IF fact.operation = "delete" THEN 1
            ELSE IF fact.operation = "edit-drop" THEN 2 ELSE 3
       ELSE IF fact.operation \in {"merge-drop-source", "merge-drop-target",
                                  "merge-take-source", "merge-preserve-target"}
            THEN 4 ELSE 3
```

**Model rule: [`PreservedPlan`](../../verification/SubscriptionRecords.tla#L106)**

```tla
PreservedPlan(fact) ==
  /\ fact.present = fact.expectedPresent
  /\ fact.present =>
       /\ IF fact.expectedBooking = 0 THEN fact.booking > 0
          ELSE fact.booking = fact.expectedBooking
       /\ fact.attendee = fact.expectedAttendee
       /\ fact.listing = fact.expectedListing
       /\ fact.afterQuantity = fact.expectedQuantity
       /\ fact.subscription = fact.expectedSubscription
       /\ fact.price = fact.expectedPrice
       /\ fact.tax = fact.expectedTax
       /\ fact.interval = fact.expectedInterval
       /\ fact.afterStatus = fact.expectedStatus

\* Individual refusal controls remove only observed presence for edit, delete,
\* and merge. They keep accepted FALSE, isolating this law from admission.
\* Real merge-copy controls change identity, amount, tax, interval, or status
\* one column at a time. None of those controls changes the expected seed plan.
```

**Model rule: [`Permitted`](../../verification/SubscriptionRecords.tla#L69)**

```tla
Permitted(fact) ==
  fact.operation /= "merge-fault" /\
    ~(fact.operation \in Drops /\ fact.status \in LiveStatuses)
```

**Model rule: [`OperationLaw`](../../verification/SubscriptionRecords.tla#L131)**

```tla
OperationLaw(fact) ==
  /\ fact.live = (fact.status \in LiveStatuses)
  /\ fact.liveRead = fact.live
  /\ fact.listingRefused = fact.live
  /\ fact.accepted = Permitted(fact)
  /\ fact.expectedAccepted = Permitted(fact)
  /\ fact.validationUnchanged
  \* The selected overlap starts with an admitted preview, not a second live refusal.
  /\ fact.deletePreview = IF fact.operation = "delete-race" THEN "available" ELSE ""
  /\ fact.operation \in MergeOperations =>
       /\ fact.validationAccepted = (Permitted(fact) \/ fact.operation = "merge-fault")
       /\ fact.applyRan = fact.validationAccepted
  /\ ~fact.accepted => fact.recordsUnchanged /\ fact.moneyUnchanged
  /\ fact.moneyCorrect
  /\ fact.rowCount = fact.expectedRowCount
  /\ ExpectedShape(fact)
  /\ PreservedPlan(fact)
```

**Production code: [`src/shared/merge/attendee-merge.ts#validateAttendeeMergeDecision`](../../src/shared/merge/attendee-merge.ts#L430)**

```ts
export const validateAttendeeMergeDecision = (
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): AttendeeMergeValidationResult => { ... }
```

Source fingerprint: `sha256:e4b47ccee2d0bafe`

**Production code: [`src/shared/merge/attendee-merge.ts#applyAttendeeMerge`](../../src/shared/merge/attendee-merge.ts#L716)**

```ts
export const applyAttendeeMerge = async (
  input: ApplyAttendeeMergeInput,
): Promise<AttendeeMergeApplyResult> => { ... }
```

Source fingerprint: `sha256:3496213178fed82b`

**Production code: [`src/shared/merge/subscription-rows.ts#droppedSubscriptionErrors`](../../src/shared/merge/subscription-rows.ts#L19)**

```ts
export const droppedSubscriptionErrors = (
  items: readonly AttendeeMergeDiffBookingItem[],
  copiesSource: (item: AttendeeMergeDiffBookingItem) => boolean,
): string[] => ...
```

Source fingerprint: `sha256:8efbc4ac6760ffde`

**Production code: [`src/shared/merge/booking-copy.ts#copiedBookingColumns`](../../src/shared/merge/booking-copy.ts#L41)**

```ts
export const copiedBookingColumns = (booking: ListingAttendeeRow) => ...
```

Source fingerprint: `sha256:c41950afd8b05464`

### Step 5: The subscriber list matches its prepared rows

The projection coverage rule checks a prepared list of 24 plans before any read. Every live and ended status occurs with zero, one, and three places. Two rows share the provider id sub_shared, so the list must keep both. The projection law compares the full subscriber list with that prepared list. It also requires a loud refusal for four bad plans. Each bad plan fails both the list read and the single-row read. A valid plan read must match the stored plan columns.

| Value | This step |
| --- | --- |
| `expected rows` | 24 rows from 8 status words and 3 place counts. |
| `shared provider id` | sub_shared appears on 2 rows. |
| `ordinary rows` | Booking rows 101 and 102 hold no plan. The single read returns null for both. |
| `invalid plans` | missing-interval, invalid-interval, missing-status, invalid-status. |
| `slots` | Each result keeps its own position. |

**Model rule: [`ProjectionCoverage`](../../verification/SubscriptionRecords.tla#L57)**

```tla
ProjectionCoverage ==
  /\ ExpectedProjectionCount = 24
  /\ \A status \in LiveStatuses \cup EndedStatuses, quantity \in {0, 1, 3} :
       \E row \in ExpectedProjection : row.status = status /\ row.quantity = quantity
  /\ Cardinality({row \in ExpectedProjection : row.subscription = "sub_shared"}) = 2
  /\ {row.scenario : row \in InvalidPlans} =
       {"missing-interval", "invalid-interval", "missing-status", "invalid-status"}
```

**Model rule: [`ProjectionLaw`](../../verification/SubscriptionRecords.tla#L152)**

```tla
ProjectionLaw ==
  /\ ObservedProjection = ExpectedProjection
  /\ \A row \in InvalidPlans : row.listThrows /\ row.singleThrows
```

**Production code: [`src/shared/db/subscriptions.ts#getSubscribedRows`](../../src/shared/db/subscriptions.ts#L97)**

```ts
export const getSubscribedRows = async (): Promise<SubscribedRow[]> => ...
```

Source fingerprint: `sha256:7e6529d1a6767ebc`

**Production code: [`src/shared/db/subscriptions.ts#getSubscribedRowOrNull`](../../src/shared/db/subscriptions.ts#L109)**

```ts
export const getSubscribedRowOrNull = async (
  id: number,
): Promise<SubscribedRow | null> => { ... }
```

Source fingerprint: `sha256:5d318ef3b5fb1f3c`

**Production code: [`scripts/verify-models/subscriptions/records-projection.ts#projectionFacts`](../../scripts/verify-models/subscriptions/records-projection.ts#L54)**

```ts
export const projectionFacts = async (beforeRead?: () => Promise<void>) => { ... }
```

Source fingerprint: `sha256:437ade1c995bc7c2`

### Step 6: One bad fact stays visible

Each step selects one prepared fact and checks its law. The operation step reads one operation fact. The projection step reads the projection law. A check that passes keeps safe TRUE. A check that fails sets safe FALSE, and a later check cannot clear it. Next also permits a step with no change, so the model does not require an event. Safety requires safe TRUE.

| Value | This step |
| --- | --- |
| `good fact` | safe TRUE, then TRUE. |
| `lost live plan` | A fact shows a drop of a live plan. safe becomes FALSE. |
| `later good projection` | safe stays FALSE. |
| `no change` | The state keeps safe. |

**Model rule: [`OperationStep`](../../verification/SubscriptionRecords.tla#L171)**

```tla
OperationStep ==
  \E index \in OperationFactsIndices :
    LET fact == OperationFactsAt(index) IN
    safe' = ChecksStillPass(safe, OperationLaw(fact))
```

**Model rule: [`ProjectionStep`](../../verification/SubscriptionRecords.tla#L175)**

```tla
ProjectionStep == safe' = ChecksStillPass(safe, ProjectionLaw)
```

**Model rule: [`Next`](../../verification/SubscriptionRecords.tla#L179)**

```tla
Next == OperationStep \/ ProjectionStep \/ UNCHANGED safe
```

**Model rule: [`Safety`](../../verification/SubscriptionRecords.tla#L163)**

```tla
Safety == safe \in BOOLEAN /\ safe
```

**Production code: [`scripts/verify-models/subscriptions/records.ts#collectRecordFacts`](../../scripts/verify-models/subscriptions/records.ts#L15)**

```ts
export const collectRecordFacts = async (): Promise<RecordFacts> => { ... }
```

Source fingerprint: `sha256:83d88e97cc8cd701`

## The safety claim

Every accepted drop leaves any live plan in place. Every kept or moved plan keeps its provider id, amount, tax, interval, and status. A refused write leaves every record and ledger leg unchanged. The subscriber list equals the prepared expected list.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use two people, three ticket offers, null dates, and the quantities zero, one, and three.
- The model checks one selected order for the delete race, not every race order.
- It does not run a live database or a Stripe request. It assumes successful transaction atomicity.
- Merge validation and apply are separate observations. Apply alone has no plan-loss guard.
- The projection claim covers the subscriber reads. It does not prove page labels, roles, or personal data rules.
- The model does not prove that an operation eventually happens.

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
