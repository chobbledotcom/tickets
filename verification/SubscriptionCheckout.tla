------------------------ MODULE SubscriptionCheckout ------------------------
\* A checkout is the buyer's first payment. A listing is a bookable ticket.
\* A booking row links one person to a listing and keeps that person's plan.
\* The plan says what Stripe charges in each later period, including VAT.
\* The bad outcomes are an unsupported order, a wrong first payment reference,
\* or a plan stored on another row. For example, buying two club places and one
\* ordinary ticket must put the club plan on the club row, not the extra ticket.
EXTENDS Integers, FiniteSets, ModelRules, SubscriptionCheckoutData

\* scripts/verify-models/subscriptions/checkout.ts supplies these facts.
\* checkout-admission.ts calls subscriptionOrderError and subscriptionCheckoutError.
\* checkout-provider.ts executes stripeApi.createCheckoutSession and the actual
\* stripePaymentProvider.retrieveSession caller. The client records the request
\* and the invoice identity read by sessionCharge. subscriptionStartOf alone
\* cannot establish which invoice the session selected.
\* checkout-storage.ts calls withSubscriptionPlan, executes the production
\* buildCapacityCheckedInsert against the production schema and reads its rows.
\* An ordinary row, a same-listing package row and a same-listing child row
\* precede the subscribed own row. Each omitted ownership test can fail.
\* It reads them again after listing and tax-setting writes.
\* Supplied client replies are assumptions, not observations from Stripe.
\* Expected money uses exact integer fractions. Expected dates are literal UTC
\* calendar examples, not calls to Temporal, assessTax or planOfStart.
\* A scenario names an independent example. An attempt names its execution.
\* Session, request, subscription, invoice, listing and booking are distinct ids.
\* Each stored fact also retains its read stage, before or after later edits.
\* Sets remove equal members; the identity fields retain each separate event.

VARIABLES
  \* Model-only evidence: FALSE retains any failed business law.
  \* @type: Bool;
  checksPassed,
  \* The last scenario or row-stage identity, so a trace names the bad event.
  \* @type: Str;
  selected,
  \* The table and its one-based index name the same selected fact.
  \* "none" and zero denote Init; these are model memory, not event ids.
  \* @type: Str;
  selectionKind,
  \* @type: Int;
  selectionIndex,
  \* The call attempt, not the number of tickets or provider invoices.
  \* @type: Int;
  attempt

\* Callers must bound index by the selected table's Indices domain first.
\* Paged lookup retains the complete identity without a 600-way string choice.
\* @type: (Str, Int) => Str;
SelectedIdentity(kind, index) ==
  IF kind = "admission" THEN AdmissionFactsAt(index).scenario
  ELSE IF kind = "request" THEN RequestFactsAt(index).scenario
  ELSE IF kind = "plan" THEN PlanFactsAt(index).identity
  ELSE "none"

\* == defines a rule, not an assignment. /\ means both conditions must hold.
\* A prime below names the value after one abstract step.
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

\* The producer names each expected identity before it reads that outcome.
\* Every observed row must carry an expected name, and every expected name
\* needs an observed row. Each count is a row count, so equal counts also
\* reject two different outcomes for one identity. IdentityOf reads the
\* identity field of one row.
\* @type: (Set(a), (a) => Str, Int, Set(Str), Int) => Bool;
IdentityCoverage(rows, IdentityOf(_), rowCount, expected, expectedCount) ==
  /\ expectedCount > 0
  /\ rowCount = expectedCount
  /\ \A row \in rows : IdentityOf(row) \in expected
  /\ \A name \in expected : \E row \in rows : IdentityOf(row) = name

\* A scenario names one admission or request. A plan row has its own identity.
\* @type: ($admissionFactsFact) => Str;
AdmissionScenarioOf(row) == row.scenario
\* @type: ($requestFactsFact) => Str;
RequestScenarioOf(row) == row.scenario
\* @type: ($planFactsFact) => Str;
PlanIdentityOf(row) == row.identity

\* Each input needs one outcome, including refusals. PlanUniverse is prepared
\* before the row SELECT, so a lost row cannot vanish from the expectation.
Coverage ==
  /\ IdentityCoverage(AdmissionFacts, AdmissionScenarioOf, AdmissionFactsCount,
       AdmissionUniverse, AdmissionUniverseCount)
  /\ IdentityCoverage(RequestFacts, RequestScenarioOf, RequestFactsCount,
       RequestUniverse, RequestUniverseCount)
  /\ IdentityCoverage(PlanFacts, PlanIdentityOf, PlanFactsCount,
       PlanUniverse, PlanUniverseCount)
  /\ \E f \in AdmissionFacts : f.orderAccepted /\ f.shape = "extra"
  /\ \E f \in AdmissionFacts : ~f.orderAccepted /\ f.shape = "deposit"
  /\ \E f \in AdmissionFacts : f.orderAccepted /\ f.shape = "quantity-two"
  /\ {f.expectedInterval : f \in RequestFacts} = {"week", "month", "year"}
  /\ {f.taxMode : f \in RequestFacts} = {"none", "add_to_total", "calculate_from_total"}
  /\ {f.status : f \in RequestFacts} = {"active", "canceled", "incomplete", "incomplete_expired", "past_due", "paused", "trialing", "unpaid"}
  /\ \E f \in PlanFacts : f.owned /\ f.quantity = 0

\* An ordinary order needs no subscription provider. A subscribed order needs
\* Stripe, one independently booked subscription line and full payment.
\* Extra ordinary lines and quantities above one do not break this law.
\* The checkout gate leaves zero-total refusal to the earlier order gate.
\* @type: ($admissionFactsFact) => Bool;
AdmissionLaw(f) ==
  LET supported == f.provider = "stripe" /\ f.subscriptions = 1 /\ f.own /\ ~f.partPayment
  IN /\ f.checkoutAccepted = (f.subscriptions = 0 \/ supported)
     /\ f.orderAccepted = (f.subscriptions = 0 \/ (supported /\ f.total > 0))

\* The first payment has two one-time ticket lines and, when added, one VAT
\* line. One additional recurring line charges the whole quantity after a period.
\* Its listing metadata must name the subscribed listing. A renewal intent
\* cannot replace the intent that paid the session's first invoice.
\* @type: ($requestFactsFact) => Bool;
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

\* Every row, including ordinary and other-person rows, must keep its own
\* complete plan. Expectations come from the supplied start and frozen policy,
\* not the returned attachment or the edited listing. Empty plans use defaults.
\* Money is integer minor units; tax is VAT inside the recurring gross amount.
\* @type: ($planFactsFact) => Bool;
PlanLaw(f) ==
  /\ f.subscription = f.expectedSubscription
  /\ f.status = f.expectedStatus
  /\ f.interval = f.expectedInterval
  /\ f.amount = f.expectedAmount
  /\ f.tax = f.expectedTax

\* Initially no event has been selected. Coverage holds no state variable, so
\* Init evaluates it one time and keeps the result in checksPassed. A gap in
\* the facts makes the first state unsafe. The unrestricted inductive check
\* starts from any safe state, not only this initial state. Each Next step
\* must retain the same laws.
Init ==
  /\ checksPassed = Coverage
  /\ selected = "none"
  /\ selectionKind = "none"
  /\ selectionIndex = 0
  /\ attempt = 0
Safety == TypeOK /\ checksPassed

\* Integer choice permits every fact, not only the first. Paged lookup avoids
\* one recursive checker equality builder across the full 600-row plan table.
\* Refusals retain their observed verdict; no safe replacement is constructed.
\* ChecksStillPass remembers a bad event even after a later successful event.
AdmissionStep ==
  \E index \in AdmissionFactsIndices :
    LET f == AdmissionFactsAt(index) IN
    /\ selectionKind' = "admission" /\ selectionIndex' = index
    /\ checksPassed' = ChecksStillPass(checksPassed, AdmissionLaw(f))
    /\ selected' = f.scenario
    /\ attempt' = f.attempt
RequestStep ==
  \E index \in RequestFactsIndices :
    LET f == RequestFactsAt(index) IN
    /\ selectionKind' = "request" /\ selectionIndex' = index
    /\ checksPassed' = ChecksStillPass(checksPassed, RequestLaw(f))
    /\ selected' = f.scenario
    /\ attempt' = f.attempt
PlanStep ==
  \E index \in PlanFactsIndices :
    LET f == PlanFactsAt(index) IN
    /\ selectionKind' = "plan" /\ selectionIndex' = index
    /\ checksPassed' = ChecksStillPass(checksPassed, PlanLaw(f))
    /\ selected' = f.identity
    /\ attempt' = f.attempt

\* Next permits each observed event or a step with no change. It asserts
\* safety, not eventual provider completion. Examples are independent seeds,
\* not a claim that one person's checkout can become another person's plan.
Next == AdmissionStep \/ RequestStep \/ PlanStep \/
        UNCHANGED <<checksPassed, selected, selectionKind, selectionIndex, attempt>>

\* Limits: selected finite synthetic orders, dateless rows and UTC calendars.
\* All current statuses, including already-ended starts, and all tax modes
\* occur. No real Stripe admission, provider truth, network race, scheduling,
\* or whole callback replay claim follows. Local zero/large-money attachment
\* cases are not proof that Stripe accepts those prices. SQL atomicity remains
\* a database assumption. Other models check renewals, cancellation and records.
=============================================================================
