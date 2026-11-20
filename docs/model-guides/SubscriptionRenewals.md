# One paid renewal reaches the ledger with cash, sale, and VAT legs

[Read the model](../../verification/SubscriptionRenewals.tla).

This page follows one Stripe renewal report into the ledger. A paid cycle invoice posts its cash, sale, and VAT roles for the right attendee and listing. A replay leaves those same legs in place. A changed booking identity posts no money.

## The bad outcome it rules out

A renewal posts money to the wrong attendee or listing, or a replay adds a second copy of one invoice.

## The cast

| Word | Meaning |
| --- | --- |
| **booking row** | One stored row that links an attendee to a listing and holds the subscription plan. |
| **plan** | The recurring amount and the VAT inside it, frozen at checkout. Amounts are integer minor units. |
| **invoice** | One paid charge from Stripe. A cycle invoice for a later period is a renewal. |
| **ledger leg** | One transfer row with a source account, a destination account, an amount, and a reference. |
| **pass** | One observed call for one attempt. The producer reads the ledger before and after the call. |
| **eligible invoice** | An invoice with reason subscription_cycle and an amount above zero. |
| **fence** | The four stored values that name the booking: row id, attendee, listing, and subscription. |

## The walkthrough

### Step 1: Start before the first pass

The model starts before the first observed pass of one scenario. The fixture has a plan and no renewal legs. The fixture seeds a trialing plan. The stale_status scenario replaces that status with canceled before its first pass. Statuses adds a blank word for a booking that a merge removed. ScenarioNames and ExpectedScenarioNames must agree before a pass can run.

| Value | This step |
| --- | --- |
| `scenario` | normal |
| `passIndex` | 0 |
| `storedStatus` | trialing |
| `checksHold` | TRUE |
| `arithmeticChecked` | FALSE |

**Model rule: [`Init`](../../verification/SubscriptionRenewals.tla#L327)**

```tla
Init ==
  /\ \E index \in ScenarioFactsIndices :
       LET item == ScenarioFactsAt(index) IN
       /\ scenario = item.scenario /\ storedStatus = item.initialStatus
  /\ passIndex = 0 /\ checksHold = (Coverage /\ JoinCoverage)
  /\ arithmeticChecked = FALSE
  /\ joinsChecked = FALSE
  /\ readsChecked = FALSE
```

**Model rule: [`TypeOK`](../../verification/SubscriptionRenewals.tla#L318)**

```tla
TypeOK ==
  /\ scenario \in ScenarioNames /\ passIndex \in 0..2
  /\ storedStatus \in Statuses
  /\ checksHold \in BOOLEAN /\ arithmeticChecked \in BOOLEAN /\ joinsChecked \in BOOLEAN
  /\ readsChecked \in BOOLEAN
```

**Model rule: [`Statuses`](../../verification/SubscriptionRenewals.tla#L53)**

```tla
Statuses == LiveStatuses \cup EndedStatuses \cup {""}
```

**Model rule: [`ScenarioNames`](../../verification/SubscriptionRenewals.tla#L54)**

```tla
ScenarioNames == {item.scenario : item \in ScenarioFacts}
```

**Model rule: [`ExpectedScenarioNames`](../../verification/SubscriptionRenewals.tla#L57)**

```tla
ExpectedScenarioNames == {item.scenario : item \in ExpectedAttempts}
```

**Production code: [`scripts/verify-models/subscriptions/renewal-cases.ts#RENEWAL_CASES`](../../scripts/verify-models/subscriptions/renewal-cases.ts#L75)**

```ts
export const RENEWAL_CASES: readonly RenewalCase[] = [
  scenario("normal", [pass([cycle()]), pass([cycle()])]),
  scenario("partial", [pass([cycle(303)])]),
  scenario("tax_only", [pass([cycle(1)])], { price: 2, tax: 1 }),
  scenario("no_tax", [pass([cycle()])], { tax: 0 }),
  scenario("excess", [pass([cycle(900)])]),
  scenario("non_renewals", [
    pass([
      cycle(0, "zero"),
      ...Object.entries(NON_RENEWAL_REASONS).map(([id, reason]) => ({
        ...cycle(600, id),
        reason,
      })),
      { ...cycle(600, "unknown"), reason: null },
    ]),
  ]),
  scenario("hundred", [
    pass(
      Array.from({ length: 100 }, (_, index) => cycle(600, `paid_${index}`)),
    ),
  ]),
  scenario("empty", [pass([], { observed: "canceled" })]),
  scenario("conflict", [
    pass([cycle()]),
// ...
```

Source fingerprint: `sha256:a0250a0bba11eba9`

**Production code: [`src/shared/subscriptions/plan.ts#SubscriptionStatusSchema`](../../src/shared/subscriptions/plan.ts#L50)**

```ts
/** Every status Stripe gives a subscription. */
export const SubscriptionStatusSchema = v.picklist([
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);
```

Source fingerprint: `sha256:20bb8b15cf795087`

### Step 2: Every declared input needs one result

Coverage requires one observed result for each declared input. The inputs come before the calls. The producer declares 18 scenario names and 21 passes. Each pass has one renewal read. Each of the 3 currency cases has one read at the Stripe client, which makes 24 reads. The producer keeps every read argument, so a repeated call with equal arguments stays visible. A renewal read must name the subscription of its attempt. A currency read must name sub_currency.

| Value | This step |
| --- | --- |
| `scenarios` | 18 |
| `passes` | 21 |
| `captured reads` | 24 |
| `currency cases` | site, foreign, and mixed |
| `arithmetic cases` | 11 |

**Model rule: [`Coverage`](../../verification/SubscriptionRenewals.tla#L128)**

```tla
Coverage ==
  /\ ScenarioNames = ExpectedScenarioNames /\ ScenarioNames # {}
  /\ Cardinality(ScenarioFacts) = Cardinality(ExpectedScenarioNames)
  /\ \A item \in ScenarioFacts :
       /\ item.steps \in {1, 2}
       /\ item.steps = Cardinality({attempt \in ExpectedAttempts :
            attempt.scenario = item.scenario})
  /\ \A expected \in ExpectedAttempts :
       Cardinality({op \in OperationFacts :
         op.attempt = expected.attempt /\ op.scenario = expected.scenario}) = 1
  /\ \A op \in OperationFacts :
       /\ op.scenario \in ScenarioNames
       /\ \E expected \in ExpectedAttempts :
            op.attempt = expected.attempt /\ op.scenario = expected.scenario
  /\ \A item \in ScenarioFacts : \A index \in {0, 1} : index < item.steps =>
       Cardinality({op \in OperationFacts :
         op.scenario = item.scenario /\ op.index = index}) = 1
  /\ InvoiceFactsCount = ExpectedInvoicesCount
  /\ \A expected \in ExpectedInvoices :
       \E invoice \in InvoiceFacts :
         invoice.attempt = expected.attempt /\ invoice.invoice = expected.invoice
  /\ {fact.caseId : fact \in ArithmeticFacts} = ArithmeticCases
  /\ Cardinality(ArithmeticFacts) = Cardinality(ArithmeticCases)
  /\ {fact.caseId : fact \in CurrencyFacts} = CurrencyCases
  /\ Cardinality(CurrencyFacts) = Cardinality(CurrencyCases)
  /\ ReadCoverage
```

**Model rule: [`CurrencyCases`](../../verification/SubscriptionRenewals.tla#L58)**

```tla
CurrencyCases == {"site_currency", "foreign_currency", "mixed_currency"}
```

**Model rule: [`ArithmeticCases`](../../verification/SubscriptionRenewals.tla#L59)**

```tla
ArithmeticCases == {"planned", "half_up", "tax_only", "zero", "below_one",
  "below_plan", "above_plan", "excess", "no_tax", "below_half", "large"}
```

**Model rule: [`RequiredReads`](../../verification/SubscriptionRenewals.tla#L65)**

```tla
RequiredReads ==
  {[kind |-> "renewal", owner |-> item.attempt] : item \in ExpectedAttempts}
  \cup {[kind |-> "currency", owner |-> item] : item \in CurrencyCases}
```

**Model rule: [`ReadCoverage`](../../verification/SubscriptionRenewals.tla#L68)**

```tla
ReadCoverage ==
  /\ \A expected \in RequiredReads :
       Cardinality({read \in ReadFacts :
         read.kind = expected.kind /\ read.owner = expected.owner}) = 1
  /\ \A read \in ReadFacts :
       /\ read.ordinal = 0
       /\ \E expected \in RequiredReads :
            read.kind = expected.kind /\ read.owner = expected.owner
```

**Model rule: [`ReadIdentitySafe`](../../verification/SubscriptionRenewals.tla#L80)**

```tla
ReadIdentitySafe(read) ==
  IF read.kind = "renewal"
  THEN \E op \in OperationFacts :
         read.owner = op.attempt /\ read.target = op.snapshotSubscription
  ELSE read.kind = "currency" /\ read.target = "sub_currency"
```

**Production code: [`scripts/verify-models/subscriptions/renewal-facts.ts#renderRenewals`](../../scripts/verify-models/subscriptions/renewal-facts.ts#L258)**

```ts
export const renderRenewals = (facts: RenewalFacts): string => ...
```

Source fingerprint: `sha256:18813386e35719c2`

**Production code: [`scripts/verify-models/subscriptions/renewal-observations.ts#captureRead`](../../scripts/verify-models/subscriptions/renewal-observations.ts#L27)**

```ts
export const captureRead = <Answer>(
  reads: RenewalFacts["reads"],
  kind: "renewal" | "currency",
  owner: string,
  answer: () => Promise<Answer>,
): ((target: string) => Promise<Answer>) => { ... }
```

Source fingerprint: `sha256:231a9984bbf6c59f`

**Production code: [`src/shared/stripe.ts#stripeApi`](../../src/shared/stripe.ts#L389)**

```ts
export const stripeApi: StripeApi = {
  cancelSubscription,
  cleanupOldWebhookEndpoints,
  createCheckoutSession,
  readInvoicePayments,
  readPaidInvoices,
  readPaymentIntent,
  readSubscription,
  refundCharge,
  retrieveCheckoutSession,
  setupWebhookEndpoint,
  testStripeConnection,
};
```

Source fingerprint: `sha256:286f1821d7e5631a`

### Step 3: One pass writes or refuses

One pass runs the producer call for one attempt. The pass reads the ledger legs before and after the call. A refused read returns without a write. A refused write keeps both the status and every leg. A successful call checks each eligible invoice and leaves other invoices alone. An attempt with no eligible invoice posts no renewal legs.

| Value | This step |
| --- | --- |
| `read` | found |
| `outcome` | returned |
| `refused read` | missing. The outcome is returned. |
| `after a refusal` | The status and every leg stay the same. |

**Model rule: [`InspectPass`](../../verification/SubscriptionRenewals.tla#L341)**

```tla
InspectPass ==
  \E index \in OperationFactsIndices :
    LET op == OperationFactsAt(index) IN
    /\ op.scenario = scenario /\ op.index = passIndex
    /\ op.beforeStatus = storedStatus
    /\ passIndex' = passIndex + 1
    /\ storedStatus' = op.afterStatus
    /\ checksHold' = ChecksStillPass(checksHold, AttemptSafe(op))
    /\ UNCHANGED <<scenario, arithmeticChecked, joinsChecked, readsChecked>>
```

**Model rule: [`AttemptSafe`](../../verification/SubscriptionRenewals.tla#L239)**

```tla
AttemptSafe(op) ==
  LET refused == op.outcome # "returned" \/ op.readStatus # "found" IN
  /\ op.outcome = ExpectedOutcome(op)
  /\ op.afterStatus = IF refused THEN op.beforeStatus ELSE ExpectedStatus(op)
  /\ \A invoice \in InvoiceFacts :
       invoice.attempt = op.attempt =>
         IF refused \/ ~Eligible(invoice)
         THEN LegsAfter(invoice) = LegsBefore(invoice)
         ELSE LegsSafe(LegsAfter(invoice), invoice)
```

**Model rule: [`ExpectedOutcome`](../../verification/SubscriptionRenewals.tla#L218)**

```tla
ExpectedOutcome(op) ==
  IF op.readStatus # "found" \/ ~HasEligible(op) THEN "returned"
  ELSE IF Conflicts(op) THEN "ledger_conflict"
  ELSE IF ~FenceHeld(op) THEN "booking_fence"
  ELSE IF op.fault THEN "write_fault"
  ELSE "returned"
```

**Production code: [`scripts/verify-models/subscriptions/renewal-observations.ts#observePass`](../../scripts/verify-models/subscriptions/renewal-observations.ts#L203)**

```ts
export const observePass = async (
  facts: RenewalFacts,
  scenario: RenewalCase,
  row: LiveRow,
  pass: RenewalPass,
  index: number,
  write: () => Promise<void> = async () => {
    await recordObserved(row, pass.observed);
  },
): Promise<void> => { ... }
```

Source fingerprint: `sha256:01ab892b7fa2e93b`

**Production code: [`src/shared/subscriptions/record.ts#recordObserved`](../../src/shared/subscriptions/record.ts#L74)**

```ts
export const recordObserved = async (
  row: LiveRow,
  observed: SubscriptionStatus,
): Promise<boolean> => { ... }
```

Source fingerprint: `sha256:8edd9a6dda52752d`

### Step 4: Cash, sale, and VAT reach the right accounts

A paid cycle invoice posts three legs. Cash moves from external:world to the attendee. Sale moves the amount without VAT from the attendee to the listing revenue account. VAT moves to tax:vat. The law checks each role before the sum. A role with expected amount zero needs no leg. A positive role needs exactly one leg with the right account, reference, and paid time. Cash must equal sale plus VAT.

| Value | This step |
| --- | --- |
| `invoice` | 600 with price 600 and tax 100 |
| `cash leg` | 600 from external:world to the attendee |
| `sale leg` | 500 from the attendee to the listing revenue account |
| `VAT leg` | 100 from the attendee to tax:vat |
| `zero role` | No leg and no account. |

**Model rule: [`TaxShare`](../../verification/SubscriptionRenewals.tla#L158)**

```tla
TaxShare(amount, price, tax) == (2 * amount * tax + price) \div (2 * price)
```

**Model rule: [`RoleSafe`](../../verification/SubscriptionRenewals.tla#L163)**

```tla
RoleSafe(count, amount, source, destination, reference, paidAt,
         expectedAmount, expectedSource, expectedDestination, expectedReference, expectedAt) ==
  IF expectedAmount = 0
  THEN /\ count = 0 /\ amount = 0 /\ source = "" /\ destination = ""
       /\ reference = "" /\ paidAt = 0
  ELSE /\ count = 1 /\ amount = expectedAmount
       /\ source = expectedSource /\ destination = expectedDestination
       /\ reference = expectedReference /\ paidAt = expectedAt
```

**Model rule: [`LegsSafe`](../../verification/SubscriptionRenewals.tla#L175)**

```tla
LegsSafe(legs, invoice) ==
  LET vat == TaxShare(invoice.amount, invoice.price, invoice.tax) IN
  /\ legs.otherCount = 0
  /\ legs.eventGroup = invoice.expectedGroup
  /\ RoleSafe(legs.cashCount, legs.cashAmount, legs.cashSource,
       legs.cashDestination, legs.cashReference, legs.cashPaidAt,
       invoice.amount, "external:world", invoice.attendee,
       invoice.cashReference, invoice.expectedAt)
  /\ RoleSafe(legs.saleCount, legs.saleAmount, legs.saleSource,
       legs.saleDestination, legs.saleReference, legs.salePaidAt,
       invoice.amount - vat, invoice.attendee, invoice.listing,
       invoice.saleReference, invoice.expectedAt)
  /\ RoleSafe(legs.vatCount, legs.vatAmount, legs.vatSource,
       legs.vatDestination, legs.vatReference, legs.vatPaidAt,
       vat, invoice.attendee, "tax:vat", invoice.vatReference, invoice.expectedAt)
  /\ legs.saleAmount + legs.vatAmount = legs.cashAmount
```

**Model rule: [`LegsBefore`](../../verification/SubscriptionRenewals.tla#L98)**

```tla
LegsBefore(row) ==
  [eventGroup |-> row.beforeEventGroup, otherCount |-> row.beforeOtherCount,
   cashCount |-> row.beforeCashCount, cashAmount |-> row.beforeCashAmount,
   cashSource |-> row.beforeCashSource, cashDestination |-> row.beforeCashDestination,
   cashReference |-> row.beforeCashReference, cashPaidAt |-> row.beforeCashPaidAt,
   saleCount |-> row.beforeSaleCount, saleAmount |-> row.beforeSaleAmount,
   saleSource |-> row.beforeSaleSource, saleDestination |-> row.beforeSaleDestination,
   saleReference |-> row.beforeSaleReference, salePaidAt |-> row.beforeSalePaidAt,
   vatCount |-> row.beforeVatCount, vatAmount |-> row.beforeVatAmount,
   vatSource |-> row.beforeVatSource, vatDestination |-> row.beforeVatDestination,
   vatReference |-> row.beforeVatReference, vatPaidAt |-> row.beforeVatPaidAt]
```

**Model rule: [`LegsAfter`](../../verification/SubscriptionRenewals.tla#L110)**

```tla
LegsAfter(row) ==
  [eventGroup |-> row.afterEventGroup, otherCount |-> row.afterOtherCount,
   cashCount |-> row.afterCashCount, cashAmount |-> row.afterCashAmount,
   cashSource |-> row.afterCashSource, cashDestination |-> row.afterCashDestination,
   cashReference |-> row.afterCashReference, cashPaidAt |-> row.afterCashPaidAt,
   saleCount |-> row.afterSaleCount, saleAmount |-> row.afterSaleAmount,
   saleSource |-> row.afterSaleSource, saleDestination |-> row.afterSaleDestination,
   saleReference |-> row.afterSaleReference, salePaidAt |-> row.afterSalePaidAt,
   vatCount |-> row.afterVatCount, vatAmount |-> row.afterVatAmount,
   vatSource |-> row.afterVatSource, vatDestination |-> row.afterVatDestination,
   vatReference |-> row.afterVatReference, vatPaidAt |-> row.afterVatPaidAt]
```

**Model rule: [`Eligible`](../../verification/SubscriptionRenewals.tla#L194)**

```tla
Eligible(invoice) == invoice.reason = "subscription_cycle" /\ invoice.amount > 0
```

**Production code: [`src/shared/accounting/mappers.ts#mapRenewal`](../../src/shared/accounting/mappers.ts#L288)**

```ts
export const mapRenewal = (facts: RenewalFacts): Promise<TransferInput[]> => { ... }
```

Source fingerprint: `sha256:878e6ffba842d7cb`

**Production code: [`src/shared/subscriptions/plan.ts#renewalTax`](../../src/shared/subscriptions/plan.ts#L146)**

```ts
export const renewalTax = (
  plan: { price: number; tax: number },
  paid: number,
): number => { ... }
```

Source fingerprint: `sha256:1065ab9cd3151a14`

**Production code: [`src/shared/tax/assessment.ts#roundedRatio`](../../src/shared/tax/assessment.ts#L26)**

```ts
export const roundedRatio = (
  amount: number,
  numerator: number,
  denominator: bigint,
): number => ...
```

Source fingerprint: `sha256:4e59dac52bfe244b`

**Production code: [`src/shared/accounting/store.ts#postTransferGroups`](../../src/shared/accounting/store.ts#L362)**

```ts
export const postTransferGroups = async (
  groups: TransferInput[][],
  companionStatements: readonly SqlStatement[] = [],
): Promise<PostResult[]> => { ... }
```

Source fingerprint: `sha256:360f164f7d4334e1`

### Step 5: A changed booking or a replay with different facts posts no money

A merge can replace the booking while Stripe answers. The fence compares the read row id, attendee, listing, and subscription with the stored row. A mismatch refuses the whole call. A replay of an invoice that already holds money must match the new facts exactly. A mismatch returns ledger_conflict and rewrites no old leg. The status rule lets an ended status replace a live one. A live status replaces only the status that the caller read, so an earlier cancel stays.

| Value | This step |
| --- | --- |
| `identity_attendee` | outcome booking_fence |
| `conflict` | first pass 600, second pass 601, outcome ledger_conflict |
| `stale status` | before trialing, observed past_due, after past_due |
| `ended observation` | A live row becomes ended. |

**Model rule: [`HasEligible`](../../verification/SubscriptionRenewals.tla#L197)**

```tla
HasEligible(op) ==
  \E invoice \in InvoiceFacts : invoice.attempt = op.attempt /\ Eligible(invoice)
```

**Model rule: [`FenceHeld`](../../verification/SubscriptionRenewals.tla#L202)**

```tla
FenceHeld(op) ==
  /\ op.snapshotId = op.storedId
  /\ op.snapshotAttendee = op.storedAttendee
  /\ op.snapshotListing = op.storedListing
  /\ op.snapshotSubscription = op.storedSubscription
```

**Model rule: [`Conflicts`](../../verification/SubscriptionRenewals.tla#L211)**

```tla
Conflicts(op) ==
  \E invoice \in InvoiceFacts :
    /\ invoice.attempt = op.attempt /\ Eligible(invoice)
    /\ invoice.beforeCashCount > 0
    /\ ~LegsSafe(LegsBefore(invoice), invoice)
```

**Model rule: [`ExpectedStatus`](../../verification/SubscriptionRenewals.tla#L228)**

```tla
ExpectedStatus(op) ==
  IF op.observed \in EndedStatuses /\ op.beforeStatus \in LiveStatuses
  THEN op.observed
  ELSE IF op.beforeStatus = op.snapshotStatus THEN op.observed
  ELSE op.beforeStatus
```

**Production code: [`src/shared/db/subscriptions.ts#renewalBookingGuard`](../../src/shared/db/subscriptions.ts#L157)**

```ts
export const renewalBookingGuard = (row: LiveRow): SqlStatement => ...
```

Source fingerprint: `sha256:b90637c8e71bf7bc`

**Production code: [`src/shared/db/subscriptions.ts#statusWrite`](../../src/shared/db/subscriptions.ts#L183)**

```ts
export const statusWrite = (
  row: LiveRow,
  status: SubscriptionStatus,
): SqlStatement => ...
```

Source fingerprint: `sha256:d9061c70c1f72e5b`

**Production code: [`src/shared/subscriptions/record.ts#recordObserved`](../../src/shared/subscriptions/record.ts#L74)**

```ts
export const recordObserved = async (
  row: LiveRow,
  observed: SubscriptionStatus,
): Promise<boolean> => { ... }
```

Source fingerprint: `sha256:8edd9a6dda52752d`

### Step 6: The plan and the failed checkout keep their identities

JoinCoverage requires four plan phases and three failed checkout deliveries. JourneyLaw keeps one real checkout row through a stored phase, a plan edit, a renewal, and an owner cancel. A listing price edit and a tax edit cannot change the stored plan. The plan holds 1002 net plus 200 VAT, which is a total of 1202. FailedJoinLaw keeps a zero-quantity failed checkout across three deliveries. Delivery one holds the payment anchor and sends no refund. Delivery two ends Stripe and refunds 600 once. Delivery three repeats the stored work and keeps one refund.

| Value | This step |
| --- | --- |
| `plan phases` | stored, edited, renewed, cancelled |
| `plan` | 1002 net, 200 VAT, 1202 total |
| `failed deliveries` | 3 |
| `delivery 1` | held 1, refunds 0, authority 0 |
| `delivery 2` | confirmed, refunds 1, cash 600 |
| `delivery 3` | refunds 1. No second provider refund. |

**Model rule: [`JoinCoverage`](../../verification/SubscriptionRenewals.tla#L252)**

```tla
JoinCoverage ==
  /\ Cardinality(JourneyFacts) = 4
  /\ {item.phase : item \in JourneyFacts} = {"stored", "edited", "renewed", "cancelled"}
  /\ Cardinality(FailedJoinFacts) = 3
  /\ {item.attempt : item \in FailedJoinFacts} = {1, 2, 3}
```

**Model rule: [`JourneyLaw`](../../verification/SubscriptionRenewals.tla#L261)**

```tla
JourneyLaw ==
  /\ \A item \in JourneyFacts :
       /\ item.booking > 0 /\ item.projectionCount = 1
       /\ item.attendee = item.expectedAttendee
       /\ item.listing = item.expectedListing
       /\ item.listing = item.requestedListing
       /\ item.listing = item.observedListing
       /\ item.subscription = item.requestedSubscription
       /\ item.subscription = item.observedSubscription
       /\ item.trialAt = item.expectedTrialAt
       /\ item.trialAt > item.checkoutAt
       /\ item.interval = item.requestedInterval
       /\ item.interval = item.observedInterval
       /\ item.price = item.requestedAmount
       /\ item.price = item.observedAmount
       /\ item.quantity = item.inputQuantity
       /\ item.requestedAmount = item.inputPrice * item.inputQuantity +
            TaxShare(item.inputPrice * item.inputQuantity, 10000, item.rate)
       /\ item.tax = TaxShare(item.observedAmount, 10000 + item.rate, item.rate)
       /\ item.status = IF item.phase \in {"stored", "edited"}
                         THEN item.observedStatus
                         ELSE IF item.phase = "renewed" THEN "active" ELSE "canceled"
       /\ item.cancelReturned = (item.phase = "cancelled")
  /\ \A left, right \in JourneyFacts : left.booking = right.booking
  /\ \A op \in OperationFacts : op.scenario = "joined" =>
       \A invoice \in InvoiceFacts : invoice.attempt = op.attempt =>
         \A item \in JourneyFacts :
           /\ invoice.price = item.price /\ invoice.tax = item.tax
           /\ invoice.attendee = item.attendeeAccount
           /\ invoice.listing = item.listingAccount
```

**Model rule: [`FailedJoinLaw`](../../verification/SubscriptionRenewals.tla#L295)**

```tla
FailedJoinLaw ==
  /\ \A item \in FailedJoinFacts :
       /\ item.booking > 0 /\ item.attendee > 0 /\ item.quantity = 0
       /\ item.listing = item.observedListing
       /\ item.subscription = item.observedSubscription
       /\ item.amount = item.observedAmount
       /\ item.interval = item.observedInterval
       /\ item.status = item.observedStatus
       /\ item.consumedReference =
            (IF item.refunds > 0 THEN item.observedReference ELSE "")
       /\ item.refundBeforeEnd = 0
       /\ item.refunds = (IF item.attempt = 1 THEN 0 ELSE 1)
       /\ item.confirmed = (item.attempt # 1)
       /\ item.held = (IF item.attempt = 1 THEN 1 ELSE 0)
       /\ item.authorityReturned = (IF item.attempt = 1 THEN 0 ELSE 600)
       /\ item.refundCash = (IF item.attempt = 1 THEN 0 ELSE 600)
  /\ \A left, right \in FailedJoinFacts :
       left.booking = right.booking /\ left.attendee = right.attendee
```

**Production code: [`scripts/verify-models/subscriptions/journey.ts#observeJourney`](../../scripts/verify-models/subscriptions/journey.ts#L75)**

```ts
export const observeJourney = async (facts: RenewalFacts): Promise<void> => { ... }
```

Source fingerprint: `sha256:1acf5a9c7275d520`

**Production code: [`scripts/verify-models/subscriptions/journey.ts#failedJourneyFacts`](../../scripts/verify-models/subscriptions/journey.ts#L214)**

```ts
export const failedJourneyFacts = async (): Promise<
  RenewalFacts["failedJoins"]
> => { ... }
```

Source fingerprint: `sha256:6188d982c63c5feb`

### Step 7: Independent checks do not trust the pass order

Three separate checks do not depend on the pass order. InspectArithmetic compares every arithmetic fact with TaxShare and every currency fact with its read result. InspectJoins rechecks both joins. InspectReads rechecks every captured read identity. Each check keeps an earlier failure visible in checksHold.

| Value | This step |
| --- | --- |
| `303 of 600 at 100` | 51 VAT |
| `900 of 600 at 100` | 150 VAT |
| `1 of price 2 at tax 1` | 1 VAT |
| `checksHold` | Stays TRUE only when every check passes. |

**Model rule: [`InspectArithmetic`](../../verification/SubscriptionRenewals.tla#L352)**

```tla
InspectArithmetic ==
  /\ ~arithmeticChecked
  /\ checksHold' = ChecksStillPass(checksHold,
       /\ \A fact \in ArithmeticFacts :
            /\ fact.price > 0 /\ fact.tax >= 0 /\ fact.tax <= fact.price
            /\ fact.amount >= 0
            /\ fact.observedTax = TaxShare(fact.amount, fact.price, fact.tax)
       /\ \A fact \in CurrencyFacts : (fact.status = "found") = fact.allMatch)
  /\ arithmeticChecked' = TRUE
  /\ UNCHANGED <<scenario, passIndex, storedStatus, joinsChecked, readsChecked>>
```

**Model rule: [`InspectJoins`](../../verification/SubscriptionRenewals.tla#L364)**

```tla
InspectJoins ==
  /\ ~joinsChecked
  /\ checksHold' = ChecksStillPass(checksHold, JourneyLaw /\ FailedJoinLaw)
  /\ joinsChecked' = TRUE
  /\ UNCHANGED <<scenario, passIndex, storedStatus, arithmeticChecked, readsChecked>>
```

**Model rule: [`InspectReads`](../../verification/SubscriptionRenewals.tla#L371)**

```tla
InspectReads ==
  /\ ~readsChecked
  /\ checksHold' = ChecksStillPass(checksHold,
       \A read \in ReadFacts : ReadIdentitySafe(read))
  /\ readsChecked' = TRUE
  /\ UNCHANGED <<scenario, passIndex, storedStatus, arithmeticChecked, joinsChecked>>
```

**Production code: [`src/shared/tax/assessment.ts#roundedRatio`](../../src/shared/tax/assessment.ts#L26)**

```ts
export const roundedRatio = (
  amount: number,
  numerator: number,
  denominator: bigint,
): number => ...
```

Source fingerprint: `sha256:4e59dac52bfe244b`

**Production code: [`scripts/verify-models/subscriptions/renewal-observations.ts#captureRead`](../../scripts/verify-models/subscriptions/renewal-observations.ts#L27)**

```ts
export const captureRead = <Answer>(
  reads: RenewalFacts["reads"],
  kind: "renewal" | "currency",
  owner: string,
  answer: () => Promise<Answer>,
): ((target: string) => Promise<Answer>) => { ... }
```

Source fingerprint: `sha256:231a9984bbf6c59f`

### Step 8: Safety covers every pass and every refusal

Safety joins the type bounds with the memory of every failed law. The initial state sets checksHold from Coverage and JoinCoverage, so a missing fact fails at once. Next permits one pass, one arithmetic check, one join check, one read check, or no change. No fairness rule requires a retry, and the model does not prove that work finishes.

| Value | This step |
| --- | --- |
| `passIndex` | 2 |
| `checksHold` | TRUE |
| `Next` | A pass, an arithmetic check, a join check, a read check, or no change. |

**Model rule: [`Safety`](../../verification/SubscriptionRenewals.tla#L323)**

```tla
Safety == TypeOK /\ checksHold
```

**Model rule: [`Next`](../../verification/SubscriptionRenewals.tla#L380)**

```tla
Next == InspectPass \/ InspectArithmetic \/ InspectJoins \/ InspectReads \/
  UNCHANGED <<scenario, passIndex, storedStatus, checksHold,
    arithmeticChecked, joinsChecked, readsChecked>>
```

**Production code: [`scripts/verify-models/subscriptions/renewals.ts#renewalFacts`](../../scripts/verify-models/subscriptions/renewals.ts#L58)**

```ts
export const renewalFacts = async (
  corruption: "none" | "stored_vat" = "none",
): Promise<RenewalFacts> => { ... }
```

Source fingerprint: `sha256:e9ee95484c1d5406`

**Production code: [`src/shared/accounting/store.ts#postTransfersTx`](../../src/shared/accounting/store.ts#L100)**

```ts
export const postTransfersTx = async (
  tx: TxScope,
  inputs: TransferInput[],
): Promise<PostResult> => { ... }
```

Source fingerprint: `sha256:92e711a63a1d9dea`

## The safety claim

Every invoice role matches its expected amount. A positive role has exactly one leg with the right account, reference, and paid time. A zero role has no leg. Cash equals sale plus VAT. A refused call leaves every stored leg unchanged.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use a month plan of 600 with 100 VAT, 100 invoices in one case, and all eight statuses.
- Provider replies are synthetic assumptions. The model does not prove provider truth.
- The model reads committed legs before and after each pass. It does not prove SQL atomicity or rollback.
- The model checks safety. It does not prove that a retry runs or that work finishes.
- Invoices older than the newest 100 and later manual collection need separate tests.
- The arithmetic cases check local integer math. They do not prove that Stripe accepts a large charge.

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
