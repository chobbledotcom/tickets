# The scheduled check and the owner cancel keep one paid renewal

[Read the model](../../verification/SubscriptionLifecycle.tla).

This page follows one booking row through the scheduled check and the owner cancel. A row becomes ended only when Stripe ends and every paid renewal sits in the ledger. The ledger never holds a renewal that Stripe does not hold as paid.

## The bad outcome it rules out

An ended row holds a paid renewal out of the ledger, or a refused read removes money that the row already holds.

## The cast

| Word | Meaning |
| --- | --- |
| **booking row** | One stored row that links an attendee to a listing and holds the subscription status word. |
| **stored** | The status word in the booking row. It is a database column. |
| **provider** | The status word that Stripe holds. It is model state, not a database column. |
| **renewal** | One later payment of the plan. The model stops at one renewal for each row. |
| **ledger** | The transfer rows that record money for the row. The model counts the renewal legs. |
| **move** | One prepared command result. The producer runs the real command before it supplies the values. |
| **live and ended** | The two status groups. Live has active, incomplete, past_due, paused, trialing, and unpaid. Ended has canceled and incomplete_expired. |

## The walkthrough

### Step 1: Start at the first checkout

The model starts at the first checkout. The row holds the status that Stripe reported. The plan has no renewal yet. The producer prepares one move for each command, reply, status pair, and ledger pair. Coverage requires every status and each important result to exist. The seed data is not a live subscription.

| Value | This step |
| --- | --- |
| `stored` | active |
| `provider` | active |
| `paid` | 0 |
| `recorded` | 0 |
| `example domain` | 2 commands, 3 Stripe replies, 8 stored statuses, 8 Stripe statuses, and 3 ledger pairs. That makes 1152 moves. |

**Model rule: [`Init`](../../verification/SubscriptionLifecycle.tla#L114)**

```tla
Init ==
  /\ stored \in Statuses /\ provider = stored
  /\ paid = 0 /\ recorded = 0
  /\ movesSafe = Coverage
```

**Model rule: [`TypeOK`](../../verification/SubscriptionLifecycle.tla#L65)**

```tla
TypeOK ==
  /\ stored \in Statuses
  /\ provider \in Statuses
  /\ paid \in {0, 1}
  /\ recorded \in Nat
  /\ movesSafe \in BOOLEAN
```

**Model rule: [`Coverage`](../../verification/SubscriptionLifecycle.tla#L48)**

```tla
Coverage ==
  /\ Statuses = LiveStatuses \cup EndedStatuses
  /\ MovesCount = ExpectedMovesCount
  /\ \E m \in Moves :
       m.outcome = "cancelled" /\ m.recordedAfter > m.recorded
  /\ \E m \in Moves : m.outcome = "behind"
  /\ \E m \in Moves : m.outcome = "not_cancelled"
  /\ \E m \in Moves : m.outcome = "ended"
  /\ \E m \in Moves :
       /\ m.command = "check" /\ m.stored \in LiveStatuses
       /\ m.storedAfter \in EndedStatuses /\ m.recordedAfter > m.recorded
  /\ \E m \in Moves :
       /\ m.command = "check" /\ m.storedAfter \in LiveStatuses
       /\ m.storedAfter # m.stored
```

**Production code: [`src/shared/subscriptions/plan.ts#planOfStart`](../../src/shared/subscriptions/plan.ts#L116)**

```ts
export const planOfStart = (
  start: SubscriptionStart,
  policy: TaxPolicy,
): SubscriptionPlan => ...
```

Source fingerprint: `sha256:66eea72fce6fd20f`

**Production code: [`scripts/verify-models/subscriptions/lifecycle-facts.ts#lifecycleCases`](../../scripts/verify-models/subscriptions/lifecycle-facts.ts#L87)**

```ts
export const lifecycleCases = (): LifecycleCase[] => { ... }
```

Source fingerprint: `sha256:4ce1457a3ae2f5bc`

### Step 2: Stripe moves on its own

Stripe can change a live subscription to any status and can take one renewal payment. This step is an assumption about Stripe. The booking row does not change. A subscription that Stripe ends stays live in the row until a command records the end. An ended Stripe subscription does not change and takes no payment.

| Value | This step |
| --- | --- |
| `provider` | active, then canceled |
| `paid` | 0, then 1 |
| `stored` | active, unchanged |
| `recorded` | 0, unchanged |

**Model rule: [`ProviderStep`](../../verification/SubscriptionLifecycle.tla#L122)**

```tla
ProviderStep ==
  /\ provider \in LiveStatuses
  /\ provider' \in Statuses
  /\ paid' \in {paid, 1}
  /\ UNCHANGED <<stored, recorded, movesSafe>>
```

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

### Step 3: One move runs at its own position

The producer lists every expected move before it runs. Each move keeps its position in that list. A move can run only from the state that it started in. The checker applies a move at its own position. A move from another state changes no stored value, and the model still checks that move. The model keeps no second result for one position.

| Value | This step |
| --- | --- |
| `move position` | 17 |
| `state` | active stored, active provider, 0 paid, 0 recorded |
| `command` | check |

**Model rule: [`StartsHere`](../../verification/SubscriptionLifecycle.tla#L130)**

```tla
StartsHere(m) ==
  /\ m.stored = stored /\ m.provider = provider
  /\ m.paid = paid /\ m.recorded = recorded
```

**Model rule: [`CommandStep`](../../verification/SubscriptionLifecycle.tla#L139)**

```tla
CommandStep ==
  \E index \in MovesIndices :
    LET m == MovesAt(index) IN
    /\ movesSafe' =
         ChecksStillPass(movesSafe, m.position = index /\ MoveLaw(m))
    /\ stored' = (IF StartsHere(m) THEN m.storedAfter ELSE stored)
    /\ provider' = (IF StartsHere(m) THEN m.providerAfter ELSE provider)
    /\ recorded' = (IF StartsHere(m) THEN m.recordedAfter ELSE recorded)
    /\ paid' = paid
```

**Production code: [`src/shared/subscriptions/record.ts#recordStripeReport`](../../src/shared/subscriptions/record.ts#L102)**

```ts
export const recordStripeReport = async (row: LiveRow): Promise<boolean> => { ... }
```

Source fingerprint: `sha256:b99028802d8de7fa`

**Production code: [`scripts/verify-models/subscriptions/lifecycle-facts.ts#lifecycleScenario`](../../scripts/verify-models/subscriptions/lifecycle-facts.ts#L61)**

```ts
export const lifecycleScenario = (sample: LifecycleCase): string => ...
```

Source fingerprint: `sha256:59f85f621bfc3407`

### Step 4: The check records the last renewal with the end

Stripe ends the subscription after one more paid renewal. The row still says active and holds no renewal. The scheduled check reads the Stripe status and the paid invoices. The write records the renewal and the ended status in one batch. The row can become ended only in a write that also records the renewal.

| Value | This step |
| --- | --- |
| `command` | check |
| `reply` | answers |
| `stored` | active, then canceled |
| `provider` | canceled |
| `paid` | 1 |
| `recorded` | 0, then 1 |
| `outcome` | returned |

**Model rule: [`CommandStep`](../../verification/SubscriptionLifecycle.tla#L139)**

```tla
CommandStep ==
  \E index \in MovesIndices :
    LET m == MovesAt(index) IN
    /\ movesSafe' =
         ChecksStillPass(movesSafe, m.position = index /\ MoveLaw(m))
    /\ stored' = (IF StartsHere(m) THEN m.storedAfter ELSE stored)
    /\ provider' = (IF StartsHere(m) THEN m.providerAfter ELSE provider)
    /\ recorded' = (IF StartsHere(m) THEN m.recordedAfter ELSE recorded)
    /\ paid' = paid
```

**Model rule: [`MoveLaw`](../../verification/SubscriptionLifecycle.tla#L88)**

```tla
MoveLaw(m) ==
  /\ m.otherLegs = 0
  /\ m.recordedAfter >= m.recorded
  /\ m.reads <= 1 /\ m.cancels <= 1 /\ m.invoiceReads <= 1
  /\ (m.stored \in EndedStatuses =>
       /\ m.storedAfter = m.stored /\ m.recordedAfter = m.recorded
       /\ m.providerAfter = m.provider
       /\ m.reads = 0 /\ m.cancels = 0 /\ m.invoiceReads = 0)
  /\ (m.providerAfter # m.provider =>
       /\ m.command = "cancel" /\ m.cancels = 1
       /\ m.provider \in LiveStatuses /\ m.providerAfter \in EndedStatuses)
  /\ (m.command = "check" => (m.cancels = 0 /\ m.outcome = "returned"))
  /\ (m.command = "cancel" =>
       /\ m.outcome \in {"cancelled", "behind", "not_cancelled", "ended"}
       /\ (m.outcome = "ended") = (m.stored \in EndedStatuses)
       /\ (m.outcome = "cancelled" => m.storedAfter \in EndedStatuses)
       /\ (m.outcome = "behind" =>
            (m.providerAfter \in EndedStatuses /\ m.storedAfter = m.stored))
       /\ (m.outcome = "not_cancelled" => m.storedAfter \in LiveStatuses))
```

**Production code: [`src/shared/subscriptions/status-check.ts#runSubscriptionCheck`](../../src/shared/subscriptions/status-check.ts#L16)**

```ts
export const runSubscriptionCheck = async ({
  checkpoint,
  requestFollowUp,
  setCheckpoint,
}: MaintenanceTaskContext): Promise<void> => { ... }
```

Source fingerprint: `sha256:ef639e4db54fc7b1`

**Production code: [`src/shared/subscriptions/record.ts#recordObserved`](../../src/shared/subscriptions/record.ts#L74)**

```ts
export const recordObserved = async (
  row: LiveRow,
  observed: SubscriptionStatus,
): Promise<boolean> => { ... }
```

Source fingerprint: `sha256:8edd9a6dda52752d`

### Step 5: The owner cancels from the Subscriptions page

The owner cancels one subscription. The production call cancels at Stripe, then records the status and the final paid invoices. A successful write returns cancelled and the row ends. A refused invoice read returns behind. Stripe ended the subscription but the row stays live, so a later check can still record its money. An ended row returns ended and sends no request.

| Value | This step |
| --- | --- |
| `command` | cancel |
| `stored` | active |
| `provider` | active, then canceled |
| `outcome` | cancelled |
| `behind case` | invoice read refused. The row stays active. |

**Model rule: [`MoveLaw`](../../verification/SubscriptionLifecycle.tla#L88)**

```tla
MoveLaw(m) ==
  /\ m.otherLegs = 0
  /\ m.recordedAfter >= m.recorded
  /\ m.reads <= 1 /\ m.cancels <= 1 /\ m.invoiceReads <= 1
  /\ (m.stored \in EndedStatuses =>
       /\ m.storedAfter = m.stored /\ m.recordedAfter = m.recorded
       /\ m.providerAfter = m.provider
       /\ m.reads = 0 /\ m.cancels = 0 /\ m.invoiceReads = 0)
  /\ (m.providerAfter # m.provider =>
       /\ m.command = "cancel" /\ m.cancels = 1
       /\ m.provider \in LiveStatuses /\ m.providerAfter \in EndedStatuses)
  /\ (m.command = "check" => (m.cancels = 0 /\ m.outcome = "returned"))
  /\ (m.command = "cancel" =>
       /\ m.outcome \in {"cancelled", "behind", "not_cancelled", "ended"}
       /\ (m.outcome = "ended") = (m.stored \in EndedStatuses)
       /\ (m.outcome = "cancelled" => m.storedAfter \in EndedStatuses)
       /\ (m.outcome = "behind" =>
            (m.providerAfter \in EndedStatuses /\ m.storedAfter = m.stored))
       /\ (m.outcome = "not_cancelled" => m.storedAfter \in LiveStatuses))
```

**Production code: [`src/shared/subscriptions/cancellation.ts#cancelOwnerSubscription`](../../src/shared/subscriptions/cancellation.ts#L48)**

```ts
export const cancelOwnerSubscription = async (
  row: LiveRow,
): Promise<OwnerCancel> => { ... }
```

Source fingerprint: `sha256:106c7909d6b4ec96`

**Production code: [`src/features/admin/subscriptions.ts#adminHandlers`](../../src/features/admin/subscriptions.ts#L101)**

```ts
export const adminHandlers = defineAdminRoutes({
  "GET /admin/subscriptions": handleSubscriptionsGet,
  "POST /admin/subscriptions/:id/cancel": handleSubscriptionCancelPost,
});
```

Source fingerprint: `sha256:98a15a1967c56709`

### Step 6: An ended row holds all its money

The ledger never holds more renewals than Stripe. An ended row needs an ended Stripe subscription and every paid renewal in the ledger. A refused read or a refused write changes no stored value. An ended row takes no command at all. No command posts a leg for another row. The scheduled check reads live rows only.

| Value | This step |
| --- | --- |
| `stored` | canceled |
| `provider` | canceled |
| `paid` | 1 |
| `recorded` | 1 |
| `refused read` | No stored value changes. |

**Model rule: [`MoveLaw`](../../verification/SubscriptionLifecycle.tla#L88)**

```tla
MoveLaw(m) ==
  /\ m.otherLegs = 0
  /\ m.recordedAfter >= m.recorded
  /\ m.reads <= 1 /\ m.cancels <= 1 /\ m.invoiceReads <= 1
  /\ (m.stored \in EndedStatuses =>
       /\ m.storedAfter = m.stored /\ m.recordedAfter = m.recorded
       /\ m.providerAfter = m.provider
       /\ m.reads = 0 /\ m.cancels = 0 /\ m.invoiceReads = 0)
  /\ (m.providerAfter # m.provider =>
       /\ m.command = "cancel" /\ m.cancels = 1
       /\ m.provider \in LiveStatuses /\ m.providerAfter \in EndedStatuses)
  /\ (m.command = "check" => (m.cancels = 0 /\ m.outcome = "returned"))
  /\ (m.command = "cancel" =>
       /\ m.outcome \in {"cancelled", "behind", "not_cancelled", "ended"}
       /\ (m.outcome = "ended") = (m.stored \in EndedStatuses)
       /\ (m.outcome = "cancelled" => m.storedAfter \in EndedStatuses)
       /\ (m.outcome = "behind" =>
            (m.providerAfter \in EndedStatuses /\ m.storedAfter = m.stored))
       /\ (m.outcome = "not_cancelled" => m.storedAfter \in LiveStatuses))
```

**Model rule: [`StateSafe`](../../verification/SubscriptionLifecycle.tla#L75)**

```tla
StateSafe ==
  /\ recorded <= paid
  /\ (stored \in EndedStatuses =>
       (provider \in EndedStatuses /\ recorded = paid))
```

**Production code: [`src/shared/db/subscriptions.ts#statusWrite`](../../src/shared/db/subscriptions.ts#L183)**

```ts
export const statusWrite = (
  row: LiveRow,
  status: SubscriptionStatus,
): SqlStatement => ...
```

Source fingerprint: `sha256:d9061c70c1f72e5b`

**Production code: [`src/shared/db/subscriptions.ts#renewalBookingGuard`](../../src/shared/db/subscriptions.ts#L157)**

```ts
export const renewalBookingGuard = (row: LiveRow): SqlStatement => ...
```

Source fingerprint: `sha256:b90637c8e71bf7bc`

**Production code: [`src/shared/db/subscriptions.ts#getCheckedRows`](../../src/shared/db/subscriptions.ts#L122)**

```ts
export const getCheckedRows = async (
  afterId: number,
  limit: number,
): Promise<LiveRow[]> => ...
```

Source fingerprint: `sha256:ec7fdae1c90e1611`

### Step 7: Safety keeps every earlier refusal

Safety joins the type bounds, the ledger law, and the memory of every broken move law. A later good move cannot hide an earlier bad result. Next permits a Stripe change, one command, or no change. The model does not require a check to run.

| Value | This step |
| --- | --- |
| `movesSafe` | TRUE |
| `Next` | A Stripe change, one command, or no change. |

**Model rule: [`Safety`](../../verification/SubscriptionLifecycle.tla#L110)**

```tla
Safety == TypeOK /\ StateSafe /\ movesSafe
```

**Model rule: [`Next`](../../verification/SubscriptionLifecycle.tla#L151)**

```tla
Next == ProviderStep \/ CommandStep \/
        UNCHANGED <<stored, provider, paid, recorded, movesSafe>>
```

**Production code: [`src/shared/payment/subscription-machine-spec.ts#isCancellable`](../../src/shared/payment/subscription-machine-spec.ts#L133)**

```ts
export const isCancellable = isOneOf(CANCELLABLE_STATUSES);
```

Source fingerprint: `sha256:529d7c3688f837b9`

**Production code: [`src/shared/subscriptions/status-check.ts#runSubscriptionCheck`](../../src/shared/subscriptions/status-check.ts#L16)**

```ts
export const runSubscriptionCheck = async ({
  checkpoint,
  requestFollowUp,
  setCheckpoint,
}: MaintenanceTaskContext): Promise<void> => { ... }
```

Source fingerprint: `sha256:ef639e4db54fc7b1`

## The safety claim

Every accepted step keeps recorded renewals at or below Stripe's paid renewals. A row that ends has an ended Stripe subscription and all its paid renewals. No command removes a recorded renewal or posts a leg for another row.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use one row, one month plan of 600 with no tax, at most one renewal, and all eight statuses.
- The commands run one after another. A command that overlaps another belongs to SubscriptionCancellation.
- Stripe replies are assumptions. The model does not prove provider truth or a provider network.
- The model reads one command result. SQL batch atomicity and the real scheduler need separate tests.
- The model checks safety. It does not prove that a check runs or that a retry finishes.

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
