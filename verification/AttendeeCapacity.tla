----------------------------- MODULE AttendeeCapacity -----------------------------
\* This module describes rules for an edit to one attendee's ticket.
\* EXTENDS imports integer arithmetic and the generated example records below.
EXTENDS Integers, AttendeeCapacityData

\* A listing is an item that a visitor can book, such as a workshop.
\* An attendee record holds the ticket details. It can hold several places.
\* A line links that attendee to one listing and states the number of places.
\* One attendee can have several lines, for different listings or package paths.
\* A package path identifies the bundle through which the line was booked.
\*
\* A slot here means one listing whose occupied places share a capacity total.
\* Slot one and slot two are two separate example listings, with ids 1 and 2.
\* They are not two people, two database columns, or two times in a schedule.
\* The examples have no dates. A dated booking needs separate capacity checks.
\* QuantityOne is slot one's limit of three places. QuantityTwo is slot two's
\* limit of two places. These small limits expose full and nearly full cases.
\* slot1Total = 3 means all three places on the first listing are occupied.
\* That total includes other attendees, not only the attendee under edit.
\*
\* An edit supplies the final lines that the attendee must hold.
\* A batch is the set of database writes for that edit, in one transaction.
\* The required result is all writes together or none, with at least one line.
\* For example, a batch can add one place on slot two, then fail to add two
\* places on a nearly full slot one. The earlier write must not survive.
\*
\* A fact is one prepared example's result, not a live customer record.
\* scripts/verify-models/attendee-capacity.ts supplies LineFacts and BatchFacts.
\* fitsFor executes lineStatementFor. batchFactFor executes
\* buildAttendeeEditBatch in write mode and reads committed totals via
\* storedAfter. Those builders live in
\* src/shared/db/attendees/atomic-update.ts. Their capacity predicate comes
\* from capacityConditionFor in src/shared/db/capacity.ts.
\* scripts/verify-models/attendee-capacity-seed.ts uses the production schema
\* and triggers. It supplies one attendee, null dates, empty group tables,
\* and two slots with caps three and two. Quantities count places, not rows.
\* Cases cover inserts, updates, preserves, a preserve on an inactive listing,
\* deletes, zero quantity, package paths, an empty edit and a later refusal.
\* Distinct package paths permit two lines on one slot without duplicate keys.
\* Line fits are separate writes on fresh seeds, not intermediate batch reads.
\* A recognised NOT NULL guard error supplies a refusal. Other errors escape.
\* Refused after-totals are reconstructed expectations, not stored observations.
\* No refused-state read here proves rollback. SQL rollback, concurrent edits,
\* dated slots, group caps and the full caller path need separate tests.

\* These variables are model-only snapshots, not a transaction log. committed
\* records a prior accepted fact. Slot totals include other attendees' demand.
\* lineCount counts this attendee's rows, even a row with zero places.
VARIABLES
  \* TRUE after a batch fact reports acceptance. It does not mean SQL is open.
  \* @type: Bool;
  committed,
  \* Occupied places on example listing 1, across all its attendee lines.
  \* @type: Int;
  slot1Total,
  \* Occupied places on example listing 2, with its own separate limit.
  \* @type: Int;
  slot2Total,
  \* This attendee's line rows, not their place quantity or the listing total.
  \* @type: Int;
  lineCount

\* Int permits all integers. TypeOK alone imposes no non-negative lower bound.
\* Name == expression defines a rule. It does not assign a program variable.
\* \in means "belongs to". BOOLEAN contains the two values TRUE and FALSE.
TypeOK ==
  /\ committed \in BOOLEAN
  /\ slot1Total \in Int
  /\ slot2Total \in Int
  /\ lineCount \in Int

\* Every accepted batch fact and current snapshot must stay at or below the
\* two slot caps. \A means every fact, including facts absent from a run.
\* /\ requires both conditions. => means "if the left side, then the right".
\* This law checks upper bounds, not all possible stored-data corruption.
NoOverfill ==
  /\ \A fact \in BatchFacts :
       fact.commits =>
         /\ fact.slot1AfterTotal <= QuantityOne
         /\ fact.slot2AfterTotal <= QuantityTwo
  /\ slot1Total <= QuantityOne
  /\ slot2Total <= QuantityTwo

\* An accepted batch must have no independently refused desired line. The
\* batch identifier joins its LineFacts. A different batch imposes no condition.
\* Each batch name connects one edit result to the line results for that edit.
\* fits means that the individual line's write affected one row on a fresh seed.
\* This implication cannot prove that a refused batch left storage untouched.
NoPartialCommit ==
  \A fact \in BatchFacts :
    fact.commits =>
      \A line \in LineFacts :
        line.batch /= fact.batch \/ line.fits

\* Each accepted fact and accepted snapshot must retain at least one row.
\* A zero-quantity row satisfies this law. It does not represent a paid place.
CommittedHoldsLine ==
  /\ \A fact \in BatchFacts : fact.commits => fact.lineCountAfter >= 1
  /\ committed => lineCount >= 1

\* A preserve retains the same slot, range and quantity. A preserve-only edit
\* must commit even if its listing is inactive. It requests no extra capacity.
PreserveOnlyCommits ==
  \A fact \in BatchFacts : fact.preserveOnly => fact.commits

\* Safety is the full set of conditions that must remain true.
\* First the checker tests Init. It then tests one Next step from any state
\* that satisfies Safety. Both checks together establish the rules for any
\* finite sequence of these abstract steps, not every SQL input or transaction.
Safety ==
  /\ TypeOK
  /\ NoOverfill
  /\ NoPartialCommit
  /\ CommittedHoldsLine
  /\ PreserveOnlyCommits

\* Init is an empty abstract snapshot, not a seed read. It has no accepted
\* batch yet. Individual scenario seeds can already contain attendee rows.
Init ==
  /\ committed = FALSE
  /\ slot1Total = 0
  /\ slot2Total = 0
  /\ lineCount = 0

\* \E selects any batch fact without a source-state guard. An accepted fact
\* replaces the snapshot with its observed totals and row count. A refused
\* fact leaves all variables as they were. A prime denotes the next value.
\* This is a replay of independent outcomes, not a sequence of real edits.
\* Unchanged state on refusal is an abstract rule, not observed SQL rollback.
BatchStep ==
  \E fact \in BatchFacts :
    /\ committed' = IF fact.commits THEN TRUE ELSE committed
    /\ slot1Total' = IF fact.commits THEN fact.slot1AfterTotal ELSE slot1Total
    /\ slot2Total' = IF fact.commits THEN fact.slot2AfterTotal ELSE slot2Total
    /\ lineCount' = IF fact.commits THEN fact.lineCountAfter ELSE lineCount

\* \/ means "or". Next describes all permitted alternatives, not their order.
\* UNCHANGED permits a step with no effect. No rule requires an edit to occur.
\* This is safety: no bad state. It is not liveness: an edit eventually finishes.
Next ==
  BatchStep \/ UNCHANGED <<committed, slot1Total, slot2Total, lineCount>>

=============================================================================
