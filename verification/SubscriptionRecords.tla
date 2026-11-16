------------------------- MODULE SubscriptionRecords -------------------------
\* An attendee is a person record. A booking links that person to one listing
\* (a ticket offer). Quantity counts places, not bookings. Quantity zero still
\* holds a subscription plan. A plan contains provider id, status, period amount,
\* VAT amount, and interval. Amounts here are integer minor currency units.
\* For example, an active zero-place booking must survive an attempted delete.
\* A merge may copy that whole plan to attendee 2, but cannot discard it.
EXTENDS Integers, FiniteSets, ModelRules, SubscriptionRules, SubscriptionRecordsData

\* scripts/verify-models/subscriptions/records.ts supplies immutable facts.
\* records-operations.ts executes applyAttendeeAtomicEdit (including its lost-line
\* guard), deleteAttendee, and validateAttendeeMergeDecision before applyAttendeeMerge.
\* The real apply copies columns through src/shared/merge/booking-copy.ts.
\* The producer reads stored rows and nonempty money records after each attempt.
\* Merge validation is a separate read-only stage. Apply alone has no plan-loss
\* guard. The model does not infer delete race safety from a pure merge check.
\* liveBookingOfAttendees and liveListingRefusal are observed beside each write.
\* records-projection.ts runs getSubscribedRows and getSubscribedRowOrNull.
\* Its expected rows come from independent seed inputs, not returned rows.
\* A slot is one result position, so two equal provider ids do not collapse.
\* Scenario plus attempt identifies each operation. All attempts here are pass 1.
\* Provider replies are not used; the local schema and successful transaction
\* atomicity are assumptions. Synthetic fixtures contain no customer information.

\* == defines a rule, not an assignment. Set braces enumerate alternatives.
\* SubscriptionRules supplies the independent business classification of statuses.
Statuses == LiveStatuses \cup EndedStatuses \cup {""}
Operations == {"edit-drop", "edit-preserve", "delete", "merge-drop-source",
               "merge-drop-target", "merge-move", "merge-take-source", "merge-preserve-target"}
MergeOperations == {"merge-drop-source", "merge-drop-target", "merge-move",
                    "merge-take-source", "merge-preserve-target", "merge-fault"}
Drops == {"edit-drop", "delete", "delete-race", "merge-drop-source", "merge-drop-target"}

\* This flag remembers a failed business check. It is model evidence, not a
\* stored payment state. A later good attempt cannot erase a bad attempt.
VARIABLE
  \* @type: Bool;
  safe

\* \A means every member, \E means some member, and /\ requires both rules.
\* Every status and place count has every operation, including refusals.
\* Two extra attempts execute a stale delete preview and a late merge failure.
\* The 216 combinations and the two extra attempts give 218 distinct rows.
\* Every combination is present, so that row count leaves one row for each.
OperationCoverage ==
  /\ OperationFactsCount = 218
  /\ \A status \in Statuses, quantity \in {0, 1, 3}, operation \in Operations :
       \E fact \in OperationFacts :
         /\ fact.status = status /\ fact.quantity = quantity
         /\ fact.operation = operation /\ fact.attempt = 1
  /\ \E fact \in OperationFacts : fact.operation = "delete-race"
  /\ \E fact \in OperationFacts : fact.operation = "merge-fault"

\* Projection coverage checks the independently prepared universe, never the
\* possibly damaged result. Each of eight statuses has zero, one and three places.
\* Invalid nonblank provider ids with missing or invalid plans must fail loudly.
ProjectionCoverage ==
  /\ ExpectedProjectionCount = 24
  /\ \A status \in LiveStatuses \cup EndedStatuses, quantity \in {0, 1, 3} :
       \E row \in ExpectedProjection : row.status = status /\ row.quantity = quantity
  /\ Cardinality({row \in ExpectedProjection : row.subscription = "sub_shared"}) = 2
  /\ {row.scenario : row \in InvalidPlans} =
       {"missing-interval", "invalid-interval", "missing-status", "invalid-status"}

\* The intended permit rule is independent of the observed production decision.
\* Ended and ordinary plans may be dropped. A live plan may only be preserved.
\* The deliberate companion fault is a refusal even though validation passed.
\* @type: ($operationFactsFact) => Bool;
Permitted(fact) ==
  fact.operation /= "merge-fault" /\
    ~(fact.operation \in Drops /\ fact.status \in LiveStatuses)

\* The seed has plan amount 731 with VAT 113, and provider id sub_protected.
\* This rule checks the producer's expectations against those independent inputs.
\* Conflict scenarios start with four rows; the other scenarios have three.
\* @type: ($operationFactsFact) => Bool;
ExpectedShape(fact) ==
  /\ fact.expectedPresent = ~(Permitted(fact) /\ fact.operation \in Drops)
  /\ fact.expectedSubscription = IF fact.status = "" THEN "" ELSE "sub_protected"
  /\ fact.expectedPrice = IF fact.status = "" THEN 0 ELSE 731
  /\ fact.expectedTax = IF fact.status = "" THEN 0 ELSE 113
  /\ fact.expectedInterval = IF fact.status = "" THEN "" ELSE "month"
  /\ fact.expectedStatus = fact.status
  /\ fact.expectedListing = 11
  /\ fact.expectedQuantity = fact.quantity +
       (IF fact.operation = "edit-preserve" THEN 1 ELSE 0)
  /\ fact.expectedAttendee =
       IF (Permitted(fact) /\ fact.operation \in MergeOperations) \/
          fact.operation \in {"merge-drop-target", "merge-preserve-target"}
       THEN 2 ELSE 1
  /\ fact.expectedBooking =
       IF Permitted(fact) /\ fact.operation \in {"merge-move", "merge-take-source"}
       THEN 0 ELSE 1
  /\ fact.expectedRowCount =
       IF Permitted(fact)
       THEN IF fact.operation = "delete" THEN 1
            ELSE IF fact.operation = "edit-drop" THEN 2 ELSE 3
       ELSE IF fact.operation \in {"merge-drop-source", "merge-drop-target",
                                  "merge-take-source", "merge-preserve-target"}
            THEN 4 ELSE 3

\* The row identity must stay exact on an edit or a kept target. A real merge
\* copy receives a new database id, represented by expectedBooking zero.
\* All five plan columns, person, listing and quantity must stay exact.
\* @type: ($operationFactsFact) => Bool;
PreservedPlan(fact) ==
  /\ fact.present = fact.expectedPresent
  /\ fact.present =>
       /\ IF fact.expectedBooking = 0 THEN fact.booking > 0
          ELSE fact.booking = fact.expectedBooking
       /\ fact.attendee = fact.expectedAttendee
       /\ fact.listing = fact.expectedListing
       /\ fact.afterQuantity = fact.expectedQuantity
       /\ fact.subscription = fact.expectedSubscription
       /\ fact.price = fact.expectedPrice
       /\ fact.tax = fact.expectedTax
       /\ fact.interval = fact.expectedInterval
       /\ fact.afterStatus = fact.expectedStatus

\* Individual refusal controls remove only observed presence for edit, delete,
\* and merge. They keep accepted FALSE, isolating this law from admission.
\* Real merge-copy controls change identity, amount, tax, interval, or status
\* one column at a time. None of those controls changes the expected seed plan.

\* Refusal comparisons use actual full snapshots, including the person and
\* money rows. They are not a refusal label or reconstructed safe after-state.
\* The late merge fault follows row copies, ledger moves and a person write.
\* It must roll all those writes back. A successful merge may repoint money,
\* but each original leg and amount must otherwise stay exact.
\* @type: ($operationFactsFact) => Bool;
OperationLaw(fact) ==
  /\ fact.live = (fact.status \in LiveStatuses)
  /\ fact.liveRead = fact.live
  /\ fact.listingRefused = fact.live
  /\ fact.accepted = Permitted(fact)
  /\ fact.expectedAccepted = Permitted(fact)
  /\ fact.validationUnchanged
  /\ fact.operation \in MergeOperations =>
       /\ fact.validationAccepted = (Permitted(fact) \/ fact.operation = "merge-fault")
       /\ fact.applyRan = fact.validationAccepted
  /\ ~fact.accepted => fact.recordsUnchanged /\ fact.moneyUnchanged
  /\ fact.moneyCorrect
  /\ fact.rowCount = fact.expectedRowCount
  /\ ExpectedShape(fact)
  /\ PreservedPlan(fact)

\* Equality checks each booking, attribution, amount, interval and read position.
\* The slot prevents a duplicate result from disappearing in a TLA set.
\* This is per stored booking, not uniqueness of the provider subscription id.
ProjectionLaw ==
  /\ ObservedProjection = ExpectedProjection
  /\ \A row \in InvalidPlans : row.listThrows /\ row.singleThrows

\* Coverage holds no state variable, so Init evaluates it one time and keeps
\* the result in safe. A gap in the facts makes the first state unsafe.
\* Outcome laws are checked by steps, so the unrestricted induction premise
\* cannot exclude an unsafe fact.
\* Init safety and preservation from any Safety state establish these abstract
\* laws for finite runs over the supplied facts. They do not prove SQL itself.
\* The only state variable is Boolean; no infinite STRING domain is needed.
Safety == safe \in BOOLEAN /\ safe

\* Start before any observed attempt is replayed. No database is initially empty:
\* each fact already carries a separately seeded real operation's outcome.
Init == safe = (OperationCoverage /\ ProjectionCoverage)

\* Integer choice permits every fact, not only the first. Paged row lookup
\* bounds the checker's symbolic choices without removing refused outcomes.
OperationStep ==
  \E index \in OperationFactsIndices :
    LET fact == OperationFactsAt(index) IN
    safe' = ChecksStillPass(safe, OperationLaw(fact))
ProjectionStep == safe' = ChecksStillPass(safe, ProjectionLaw)

\* Next permits either observation, or a step with no model change. No fairness
\* is assumed. These laws do not claim that an operation eventually happens.
Next == OperationStep \/ ProjectionStep \/ UNCHANGED safe

\* Limits: two people, three ticket offers, null dates for operations, and three
\* quantities. Projection also has distinct dated slots and week/month/year.
\* The delete overlap makes a live row appear after an admitted preview, then
\* executes the real writer. It is a selected interleaving, not all race orders.
\* No live database or Stripe request runs. The page's labels, roles and personal
\* data remain existing runtime-test obligations, not a formal page proof.
=============================================================================
