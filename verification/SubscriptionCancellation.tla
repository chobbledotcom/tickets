---------------------- MODULE SubscriptionCancellation ----------------------
EXTENDS Integers, FiniteSets, ModelRules, SubscriptionRules, SubscriptionCancellationData

\* A booking row links an attendee (a buyer) to a listing (a ticket). A plan
\* keeps the provider subscription id, price, tax, and period on that row.
\* A failed checkout keeps quantity zero: the row holds a plan but no ticket.
\* A payment anchor is a durable row that holds the right to finish a refund.
\* A ledger leg records one movement of money. An invoice identifies a charge.
\* For example, two last invoices for 600 each must both reach the books before
\* a live row becomes ended. A failed checkout cannot refund while Stripe still
\* permits future charges. An already observed end is sufficient confirmation.
\*
\* scripts/verify-models/subscriptions/cancellation.ts supplies the facts.
\* cancellation-owner.ts runs statusWrite against the production schema. Its
\* cancellation-owner-fixture.ts helper runs cancelOwnerSubscription. The
\* cancellation-checkout-attempt.ts helper runs settleRejectedSubscription
\* and finishPlaceholderRefund. No helper rebuilds that orchestration.
\* Provider requests and stored rows are observed. Supplied provider replies,
\* their truth, and successful SQLite commit atomicity are assumptions.
\* The laws below are independent of the runtime machine's move table.
\*
\* == defines a rule, not an assignment. A prime names the state after a step.
\* A model permits steps; it does not execute this text from top to bottom.
\* Each scenario is an isolated production database. Attempt 2 and attempt 3
\* are deliveries of the same session on that scenario's retained database.
\* The fact identity includes that attempt, so equal-value events cannot merge.

\* SubscriptionRules supplies the independent live and ended status groups.
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

\* A unique fact is required for every selected input identity. Each table
\* count is its number of facts. Every expected identity needs a fact, and the
\* count equals the number of expected identities, so each has exactly one.
\* Cardinality counts the distinct names. Repeated scenarios have three
\* deliveries, so each adds two facts. The guarded-write domain has six live
\* snapshots, eight stored statuses, and eight requested statuses. The write
\* table must hold every combination, and its row count must equal their
\* product. Then no combination is absent and no combination has two results.
\* None of these requirements excludes an unsafe result from an action.
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
  /\ \E o \in Owners : o.returned /\ o.after \in EndedStatuses /\ o.cash = 1200
  /\ \E o \in Owners : o.returned /\ o.after \in LiveStatuses /\ ~o.invoicesRead
  /\ \A affected \in {0, 1} : \E w \in Writes : w.affected = affected
  /\ \E c \in Checkouts : c.entrypoint = "placeholder" /\ c.refunded
  /\ \E c \in Checkouts : c.threw /\ c.held = 1 /\ c.refunds = 0

\* Callers must bound index by the selected table's Indices domain first.
\* The complete scenario identity remains related to the indexed observation.
\* @type: (Str, Int) => Str;
ScenarioIdentity(kind, index) ==
  IF kind = "owner" THEN OwnersAt(index).scenario
  ELSE IF kind = "write" THEN WritesAt(index).scenario
  ELSE IF kind = "checkout" THEN CheckoutsAt(index).scenario
  ELSE "none"

\* TypeOK does not restrict facts or the arbitrary safe pre-state of induction.
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

\* An owner result confirms the external end, not local invoice completion.
\* Refused invoice reads leave the row live even when the return is TRUE.
\* Every fallback and invoice read must target the original subscription id,
\* including refusals. The cumulative identity flag remembers any wrong read.
\* Each final invoice has its own id, event group, cash and leg count. The
\* aggregate cannot hide one lost invoice behind two copies of the other.
\* A stale status alone can still post eligible money. A replaced booking
\* identity must post none. Statement order inside the atomic batch is not a
\* law: the status statement precedes the inserts, and a fault rolls both back.
\* @type: ($ownersFact) => Bool;
SafeOwner(o) ==
  /\ o.requestId = o.subscriptionId
  /\ (o.reads > 0 =>
       (o.readRequestId = o.subscriptionId /\ o.readIdentityKept))
  /\ (o.invoiceReads > 0 =>
       (o.invoiceRequestId = o.subscriptionId /\ o.invoiceIdentityKept))
  /\ o.planKept /\ o.quantity = 1
  /\ o.returned = (~o.threw /\ o.observed \in EndedStatuses)
  /\ o.firstInvoice # o.secondInvoice /\ o.firstGroup # o.secondGroup
  /\ o.cash = o.firstCash + o.secondCash
  /\ o.legs = o.firstLegs + o.secondLegs
  /\ ((o.threw \/ ~o.invoicesRead \/ ~o.identityCurrent) =>
       (o.after = o.before /\ o.cash = 0 /\ o.legs = 0))
  /\ ((o.invoicesRead /\ o.identityCurrent /\ ~o.threw) =>
       (o.firstCash = 600 /\ o.secondCash = 600 /\
        o.firstLegs = 2 /\ o.secondLegs = 2))
  /\ ((o.before \in LiveStatuses /\ o.after \in EndedStatuses) =>
       (o.invoicesRead /\ o.cash = 1200 /\ o.legs = 4))
  /\ ((o.before \in EndedStatuses) => o.after \in EndedStatuses)

\* An ended observation can replace any live word. A live observation can
\* replace only the live word its caller read. Zero changed rows is a silent
\* SQL refusal; the law uses the stored readback, not an assumed exception.
\* @type: ($writesFact) => Bool;
SafeWrite(w) ==
  LET mayWrite == IF w.target \in EndedStatuses
                 THEN w.before \in LiveStatuses
                 ELSE w.before = w.snapshot
  IN /\ w.after = (IF mayWrite THEN w.target ELSE w.before)
     /\ w.affected = (IF mayWrite THEN 1 ELSE 0)

\* Refund counts and ordering come from actual provider boundary calls. The
\* start can already prove an end; then no extra provider call is required.
\* Kept plans retain the start status for the next scheduled invoice pass.
\* A valid anchorless retry still retains its quantity-zero plan; only the
\* failed disposition requires a held payment anchor before cancellation.
\* A booked row or an orphaned sale is durable protection, independent of a
\* historic successful HTTP answer. An occupied callback and foreign proof
\* also permit no cancellation or refund. Missing anchors permit no refund.
\* @type: ($checkoutsFact) => Bool;
SafeCheckout(c) ==
  /\ (c.planRows > 0 => c.planKept)
  /\ c.confirmed = (c.start \in EndedStatuses \/ c.observed \in EndedStatuses)
  /\ c.refundBeforeEnd = 0
  /\ c.refunds <= 1 /\ c.refundLegs <= 1
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
  /\ (c.disposition = "anchorless" => c.refunds = 0)
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

\* Coverage holds no state variable, so Init evaluates it one time and keeps
\* the result in allAttemptsSafe. A gap in the facts makes the first state
\* unsafe. The unrestricted inductive check starts from any state that
\* satisfies Safety, not a hand-picked reachable subset.
\* A fact can enter from every safe state, so no guard hides a bad result.
Safety == TypeOK /\ allAttemptsSafe

\* Init is before applying observations, not a pretend empty application row.
Init ==
  /\ scenario = "none" /\ scenarioKind = "none" /\ scenarioIndex = 0
  /\ attempt = 0 /\ allAttemptsSafe = Coverage

\* Integer choice permits every fact, not only the first. Paged row lookup
\* bounds the checker's symbolic choices without removing an observed attempt.
OwnerStep ==
  \E index \in OwnersIndices :
    LET o == OwnersAt(index) IN
    /\ scenarioKind' = "owner" /\ scenarioIndex' = index
    /\ scenario' = o.scenario /\ attempt' = o.attempt
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeOwner(o))
WriteStep ==
  \E index \in WritesIndices :
    LET w == WritesAt(index) IN
    /\ scenarioKind' = "write" /\ scenarioIndex' = index
    /\ scenario' = w.scenario /\ attempt' = w.attempt
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeWrite(w))
CheckoutStep ==
  \E index \in CheckoutsIndices :
    LET c == CheckoutsAt(index) IN
    /\ scenarioKind' = "checkout" /\ scenarioIndex' = index
    /\ scenario' = c.scenario /\ attempt' = c.attempt
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeCheckout(c))

\* Next permits an owner attempt, a guarded write, a checkout delivery, or a
\* pause. No fairness rule requires a retry. This is safety, not completion.
Next == OwnerStep \/ WriteStep \/ CheckoutStep \/
        UNCHANGED <<scenario, scenarioKind, scenarioIndex, attempt, allAttemptsSafe>>

\* Limits: synthetic GBP charges of 600 and two final renewals of 600, one
\* representative month plan, all eight statuses, and selected interruptions.
\* SQL writes and rollback execute locally; no real concurrent database race,
\* provider network, authentication, scheduler liveness, or Stripe truth is
\* proved. Provider replies must be truthful and belong to the requested id.
\* Other models check money arithmetic, checkout admission and record edits.
=============================================================================
