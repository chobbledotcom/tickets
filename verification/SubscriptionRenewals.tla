------------------------- MODULE SubscriptionRenewals -------------------------
EXTENDS Integers, FiniteSets, ModelRules, SubscriptionRules, SubscriptionRenewalsData

\* A booking row connects one attendee, the stored customer, to one listing,
\* the ticket offer. Its frozen plan states the recurring amount and VAT.
\* A Stripe invoice identifies one outside payment. A ledger leg records
\* money between accounts. Amounts are integer currency minor units.
\* Example: a 600-unit invoice with 100 VAT needs cash 600, sale 500, VAT 100.
\* A replay must keep those same legs. A replaced booking must post nothing.
\*
\* renewal-observations.ts executes recordObserved and reads committed legs.
\* The production store runs renewalBookingGuard, statusWrite, and the legs
\* in one batch. The producer also observes rollback after a later leg fails.
\* It supplies separate before and after snapshots for each attempted pass.
\* Provider replies are synthetic assumptions. CurrencyFacts executes the
\* real local Stripe read policy, not an outside Stripe request.
\* ArithmeticFacts executes renewalTax. The exact law below is independent.
\*
\* The domain has first and replay passes, equal-value invoice identities,
\* refused reads, changed booking identities, one write fault, and 100 invoices.
\* Large arithmetic cases concern local calculation, not Stripe admission.
\* A changed status alone does not prohibit a previously paid renewal.
\* The booking identity fence and the status comparison have separate purposes.
\* This model does not prove database atomicity, provider truth, eventual work,
\* older invoices outside the newest 100, or later manual collection.
\* == defines a rule. A prime denotes the value after one abstract event.

VARIABLES
  \* The selected synthetic scenario, not a production database column.
  \* @type: Str;
  scenario,
  \* The next observed pass: zero, then one replay, then completion.
  \* @type: Int;
  passIndex,
  \* The status visible in the selected booking after the last commit.
  \* Blank means that the original booking identity no longer exists.
  \* @type: Str;
  storedStatus,
  \* Model evidence that keeps every earlier failed law visible.
  \* @type: Bool;
  checksHold,
  \* Whether the independent arithmetic and currency checks took a step.
  \* This flag imposes no eventual-execution obligation.
  \* @type: Bool;
  arithmeticChecked,
  \* Whether the explicit component joins took a step. This is proof memory.
  \* @type: Bool;
  joinsChecked,
  \* Whether the recorded provider-read identities took a step.
  \* @type: Bool;
  readsChecked

Statuses == LiveStatuses \cup EndedStatuses \cup {""}
ScenarioNames == {item.scenario : item \in ScenarioFacts}
CurrencyCases == {"site_currency", "foreign_currency", "mixed_currency"}
ArithmeticCases == {"planned", "half_up", "tax_only", "zero", "below_one",
  "below_plan", "above_plan", "excess", "no_tax", "below_half", "large"}

\* Required read events come from input attempts, not from returned read rows.
\* An ordinal retains repeated calls even when both arguments are equal.
\* @type: Set({kind: Str, owner: Str});
RequiredReads ==
  {[kind |-> "renewal", owner |-> item.attempt] : item \in ExpectedAttempts}
  \cup {[kind |-> "currency", owner |-> item] : item \in CurrencyCases}
ReadCoverage ==
  /\ \A expected \in RequiredReads :
       Cardinality({read \in ReadFacts :
         read.kind = expected.kind /\ read.owner = expected.owner}) = 1
  /\ \A read \in ReadFacts :
       /\ read.ordinal = 0
       /\ \E expected \in RequiredReads :
            read.kind = expected.kind /\ read.owner = expected.owner

\* The stored booking supplies the renewal target. The currency examples
\* explicitly request sub_currency at the actual Stripe client boundary.
\* @type: ($readFactsFact) => Bool;
ReadIdentitySafe(read) ==
  IF read.kind = "renewal"
  THEN \E op \in OperationFacts :
         read.owner = op.attempt /\ read.target = op.snapshotSubscription
  ELSE read.kind = "currency" /\ read.target = "sub_currency"

\* An invoice fact holds the invoice that the fixture supplied and the ledger
\* legs of its event group at two times: before the call and after the call.
\* The producer reads both from the database. It fails if either read is
\* absent. These two rules give the legs of one time under the same names.
\* @typeAlias: ledgerLegs = { eventGroup: Str, otherCount: Int,
\*   cashCount: Int, cashAmount: Int, cashSource: Str, cashDestination: Str,
\*   cashReference: Str, cashPaidAt: Int,
\*   saleCount: Int, saleAmount: Int, saleSource: Str, saleDestination: Str,
\*   saleReference: Str, salePaidAt: Int,
\*   vatCount: Int, vatAmount: Int, vatSource: Str, vatDestination: Str,
\*   vatReference: Str, vatPaidAt: Int };
\* @type: ($invoiceFactsFact) => $ledgerLegs;
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
\* @type: ($invoiceFactsFact) => $ledgerLegs;
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

\* Every expected attempt and input invoice needs its observed outcomes.
\* The expected sets come from fixture inputs, before the production call.
\* Cardinality counts records. Attempt and invoice ids prevent equal-value
\* payments from disappearing when TLA sets remove identical records.
\* Equal row counts and one invoice fact for each expected invoice leave
\* exactly one fact for each.
Coverage ==
  /\ ScenarioFacts # {}
  /\ \A item \in ScenarioFacts : item.steps \in {1, 2}
  /\ \A expected \in ExpectedAttempts :
       Cardinality({op \in OperationFacts :
         op.attempt = expected.attempt /\ op.scenario = expected.scenario}) = 1
  /\ \A op \in OperationFacts :
       \E expected \in ExpectedAttempts :
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

\* Exact rational arithmetic rounds a half unit upwards. TLA integers do not
\* lose precision in amount * tax, even when both operands are large.
\* @type: (Int, Int, Int) => Int;
TaxShare(amount, price, tax) == (2 * amount * tax + price) \div (2 * price)

\* A missing role has count zero and no account, reference, or paid time.
\* Positive roles need exactly one leg, not a correct sum of duplicate legs.
\* @type: (Int, Int, Str, Str, Str, Int, Int, Str, Str, Str, Int) => Bool;
RoleSafe(count, amount, source, destination, reference, paidAt,
         expectedAmount, expectedSource, expectedDestination, expectedReference, expectedAt) ==
  IF expectedAmount = 0
  THEN /\ count = 0 /\ amount = 0 /\ source = "" /\ destination = ""
       /\ reference = "" /\ paidAt = 0
  ELSE /\ count = 1 /\ amount = expectedAmount
       /\ source = expectedSource /\ destination = expectedDestination
       /\ reference = expectedReference /\ paidAt = expectedAt

\* Check each account role before conservation. A correct total cannot hide
\* cash assigned to another attendee or revenue assigned to another listing.
\* @type: ($ledgerLegs, $invoiceFactsFact) => Bool;
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

\* Only a paid cycle invoice with money can post renewal legs.
\* @type: ($invoiceFactsFact) => Bool;
Eligible(invoice) == invoice.reason = "subscription_cycle" /\ invoice.amount > 0

\* @type: ($operationFactsFact) => Bool;
HasEligible(op) ==
  \E invoice \in InvoiceFacts : invoice.attempt = op.attempt /\ Eligible(invoice)

\* The four identity comparisons are independent of the status comparison.
\* @type: ($operationFactsFact) => Bool;
FenceHeld(op) ==
  /\ op.snapshotId = op.storedId
  /\ op.snapshotAttendee = op.storedAttendee
  /\ op.snapshotListing = op.storedListing
  /\ op.snapshotSubscription = op.storedSubscription

\* A previously recorded invoice must match the new facts exactly. Otherwise
\* the ledger must refuse the whole operation, not rewrite its existing money.
\* @type: ($operationFactsFact) => Bool;
Conflicts(op) ==
  \E invoice \in InvoiceFacts :
    /\ invoice.attempt = op.attempt /\ Eligible(invoice)
    /\ invoice.beforeCashCount > 0
    /\ ~LegsSafe(LegsBefore(invoice), invoice)

\* @type: ($operationFactsFact) => Str;
ExpectedOutcome(op) ==
  IF op.readStatus # "found" \/ ~HasEligible(op) THEN "returned"
  ELSE IF Conflicts(op) THEN "ledger_conflict"
  ELSE IF ~FenceHeld(op) THEN "booking_fence"
  ELSE IF op.fault THEN "write_fault"
  ELSE "returned"

\* A terminal status replaces a live status. A live observation replaces only
\* the status that the caller read. Neither can resurrect an ended record.
\* @type: ($operationFactsFact) => Str;
ExpectedStatus(op) ==
  IF op.observed \in EndedStatuses /\ op.beforeStatus \in LiveStatuses
  THEN op.observed
  ELSE IF op.beforeStatus = op.snapshotStatus THEN op.observed
  ELSE op.beforeStatus

\* Refused reads and failed writes must preserve both durable facts together.
\* The legs after such a call must equal the legs before it in every field:
\* amounts, accounts, references, and paid times.
\* A successful call checks each eligible invoice and leaves other invoices alone.
\* @type: ($operationFactsFact) => Bool;
AttemptSafe(op) ==
  LET refused == op.outcome # "returned" \/ op.readStatus # "found" IN
  /\ op.outcome = ExpectedOutcome(op)
  /\ op.afterStatus = IF refused THEN op.beforeStatus ELSE ExpectedStatus(op)
  /\ \A invoice \in InvoiceFacts :
       invoice.attempt = op.attempt =>
         IF refused \/ ~Eligible(invoice)
         THEN LegsAfter(invoice) = LegsBefore(invoice)
         ELSE LegsSafe(LegsAfter(invoice), invoice)

\* One fixture carries the actual provider plan through four stored phases.
\* Another fixture carries one first-invoice reference through three failed
\* checkout deliveries. Missing joins must fail at Init, not become vacuous.
JoinCoverage ==
  /\ Cardinality(JourneyFacts) = 4
  /\ {item.phase : item \in JourneyFacts} = {"stored", "edited", "renewed", "cancelled"}
  /\ Cardinality(FailedJoinFacts) = 3
  /\ {item.attempt : item \in FailedJoinFacts} = {1, 2, 3}

\* The source request, observed plan, projection, and renewal inputs must agree
\* on identities, units and multiplicity. Listing and tax edits cannot change
\* the stored plan. The fixture adds 20 percent VAT to the initial net plan.
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

\* These are stored zero-place rows and durable refund-authority amounts.
\* Delivery one cannot end the subscription. Two ends it and refunds once.
\* Three replays the same completed work without another provider refund.
FailedJoinLaw ==
  /\ \A item \in FailedJoinFacts :
       /\ item.booking > 0 /\ item.attendee > 0 /\ item.quantity = 0
       /\ item.listing = item.observedListing
       /\ item.subscription = item.observedSubscription
       /\ item.amount = item.observedAmount
       /\ item.interval = item.observedInterval
       /\ item.status = item.observedStatus
       /\ item.consumedReference = item.observedReference
       /\ item.refundBeforeEnd = 0
       /\ item.refunds = (IF item.attempt = 1 THEN 0 ELSE 1)
       /\ item.confirmed = (item.attempt # 1)
       /\ item.held = (IF item.attempt = 1 THEN 1 ELSE 0)
       /\ item.authorityReturned = (IF item.attempt = 1 THEN 0 ELSE 600)
       /\ item.refundCash = (IF item.attempt = 1 THEN 0 ELSE 600)
  /\ \A left, right \in FailedJoinFacts :
       left.booking = right.booking /\ left.attendee = right.attendee

\* Coverage holds no state variable, so Init evaluates it one time and keeps
\* the result in checksHold. A gap in the facts makes the first state unsafe.
\* Safety first checks Init, then an unrestricted Next step from any Safety
\* state. This induction concerns the supplied abstract events and finite facts.
TypeOK ==
  /\ scenario \in ScenarioNames /\ passIndex \in 0..2
  /\ storedStatus \in Statuses
  /\ checksHold \in BOOLEAN /\ arithmeticChecked \in BOOLEAN /\ joinsChecked \in BOOLEAN
  /\ readsChecked \in BOOLEAN
Safety == TypeOK /\ checksHold

\* Begin before the selected scenario's first recordObserved call. The fixture
\* has a plan but no renewal legs, even if its identity already changed.
Init ==
  /\ \E index \in ScenarioFactsIndices :
       LET item == ScenarioFactsAt(index) IN
       /\ scenario = item.scenario /\ storedStatus = item.initialStatus
  /\ passIndex = 0 /\ checksHold = (Coverage /\ JoinCoverage)
  /\ arithmeticChecked = FALSE
  /\ joinsChecked = FALSE
  /\ readsChecked = FALSE

\* Integer choice permits any observed attempt through bounded-width pages.
\* The status before a pass must match the abstract committed status. Each
\* pass reads its ledger legs from the database before and after the call,
\* so the model keeps no ledger state between passes.
\* Refusals still take a step, so an unsafe result cannot vanish behind a guard.
InspectPass ==
  \E index \in OperationFactsIndices :
    LET op == OperationFactsAt(index) IN
    /\ op.scenario = scenario /\ op.index = passIndex
    /\ op.beforeStatus = storedStatus
    /\ passIndex' = passIndex + 1
    /\ storedStatus' = op.afterStatus
    /\ checksHold' = ChecksStillPass(checksHold, AttemptSafe(op))
    /\ UNCHANGED <<scenario, arithmeticChecked, joinsChecked, readsChecked>>

\* Arithmetic and currency faults remain visible even when later passes pass.
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

\* A failed component join remains visible after every later successful event.
InspectJoins ==
  /\ ~joinsChecked
  /\ checksHold' = ChecksStillPass(checksHold, JourneyLaw /\ FailedJoinLaw)
  /\ joinsChecked' = TRUE
  /\ UNCHANGED <<scenario, passIndex, storedStatus, arithmeticChecked, readsChecked>>

\* Every captured argument must name the subscription that owns its evidence.
InspectReads ==
  /\ ~readsChecked
  /\ checksHold' = ChecksStillPass(checksHold,
       \A read \in ReadFacts : ReadIdentitySafe(read))
  /\ readsChecked' = TRUE
  /\ UNCHANGED <<scenario, passIndex, storedStatus, arithmeticChecked, joinsChecked>>

\* The alternatives describe event order, not instructions that always run.
\* Stuttering permits no change. No fairness or eventual completion is claimed.
Next == InspectPass \/ InspectArithmetic \/ InspectJoins \/ InspectReads \/
  UNCHANGED <<scenario, passIndex, storedStatus, checksHold,
    arithmeticChecked, joinsChecked, readsChecked>>
=============================================================================
