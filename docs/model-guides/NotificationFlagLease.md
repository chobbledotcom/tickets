# Lease two notification flags between two recoveries

[Read the model](../../verification/NotificationFlagLease.tla).

This page follows two recoveries on one attendee. A claim reserves each positive flag and remembers its colour. A restore writes that exact colour back. A clear removes the debt only after an external send accepts.

## The bad outcome it rules out

A recovery clears an owed send and loses its origin, or two recoveries both claim the same work.

## The cast

| Word | Meaning |
| --- | --- |
| **attendee** | The customer record that holds a buyer's booked places. |
| **notification** | One message that the application owes after a booking. Email and webhooks are separate sides. |
| **flag** | A small stored integer on the attendee. A positive value says a send is still due. Zero says no stored debt. |
| **colour** | The origin that a positive flag records. Colour 1 is online and shows red. Colour 2 is admin-added and shows orange. |
| **lease** | The model memory of work that a claim reserved. A claim sets the stored flags to zero and remembers their colours. The application stores no lease row. |
| **capture** | The exact flag colour that a claim read. A restore must write this value back. |
| **worker** | One recovery caller. The examples use w1 and w2. |
| **fact** | The result of one production statement. It is not a live database event. |

## The walkthrough

### Step 1: Start with two owed sends

The model starts with one attendee who owes an email and a webhook. The two colours differ, so a restore that writes one fixed colour is visible. Real flags need not have this mixture. Workers names the two recovery callers w1 and w2. TypeOK limits each flag to 0, 1, or 2 and each holder to none, w1, or w2.

| Value | This step |
| --- | --- |
| `storedEmail` | 2 (admin-added, orange) |
| `storedWebhooks` | 1 (online, red) |
| `emailLeased` | FALSE |
| `emailCaptured` | 0 |
| `emailHolder` | none |
| `allFactsSafe` | TRUE |

**Model rule: [`Init`](../../verification/NotificationFlagLease.tla#L153)**

```tla
Init ==
  /\ storedEmail = 2
  /\ storedWebhooks = 1
  /\ emailLeased = FALSE
  /\ webhooksLeased = FALSE
  /\ emailCaptured = 0
  /\ webhooksCaptured = 0
  /\ emailHolder = "none"
  /\ webhooksHolder = "none"
  /\ allFactsSafe = TRUE
```

**Model rule: [`TypeOK`](../../verification/NotificationFlagLease.tla#L81)**

```tla
TypeOK ==
  /\ storedEmail \in 0..2
  /\ storedWebhooks \in 0..2
  /\ emailLeased \in BOOLEAN
  /\ webhooksLeased \in BOOLEAN
  /\ emailCaptured \in 0..2
  /\ webhooksCaptured \in 0..2
  /\ emailHolder \in {"none"} \cup Workers
  /\ webhooksHolder \in {"none"} \cup Workers
  /\ allFactsSafe \in BOOLEAN
```

**Model rule: [`Workers`](../../verification/NotificationFlagLease.tla#L78)**

```tla
Workers == {"w1", "w2"}
```

**Production code: [`scripts/verify-models/notification-flag-lease.ts#REPRESENTATIVE`](../../scripts/verify-models/notification-flag-lease.ts#L32)**

```ts
export const REPRESENTATIVE = {
  email: PENDING_NOTIFICATION.admin,
  webhooks: PENDING_NOTIFICATION.online,
};
```

Source fingerprint: `sha256:f6598883fd657b40`

**Production code: [`src/shared/db/attendees/notification-flags.ts#PENDING_NOTIFICATION`](../../src/shared/db/attendees/notification-flags.ts#L32)**

```ts
export const PENDING_NOTIFICATION = {
  /** A send is owed for a person an admin added by hand (orange badge). */
  admin: 2,
  /** No send is owed. */
  none: 0,
  /** A send is owed for a person who booked online (red badge). */
  online: 1,
} as const satisfies Record<string, PendingNotificationFlag>;
```

Source fingerprint: `sha256:b668352e4ecb6adf`

### Step 2: Claim both sides for w1

The claim reads both flags and writes them to zero in one transaction. It returns the two colours. ClaimValueCaptured requires a positive before-value on each claimed side and no claim on a zero side. The stored flag stays zero while the lease holds the work, so SendStaysOwed keeps the debt in the captured value. The worker name records the holder.

| Value | This step |
| --- | --- |
| `beforeEmail` | 2 |
| `beforeWebhooks` | 1 |
| `claimsEmail` | TRUE |
| `claimsWebhooks` | TRUE |
| `worker` | w1 |
| `storedEmailAfter` | 0 |
| `storedWebhooksAfter` | 0 |
| `emailCaptured` | 2 |
| `webhooksCaptured` | 1 |
| `emailHolder` | w1 |

**Model rule: [`ClaimStep`](../../verification/NotificationFlagLease.tla#L168)**

```tla
ClaimStep ==
  \E fact \in ClaimFacts :
    /\ storedEmail = fact.beforeEmail
    /\ storedWebhooks = fact.beforeWebhooks
    /\ storedEmail' = 0
    /\ storedWebhooks' = 0
    /\ emailLeased' = IF fact.claimsEmail THEN TRUE ELSE emailLeased
    /\ emailCaptured' = IF fact.claimsEmail THEN fact.beforeEmail ELSE emailCaptured
    /\ webhooksLeased' = IF fact.claimsWebhooks THEN TRUE ELSE webhooksLeased
    /\ webhooksCaptured' =
         IF fact.claimsWebhooks THEN fact.beforeWebhooks ELSE webhooksCaptured
    /\ emailHolder' = IF fact.claimsEmail THEN fact.worker ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.claimsWebhooks THEN fact.worker ELSE webhooksHolder
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, ClaimValueCaptured(fact))
```

**Model rule: [`ClaimValueCaptured`](../../verification/NotificationFlagLease.tla#L95)**

```tla
ClaimValueCaptured(fact) ==
  /\ fact.claimsEmail <=> fact.beforeEmail > 0
  /\ fact.claimsWebhooks <=> fact.beforeWebhooks > 0
```

**Model rule: [`SendStaysOwed`](../../verification/NotificationFlagLease.tla#L127)**

```tla
SendStaysOwed ==
  /\ (emailLeased => storedEmail = 0)
  /\ (webhooksLeased => storedWebhooks = 0)
```

**Production code: [`src/shared/db/attendees/notification-flags.ts#claimOutstandingNotificationFlags`](../../src/shared/db/attendees/notification-flags.ts#L95)**

```ts
export const claimOutstandingNotificationFlags = async (
  attendeeId: number,
): Promise<ClaimedNotificationSide[]> => ...
```

Source fingerprint: `sha256:af78ae402dadd9d5`

### Step 3: A second worker claims nothing

Worker w2 runs after the claim. It reads zero on both sides, so it captures nothing and keeps the live lease. One scalar holder for each side records the single owner. The claim facts cover both workers and every before-value that the representative can hold. The model assumes an atomic claim read and write, so it does not prove the SQL race.

| Value | This step |
| --- | --- |
| `beforeEmail` | 0 |
| `beforeWebhooks` | 0 |
| `worker` | w2 |
| `claimsEmail` | FALSE |
| `claimsWebhooks` | FALSE |
| `emailHolder` | w1 |
| `webhooksHolder` | w1 |
| `emailCaptured` | 2 |
| `webhooksCaptured` | 1 |

**Model rule: [`ClaimStep`](../../verification/NotificationFlagLease.tla#L168)**

```tla
ClaimStep ==
  \E fact \in ClaimFacts :
    /\ storedEmail = fact.beforeEmail
    /\ storedWebhooks = fact.beforeWebhooks
    /\ storedEmail' = 0
    /\ storedWebhooks' = 0
    /\ emailLeased' = IF fact.claimsEmail THEN TRUE ELSE emailLeased
    /\ emailCaptured' = IF fact.claimsEmail THEN fact.beforeEmail ELSE emailCaptured
    /\ webhooksLeased' = IF fact.claimsWebhooks THEN TRUE ELSE webhooksLeased
    /\ webhooksCaptured' =
         IF fact.claimsWebhooks THEN fact.beforeWebhooks ELSE webhooksCaptured
    /\ emailHolder' = IF fact.claimsEmail THEN fact.worker ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.claimsWebhooks THEN fact.worker ELSE webhooksHolder
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, ClaimValueCaptured(fact))
```

**Model rule: [`ClaimValueCaptured`](../../verification/NotificationFlagLease.tla#L95)**

```tla
ClaimValueCaptured(fact) ==
  /\ fact.claimsEmail <=> fact.beforeEmail > 0
  /\ fact.claimsWebhooks <=> fact.beforeWebhooks > 0
```

**Model rule: [`LeaseHasOneHolder`](../../verification/NotificationFlagLease.tla#L133)**

```tla
LeaseHasOneHolder ==
  /\ (emailLeased <=> emailHolder # "none")
  /\ (webhooksLeased <=> webhooksHolder # "none")
```

**Production code: [`scripts/verify-models/notification-flag-lease.ts#claimFacts`](../../scripts/verify-models/notification-flag-lease.ts#L108)**

```ts
export const claimFacts = (): ClaimFact[] => { ... }
```

Source fingerprint: `sha256:cfed2292a7e8a9e2`

**Production code: [`src/shared/db/attendees/notification-flags.ts#claimOutstandingNotificationFlags`](../../src/shared/db/attendees/notification-flags.ts#L95)**

```ts
export const claimOutstandingNotificationFlags = async (
  attendeeId: number,
): Promise<ClaimedNotificationSide[]> => ...
```

Source fingerprint: `sha256:af78ae402dadd9d5`

### Step 4: A failed email send restores colour 2

The email send does not run or it fails, so the recovery restores the captured colour. The restore writes 2, not the online colour 1. A restore of 1 breaks RestoreWritesCaptured and turns the orange badge red. The named side loses its lease, capture, and holder. The webhook side stays leased. LeaseKeepsCaptured requires a restore fact for every live capture.

| Value | This step |
| --- | --- |
| `returnsEmail` | TRUE |
| `emailValue` | 2 |
| `returnsWebhooks` | FALSE |
| `storedEmailAfter` | 2 (admin-added, orange) |
| `emailLeased` | FALSE |
| `emailCaptured` | 0 |
| `emailHolder` | none |
| `webhooks` | The lease stays with w1 and keeps colour 1. |

**Model rule: [`RestoreStep`](../../verification/NotificationFlagLease.tla#L188)**

```tla
RestoreStep ==
  \E fact \in RestoreFacts :
    /\ ((fact.returnsEmail /\ emailLeased) \/
        (fact.returnsWebhooks /\ webhooksLeased))
    /\ storedEmail' =
         IF fact.returnsEmail /\ emailLeased THEN fact.emailValue
         ELSE storedEmail
    /\ storedWebhooks' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN fact.webhooksValue
         ELSE storedWebhooks
    /\ emailLeased' =
         IF fact.returnsEmail /\ emailLeased THEN FALSE ELSE emailLeased
    /\ webhooksLeased' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN FALSE
         ELSE webhooksLeased
    /\ emailCaptured' =
         IF fact.returnsEmail /\ emailLeased THEN 0 ELSE emailCaptured
    /\ webhooksCaptured' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN 0
         ELSE webhooksCaptured
    /\ emailHolder' =
         IF fact.returnsEmail /\ emailLeased THEN "none" ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN "none"
         ELSE webhooksHolder
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, RestoreWritesCaptured(fact))
```

**Model rule: [`RestoreWritesCaptured`](../../verification/NotificationFlagLease.tla#L102)**

```tla
RestoreWritesCaptured(fact) ==
  /\ (fact.returnsEmail /\ emailLeased =>
        fact.emailValue = emailCaptured)
  /\ (fact.returnsWebhooks /\ webhooksLeased =>
        fact.webhooksValue = webhooksCaptured)
```

**Model rule: [`LeaseKeepsCaptured`](../../verification/NotificationFlagLease.tla#L111)**

```tla
LeaseKeepsCaptured ==
  /\ (emailLeased =>
       /\ emailCaptured > 0
       /\ \E fact \in RestoreFacts :
            /\ fact.returnsEmail
            /\ fact.emailValue = emailCaptured)
  /\ (webhooksLeased =>
       /\ webhooksCaptured > 0
       /\ \E fact \in RestoreFacts :
            /\ fact.returnsWebhooks
            /\ fact.webhooksValue = webhooksCaptured)
  /\ (~emailLeased => emailCaptured = 0)
  /\ (~webhooksLeased => webhooksCaptured = 0)
```

**Production code: [`src/shared/db/attendees/notification-flags.ts#restorePendingFlagStatement`](../../src/shared/db/attendees/notification-flags.ts#L72)**

```ts
export const restorePendingFlagStatement = (
  side: PendingNotificationSide,
  attendeeIds: readonly number[],
  value: PendingNotificationFlag,
): SqlStatement => ...
```

Source fingerprint: `sha256:dcd511164f24a331`

**Production code: [`src/shared/db/attendees/notification-flags.ts#restoreClaimedNotificationFlags`](../../src/shared/db/attendees/notification-flags.ts#L129)**

```ts
export const restoreClaimedNotificationFlags = (
  attendeeId: number,
  claimed: readonly ClaimedNotificationSide[],
): Promise<unknown> => ...
```

Source fingerprint: `sha256:d8cd77f8b752712f`

### Step 5: An accepted email send clears the debt

The email send reaches external acceptance. A clear names the email side and sets its flag to zero. The production clear touches rows whose flag is up. The model also allows a clear on a live lease, because the claim already set that stored flag to zero. A refused send restores the captured colour instead. The other side stays as it was.

| Value | This step |
| --- | --- |
| `side` | email |
| `storedEmailBefore` | 2 |
| `emailLeasedBefore` | FALSE |
| `storedEmailAfter` | 0 |
| `webhooks` | Unchanged. |

**Model rule: [`ClearStep`](../../verification/NotificationFlagLease.tla#L218)**

```tla
ClearStep ==
  \E fact \in ClearFacts :
    /\ (fact.side = "email" => storedEmail > 0 \/ emailLeased)
    /\ (fact.side = "webhooks" => storedWebhooks > 0 \/ webhooksLeased)
    /\ storedEmail' = IF fact.side = "email" THEN 0 ELSE storedEmail
    /\ storedWebhooks' = IF fact.side = "webhooks" THEN 0 ELSE storedWebhooks
    /\ emailLeased' = IF fact.side = "email" THEN FALSE ELSE emailLeased
    /\ webhooksLeased' = IF fact.side = "webhooks" THEN FALSE ELSE webhooksLeased
    /\ emailCaptured' = IF fact.side = "email" THEN 0 ELSE emailCaptured
    /\ webhooksCaptured' = IF fact.side = "webhooks" THEN 0 ELSE webhooksCaptured
    /\ emailHolder' = IF fact.side = "email" THEN "none" ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.side = "webhooks" THEN "none" ELSE webhooksHolder
    /\ allFactsSafe' = allFactsSafe
```

**Production code: [`src/shared/db/attendees/notification-flags.ts#clearPendingFlagStatement`](../../src/shared/db/attendees/notification-flags.ts#L58)**

```ts
export const clearPendingFlagStatement = (
  side: PendingNotificationSide,
  attendeeIds: readonly number[],
): SqlStatement => ...
```

Source fingerprint: `sha256:dd6bc96ebe2c9321`

### Step 6: Every state keeps the debt visible

Safety joins TypeOK, the capture rule, the zero stored flag under a live lease, the holder rule, and every retained verdict. Next permits a claim, a restore, a clear, or a pause. No rule requires progress, so debt can persist. The model does not prove eventual delivery.

| Value | This step |
| --- | --- |
| `live lease` | Captured colour 2, stored flag 0, holder w1. |
| `restore fact` | A fact that returns colour 2 exists. |
| `holder` | w1 or none, never two names. |
| `allFactsSafe` | TRUE |

**Model rule: [`Safety`](../../verification/NotificationFlagLease.tla#L142)**

```tla
Safety ==
  /\ TypeOK
  /\ LeaseKeepsCaptured
  /\ SendStaysOwed
  /\ LeaseHasOneHolder
  /\ allFactsSafe
```

**Model rule: [`Next`](../../verification/NotificationFlagLease.tla#L237)**

```tla
Next ==
  ClaimStep \/ RestoreStep \/ ClearStep \/
  UNCHANGED <<storedEmail, storedWebhooks, emailLeased, webhooksLeased,
             emailCaptured, webhooksCaptured, emailHolder, webhooksHolder,
             allFactsSafe>>
```

**Model rule: [`LeaseKeepsCaptured`](../../verification/NotificationFlagLease.tla#L111)**

```tla
LeaseKeepsCaptured ==
  /\ (emailLeased =>
       /\ emailCaptured > 0
       /\ \E fact \in RestoreFacts :
            /\ fact.returnsEmail
            /\ fact.emailValue = emailCaptured)
  /\ (webhooksLeased =>
       /\ webhooksCaptured > 0
       /\ \E fact \in RestoreFacts :
            /\ fact.returnsWebhooks
            /\ fact.webhooksValue = webhooksCaptured)
  /\ (~emailLeased => emailCaptured = 0)
  /\ (~webhooksLeased => webhooksCaptured = 0)
```

**Model rule: [`SendStaysOwed`](../../verification/NotificationFlagLease.tla#L127)**

```tla
SendStaysOwed ==
  /\ (emailLeased => storedEmail = 0)
  /\ (webhooksLeased => storedWebhooks = 0)
```

**Model rule: [`LeaseHasOneHolder`](../../verification/NotificationFlagLease.tla#L133)**

```tla
LeaseHasOneHolder ==
  /\ (emailLeased <=> emailHolder # "none")
  /\ (webhooksLeased <=> webhooksHolder # "none")
```

**Production code: [`scripts/verify-models/notification-flag-lease.ts#notificationFlagLeaseModelData`](../../scripts/verify-models/notification-flag-lease.ts#L208)**

```ts
export const notificationFlagLeaseModelData: ModelDataSource = modelDataFor(
  () => moduleFor(claimFacts(), restoreFacts(), clearFacts()),
);
```

Source fingerprint: `sha256:88a66537c9f9db94`

## The safety claim

Every live lease keeps a positive captured colour and a matching restore fact. Its stored flag stays zero. One holder name owns each side. Every fact used so far passed its rule.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use one attendee, two workers, email colour 2, and webhook colour 1. Real flags need not have this mixture of origins.
- The model assumes an atomic claim read and write and an accepted external send. It does not prove transaction isolation, SQL guards, or provider acceptance.
- The lease, the captured colour, and the holder are model memory. The application stores no lease row and has no clock or automatic expiry.
- The model checks safety. It does not prove that a recovery eventually runs, that a restore owns the lease, or that a buyer reads a message.

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
