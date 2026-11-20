# A door admits the right number of places

[Read the model](../../verification/DoorScan.tla).

This page follows one ticket at a door. Each scan admits no more places than the booking owns on each listing. A refunded row, a purchase-only row, and an unverified non-transferable row admit nothing. A failed fact stays visible.

## The bad outcome it rules out

A scan admits more places than the booking owns, lowers an admitted count, or admits from a refunded row.

## The cast

| Word | Meaning |
| --- | --- |
| **booking** | One customer order that records the places owned on one or more listings. |
| **listing** | One item that a visitor can book, such as an event. |
| **place** | One unit of admission. Every count here is a whole number of places. |
| **row** | One attendee row. It supplies the customer quantity and the checked-in count for one listing. |
| **ticket** | The access record presented at the door, such as a QR code that identifies the booked rows. |
| **pick** | The count that door staff request for one scan. It applies to each selected listing and stops at the unadmitted count. |
| **fact** | One prepared decision output from the producer. The fact is not a database write. |
| **all-facts-safe flag** | A model-only flag. It starts TRUE and stays FALSE after one bad fact. |

## The walkthrough

### Step 1: Start with no admitted places

The model starts at a fresh door view. The producer names two representative listings with booked quantities of three and one. Init sets both admitted totals to zero and keeps the safe verdict.

| Value | This step |
| --- | --- |
| `listing one` | Three booked places, zero admitted. |
| `listing two` | One booked place, zero admitted. |
| `all-facts-safe flag` | TRUE |

**Model rule: [`Init`](../../verification/DoorScan.tla#L100)**

```tla
Init ==
  /\ listing1Admitted = 0
  /\ listing2Admitted = 0
  /\ allFactsSafe = TRUE
```

**Model rule: [`TypeOK`](../../verification/DoorScan.tla#L67)**

```tla
TypeOK ==
  /\ listing1Admitted \in Int
  /\ listing2Admitted \in Int
  /\ allFactsSafe \in BOOLEAN
```

**Production code: [`src/features/admin/scan-decision.ts#decideScan`](../../src/features/admin/scan-decision.ts#L99)**

```ts
export const decideScan = (
  { entries, scope, force }: DoorAsk,
  checkInEveryListing: boolean,
  idVerified: boolean,
  count?: number,
): ScanDecision => { ... }
```

Source fingerprint: `sha256:13071671a8bc175d`

**Production code: [`scripts/verify-models/door-scan.ts#representatives`](../../scripts/verify-models/door-scan.ts#L65)**

```ts
export const representatives = [
  { id: 1, name: "one", quantity: 3 },
  { id: 2, name: "two", quantity: 1 },
] as const;
```

Source fingerprint: `sha256:7bf8aaa7c06a0842`

### Step 2: An excessive pick stops at the unadmitted count

The party owns three places and already used two. Door staff request five more. The decision caps the unit at the one place that remains. SafeAdmission requires the after count to stay within the booked quantity and to keep the before count.

| Value | This step |
| --- | --- |
| `listing one booked` | 3 |
| `admitted before` | 2 |
| `pick` | 5 |
| `admitted after` | 3 |
| `places this scan admits` | 1 |

**Model rule: [`AdmitStep`](../../verification/DoorScan.tla#L113)**

```tla
AdmitStep ==
  \E fact \in AdmitFacts :
    /\ (fact.listing = "one" => listing1Admitted = fact.before)
    /\ (fact.listing = "two" => listing2Admitted = fact.before)
    /\ listing1Admitted' =
         IF fact.listing = "one" THEN fact.after ELSE listing1Admitted
    /\ listing2Admitted' =
         IF fact.listing = "two" THEN fact.after ELSE listing2Admitted
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeAdmission(fact))
```

**Model rule: [`SafeAdmission`](../../verification/DoorScan.tla#L77)**

```tla
SafeAdmission(fact) ==
  /\ fact.after <= IF fact.listing = "one" THEN QuantityOne ELSE QuantityTwo
  /\ fact.after >= fact.before
  /\ fact.before >= 0
  /\ fact.refunded => fact.after = fact.before
  /\ fact.purchaseOnly => fact.after = fact.before
  /\ (fact.nonTransferable /\ ~fact.idVerified) => fact.after = fact.before
```

**Production code: [`src/features/admin/scan-decision.ts#decideScan`](../../src/features/admin/scan-decision.ts#L99)**

```ts
export const decideScan = (
  { entries, scope, force }: DoorAsk,
  checkInEveryListing: boolean,
  idVerified: boolean,
  count?: number,
): ScanDecision => { ... }
```

Source fingerprint: `sha256:13071671a8bc175d`

### Step 3: A second listing admits its own place

The scan selects listing two and admits its single owed place. A pick of one on two selected listings admits one place on each, not one place shared between them. The decision reports one unit for each selected listing.

| Value | This step |
| --- | --- |
| `listing two booked` | 1 |
| `admitted before` | 0 |
| `pick` | 1 |
| `admitted after` | 1 |

**Model rule: [`AdmitStep`](../../verification/DoorScan.tla#L113)**

```tla
AdmitStep ==
  \E fact \in AdmitFacts :
    /\ (fact.listing = "one" => listing1Admitted = fact.before)
    /\ (fact.listing = "two" => listing2Admitted = fact.before)
    /\ listing1Admitted' =
         IF fact.listing = "one" THEN fact.after ELSE listing1Admitted
    /\ listing2Admitted' =
         IF fact.listing = "two" THEN fact.after ELSE listing2Admitted
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeAdmission(fact))
```

**Production code: [`src/features/admin/scan-decision.ts#scanAdmits`](../../src/features/admin/scan-decision.ts#L76)**

```ts
export const scanAdmits = <Row>(
  widened: boolean,
  checkInEveryListing: boolean,
  owed: readonly Row[][],
): Row[][] => ...
```

Source fingerprint: `sha256:61889993290d9958`

**Production code: [`src/features/admin/scan-decision.ts#unitTickets`](../../src/features/admin/scan-decision.ts#L86)**

```ts
export const unitTickets: (units: readonly ScanUnit[]) => number = sumOf(
  (unit: ScanUnit) => unit.tickets,
);
```

Source fingerprint: `sha256:37efd19f6af90425`

### Step 4: A gate keeps the count unchanged

A refunded row grants no admission. A purchase-only listing sells with no door check-in. A non-transferable listing holds the place until the ID answer is true. A scan with more than one owed place and no quantity answer asks first. Each refusal keeps the count, so the fact adds no place.

| Value | This step |
| --- | --- |
| `refunded row` | before 2, after 2 |
| `non-transferable row without ID` | before 1, after 1 |
| `purchase-only row` | before 0, after 0 |
| `no quantity answer` | before 1, after 1 |

**Model rule: [`AdmitStep`](../../verification/DoorScan.tla#L113)**

```tla
AdmitStep ==
  \E fact \in AdmitFacts :
    /\ (fact.listing = "one" => listing1Admitted = fact.before)
    /\ (fact.listing = "two" => listing2Admitted = fact.before)
    /\ listing1Admitted' =
         IF fact.listing = "one" THEN fact.after ELSE listing1Admitted
    /\ listing2Admitted' =
         IF fact.listing = "two" THEN fact.after ELSE listing2Admitted
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeAdmission(fact))
```

**Model rule: [`SafeAdmission`](../../verification/DoorScan.tla#L77)**

```tla
SafeAdmission(fact) ==
  /\ fact.after <= IF fact.listing = "one" THEN QuantityOne ELSE QuantityTwo
  /\ fact.after >= fact.before
  /\ fact.before >= 0
  /\ fact.refunded => fact.after = fact.before
  /\ fact.purchaseOnly => fact.after = fact.before
  /\ (fact.nonTransferable /\ ~fact.idVerified) => fact.after = fact.before
```

**Production code: [`src/features/admin/scan-decision.ts#decideScan`](../../src/features/admin/scan-decision.ts#L99)**

```ts
export const decideScan = (
  { entries, scope, force }: DoorAsk,
  checkInEveryListing: boolean,
  idVerified: boolean,
  count?: number,
): ScanDecision => { ... }
```

Source fingerprint: `sha256:13071671a8bc175d`

### Step 5: Safety holds for every allowed scan

AdmitStep selects a fact that matches the current count on its listing. It moves only that listing and keeps the other total. Next also permits no change. Safety joins TypeOK, the safe verdict, and the two count bounds. A bad fact leaves the flag false, so a later safe fact cannot erase the failure.

| Value | This step |
| --- | --- |
| `listing one total` | 0 to 3 |
| `listing two total` | 0 to 1 |
| `all-facts-safe flag` | FALSE after one bad fact |

**Model rule: [`Next`](../../verification/DoorScan.tla#L127)**

```tla
Next ==
  AdmitStep \/
  UNCHANGED <<listing1Admitted, listing2Admitted, allFactsSafe>>
```

**Model rule: [`Safety`](../../verification/DoorScan.tla#L90)**

```tla
Safety ==
  /\ TypeOK
  /\ allFactsSafe
  /\ listing1Admitted <= QuantityOne
  /\ listing2Admitted <= QuantityTwo
  /\ listing1Admitted >= 0
  /\ listing2Admitted >= 0
```

**Production code: [`src/features/admin/scan-decision.ts#decideScan`](../../src/features/admin/scan-decision.ts#L99)**

```ts
export const decideScan = (
  { entries, scope, force }: DoorAsk,
  checkInEveryListing: boolean,
  idVerified: boolean,
  count?: number,
): ScanDecision => { ... }
```

Source fingerprint: `sha256:13071671a8bc175d`

**Production code: [`scripts/verify-models/door-scan.ts#representatives`](../../scripts/verify-models/door-scan.ts#L65)**

```ts
export const representatives = [
  { id: 1, name: "one", quantity: 3 },
  { id: 2, name: "two", quantity: 1 },
] as const;
```

Source fingerprint: `sha256:7bf8aaa7c06a0842`

## The safety claim

Every allowed state keeps each listing total between zero and its booked quantity. The all-facts-safe flag stays false after one bad fact.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use listing one with three booked places and listing two with one.
- The facts cover the supplied picks, gates, and scope choices, not every combination.
- The model assumes the fixture flags represent the ticket. It does not prove staff authority or a real ID check.
- It does not prove the SQL admission write, concurrent scans, or listing order.

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
