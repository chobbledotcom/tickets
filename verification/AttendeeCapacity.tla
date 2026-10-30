----------------------------- MODULE AttendeeCapacity -----------------------------
EXTENDS Integers, AttendeeCapacityData

\* One atomic attendee edit batch over one attendee's lines, on two
\* representative slots. The batch inserts new capacity-checked lines,
\* updates changed lines with a pin on the old slot, and deletes removed
\* lines. Every capacity decision comes from the production capacity
\* condition, so a slip there shows up as a corrupted fact the checker
\* rejects. The model does not prove the SQL text; it proves the decision
\* the statements encode: one batch commits whole, a refused capacity write
\* commits nothing, and a committed attendee holds at least one line.
VARIABLES
  \* @type: Bool;
  committed,
  \* @type: Int;
  slot1Total,
  \* @type: Int;
  slot2Total,
  \* @type: Int;
  lineCount

TypeOK ==
  /\ committed \in BOOLEAN
  /\ slot1Total \in Int
  /\ slot2Total \in Int
  /\ lineCount \in Int

\* The summed quantity on each slot never passes the listing's quantity.
\* A committing batch claims slot totals that stay inside the caps, and the
\* stored totals track every line the batch commits.
NoOverfill ==
  /\ \A fact \in BatchFacts :
       fact.commits =>
         /\ fact.slot1AfterTotal <= QuantityOne
         /\ fact.slot2AfterTotal <= QuantityTwo
  /\ slot1Total <= QuantityOne
  /\ slot2Total <= QuantityTwo

\* One batch commits whole. A batch that commits carries every one of its
\* lines through, so no earlier line survives a later refused line.
NoPartialCommit ==
  \A fact \in BatchFacts :
    fact.commits =>
      \A line \in LineFacts :
        line.batch /= fact.batch \/ line.fits

\* A committed attendee holds at least one line, and no batch claims to
\* commit an empty attendee.
CommittedHoldsLine ==
  /\ \A fact \in BatchFacts : fact.commits => fact.lineCountAfter >= 1
  /\ committed => lineCount >= 1

\* An unchanged-preserved line consumes no capacity headroom. A batch of
\* only preserves is never refused, because its lines demand nothing new.
PreserveOnlyCommits ==
  \A fact \in BatchFacts : fact.preserveOnly => fact.commits

Safety ==
  /\ TypeOK
  /\ NoOverfill
  /\ NoPartialCommit
  /\ CommittedHoldsLine
  /\ PreserveOnlyCommits

Init ==
  /\ committed = FALSE
  /\ slot1Total = 0
  /\ slot2Total = 0
  /\ lineCount = 0

\* One atomic batch. When every capacity-checked line fits, the attendee
\* commits with the batch's lines. A refused write leaves every state
\* variable untouched, because the guard rolls the whole batch back.
BatchStep ==
  \E fact \in BatchFacts :
    /\ committed' = IF fact.commits THEN TRUE ELSE committed
    /\ slot1Total' = IF fact.commits THEN fact.slot1AfterTotal ELSE slot1Total
    /\ slot2Total' = IF fact.commits THEN fact.slot2AfterTotal ELSE slot2Total
    /\ lineCount' = IF fact.commits THEN fact.lineCountAfter ELSE lineCount

Next ==
  BatchStep \/ UNCHANGED <<committed, slot1Total, slot2Total, lineCount>>

InductionStart == Safety
=============================================================================
