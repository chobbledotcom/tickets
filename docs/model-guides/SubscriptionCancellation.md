# One owner cancel and one failed checkout refund

[Read the model](../../verification/SubscriptionCancellation.tla).

This page follows an owner cancel and a failed checkout. An owner cancel records the final renewals before the row ends. A failed checkout keeps its zero-quantity plan, ends Stripe, and refunds at most once. A replay finishes stored work without a second provider refund.

## The bad outcome it rules out

A row ends while Stripe still charges, or a replay sends a second refund for one failed checkout.

## The cast

| Word | Meaning |
| --- | --- |
| **booking row** | One stored row that links an attendee to a listing and holds the subscription plan. |
| **plan** | The subscription id, price, tax, and period on the booking row, frozen at checkout. |
| **payment anchor** | A durable row that holds the right to finish one refund. A held anchor permits a later delivery to continue. |
| **final invoice** | One paid charge in the last billing period. The owner examples use two final invoices of 600 each. |
| **ledger leg** | One transfer row with a source account, a destination account, an amount, and a reference. |
| **delivery** | One run of the callback for one scenario. A repeated scenario has three deliveries on one retained database. |
| **guarded write** | A status write that changes a row only when the stored status still matches the value that the caller read. |

## The walkthrough

### Step 1: Start before any observation

The model starts before it applies any observed fact. It does not start from an empty application row. The producer runs each scenario in an isolated database. TypeOK bounds the selected table and index. The checkout fixture supplies a trialing subscription sub_failed for 600 GBP.

| Value | This step |
| --- | --- |
| `scenario` | none |
| `scenarioKind` | none |
| `scenarioIndex` | 0 |
| `attempt` | 0 |
| `allAttemptsSafe` | TRUE |

**Model rule: [`Init`](../../verification/SubscriptionCancellation.tla#L216)**

```tla
Init ==
  /\ scenario = "none" /\ scenarioKind = "none" /\ scenarioIndex = 0
  /\ attempt = 0 /\ allAttemptsSafe = Coverage
```

**Model rule: [`TypeOK`](../../verification/SubscriptionCancellation.tla#L92)**

```tla
TypeOK ==
  /\ scenarioKind \in {"none", "owner", "write", "checkout"}
  /\ scenarioIndex \in Int
  /\ IF scenarioKind = "none" THEN scenarioIndex = 0
     ELSE /\ scenarioIndex >= 1
          /\ scenarioIndex <=
               IF scenarioKind = "owner" THEN OwnersCount
               ELSE IF scenarioKind = "write" THEN WritesCount
               ELSE CheckoutsCount
  /\ scenario = ScenarioIdentity(scenarioKind, scenarioIndex)
  /\ attempt \in Nat
  /\ allAttemptsSafe \in BOOLEAN
```

**Production code: [`scripts/verify-models/subscriptions/cancellation-facts.ts#CANCELLATION_TABLES`](../../scripts/verify-models/subscriptions/cancellation-facts.ts#L5)**

```ts
export const CANCELLATION_TABLES = {
  checkouts: [
    "Checkouts",
    {
      after: "Str",
      attempt: "Int",
      attendeeId: "Int",
      authorityLocal: "Str",
      authorityReturned: "Int",
      authorityRows: "Int",
      bookingId: "Int",
      cancels: "Int",
      chargeNamed: "Bool",
      confirmed: "Bool",
      disposition: "Str",
      durableRefunded: "Bool",
      endOrder: "Int",
      entrypoint: "Str",
      failureStored: "Bool",
      held: "Int",
      heldAtCancel: "Int",
      invoiceIdentityKept: "Bool",
      invoiceReads: "Int",
      invoiceRequestId: "Str",
// ...
```

Source fingerprint: `sha256:2d54fb1879b822db`

**Production code: [`scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts#checkoutStart`](../../scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts#L42)**

```ts
export const checkoutStart = (
  status: SubscriptionStart["status"] = "trialing",
): SubscriptionStart => ...
```

Source fingerprint: `sha256:585293907510d698`

### Step 2: Every input needs exactly one fact

Coverage requires one fact for each expected input. The owner set has 27 scenarios. The checkout set has 31 single-delivery scenarios plus 4 repeated scenarios with 3 deliveries each, which makes 39 facts. The write set has 6 live snapshots, 8 before statuses, and 8 target statuses, which makes 384 facts. RepeatedScenarios names the four cases with three deliveries. ScenarioIdentity joins the selected table index back to the full scenario name. Coverage also requires each important answer to exist.

| Value | This step |
| --- | --- |
| `owner facts` | 27 |
| `checkout facts` | 39 |
| `write facts` | 384 |
| `repeated scenarios` | retry, placeholder, ledger-interrupted, anchorless |
| `write domain` | 6 live snapshots, 8 before statuses, 8 target statuses |

**Model rule: [`Coverage`](../../verification/SubscriptionCancellation.tla#L58)**

```tla
Coverage ==
  /\ Statuses = LiveStatuses \cup EndedStatuses
  /\ {o.scenario : o \in Owners} = ExpectedOwners
  /\ OwnersCount = Cardinality(ExpectedOwners)
  /\ {c.scenario : c \in Checkouts} = ExpectedCheckouts
  /\ CheckoutsCount = Cardinality(ExpectedCheckouts) + 2 * Cardinality(RepeatedScenarios)
  /\ \A name \in ExpectedCheckouts :
       \A pass \in (IF name \in RepeatedScenarios THEN 1..3 ELSE {1}) :
         \E c \in Checkouts : c.scenario = name /\ c.attempt = pass
  /\ WritesCount =
       Cardinality(LiveStatuses) * Cardinality(Statuses) * Cardinality(Statuses)
  /\ \A snapshot \in LiveStatuses, before \in Statuses, target \in Statuses :
       \E w \in Writes :
         w.snapshot = snapshot /\ w.before = before /\ w.target = target
  /\ \E o \in Owners :
       o.answer = "cancelled" /\ o.after \in EndedStatuses /\ o.cash = 1200
  /\ \E o \in Owners :
       o.answer = "behind" /\ o.after \in LiveStatuses /\ ~o.invoicesRead
  /\ \E o \in Owners : o.answer = "not_cancelled"
  /\ \E o \in Owners : o.answer = "threw"
  /\ \A affected \in {0, 1} : \E w \in Writes : w.affected = affected
  /\ \E c \in Checkouts : c.entrypoint = "placeholder" /\ c.refunded
  /\ \E c \in Checkouts : c.threw /\ c.held = 1 /\ c.refunds = 0
```

**Model rule: [`RepeatedScenarios`](../../verification/SubscriptionCancellation.tla#L29)**

```tla
RepeatedScenarios == {"retry", "placeholder", "ledger-interrupted", "anchorless"}

VARIABLES
  \* The last applied scenario is model evidence, not a database key.
  \* @type: Str;
  scenario,
  \* The table and one-based index retain the selected fact without a wide
  \* symbolic choice of scenario strings. "none" and zero denote Init.
  \* @type: Str;
  scenarioKind,
  \* @type: Int;
  scenarioIndex,
  \* The last delivery number, starting at zero before any observation.
  \* @type: Int;
  attempt,
  \* FALSE remembers any bad stored result. A later good result cannot hide it.
  \* This flag is model-only evidence, not an application column.
  \* @type: Bool;
  allAttemptsSafe
```

**Model rule: [`ScenarioIdentity`](../../verification/SubscriptionCancellation.tla#L85)**

```tla
ScenarioIdentity(kind, index) ==
  IF kind = "owner" THEN OwnersAt(index).scenario
  ELSE IF kind = "write" THEN WritesAt(index).scenario
  ELSE IF kind = "checkout" THEN CheckoutsAt(index).scenario
  ELSE "none"
```

**Production code: [`scripts/verify-models/subscriptions/cancellation.ts#cancellationFacts`](../../scripts/verify-models/subscriptions/cancellation.ts#L23)**

```ts
export const cancellationFacts = async (
  fault: CancellationFault = "none",
): Promise<CancellationFacts> => { ... }
```

Source fingerprint: `sha256:73e3f2ec5f3dd7e1`

**Production code: [`scripts/verify-models/subscriptions/cancellation-owner.ts#ownerFacts`](../../scripts/verify-models/subscriptions/cancellation-owner.ts#L125)**

```ts
export const ownerFacts = async (
  fault: CancellationFault,
): Promise<CancellationFacts["owners"]> => { ... }
```

Source fingerprint: `sha256:bd00019678ce52c0`

**Production code: [`scripts/verify-models/subscriptions/cancellation-checkout.ts#checkoutFacts`](../../scripts/verify-models/subscriptions/cancellation-checkout.ts#L184)**

```ts
export const checkoutFacts = async (
  fault: CancellationFault,
): Promise<CancellationFacts["checkouts"]> => { ... }
```

Source fingerprint: `sha256:b4f2e47feca9349b`

### Step 3: The owner cancel records both the end and the money

The owner cancels from the Subscriptions page. The production call cancels at Stripe, or reads the current status when the cancel is refused. A successful read records the final paid invoices and the ended status. The example has two final invoices of 600 each. The row then holds 1200 cash across 4 legs and the status canceled. The answer is cancelled only when the row holds the end. A refused invoice read returns behind and leaves the row live. The final invoices keep separate ids and event groups, so two equal payments cannot merge.

| Value | This step |
| --- | --- |
| `final invoices` | 2 at 600 each |
| `cash` | 1200 |
| `legs` | 4 |
| `row after` | canceled |
| `behind case` | invoice read refused. The row stays live. |

**Model rule: [`OwnerStep`](../../verification/SubscriptionCancellation.tla#L222)**

```tla
OwnerStep ==
  \E index \in OwnersIndices :
    LET o == OwnersAt(index) IN
    /\ scenarioKind' = "owner" /\ scenarioIndex' = index
    /\ scenario' = o.scenario /\ attempt' = o.attempt
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeOwner(o))
```

**Model rule: [`SafeOwner`](../../verification/SubscriptionCancellation.tla#L117)**

```tla
SafeOwner(o) ==
  /\ o.requestId = o.subscriptionId
  /\ (o.reads > 0 =>
       (o.readRequestId = o.subscriptionId /\ o.readIdentityKept))
  /\ (o.invoiceReads > 0 =>
       (o.invoiceRequestId = o.subscriptionId /\ o.invoiceIdentityKept))
  /\ o.planKept /\ o.quantity = 1
  /\ o.answer =
       IF o.threw THEN "threw"
       ELSE IF o.observed \notin EndedStatuses THEN "not_cancelled"
       ELSE IF o.invoicesRead THEN "cancelled"
       ELSE "behind"
  /\ (o.answer = "cancelled" => o.after \in EndedStatuses)
  \* An owner cancel reads the final invoices. A subscription in its first
  \* period has none, so a valid cancel can move no money.
  /\ o.finalInvoices \in {0, 2}
  /\ o.firstInvoice # o.secondInvoice /\ o.firstGroup # o.secondGroup
  /\ o.cash = o.firstCash + o.secondCash
  /\ o.legs = o.firstLegs + o.secondLegs
  /\ ((o.threw \/ ~o.invoicesRead \/ ~o.identityCurrent) =>
       (o.after = o.before /\ o.cash = 0 /\ o.legs = 0))
  /\ ((o.invoicesRead /\ o.identityCurrent /\ ~o.threw) =>
       IF o.finalInvoices = 2
       THEN (o.firstCash = 600 /\ o.secondCash = 600 /\
             o.firstLegs = 2 /\ o.secondLegs = 2)
       ELSE (o.firstCash = 0 /\ o.secondCash = 0 /\
             o.firstLegs = 0 /\ o.secondLegs = 0))
  /\ ((o.before \in LiveStatuses /\ o.after \in EndedStatuses) =>
       (o.invoicesRead /\ o.cash = 600 * o.finalInvoices /\
        o.legs = 2 * o.finalInvoices))
  /\ ((o.before \in EndedStatuses) => o.after \in EndedStatuses)
```

**Production code: [`src/shared/subscriptions/cancellation.ts#cancelOwnerSubscription`](../../src/shared/subscriptions/cancellation.ts#L48)**

```ts
export const cancelOwnerSubscription = async (
  row: LiveRow,
): Promise<OwnerCancel> => { ... }
```

Source fingerprint: `sha256:106c7909d6b4ec96`

**Production code: [`src/shared/subscriptions/record.ts#recordObserved`](../../src/shared/subscriptions/record.ts#L74)**

```ts
export const recordObserved = async (
  row: LiveRow,
  observed: SubscriptionStatus,
): Promise<boolean> => { ... }
```

Source fingerprint: `sha256:8edd9a6dda52752d`

**Production code: [`src/shared/subscriptions/plan.ts#SUBSCRIPTION_NODE_OF`](../../src/shared/subscriptions/plan.ts#L63)**

```ts
/** The state group of each status that Stripe reports. */
export const SUBSCRIPTION_NODE_OF: Record<
  SubscriptionStatus,
  "ended" | "live"
> = {
  active: "live",
  canceled: "ended",
  incomplete: "live",
  incomplete_expired: "ended",
  past_due: "live",
  paused: "live",
  trialing: "live",
  unpaid: "live",
};
```

Source fingerprint: `sha256:ee361f7434c5bc1e`

### Step 4: A stale live write changes no row

The status write compares the row state. An ended target replaces any live status. A live target replaces only the status that the caller read. The example tries a live target on a row that a cancel already ended. The update changes zero rows and the row stays canceled. A zero-row update is a normal refusal, not an exception. The model runs every combination of live snapshot, stored status, and target.

| Value | This step |
| --- | --- |
| `snapshot` | active |
| `before` | canceled |
| `target` | active |
| `affected` | 0. The row stays canceled. |
| `live to ended` | active before, canceled target, affected 1 |

**Model rule: [`WriteStep`](../../verification/SubscriptionCancellation.tla#L228)**

```tla
WriteStep ==
  \E index \in WritesIndices :
    LET w == WritesAt(index) IN
    /\ scenarioKind' = "write" /\ scenarioIndex' = index
    /\ scenario' = w.scenario /\ attempt' = w.attempt
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeWrite(w))
```

**Model rule: [`SafeWrite`](../../verification/SubscriptionCancellation.tla#L153)**

```tla
SafeWrite(w) ==
  LET mayWrite == IF w.target \in EndedStatuses
                 THEN w.before \in LiveStatuses
                 ELSE w.before = w.snapshot
  IN /\ w.after = (IF mayWrite THEN w.target ELSE w.before)
     /\ w.affected = (IF mayWrite THEN 1 ELSE 0)
```

**Production code: [`src/shared/db/subscriptions.ts#statusWrite`](../../src/shared/db/subscriptions.ts#L183)**

```ts
export const statusWrite = (
  row: LiveRow,
  status: SubscriptionStatus,
): SqlStatement => ...
```

Source fingerprint: `sha256:d9061c70c1f72e5b`

**Production code: [`scripts/verify-models/subscriptions/cancellation-owner.ts#guardedWriteFacts`](../../scripts/verify-models/subscriptions/cancellation-owner.ts#L214)**

```ts
export const guardedWriteFacts = (
  fault: CancellationFault,
): Promise<CancellationFacts["writes"]> => ...
```

Source fingerprint: `sha256:afecb9057c4cd05e`

**Production code: [`src/shared/db/subscriptions.ts#getSubscribedRowOrNull`](../../src/shared/db/subscriptions.ts#L109)**

```ts
export const getSubscribedRowOrNull = async (
  id: number,
): Promise<SubscribedRow | null> => { ... }
```

Source fingerprint: `sha256:5d318ef3b5fb1f3c`

### Step 5: A failed checkout keeps its plan and stops Stripe

A stored failed checkout keeps a plan with quantity zero. The callback stores the plan before it ends Stripe. The end must come before any refund. Delivery one holds the payment anchor and sends no refund. The row stays at quantity zero for a person to inspect. A booked row, an orphaned sale, an occupied callback, or a foreign proof permits no cancel and no refund.

| Value | This step |
| --- | --- |
| `attempt` | 1 |
| `quantity` | 0 |
| `plan rows` | 1. The plan is kept. |
| `refunds` | 0 |
| `held` | 1 |
| `authority returned` | 0 |

**Model rule: [`CheckoutStep`](../../verification/SubscriptionCancellation.tla#L234)**

```tla
CheckoutStep ==
  \E index \in CheckoutsIndices :
    LET c == CheckoutsAt(index) IN
    /\ scenarioKind' = "checkout" /\ scenarioIndex' = index
    /\ scenario' = c.scenario /\ attempt' = c.attempt
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeCheckout(c))
```

**Model rule: [`SafeCheckout`](../../verification/SubscriptionCancellation.tla#L171)**

```tla
SafeCheckout(c) ==
  /\ (c.planRows > 0 => c.planKept)
  /\ c.confirmed = (c.start \in EndedStatuses \/ c.observed \in EndedStatuses)
  /\ c.refundBeforeEnd = 0
  /\ c.refunds <= 1 /\ c.refundLegs <= 1
  /\ c.refundReference = (IF c.refunds > 0 THEN c.paymentReference ELSE "")
  /\ (c.cancels > 0 => c.requestId = c.subscriptionId)
  /\ (c.reads > 0 =>
       (c.readRequestId = c.subscriptionId /\ c.readIdentityKept))
  /\ (c.invoiceReads > 0 =>
       (c.invoiceRequestId = c.subscriptionId /\ c.invoiceIdentityKept))
  /\ (c.refunds > 0 =>
       (c.confirmed /\ (c.start \in EndedStatuses \/
         (c.endOrder > 0 /\ c.endOrder < c.refundOrder))))
  /\ (c.start \in EndedStatuses => (c.cancels = 0 /\ c.reads = 0))
  /\ (c.disposition \in {"booked", "orphaned", "occupied", "foreign"} =>
       (c.cancels = 0 /\ c.reads = 0 /\ c.refunds = 0))
  /\ (c.disposition = "anchorless" =>
       (c.refunds = 0 /\ (c.attempt > 1 => c.threw)))
  /\ ((c.owned /\ c.signedOrder /\ c.disposition \in {"failed", "anchorless"}) =>
       /\ c.planKept /\ c.planRows = 1 /\ c.quantity = 0 /\ c.after = c.start
       /\ c.bookingId > 0 /\ c.attendeeId > 0 /\ c.listingId = 1
       /\ (c.cancels > 0 => c.planAtCancel = 1))
  /\ ((c.owned /\ c.signedOrder /\ c.disposition = "failed") =>
       /\ ((c.chargeNamed /\ c.cancels > 0) => c.heldAtCancel = 1)
       /\ ((c.threw /\ ~c.confirmed /\ c.chargeNamed) =>
            (c.held = 1 /\ c.failureStored))
       /\ (c.durableRefunded =>
            (c.refundLegs = 1 /\ c.refundCash = 600 /\ c.paymentLegs = 1 /\
             c.authorityLocal = "recorded" /\ c.held = 0))
       /\ (c.authorityLocal = "recorded" =>
            (c.refundLegs = 1 /\ c.refundCash = 600 /\ c.held = 0))
       /\ ((c.authorityReturned = 600 /\ c.refundLegs = 0) =>
            (c.authorityLocal = "due" /\ c.held = 1)))
  /\ (c.refunded => (c.confirmed /\ c.refunds = 1 /\ c.authorityReturned = 600))
  /\ (c.threw => ~c.refunded)
```

**Production code: [`src/features/api/payment-processing/rejected-subscription.ts#settleRejectedSubscription`](../../src/features/api/payment-processing/rejected-subscription.ts#L256)**

```ts
export const settleRejectedSubscription: RejectionHandler<MalformedRejection> =
  ownedRejection((rejection) =>
    withRejectedSession(rejection.sessionId, (reservation) => {
      if (!reservation.reserved && reservation.existing.attendeeId !== null) {
        return NOTHING_TO_REFUND;
      }
      if (!reservation.reserved && reservation.existing.failureData === "") {
        return { ...NOTHING_TO_REFUND, settled: false };
      }
      return settleOwnedRejection(rejection, reservation);
    }),
  );
```

Source fingerprint: `sha256:34b30bfc88a05e9f`

**Production code: [`src/features/api/payment-processing/placeholder-resume.ts#finishPlaceholderRefund`](../../src/features/api/payment-processing/placeholder-resume.ts#L152)**

```ts
export const finishPlaceholderRefund = async (
  session: ValidatedPaymentSession,
  work: PlaceholderMoneyTarget,
): Promise<PlaceholderFailureResult> => { ... }
```

Source fingerprint: `sha256:ace30efb3373974f`

### Step 6: A retry finishes one refund

A later delivery repeats the same work. The second delivery ends Stripe and records one 600 refund. The third delivery repeats the same result and keeps one refund. No second provider refund appears in the facts. An anchorless failure sends no refund. A later anchorless delivery throws and calls no provider. A failed checkout that names a charge needs a held anchor at its cancel.

| Value | This step |
| --- | --- |
| `attempt 2` | refunds 1, cash 600, legs 1, held 0 |
| `attempt 3` | refunds 1. No second provider refund. |
| `anchorless retry` | throws on a later delivery without a held anchor |

**Model rule: [`SafeCheckout`](../../verification/SubscriptionCancellation.tla#L171)**

```tla
SafeCheckout(c) ==
  /\ (c.planRows > 0 => c.planKept)
  /\ c.confirmed = (c.start \in EndedStatuses \/ c.observed \in EndedStatuses)
  /\ c.refundBeforeEnd = 0
  /\ c.refunds <= 1 /\ c.refundLegs <= 1
  /\ c.refundReference = (IF c.refunds > 0 THEN c.paymentReference ELSE "")
  /\ (c.cancels > 0 => c.requestId = c.subscriptionId)
  /\ (c.reads > 0 =>
       (c.readRequestId = c.subscriptionId /\ c.readIdentityKept))
  /\ (c.invoiceReads > 0 =>
       (c.invoiceRequestId = c.subscriptionId /\ c.invoiceIdentityKept))
  /\ (c.refunds > 0 =>
       (c.confirmed /\ (c.start \in EndedStatuses \/
         (c.endOrder > 0 /\ c.endOrder < c.refundOrder))))
  /\ (c.start \in EndedStatuses => (c.cancels = 0 /\ c.reads = 0))
  /\ (c.disposition \in {"booked", "orphaned", "occupied", "foreign"} =>
       (c.cancels = 0 /\ c.reads = 0 /\ c.refunds = 0))
  /\ (c.disposition = "anchorless" =>
       (c.refunds = 0 /\ (c.attempt > 1 => c.threw)))
  /\ ((c.owned /\ c.signedOrder /\ c.disposition \in {"failed", "anchorless"}) =>
       /\ c.planKept /\ c.planRows = 1 /\ c.quantity = 0 /\ c.after = c.start
       /\ c.bookingId > 0 /\ c.attendeeId > 0 /\ c.listingId = 1
       /\ (c.cancels > 0 => c.planAtCancel = 1))
  /\ ((c.owned /\ c.signedOrder /\ c.disposition = "failed") =>
       /\ ((c.chargeNamed /\ c.cancels > 0) => c.heldAtCancel = 1)
       /\ ((c.threw /\ ~c.confirmed /\ c.chargeNamed) =>
            (c.held = 1 /\ c.failureStored))
       /\ (c.durableRefunded =>
            (c.refundLegs = 1 /\ c.refundCash = 600 /\ c.paymentLegs = 1 /\
             c.authorityLocal = "recorded" /\ c.held = 0))
       /\ (c.authorityLocal = "recorded" =>
            (c.refundLegs = 1 /\ c.refundCash = 600 /\ c.held = 0))
       /\ ((c.authorityReturned = 600 /\ c.refundLegs = 0) =>
            (c.authorityLocal = "due" /\ c.held = 1)))
  /\ (c.refunded => (c.confirmed /\ c.refunds = 1 /\ c.authorityReturned = 600))
  /\ (c.threw => ~c.refunded)
```

**Production code: [`src/features/api/payment-processing/placeholder-completion.ts#completePlaceholderMoney`](../../src/features/api/payment-processing/placeholder-completion.ts#L89)**

```ts
export const completePlaceholderMoney = async (
  completion: PlaceholderMoneyCompletion,
): Promise<{ posted: boolean }> => { ... }
```

Source fingerprint: `sha256:71b9f8c6de77b1f7`

**Production code: [`src/features/api/payment-processing/rejected-money.ts#completeRejectedMoney`](../../src/features/api/payment-processing/rejected-money.ts#L24)**

```ts
export const completeRejectedMoney =
  (facts: {
    readonly authority: RefundAuthorityRow;
    readonly intent: Pick<BookingIntent, "items">;
    readonly reference: TaggedPaymentReference;
    readonly returned: ReturnedRejectionReceipt;
    readonly sessionId: string;
    readonly spec: PlaceholderRefund;
  }) => ...
```

Source fingerprint: `sha256:2a5b501eaf9f28be`

**Production code: [`src/shared/payment/refund-authority.ts#markRefundCompleted`](../../src/shared/payment/refund-authority.ts#L158)**

```ts
export const markRefundCompleted = (
  state: RefundAuthorityState,
  completedAt: number,
  proof: "owner" | "provider",
): CompletedRefundState => { ... }
```

Source fingerprint: `sha256:14f4330328c3319c`

### Step 7: Safety joins every observed answer

Safety joins the type bounds with the memory of every bad observed result. The initial state sets allAttemptsSafe from Coverage, so a missing owner, checkout, or write fact fails at once. Next permits one owner fact, one write fact, one checkout evidence row, or no change. The model permits a pause. It does not require a retry to run.

| Value | This step |
| --- | --- |
| `allAttemptsSafe` | TRUE |
| `Next` | An owner fact, a write fact, a checkout fact, or no change. |

**Model rule: [`Safety`](../../verification/SubscriptionCancellation.tla#L213)**

```tla
Safety == TypeOK /\ allAttemptsSafe
```

**Model rule: [`Next`](../../verification/SubscriptionCancellation.tla#L243)**

```tla
Next == OwnerStep \/ WriteStep \/ CheckoutStep \/
        UNCHANGED <<scenario, scenarioKind, scenarioIndex, attempt, allAttemptsSafe>>
```

**Production code: [`src/shared/db/subscriptions.ts#getSubscribedRowOrNull`](../../src/shared/db/subscriptions.ts#L109)**

```ts
export const getSubscribedRowOrNull = async (
  id: number,
): Promise<SubscribedRow | null> => { ... }
```

Source fingerprint: `sha256:5d318ef3b5fb1f3c`

**Production code: [`src/shared/payment/refund-authority.ts#markRefundLocalRecorded`](../../src/shared/payment/refund-authority.ts#L178)**

```ts
export const markRefundLocalRecorded = (
  state: RefundAuthorityState,
  recordedAt: number,
): CompletedRefundState => { ... }
```

Source fingerprint: `sha256:3b5fe9245ccc0fae`

## The safety claim

An ended row follows an ended Stripe subscription and its final renewal money. A refund follows a confirmed external end. A replay keeps one refund and one refund leg.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use synthetic GBP charges of 600, two final renewals of 600, one month plan, all eight statuses, and selected interruptions.
- Provider replies are assumptions. They must be truthful and belong to the requested subscription id.
- The model assumes successful SQLite commit atomicity. It does not prove a real concurrent database race.
- The model does not prove provider network behavior, authentication, scheduler liveness, or Stripe truth.
- Other models check money arithmetic, checkout admission, and record edits.

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
