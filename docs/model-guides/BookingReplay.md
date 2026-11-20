# A repeat payment callback does not book a second ticket

[Read the model](../../verification/BookingReplay.tla).

This page follows one paid session through repeat provider callbacks and temporary row loss. The session creates at most one ticket. No delivery refunds a live ticket. The durable ledger label agrees with the ticket count.

## The bad outcome it rules out

A late callback books a second ticket. Or a callback refunds a live ticket after the temporary row disappears.

## The cast

| Word | Meaning |
| --- | --- |
| **session** | One checkout attempt. The same identity stands for its ledger event group and its temporary payment row. |
| **delivery** | One provider callback about that session. A replay answers from an earlier result and makes no new sale. |
| **ledger** | The durable record of money and amounts owed. unrecorded means no legs, booked means legs with a live attendee owner, and orphaned means legs with no live owner. |
| **row** | The temporary processed_payments row. none is absent, reserved is an unresolved reservation, and finalized is a successful result with its attendee id. |
| **ticket count** | The number of abstract ticket creations for this session. The model allows zero or one. |
| **no-refund flag** | A model-only memory of the refund verdict. It starts true and stays false after one bad refund. |
| **fact** | One prepared delivery outcome from the producer. The fact is not an observed callback or SQL race. |

## The walkthrough

### Step 1: Start before the first delivery

The model starts before any provider delivery. The classifier answers unrecorded when the session has no ledger legs. Init sets no temporary row and zero tickets.

| Value | This step |
| --- | --- |
| `ledger` | unrecorded |
| `row` | none |
| `ticket count` | 0 |
| `no-refund flag` | TRUE |

**Model rule: [`Init`](../../verification/BookingReplay.tla#L83)**

```tla
Init ==
  /\ ledger = "unrecorded"
  /\ row = "none"
  /\ bookings = 0
  /\ noRefundAfterHonoured = TRUE
```

**Model rule: [`TypeOK`](../../verification/BookingReplay.tla#L57)**

```tla
TypeOK ==
  /\ ledger \in LedgerStates
  /\ row \in RowStates
  /\ bookings \in 0..1
  /\ noRefundAfterHonoured \in BOOLEAN
```

**Production code: [`src/shared/session-ledger.ts#classifyBookingLedger`](../../src/shared/session-ledger.ts#L8)**

```ts
export const classifyBookingLedger = (
  hasLegs: boolean,
  ownerAttendeeId: number | null,
): BookingLedgerDisposition => ...
```

Source fingerprint: `sha256:6a54c7f6955610d2`

### Step 2: A reservation claims the temporary row

The reserve action exposes the gap after the session claims a row and before the outcome. Only an unrecorded session with no row can enter this gap. A duplicate delivery in this gap finds the reserved row and takes the held outcome from the producer table.

| Value | This step |
| --- | --- |
| `ledger` | unrecorded |
| `row before` | none |
| `row after` | reserved |
| `ticket count` | 0 |

**Model rule: [`ReserveStep`](../../verification/BookingReplay.tla#L110)**

```tla
ReserveStep ==
  /\ ledger = "unrecorded"
  /\ row = "none"
  /\ row' = "reserved"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>
```

**Production code: [`src/shared/session-ledger.ts#classifyBookingLedger`](../../src/shared/session-ledger.ts#L8)**

```ts
export const classifyBookingLedger = (
  hasLegs: boolean,
  ownerAttendeeId: number | null,
): BookingLedgerDisposition => ...
```

Source fingerprint: `sha256:6a54c7f6955610d2`

**Production code: [`scripts/verify-models/booking.ts#bookingReplayModelData`](../../scripts/verify-models/booking.ts#L113)**

```ts
export const bookingReplayModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(DELIVERIES),
);
```

Source fingerprint: `sha256:19e4a54443feed22`

### Step 3: A successful outcome adds one ticket

The success step writes the durable legs and the attendee owner. The classifier answers booked when the legs exist and the owner id is present. The step also finalizes the temporary row. The model assumes the batch boundary of these writes.

| Value | This step |
| --- | --- |
| `ledger before` | unrecorded |
| `row before` | reserved |
| `ledger after` | booked |
| `row after` | finalized |
| `ticket count` | 1 |

**Model rule: [`SettleReserved`](../../verification/BookingReplay.tla#L121)**

```tla
SettleReserved ==
  /\ ledger = "unrecorded"
  /\ row = "reserved"
  /\ ledger' = "booked"
  /\ row' = "finalized"
  /\ bookings' = bookings + 1
  /\ noRefundAfterHonoured' = noRefundAfterHonoured
```

**Production code: [`src/shared/session-ledger.ts#classifyBookingLedger`](../../src/shared/session-ledger.ts#L8)**

```ts
export const classifyBookingLedger = (
  hasLegs: boolean,
  ownerAttendeeId: number | null,
): BookingLedgerDisposition => ...
```

Source fingerprint: `sha256:6a54c7f6955610d2`

### Step 4: The temporary row can disappear

Cleanup removes only a reserved row. Retention or operator deletion removes a finalized row. The model permits both losses as disturbances. The durable ledger stays booked and the ticket count stays one.

| Value | This step |
| --- | --- |
| `cleanup` | reserved becomes none |
| `deletion` | finalized becomes none |
| `ledger` | booked |
| `ticket count` | 1 |

**Model rule: [`StaleCleanup`](../../verification/BookingReplay.tla#L131)**

```tla
StaleCleanup ==
  /\ row = "reserved"
  /\ row' = "none"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>
```

**Model rule: [`DeleteRow`](../../verification/BookingReplay.tla#L139)**

```tla
DeleteRow ==
  /\ row = "finalized"
  /\ row' = "none"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>
```

**Production code: [`scripts/verify-models/booking.ts#bookingReplayModelData`](../../scripts/verify-models/booking.ts#L113)**

```ts
export const bookingReplayModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(DELIVERIES),
);
```

Source fingerprint: `sha256:19e4a54443feed22`

### Step 5: A late callback replays and does not refund

A late delivery finds a booked ledger and no row. It claims the absent row and heals the row to finalized. It adds no ticket and no refund. The producer transcribes this outcome for the pair. The deleted-row control corrupts the same pair with a refund, and the checker rejects it.

| Value | This step |
| --- | --- |
| `ledger before` | booked |
| `row before` | none |
| `ledger after` | booked |
| `row after` | finalized |
| `tickets added` | 0 |
| `refund` | FALSE |

**Model rule: [`DeliveryStep`](../../verification/BookingReplay.tla#L96)**

```tla
DeliveryStep ==
  \E fact \in DeliveryFacts :
    /\ fact.ledgerBefore = ledger
    /\ fact.rowBefore = row
    /\ ledger' = fact.ledgerAfter
    /\ row' = fact.rowAfter
    /\ bookings' = bookings + IF fact.books THEN 1 ELSE 0
    /\ noRefundAfterHonoured' =
         ChecksStillPass(noRefundAfterHonoured, ~RefundsWhenHonoured(fact))
```

**Production code: [`scripts/verify-models/booking.ts#bookingReplayModelData`](../../scripts/verify-models/booking.ts#L113)**

```ts
export const bookingReplayModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(DELIVERIES),
);
```

Source fingerprint: `sha256:19e4a54443feed22`

**Production code: [`scripts/verify-models/booking.ts#deletedRowRefundData`](../../scripts/verify-models/booking.ts#L129)**

```ts
export const deletedRowRefundData: ModelDataSource = corruptedModelData(
  (delivery) =>
    delivery.ledgerBefore === "booked" && delivery.rowBefore === "none"
      ? { ...delivery, refunds: true }
      : delivery,
);
```

Source fingerprint: `sha256:7117ddf6d3967cff`

### Step 6: Safety joins the count, the label, and the verdict

RefundsWhenHonoured calls a refund unsafe only when the ledger before the delivery says booked. LedgerMatchesBookings requires a booked label exactly when the count is at least one. Safety joins TypeOK, the no-refund flag, and that relation. Next permits a delivery, the reserve, the settle, either row loss, or no change. The duplicate control makes every delivery on a booked ledger book again, and the checker rejects it.

| Value | This step |
| --- | --- |
| `booked ledger` | The ticket count is at least one. |
| `no legs` | The ticket count is zero. |
| `unsafe refund` | The ledger before the delivery says booked and the fact refunds. |

**Model rule: [`Next`](../../verification/BookingReplay.tla#L148)**

```tla
Next ==
  DeliveryStep \/ ReserveStep \/ SettleReserved \/ StaleCleanup \/ DeleteRow \/
  UNCHANGED <<ledger, row, bookings, noRefundAfterHonoured>>
```

**Model rule: [`Safety`](../../verification/BookingReplay.tla#L77)**

```tla
Safety ==
  /\ TypeOK
  /\ noRefundAfterHonoured
  /\ LedgerMatchesBookings
```

**Model rule: [`RefundsWhenHonoured`](../../verification/BookingReplay.tla#L66)**

```tla
RefundsWhenHonoured(fact) == fact.ledgerBefore = "booked" /\ fact.refunds
```

**Model rule: [`LedgerMatchesBookings`](../../verification/BookingReplay.tla#L70)**

```tla
LedgerMatchesBookings ==
  (bookings >= 1) = (ledger = "booked")
```

**Production code: [`src/shared/session-ledger.ts#classifyBookingLedger`](../../src/shared/session-ledger.ts#L8)**

```ts
export const classifyBookingLedger = (
  hasLegs: boolean,
  ownerAttendeeId: number | null,
): BookingLedgerDisposition => ...
```

Source fingerprint: `sha256:6a54c7f6955610d2`

**Production code: [`scripts/verify-models/booking.ts#duplicateBookingData`](../../scripts/verify-models/booking.ts#L119)**

```ts
export const duplicateBookingData: ModelDataSource = corruptedModelData(
  (delivery) =>
    delivery.ledgerBefore === "booked"
      ? { ...delivery, books: true }
      : delivery,
);
```

Source fingerprint: `sha256:8b33ece63e8b6e25`

## The safety claim

Every allowed state keeps the ticket count in step with the booked ledger label. Every delivery that starts on a booked ledger keeps the no-refund flag true.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The model uses one session and the three ledger labels, two of them with legs.
- It does not model amounts, provider request identity, or a real provider payload.
- It assumes the atomic boundary of the ticket write. It does not prove SQL atomicity or row locks.
- It does not prove that a callback or a cleanup ever occurs.

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
