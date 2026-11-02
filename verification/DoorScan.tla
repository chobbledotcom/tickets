----------------------------- MODULE DoorScan -----------------------------
EXTENDS Integers, ModelRules, DoorScanData

\* A listing is an item that a customer can book, such as an event. A booking
\* records the places a customer owns on one or more listings. A ticket is
\* the access record presented at a door, such as a QR code that identifies
\* those booked lines. An attendee row supplies the customer's quantity and
\* checked-in count for a listing. One row can represent several places.
\* A door scan asks which of those places to admit now. Checked in means a
\* place already counted as admitted, not a separate customer or a scan count.
\* All quantities here count whole places, not money or database rows.
\* The pick is the count door staff request for this scan. Without a pick,
\* more than one place left requires a quantity answer before admission.
\* A pick applies to each selected listing and stops at its unadmitted count.
\* For example, a pick of one across two selected listings admits one place
\* on each. It is not a single place split between those two listings.
\* A refunded row no longer grants admission. A non-transferable listing
\* requires staff to confirm the holder's identity through the ID answer.
\* The model sees that answer as a Boolean, not the person's identity papers.
\* A purchase-only listing sells an item with no door check-in and grants no
\* admission. These gates are conditions that must pass before a count rises.
\*
\* MODULE names this specification. EXTENDS imports integer rules, the shared
\* verdict helper in ModelRules, and generated facts from the Data module.
\* A fact records one decision result for a finite example, not a live scan.
\* == defines a named expression, not an assignment. A condition describes
\* one state. An action relates it to next values marked with a prime. The
\* checker explores permitted choices, not an executable door staff workflow.
\* A door must admit no more places than a booking owns on each listing.
\* For example, a party owns three places and has used two. A request for
\* five more must admit one, not five. A refunded row must admit none.
\* scripts/verify-models/door-scan.ts supplies AdmitFacts. factsOf calls
\* decideScan in src/features/admin/scan-decision.ts and projects every
\* decision kind. heldBefore sums all booking rows on an admitted listing.
\* after adds that decision's unit.tickets. Non-admit decisions retain the
\* named row's count. These are decision outputs, not database write results.
\* The finite cases use listing one with three booked places and listing two
\* with one. They cover partial and full picks, an excessive pick, two rows
\* on one listing, no quantity choice, an exhausted booking, refund and ID
\* gates, no-check-in listings, and one-listing or all-listing admission.
\* An empty forced ticket yields no fact. The sample does not cover every
\* force/scope combination, input count or mixture of row attributes.
\* The model assumes those fixture quantities and flags represent the ticket.
\* It does not prove staff authority, actual ID checks, SQL admission writes,
\* concurrent scans, listing order, or the separate quantityAdmission plan.

\* The state counts below are abstract totals, not extra database columns.
\* "one" and "two" are distinct example listing identities with quantities
\* QuantityOne = 3 and QuantityTwo = 1. They are not scan order numbers or
\* two ticket types. Distinct identities expose a count charged to the wrong
\* listing. Three places expose partial admission and an excessive pick.
VARIABLES
  \* Places already admitted on example listing "one", across its booking
  \* rows. A total of two leaves one of its three booked places unused.
  \* @type: Int;
  listing1Admitted,
  \* Places already admitted on example listing "two", across its booking
  \* rows. Its single booked place permits totals zero and one only.
  \* @type: Int;
  listing2Admitted,
  \* TRUE means every fact used so far passed. FALSE remembers an unsafe fact
  \* so a later safe fact cannot erase its failure. This is model-only memory.
  \* @type: Bool;
  allFactsSafe

\* Int permits any integer. Safety below adds the non-negative count bounds.
TypeOK ==
  /\ listing1Admitted \in Int
  /\ listing2Admitted \in Int
  /\ allFactsSafe \in BOOLEAN

\* A fact's after count must stay within its listing's booked quantity and
\* must not decrease its non-negative before count. Refunded, purchase-only
\* (no check-in), and non-transferable rows without verified ID must stay put.
\* => means implication: each gate constrains a fact only when that gate holds.
\* @type: ($admitFactsFact) => Bool;
SafeAdmission(fact) ==
  /\ fact.after <= IF fact.listing = "one" THEN QuantityOne ELSE QuantityTwo
  /\ fact.after >= fact.before
  /\ fact.before >= 0
  /\ fact.refunded => fact.after = fact.before
  /\ fact.purchaseOnly => fact.after = fact.before
  /\ (fact.nonTransferable /\ ~fact.idVerified) => fact.after = fact.before

\* Safety is the condition that must stay true in every allowed state.
\* The initial check asks whether Init implies Safety. The inductive check
\* asks whether any Safety state followed by one Next step preserves Safety.
\* This includes states not reached from Init. The result establishes abstract
\* safety for supplied facts, not all tickets or all generated reachable paths.
Safety ==
  /\ TypeOK
  /\ allFactsSafe
  /\ listing1Admitted <= QuantityOne
  /\ listing2Admitted <= QuantityTwo
  /\ listing1Admitted >= 0
  /\ listing2Admitted >= 0

\* Init starts with no admitted places and no failed verdict. It is an
\* abstract fresh ticket, not an observed read of an existing booking.
Init ==
  /\ listing1Admitted = 0
  /\ listing2Admitted = 0
  /\ allFactsSafe = TRUE

\* \E selects a fact whose before count matches its listing's current count.
\* A prime denotes the next value. The named listing takes fact.after and
\* the other listing stays as it was. Refusal or a request for staff input
\* has equal before/after counts, so it makes no count change.
\* ChecksStillPass returns TRUE only when both verdicts are TRUE. A bad fact
\* must leave a visible failure even if a later fact passes.
\* Each step uses one listing fact. It does not model a multi-listing SQL
\* transaction or prove the order in which production chooses listings.
AdmitStep ==
  \E fact \in AdmitFacts :
    /\ (fact.listing = "one" => listing1Admitted = fact.before)
    /\ (fact.listing = "two" => listing2Admitted = fact.before)
    /\ listing1Admitted' =
         IF fact.listing = "one" THEN fact.after ELSE listing1Admitted
    /\ listing2Admitted' =
         IF fact.listing = "two" THEN fact.after ELSE listing2Admitted
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeAdmission(fact))

\* Next defines the permitted count changes. An enabled fact is one whose
\* conditions match the current count. UNCHANGED permits no value change.
\* No rule requires a scan, an ID answer or eventual admission. This checks
\* that bad admission never occurs, not that admission eventually occurs.
Next ==
  AdmitStep \/
  UNCHANGED <<listing1Admitted, listing2Admitted, allFactsSafe>>

=============================================================================
