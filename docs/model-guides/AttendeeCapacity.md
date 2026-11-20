# Editing one attendee's ticket without overfilling a listing

[Read the model](../../verification/AttendeeCapacity.tla).

This page follows one edit to one attendee's ticket. The edit writes all its lines or none. No accepted line puts more places on a listing than its limit.

## The bad outcome it rules out

A failed edit leaves one new line behind, or a listing accepts more places than its limit allows.

## The cast

| Word | Meaning |
| --- | --- |
| **listing** | One item that a visitor can book, such as a workshop. |
| **line** | One stored row that links an attendee to a listing and states a number of places. |
| **slot** | One example listing whose occupied places share a limit. The examples use two dateless slots. Slot one has a limit of three. Slot two has a limit of two. |
| **batch** | All the database writes for one edit, sent together. The database commits all of them or none. |
| **fact** | The prepared result of one example run. The fact is not a live customer record. |

## The walkthrough

### Step 1: Start with an empty example

The model starts before any edit. The seed prepares the production schema and two listings. The seed does not stand for a live database.

| Value | This step |
| --- | --- |
| `committed` | FALSE |
| `slot1Total` | 0 |
| `slot2Total` | 0 |
| `lineCount` | 0 |

**Model rule: [`Init`](../../verification/AttendeeCapacity.tla#L119)**

```tla
Init ==
  /\ committed = FALSE
  /\ slot1Total = 0
  /\ slot2Total = 0
  /\ lineCount = 0
```

**Model rule: [`TypeOK`](../../verification/AttendeeCapacity.tla#L66)**

```tla
TypeOK ==
  /\ committed \in BOOLEAN
  /\ slot1Total \in Int
  /\ slot2Total \in Int
  /\ lineCount \in Int
```

**Production code: [`scripts/verify-models/attendee-capacity-seed.ts#seededClient`](../../scripts/verify-models/attendee-capacity-seed.ts#L81)**

```ts
export const seededClient = async (scenario: Scenario): Promise<Client> => { ... }
```

Source fingerprint: `sha256:1626a9b7fd5d20cd`

### Step 2: One line must fit its listing

The production capacity condition checks the limit before the line write. A line that does not fit becomes a refused line fact. The rule reads the already occupied places, which can belong to other attendees.

| Value | This step |
| --- | --- |
| `slot one` | Three places are occupied. The limit is three. One more place does not fit. |
| `slot two` | One place is occupied. The limit is two. One more place fits. |

**Model rule: [`NoOverfill`](../../verification/AttendeeCapacity.tla#L76)**

```tla
NoOverfill ==
  /\ \A fact \in BatchFacts :
       fact.commits =>
         /\ fact.slot1AfterTotal <= QuantityOne
         /\ fact.slot2AfterTotal <= QuantityTwo
  /\ slot1Total <= QuantityOne
  /\ slot2Total <= QuantityTwo
```

**Production code: [`src/shared/db/capacity.ts#capacityConditionFor`](../../src/shared/db/capacity.ts#L372)**

```ts
export const capacityConditionFor = (
  booking: LineBooking,
  excludeAttendeeId?: number,
): Expr<boolean> => ...
```

Source fingerprint: `sha256:8ced2930f46385e5`

**Production code: [`src/shared/db/attendees/atomic-update.ts#lineStatementFor`](../../src/shared/db/attendees/atomic-update.ts#L267)**

```ts
export const lineStatementFor = (
  line: DesiredListingLine,
  attendeeId: number,
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
  allowOverbook: boolean,
): { guarded: boolean; statement: SqlStatement } => { ... }
```

Source fingerprint: `sha256:86080fe1a741fff2`

### Step 3: One edit is one batch

The production builder returns one statement for each desired line. The model joins each line fact to its batch by the batch name. In an accepted batch, no desired line is independently refused.

| Value | This step |
| --- | --- |
| `batch` | Add one place on slot two, then add two places on slot one. |
| `result` | The slot one line does not fit. The batch must not keep the slot two line. |
| `committed` | FALSE |

**Model rule: [`NoPartialCommit`](../../verification/AttendeeCapacity.tla#L89)**

```tla
NoPartialCommit ==
  \A fact \in BatchFacts :
    fact.commits =>
      \A line \in LineFacts :
        line.batch /= fact.batch \/ line.fits
```

**Production code: [`src/shared/db/attendees/atomic-update.ts#buildAttendeeEditBatch`](../../src/shared/db/attendees/atomic-update.ts#L324)**

```ts
export const buildAttendeeEditBatch = (
  attendeeId: number,
  desired: readonly DesiredListingLine[],
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
  allowOverbook: boolean,
): SqlStatement[] => { ... }
```

Source fingerprint: `sha256:a35b5bbc9b0c0306`

### Step 4: An accepted edit keeps a line

An accepted edit cannot remove the last line. A line with zero places still counts as a line. It does not represent a paid place.

| Value | This step |
| --- | --- |
| `lineCountAfter` | 1 |
| `committed` | TRUE |

**Model rule: [`CommittedHoldsLine`](../../verification/AttendeeCapacity.tla#L97)**

```tla
CommittedHoldsLine ==
  /\ \A fact \in BatchFacts : fact.commits => fact.lineCountAfter >= 1
  /\ committed => lineCount >= 1
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

### Step 5: An unchanged line can still commit

A preserve asks for no extra place. The listing can be inactive. The edit must still commit, because it only keeps what the attendee already holds.

| Value | This step |
| --- | --- |
| `listing active` | FALSE |
| `edit` | Preserve the same line with the same quantity. |
| `committed` | TRUE |

**Model rule: [`PreserveOnlyCommits`](../../verification/AttendeeCapacity.tla#L103)**

```tla
PreserveOnlyCommits ==
  \A fact \in BatchFacts : fact.preserveOnly => fact.commits
```

**Production code: [`src/shared/db/attendees/atomic-update.ts#isUnchangedLine`](../../src/shared/db/attendees/atomic-update.ts#L188)**

```ts
export const isUnchangedLine = (
  line: DesiredListingLine,
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
): boolean => { ... }
```

Source fingerprint: `sha256:e7a1ea396c022a19`

### Step 6: A refused batch changes nothing

The step selects any prepared batch fact. An accepted fact replaces the snapshot with its observed totals. A refused fact leaves the snapshot unchanged. The next-state relation also permits a step that changes nothing, so the model does not require an edit to occur.

| Value | This step |
| --- | --- |
| `accepted fact` | The snapshot takes the observed totals and line count. |
| `refused fact` | The snapshot keeps every current value. |

**Model rule: [`BatchStep`](../../verification/AttendeeCapacity.tla#L130)**

```tla
BatchStep ==
  \E fact \in BatchFacts :
    /\ committed' = IF fact.commits THEN TRUE ELSE committed
    /\ slot1Total' = IF fact.commits THEN fact.slot1AfterTotal ELSE slot1Total
    /\ slot2Total' = IF fact.commits THEN fact.slot2AfterTotal ELSE slot2Total
    /\ lineCount' = IF fact.commits THEN fact.lineCountAfter ELSE lineCount
```

**Model rule: [`Next`](../../verification/AttendeeCapacity.tla#L140)**

```tla
Next ==
  BatchStep \/ UNCHANGED <<committed, slot1Total, slot2Total, lineCount>>
```

**Model rule: [`Safety`](../../verification/AttendeeCapacity.tla#L110)**

```tla
Safety ==
  /\ TypeOK
  /\ NoOverfill
  /\ NoPartialCommit
  /\ CommittedHoldsLine
  /\ PreserveOnlyCommits
```

**Production code: [`scripts/verify-models/attendee-capacity.ts#attendeeCapacityModelData`](../../scripts/verify-models/attendee-capacity.ts#L311)**

```ts
export const attendeeCapacityModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:53a6b745adca680f`

## The safety claim

Every accepted edit keeps both slot totals within their limits. A refused line does not stick in an accepted batch. Every accepted edit keeps at least one line.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use two dateless listings with limits of three and two places.
- They do not prove every date rule, every shared-group rule, or a concurrent edit.
- SQL rollback, triggers, and the full caller path need separate database tests.
- The model checks safety. It does not prove that an edit eventually finishes.

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
