# One subscription checkout and the plan that it stores

[Read the model](../../verification/SubscriptionCheckout.tla).

This page follows one subscription checkout from order admission to the stored plan. An admitted subscription order reaches Stripe with one recurring line and the first invoice reference. Every booking row keeps the plan of its own start, with VAT inside the recurring amount.

## The bad outcome it rules out

An unsupported order reaches Stripe, the first payment cites the wrong invoice or intent, or the plan lands on another person's row or the wrong row.

## The cast

| Word | Meaning |
| --- | --- |
| **checkout** | The first payment of a subscription. It starts one subscription and charges the tickets at once. |
| **admission** | The decision that an order can reach a checkout, and that a subscription can start. |
| **request** | The Stripe checkout request, with its one-time lines, its one recurring line, and its interval. |
| **plan** | The stored columns on one booking row. They state the provider id, status, period amount, VAT amount, and interval. |
| **fact** | One prepared example record from the producer. It is not a live Stripe reply. |
| **identity** | The scenario name or row name that ties one fact to its expected outcome. |
| **verdict** | The model memory of any failed business law. |

## The walkthrough

### Step 1: Start before any observed event

The model starts with no selected fact. Coverage checks the prepared facts one time and stores the answer in checksPassed. TypeOK keeps the table name and its one-based index in step. SelectedIdentity reads the identity of the selected row. The words none and zero are model memory, not event ids.

| Value | This step |
| --- | --- |
| `checksPassed` | TRUE |
| `selected` | none |
| `selectionKind` | none |
| `selectionIndex` | 0 |
| `attempt` | 0 |

**Model rule: [`Init`](../../verification/SubscriptionCheckout.tla#L160)**

```tla
Init ==
  /\ checksPassed = Coverage
  /\ selected = "none"
  /\ selectionKind = "none"
  /\ selectionIndex = 0
  /\ attempt = 0
```

**Model rule: [`TypeOK`](../../verification/SubscriptionCheckout.tla#L57)**

```tla
TypeOK ==
  /\ checksPassed \in BOOLEAN
  /\ selectionKind \in {"none", "admission", "request", "plan"}
  /\ selectionIndex \in Int
  /\ IF selectionKind = "none" THEN selectionIndex = 0
     ELSE /\ selectionIndex >= 1
          /\ selectionIndex <=
               IF selectionKind = "admission" THEN AdmissionFactsCount
               ELSE IF selectionKind = "request" THEN RequestFactsCount
               ELSE PlanFactsCount
  /\ selected = SelectedIdentity(selectionKind, selectionIndex)
  /\ attempt \in Int
```

**Model rule: [`SelectedIdentity`](../../verification/SubscriptionCheckout.tla#L49)**

```tla
SelectedIdentity(kind, index) ==
  IF kind = "admission" THEN AdmissionFactsAt(index).scenario
  ELSE IF kind = "request" THEN RequestFactsAt(index).scenario
  ELSE IF kind = "plan" THEN PlanFactsAt(index).identity
  ELSE "none"
```

**Production code: [`scripts/verify-models/subscriptions/checkout-facts.ts#CHECKOUT_TABLES`](../../scripts/verify-models/subscriptions/checkout-facts.ts#L5)**

```ts
export const CHECKOUT_TABLES = {
  admissions: [
    "AdmissionFacts",
    {
      attempt: "Int",
      checkoutAccepted: "Bool",
      deposit: "Bool",
      orderAccepted: "Bool",
      own: "Bool",
      provider: "Str",
      scenario: "Str",
      shape: "Str",
      subscriptions: "Int",
      total: "Int",
    },
  ],
  plans: [
    "PlanFacts",
    {
      amount: "Int",
      attempt: "Int",
      attendee: "Int",
      booking: "Int",
      expectedAmount: "Int",
// ...
```

Source fingerprint: `sha256:4b5aacf9d95db08b`

### Step 2: An order must pass the admission gate

The admission rule reads one order. An ordinary order with no subscription line passes. A subscription order passes only with the stripe provider, one subscription line, and a row that the order books on its own. The order gate also needs a total above zero. A deposit changes the first payment only, so it does not change this decision. The step records the observed verdict and keeps any earlier failure.

| Value | This step |
| --- | --- |
| `stripe-extra` | Provider stripe, one subscription line, own row TRUE, total 2000. Checkout accepted TRUE. Order accepted TRUE. |
| `square-single` | Provider square, one subscription line. Checkout accepted FALSE. Order accepted FALSE. |
| `none-ordinary` | No subscription line, total 0. Checkout accepted TRUE. Order accepted TRUE. |
| `stripe-zero` | One subscription line, total 0. Checkout accepted TRUE. Order accepted FALSE. |
| `stripe-deposit` | A deposit changes the first payment to 100. Admission still passes with one subscription line. |

**Model rule: [`AdmissionLaw`](../../verification/SubscriptionCheckout.tla#L114)**

```tla
AdmissionLaw(f) ==
  LET supported == f.provider = "stripe" /\ f.subscriptions = 1 /\ f.own
  IN /\ f.checkoutAccepted = (f.subscriptions = 0 \/ supported)
     /\ f.orderAccepted = (f.subscriptions = 0 \/ (supported /\ f.total > 0))
```

**Model rule: [`AdmissionStep`](../../verification/SubscriptionCheckout.tla#L172)**

```tla
AdmissionStep ==
  \E index \in AdmissionFactsIndices :
    LET f == AdmissionFactsAt(index) IN
    /\ selectionKind' = "admission" /\ selectionIndex' = index
    /\ checksPassed' = ChecksStillPass(checksPassed, AdmissionLaw(f))
    /\ selected' = f.scenario
    /\ attempt' = f.attempt
```

**Production code: [`src/shared/subscriptions/checkout-rules.ts#subscriptionCheckoutError`](../../src/shared/subscriptions/checkout-rules.ts#L26)**

```ts
export const subscriptionCheckoutError = (
  provider: PaymentProviderType | null,
  intent: CheckoutIntent,
): string | null => { ... }
```

Source fingerprint: `sha256:31cca1f2930dcbdc`

**Production code: [`src/shared/subscriptions/checkout-rules.ts#subscriptionOrderError`](../../src/shared/subscriptions/checkout-rules.ts#L52)**

```ts
export const subscriptionOrderError = (
  provider: PaymentProviderType | null,
  intent: CheckoutIntent,
  total: number,
): string | null => { ... }
```

Source fingerprint: `sha256:d47ac7650a5a56e0`

### Step 3: The Stripe request names one recurring line

The request rule reads the composed Stripe request. The mode is subscription. The request has one recurring line with quantity one. That line charges the whole recurring amount and names the subscribed listing in its metadata. The one-time lines charge the first payment. The trial end is one period after the start. The payment reference comes from the first invoice of this session, not a later renewal. The request id, the session id, and the first invoice id stay apart.

| Value | This step |
| --- | --- |
| `checkout-1 interval` | week. The recurring amount is 1002 minor units for two places. |
| `checkout-1 first payment` | 2137 minor units on 2 one-time lines. |
| `checkout-1 trial end` | 2027-01-04T10:15:00Z from the start 2026-12-28T10:15:00Z. |
| `checkout-10 interval` | month. The start 2026-01-31T10:15:00Z gives the trial end 2026-02-28T10:15:00Z. |
| `checkout-25 interval` | year. The leap-day start 2024-02-29T10:15:00Z gives the trial end 2025-02-28T10:15:00Z. |
| `identities` | request_1, session cs_model_1, first invoice in_first_1, reference pi_first_1. |

**Model rule: [`RequestLaw`](../../verification/SubscriptionCheckout.tla#L124)**

```tla
RequestLaw(f) ==
  /\ f.mode = "subscription"
  /\ f.recurringLines = 1
  /\ f.recurringQuantity = 1
  /\ f.recurringAmount = f.expectedAmount
  /\ f.interval = f.expectedInterval
  /\ f.metadataListing = f.listing
  /\ f.oneTimeLines = f.expectedOneTimeLines
  /\ f.oneTimeAmount = f.expectedInitial
  /\ f.subscribedInitial = f.expectedSubscribedInitial
  /\ f.ordinaryInitial = f.expectedOrdinaryInitial
  /\ f.initialQuantity = f.expectedQuantity
  /\ f.trialEnd = f.expectedTrialEnd
  /\ f.paymentReference = f.expectedReference
  /\ f.invoiceRead = f.firstInvoice
  /\ f.subscriptionRead = f.subscription
  /\ f.request /= f.session
  /\ f.firstInvoice /= f.subscription
```

**Model rule: [`RequestStep`](../../verification/SubscriptionCheckout.tla#L179)**

```tla
RequestStep ==
  \E index \in RequestFactsIndices :
    LET f == RequestFactsAt(index) IN
    /\ selectionKind' = "request" /\ selectionIndex' = index
    /\ checksPassed' = ChecksStillPass(checksPassed, RequestLaw(f))
    /\ selected' = f.scenario
    /\ attempt' = f.attempt
```

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

**Production code: [`src/shared/payment/checkout-session.ts#makeCreateCheckoutSession`](../../src/shared/payment/checkout-session.ts#L59)**

```ts
export const makeCreateCheckoutSession =
  <Result>(
    provider: PaymentProviderType,
    create: (intent: CheckoutIntent, baseUrl: string) => Promise<Result | null>,
    readResult: (result: Result) => {
      id: string | undefined;
      /** When the checkout stops taking payment, for a provider whose
       * checkout can outlive the payments clock. */
      linkEndsAt?: string;
      url: string | undefined | null;
    },
  ): ((
    intent: CheckoutIntent,
    baseUrl: string,
  ) => Promise<CheckoutSessionResult>) => ...
```

Source fingerprint: `sha256:8776a7df2b80d238`

**Production code: [`src/shared/subscriptions/plan.ts#firstRecurringChargeAt`](../../src/shared/subscriptions/plan.ts#L40)**

```ts
export const firstRecurringChargeAt = (
  nowSeconds: number,
  interval: RecurringInterval,
): number => ...
```

Source fingerprint: `sha256:62bb90061b1f3836`

**Production code: [`src/shared/stripe/subscription.ts#subscriptionStartOf`](../../src/shared/stripe/subscription.ts#L32)**

```ts
export const subscriptionStartOf = (
  subscription: StripeSubscription,
  firstInvoice: StripeInvoicePayments,
): { paymentReference: string; start: SubscriptionStart } => { ... }
```

Source fingerprint: `sha256:3873c12bd70cc549`

### Step 4: The plan stays on the row that started it

The plan rule reads every stored row, not only the subscribed row. The plan goes on the own row of the subscribed listing. An extra ordinary line, a package row, and an add-on child row keep no plan. The plan amount is the whole recurring charge, and the tax is the VAT inside that amount. A later listing edit or a change to the tax policy cannot move a plan that is already stored. An ended status still keeps its plan columns.

| Value | This step |
| --- | --- |
| `checkout-1 own row` | Row 105 keeps 1002 minor units, VAT 0, interval week, status active, provider sub_model_1. |
| `checkout-10 own row` | Row 1005 keeps 501 minor units, VAT 251, interval month, status canceled, provider sub_model_10. |
| `checkout-10 control row` | Row 1000 keeps provider sub_other_10, 333 minor units, VAT 55, interval year, status canceled. |
| `after a listing edit` | Row 1005 still keeps 501 minor units and the month interval while its listing states 9999 and week. |

**Model rule: [`PlanLaw`](../../verification/SubscriptionCheckout.tla#L148)**

```tla
PlanLaw(f) ==
  /\ f.subscription = f.expectedSubscription
  /\ f.status = f.expectedStatus
  /\ f.interval = f.expectedInterval
  /\ f.amount = f.expectedAmount
  /\ f.tax = f.expectedTax
```

**Model rule: [`PlanStep`](../../verification/SubscriptionCheckout.tla#L186)**

```tla
PlanStep ==
  \E index \in PlanFactsIndices :
    LET f == PlanFactsAt(index) IN
    /\ selectionKind' = "plan" /\ selectionIndex' = index
    /\ checksPassed' = ChecksStillPass(checksPassed, PlanLaw(f))
    /\ selected' = f.identity
    /\ attempt' = f.attempt
```

**Production code: [`src/shared/subscriptions/booking-plan.ts#withSubscriptionPlan`](../../src/shared/subscriptions/booking-plan.ts#L22)**

```ts
export const withSubscriptionPlan = (
  bookings: ListingBooking[],
  start: SubscriptionStart | undefined,
  policy: TaxPolicy,
): ListingBooking[] => { ... }
```

Source fingerprint: `sha256:a1a5fc78afd91e5c`

**Production code: [`src/shared/db/attendees/capacity/checks.ts#buildCapacityCheckedInsert`](../../src/shared/db/attendees/capacity/checks.ts#L42)**

```ts
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeId: Operand<number> = valued(sql`last_insert_rowid()`),
  allowOverbook = false,
  extraCondition?: SqlStatement,
): SqlStatement => { ... }
```

Source fingerprint: `sha256:101b92315305deb9`

**Production code: [`src/shared/tax/assessment.ts#assessTax`](../../src/shared/tax/assessment.ts#L37)**

```ts
export const assessTax = (
  basis: TaxBasis,
  policy: TaxPolicy,
): TaxAssessment => { ... }
```

Source fingerprint: `sha256:728a9319fc2523a6`

### Step 5: Every prepared input has one outcome

The coverage rule compares three prepared universes with the observed facts. Each universe lists every expected identity before a read. A row must carry an expected name, and each expected name needs one row. Equal counts also stop two different outcomes for one identity. Coverage also requires each important shape to occur. The interval set must hold week, month, and year. The tax mode set must hold none, add_to_total, and calculate_from_total. The status set must hold all eight words. One owned plan row must hold zero places.

| Value | This step |
| --- | --- |
| `admission facts` | 40 rows from 4 providers and 10 order shapes. |
| `request facts` | 40 rows from 5 start dates and 8 status words. |
| `plan facts` | 516 rows from 43 examples, 6 rows each, in 2 read stages. |
| `required witnesses` | stripe-extra accepted, stripe-deposit accepted, square-package refused, stripe-quantity-two accepted. |
| `local-41` | An owned plan row with quantity 0. The amount is 0 minor units. |

**Model rule: [`Coverage`](../../verification/SubscriptionCheckout.tla#L92)**

```tla
Coverage ==
  /\ IdentityCoverage(AdmissionFacts, AdmissionScenarioOf, AdmissionFactsCount,
       AdmissionUniverse, AdmissionUniverseCount)
  /\ IdentityCoverage(RequestFacts, RequestScenarioOf, RequestFactsCount,
       RequestUniverse, RequestUniverseCount)
  /\ IdentityCoverage(PlanFacts, PlanIdentityOf, PlanFactsCount,
       PlanUniverse, PlanUniverseCount)
  /\ \E f \in AdmissionFacts : f.orderAccepted /\ f.shape = "extra"
  /\ \E f \in AdmissionFacts : f.orderAccepted /\ f.deposit /\ f.subscriptions = 1
  /\ \E f \in AdmissionFacts : ~f.orderAccepted /\ f.shape = "package"
  /\ \E f \in AdmissionFacts : f.orderAccepted /\ f.shape = "quantity-two"
  /\ {f.expectedInterval : f \in RequestFacts} = {"week", "month", "year"}
  /\ {f.taxMode : f \in RequestFacts} = {"none", "add_to_total", "calculate_from_total"}
  /\ {f.status : f \in RequestFacts} = {"active", "canceled", "incomplete", "incomplete_expired", "past_due", "paused", "trialing", "unpaid"}
  /\ \E f \in PlanFacts : f.owned /\ f.quantity = 0
```

**Model rule: [`IdentityCoverage`](../../verification/SubscriptionCheckout.tla#L76)**

```tla
IdentityCoverage(rows, IdentityOf(_), rowCount, expected, expectedCount) ==
  /\ expectedCount > 0
  /\ rowCount = expectedCount
  /\ \A row \in rows : IdentityOf(row) \in expected
  /\ \A name \in expected : \E row \in rows : IdentityOf(row) = name
```

**Model rule: [`AdmissionScenarioOf`](../../verification/SubscriptionCheckout.tla#L84)**

```tla
AdmissionScenarioOf(row) == row.scenario
```

**Model rule: [`RequestScenarioOf`](../../verification/SubscriptionCheckout.tla#L86)**

```tla
RequestScenarioOf(row) == row.scenario
```

**Model rule: [`PlanIdentityOf`](../../verification/SubscriptionCheckout.tla#L88)**

```tla
PlanIdentityOf(row) == row.identity
```

**Production code: [`scripts/verify-models/subscriptions/checkout.ts#checkoutFacts`](../../scripts/verify-models/subscriptions/checkout.ts#L18)**

```ts
export const checkoutFacts = (
  boundary: CheckoutBoundary = {},
): Promise<CheckoutFacts> => ...
```

Source fingerprint: `sha256:1b03057eaac644c4`

**Production code: [`scripts/verify-models/subscriptions/checkout-admission.ts#admissionFacts`](../../scripts/verify-models/subscriptions/checkout-admission.ts#L73)**

```ts
export const admissionFacts = (): {
  facts: CheckoutFacts["admissions"];
  universe: string[];
} => { ... }
```

Source fingerprint: `sha256:151e7cca36a3b344`

### Step 6: A failed law stays failed

The step relation selects any prepared fact or changes nothing. Each selected fact must pass its law. A fact that passes keeps checksPassed TRUE. A fact that fails sets checksPassed FALSE. A later fact that passes cannot clear that value. Safety requires TypeOK and checksPassed. The model does not force a checkout event to occur.

| Value | This step |
| --- | --- |
| `good fact` | checksPassed TRUE, then TRUE. |
| `square-single with order accepted TRUE` | The admission law fails. checksPassed becomes FALSE. |
| `later good fact` | checksPassed stays FALSE. |
| `no event` | Every value keeps its current state. |

**Model rule: [`Next`](../../verification/SubscriptionCheckout.tla#L197)**

```tla
Next == AdmissionStep \/ RequestStep \/ PlanStep \/
        UNCHANGED <<checksPassed, selected, selectionKind, selectionIndex, attempt>>
```

**Model rule: [`Safety`](../../verification/SubscriptionCheckout.tla#L166)**

```tla
Safety == TypeOK /\ checksPassed
```

**Production code: [`src/shared/stripe-provider.ts#stripePaymentProvider`](../../src/shared/stripe-provider.ts#L139)**

```ts
export const stripePaymentProvider: PaymentProvider = {
  checkoutCompletedEventType:
    "checkout.session.completed" satisfies StripeCheckoutCompletedEvent["type"],
  createCheckoutSession: createStripeCheckoutSession,

  readCharge: readStripeCharge,

  refundCharge: refundWithOneReread(
    (request) => {
      requireProviderRefundAuthorization(request, "stripe");
      return stripeApi.refundCharge(request);
    },
    (reference) => stripePaymentProvider.readCharge(reference),
  ),

  async resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<WebhookSessionResult> {
    const id = obj.id;
    if (typeof id !== "string" || id.length === 0) return null;

    const session = v.parse(StripeCheckoutSessionSchema, obj);
    const validated = await toValidatedSession(session);
    return validated === null ? await this.retrieveSession(id) : validated;
// ...
```

Source fingerprint: `sha256:bea3ea5921fae893`

## The safety claim

Every observed admission fact obeys the order gate. Every request fact has one recurring line for the whole quantity and the first-invoice reference. Every stored row keeps its own exact plan. Any failed law stays visible.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use synthetic orders and a local Stripe client. No live Stripe reply is observed.
- Expected money uses integer minor units from supplied inputs. The model does not prove that Stripe accepts those prices.
- The model uses literal UTC calendar dates. It does not call the production date code.
- The model checks the supplied finite facts. It does not prove a network race, an order that a scheduler chooses, or a full callback replay.
- The model does not prove that a checkout finishes or that a webhook later arrives.
- SQL atomicity and the local database remain assumptions.

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
