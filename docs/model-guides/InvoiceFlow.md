# Create, cancel, and settle one attendee's invoice

[Read the model](../../verification/InvoiceFlow.tla).

This page follows one attendee with two invoice numbers. Every reachable state keeps at most one open invoice. Every accepted action reaches its own status, and no action changes the other invoice number.

## The bad outcome it rules out

Two open invoices for one attendee, a closed invoice that returns to open, or a status that does not match the action that caused it.

## The cast

| Word | Meaning |
| --- | --- |
| **attendee** | The customer record that holds the booked places and owes the invoice. |
| **invoice** | One bill for one attendee. It has an invoice number, a status, and a frozen rendered body. |
| **invoice number** | The operator-visible identity of an invoice. The examples use numbers 1 and 2 for one attendee. |
| **open invoice** | An invoice with status new. It is not yet cancelled or paid. |
| **closed invoice** | An invoice with status cancelled or paid. |
| **attempt** | One create, cancel, or settle action on one invoice number. |
| **fact** | The result of one production statement on a fresh copy of the invoice table. It is not a live row. |

## The walkthrough

### Step 1: Start with no invoice

The model starts with no row at invoice number 1 and no row at number 2. A real attendee can start with a closed invoice, and the facts supply that case as a step. TypeOK limits each status to absent, new, cancelled, or paid. The invoice table supplies the status column and the unique partial index that the facts exercise.

| Value | This step |
| --- | --- |
| `firstInvoice` | absent |
| `secondInvoice` | absent |
| `allAttemptsSafe` | TRUE |
| `OpenCount` | 0 |

**Model rule: [`Init`](../../verification/InvoiceFlow.tla#L103)**

```tla
Init ==
  /\ firstInvoice = "absent"
  /\ secondInvoice = "absent"
  /\ allAttemptsSafe = TRUE
```

**Model rule: [`TypeOK`](../../verification/InvoiceFlow.tla#L59)**

```tla
TypeOK ==
  /\ firstInvoice \in InvoiceStatuses
  /\ secondInvoice \in InvoiceStatuses
  /\ allAttemptsSafe \in BOOLEAN
```

**Production code: [`scripts/verify-models/invoice-flow.ts#invoiceFlowModelData`](../../scripts/verify-models/invoice-flow.ts#L334)**

```ts
export const invoiceFlowModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:dabdb656bfa7bce9`

**Production code: [`src/shared/db/migrations/schema/tables-invoices.ts#invoiceTables`](../../src/shared/db/migrations/schema/tables-invoices.ts#L9)**

```ts
export const invoiceTables = declaredTables([
  [
    // An invoice belongs to one attendee. The body is the rendered Liquid
    // output, frozen when an operator creates the invoice. It is sealed under
    // a key that the share token and the site key derive. The token holder
    // reads the body, and a dump of the database alone opens nothing.
    // `share_token` holds that capability, sealed under the owner key for an
    // owner session. `share_token_index` finds the row without opening it.
    // No FK: the attendee delete path removes these rows explicitly, like
    // system_notes.
    "invoices",
    {
      columns: [
        // The operator-visible invoice number. A create form prefills the next
        // free number, and the database keeps it unique.
        ["id", rowId],
        attendeeIdColumn,
        ["body", checked(sql`body GLOB 'enc:1:?*'`)(text)],
        ["status", oneOf("status", INVOICE_STATUSES)(defaulted(text, "new"))],
        ["share_token", checked(sql`share_token GLOB 'hyb:1:?*'`)(text)],
        ["share_token_index", text],
        ["created", text],
      ],
      indexes: [
// ...
```

Source fingerprint: `sha256:18eaf7c06ca6e8a5`

### Step 2: Create invoice 1

The create form stores the row with status new. The unique partial index allows the row because this attendee has no open invoice. The fact records the accepted action and the target status new. AttemptStep writes new to the first number and leaves the second number absent. IsOpen reads new as open, so the open count becomes one.

| Value | This step |
| --- | --- |
| `action` | create invoice 1 |
| `statusBefore` | absent |
| `otherNew` | FALSE |
| `accepted` | TRUE |
| `statusAfter` | new |
| `firstInvoice` | new |
| `secondInvoice` | absent |
| `OpenCount` | 1 |

**Model rule: [`AttemptStep`](../../verification/InvoiceFlow.tla#L114)**

```tla
AttemptStep ==
  \E attempt \in Attempts :
    /\ StatusAt(attempt.slot) = attempt.statusBefore
    /\ (attempt.kind = "create" =>
          attempt.otherNew = IsOpen(StatusElsewhere(attempt.slot)))
    /\ firstInvoice' =
         IF attempt.slot = 1 THEN attempt.statusAfter ELSE firstInvoice
    /\ secondInvoice' =
         IF attempt.slot = 2 THEN attempt.statusAfter ELSE secondInvoice
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeAttempt(attempt))
```

**Model rule: [`SafeAttempt`](../../verification/InvoiceFlow.tla#L86)**

```tla
SafeAttempt(attempt) ==
  /\ attempt.acceptedCorrect
  /\ attempt.otherKept
  /\ attempt.statusAfterCorrect
  /\ attempt.safe
```

**Model rule: [`IsOpen`](../../verification/InvoiceFlow.tla#L66)**

```tla
IsOpen(status) == status = "new"
```

**Model rule: [`OpenCount`](../../verification/InvoiceFlow.tla#L77)**

```tla
OpenCount ==
  (IF IsOpen(firstInvoice) THEN 1 ELSE 0) +
  (IF IsOpen(secondInvoice) THEN 1 ELSE 0)
```

**Production code: [`src/shared/db/invoices.ts#createInvoice`](../../src/shared/db/invoices.ts#L87)**

```ts
export const createInvoice = async ({
  attendeeId,
  bodyHtml,
  created,
  id,
}: NewInvoice): Promise<CreatedInvoice> => { ... }
```

Source fingerprint: `sha256:8db426b51f5a0d02`

**Production code: [`src/shared/db/migrations/schema/tables-invoices.ts#invoiceTables`](../../src/shared/db/migrations/schema/tables-invoices.ts#L9)**

```ts
export const invoiceTables = declaredTables([
  [
    // An invoice belongs to one attendee. The body is the rendered Liquid
    // output, frozen when an operator creates the invoice. It is sealed under
    // a key that the share token and the site key derive. The token holder
    // reads the body, and a dump of the database alone opens nothing.
    // `share_token` holds that capability, sealed under the owner key for an
    // owner session. `share_token_index` finds the row without opening it.
    // No FK: the attendee delete path removes these rows explicitly, like
    // system_notes.
    "invoices",
    {
      columns: [
        // The operator-visible invoice number. A create form prefills the next
        // free number, and the database keeps it unique.
        ["id", rowId],
        attendeeIdColumn,
        ["body", checked(sql`body GLOB 'enc:1:?*'`)(text)],
        ["status", oneOf("status", INVOICE_STATUSES)(defaulted(text, "new"))],
        ["share_token", checked(sql`share_token GLOB 'hyb:1:?*'`)(text)],
        ["share_token_index", text],
        ["created", text],
      ],
      indexes: [
// ...
```

Source fingerprint: `sha256:18eaf7c06ca6e8a5`

### Step 3: Refuse a second open invoice

Invoice 1 is still new. The insert for invoice 2 fails the partial unique index on the attendee. The producer recognises that failure as the open-invoice refusal and records a refused fact. StatusAt reads the number that the attempt names, and StatusElsewhere supplies the open invoice 1 to the create guard. The step keeps the absent status at number 2 and the open count stays one.

| Value | This step |
| --- | --- |
| `action` | create invoice 2 |
| `statusBefore` | absent |
| `otherNew` | TRUE |
| `accepted` | FALSE |
| `statusAfter` | absent |
| `secondInvoice` | absent |
| `OpenCount` | 1 |

**Model rule: [`AttemptStep`](../../verification/InvoiceFlow.tla#L114)**

```tla
AttemptStep ==
  \E attempt \in Attempts :
    /\ StatusAt(attempt.slot) = attempt.statusBefore
    /\ (attempt.kind = "create" =>
          attempt.otherNew = IsOpen(StatusElsewhere(attempt.slot)))
    /\ firstInvoice' =
         IF attempt.slot = 1 THEN attempt.statusAfter ELSE firstInvoice
    /\ secondInvoice' =
         IF attempt.slot = 2 THEN attempt.statusAfter ELSE secondInvoice
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeAttempt(attempt))
```

**Model rule: [`SafeAttempt`](../../verification/InvoiceFlow.tla#L86)**

```tla
SafeAttempt(attempt) ==
  /\ attempt.acceptedCorrect
  /\ attempt.otherKept
  /\ attempt.statusAfterCorrect
  /\ attempt.safe
```

**Model rule: [`StatusAt`](../../verification/InvoiceFlow.tla#L70)**

```tla
StatusAt(slot) == IF slot = 1 THEN firstInvoice ELSE secondInvoice
```

**Model rule: [`StatusElsewhere`](../../verification/InvoiceFlow.tla#L74)**

```tla
StatusElsewhere(slot) == IF slot = 1 THEN secondInvoice ELSE firstInvoice
```

**Model rule: [`IsOpen`](../../verification/InvoiceFlow.tla#L66)**

```tla
IsOpen(status) == status = "new"
```

**Model rule: [`OpenCount`](../../verification/InvoiceFlow.tla#L77)**

```tla
OpenCount ==
  (IF IsOpen(firstInvoice) THEN 1 ELSE 0) +
  (IF IsOpen(secondInvoice) THEN 1 ELSE 0)
```

**Production code: [`scripts/verify-models/invoice-flow.ts#isOpenInvoiceRefusal`](../../scripts/verify-models/invoice-flow.ts#L71)**

```ts
export const isOpenInvoiceRefusal = (error: unknown): boolean => ...
```

Source fingerprint: `sha256:8f6d81fa626fc062`

**Production code: [`src/shared/db/migrations/schema/tables-invoices.ts#invoiceTables`](../../src/shared/db/migrations/schema/tables-invoices.ts#L9)**

```ts
export const invoiceTables = declaredTables([
  [
    // An invoice belongs to one attendee. The body is the rendered Liquid
    // output, frozen when an operator creates the invoice. It is sealed under
    // a key that the share token and the site key derive. The token holder
    // reads the body, and a dump of the database alone opens nothing.
    // `share_token` holds that capability, sealed under the owner key for an
    // owner session. `share_token_index` finds the row without opening it.
    // No FK: the attendee delete path removes these rows explicitly, like
    // system_notes.
    "invoices",
    {
      columns: [
        // The operator-visible invoice number. A create form prefills the next
        // free number, and the database keeps it unique.
        ["id", rowId],
        attendeeIdColumn,
        ["body", checked(sql`body GLOB 'enc:1:?*'`)(text)],
        ["status", oneOf("status", INVOICE_STATUSES)(defaulted(text, "new"))],
        ["share_token", checked(sql`share_token GLOB 'hyb:1:?*'`)(text)],
        ["share_token_index", text],
        ["created", text],
      ],
      indexes: [
// ...
```

Source fingerprint: `sha256:18eaf7c06ca6e8a5`

### Step 4: Cancel the open invoice

The cancel statement moves one row from new to cancelled and matches no other row. The fact accepts the action because the stored status is new. StatusAt gives the current status at number 1. AttemptStep writes cancelled to that number, and SafeAttempt checks the target and the unchanged number 2. The open count falls to zero.

| Value | This step |
| --- | --- |
| `action` | cancel invoice 1 |
| `statusBefore` | new |
| `accepted` | TRUE |
| `statusAfter` | cancelled |
| `OpenCount` | 0 |

**Model rule: [`AttemptStep`](../../verification/InvoiceFlow.tla#L114)**

```tla
AttemptStep ==
  \E attempt \in Attempts :
    /\ StatusAt(attempt.slot) = attempt.statusBefore
    /\ (attempt.kind = "create" =>
          attempt.otherNew = IsOpen(StatusElsewhere(attempt.slot)))
    /\ firstInvoice' =
         IF attempt.slot = 1 THEN attempt.statusAfter ELSE firstInvoice
    /\ secondInvoice' =
         IF attempt.slot = 2 THEN attempt.statusAfter ELSE secondInvoice
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeAttempt(attempt))
```

**Model rule: [`SafeAttempt`](../../verification/InvoiceFlow.tla#L86)**

```tla
SafeAttempt(attempt) ==
  /\ attempt.acceptedCorrect
  /\ attempt.otherKept
  /\ attempt.statusAfterCorrect
  /\ attempt.safe
```

**Model rule: [`StatusAt`](../../verification/InvoiceFlow.tla#L70)**

```tla
StatusAt(slot) == IF slot = 1 THEN firstInvoice ELSE secondInvoice
```

**Model rule: [`OpenCount`](../../verification/InvoiceFlow.tla#L77)**

```tla
OpenCount ==
  (IF IsOpen(firstInvoice) THEN 1 ELSE 0) +
  (IF IsOpen(secondInvoice) THEN 1 ELSE 0)
```

**Production code: [`src/shared/db/invoices.ts#cancelInvoiceStatement`](../../src/shared/db/invoices.ts#L114)**

```ts
export const cancelInvoiceStatement = (id: number): SqlStatement => ...
```

Source fingerprint: `sha256:7df7f1c5410ee48e`

### Step 5: Create invoice 2 after the cancel

Number 1 is now cancelled. The create guard sees no open invoice on the other number, so the insert lands with status new. The fact matches the current absent status at number 2. AttemptStep writes new there and leaves number 1 cancelled. The open count returns to one, never two.

| Value | This step |
| --- | --- |
| `action` | create invoice 2 |
| `statusBefore` | absent |
| `otherNew` | FALSE |
| `accepted` | TRUE |
| `statusAfter` | new |
| `firstInvoice` | cancelled |
| `secondInvoice` | new |
| `OpenCount` | 1 |

**Model rule: [`AttemptStep`](../../verification/InvoiceFlow.tla#L114)**

```tla
AttemptStep ==
  \E attempt \in Attempts :
    /\ StatusAt(attempt.slot) = attempt.statusBefore
    /\ (attempt.kind = "create" =>
          attempt.otherNew = IsOpen(StatusElsewhere(attempt.slot)))
    /\ firstInvoice' =
         IF attempt.slot = 1 THEN attempt.statusAfter ELSE firstInvoice
    /\ secondInvoice' =
         IF attempt.slot = 2 THEN attempt.statusAfter ELSE secondInvoice
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeAttempt(attempt))
```

**Model rule: [`SafeAttempt`](../../verification/InvoiceFlow.tla#L86)**

```tla
SafeAttempt(attempt) ==
  /\ attempt.acceptedCorrect
  /\ attempt.otherKept
  /\ attempt.statusAfterCorrect
  /\ attempt.safe
```

**Model rule: [`IsOpen`](../../verification/InvoiceFlow.tla#L66)**

```tla
IsOpen(status) == status = "new"
```

**Model rule: [`StatusElsewhere`](../../verification/InvoiceFlow.tla#L74)**

```tla
StatusElsewhere(slot) == IF slot = 1 THEN secondInvoice ELSE firstInvoice
```

**Model rule: [`OpenCount`](../../verification/InvoiceFlow.tla#L77)**

```tla
OpenCount ==
  (IF IsOpen(firstInvoice) THEN 1 ELSE 0) +
  (IF IsOpen(secondInvoice) THEN 1 ELSE 0)
```

**Production code: [`src/shared/db/invoices.ts#createInvoice`](../../src/shared/db/invoices.ts#L87)**

```ts
export const createInvoice = async ({
  attendeeId,
  bodyHtml,
  created,
  id,
}: NewInvoice): Promise<CreatedInvoice> => { ... }
```

Source fingerprint: `sha256:8db426b51f5a0d02`

### Step 6: Settle or pause, and keep the law

The settle statement marks the attendee's open invoices paid only when the ledger balance equals the amount that the settle clears. A matched guard closes the invoice. An unmatched guard leaves it open. The next-state relation also permits a pause with no change. Safety joins TypeOK, the open count at most one, and every retained verdict. A failed fact stays visible after a later good fact, so a good step cannot hide it.

| Value | This step |
| --- | --- |
| `accepted settle` | The guard matches. The open invoice becomes paid. |
| `refused settle` | The guard does not match. The invoice stays new. |
| `pause` | Every value stays the same. |
| `result` | At most one open invoice. |

**Model rule: [`Next`](../../verification/InvoiceFlow.tla#L129)**

```tla
Next ==
  AttemptStep \/
  UNCHANGED <<firstInvoice, secondInvoice, allAttemptsSafe>>
```

**Model rule: [`Safety`](../../verification/InvoiceFlow.tla#L96)**

```tla
Safety ==
  /\ TypeOK
  /\ OpenCount <= 1
  /\ allAttemptsSafe
```

**Model rule: [`TypeOK`](../../verification/InvoiceFlow.tla#L59)**

```tla
TypeOK ==
  /\ firstInvoice \in InvoiceStatuses
  /\ secondInvoice \in InvoiceStatuses
  /\ allAttemptsSafe \in BOOLEAN
```

**Model rule: [`OpenCount`](../../verification/InvoiceFlow.tla#L77)**

```tla
OpenCount ==
  (IF IsOpen(firstInvoice) THEN 1 ELSE 0) +
  (IF IsOpen(secondInvoice) THEN 1 ELSE 0)
```

**Model rule: [`SafeAttempt`](../../verification/InvoiceFlow.tla#L86)**

```tla
SafeAttempt(attempt) ==
  /\ attempt.acceptedCorrect
  /\ attempt.otherKept
  /\ attempt.statusAfterCorrect
  /\ attempt.safe
```

**Production code: [`src/shared/db/invoices.ts#markOpenInvoicesPaidStatement`](../../src/shared/db/invoices.ts#L128)**

```ts
export const markOpenInvoicesPaidStatement = (
  attendeeId: number,
  owed: Expr<Counted>,
  expectedAmount: number,
): SqlStatement => ...
```

Source fingerprint: `sha256:02b824af57454adb`

**Production code: [`scripts/verify-models/invoice-flow.ts#invoiceFlowModelData`](../../scripts/verify-models/invoice-flow.ts#L334)**

```ts
export const invoiceFlowModelData: ModelDataSource = async () => ...
```

Source fingerprint: `sha256:dabdb656bfa7bce9`

## The safety claim

Every reachable state has at most one invoice with status new. Every applied fact agrees with its guard, reaches its own target status, and keeps the other invoice number unchanged.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use one attendee and two invoice numbers. They do not prove every number, every amount, or a ledger balance that a later charge changes.
- One step applies one fact. The model does not prove a concurrent create, a batch of actions, or SQL rollback.
- A delete removes the row, so the model shows an absent number and gives the delete no separate step.
- The model checks safety. It does not prove that an invoice eventually closes, that a provider accepts a payment, or that a share link delivers the body.

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
